import { DiscordSDK } from '@discord/embedded-app-sdk';
import type { ClientMsg, Member, PlaybackState, ServerMsg } from '../../shared/protocol';
import type { SearchResult } from '../../shared/search';
import { authenticate, watchLayout } from './discord';
import { describeError, devlog, watchErrors } from './devlog';
import { inDiscord, proxied } from './env';
import { getLang, serverErrorText, t } from './i18n';
import { NicoPlayer } from './nicoPlayer';
import { attachPlayerDocHooks } from './playerDocHooks';
import { renderQueue } from './playlist';
import { RoomConnection } from './roomConnection';
import { createPresence } from './presence';
import { isPresenceEnabled } from './settings';
import { setupViewport } from './viewport';
import { SyncEngine } from './sync';
import {
  hideLoading,
  mountUi,
  renderConnecting,
  renderMembers,
  renderState,
  searchFor,
  setPlayerCover,
  setCompact,
  showError,
  slowLoading,
} from './ui';

/** Discord 内では iframe から外のページへ移れないので、Discord の「外部リンクを開く」を使う */
function openExternal(url: string) {
  if (sdk) sdk.commands.openExternalLink({ url }).catch(() => {});
  else window.open(url, '_blank', 'noopener');
}

/** サーバーが発行した、ニコニコの中継と検索を使うための通行証（Discord にログインできたときだけ） */
let nicoPass: string | undefined;

const playerEl = mountUi(document.querySelector<HTMLElement>('#app')!, {
  enqueue: (url) => request({ t: 'enqueue', url }),
  remove: (id) => request({ t: 'remove', id }),
  skip: (itemId) => request({ t: 'next', itemId }),
  prev: (itemId) => request({ t: 'prev', itemId }),
  move: (id, index) => request({ t: 'move', id, index }),
  jump: (id) => request({ t: 'jump', id }),
  mode: (m) => request({ t: 'mode', ...m }),
  openLink: (url) => openExternal(url),
  setPresence: (enabled) => presence?.setEnabled(enabled),
  search: async (q, sort, offset) => {
    const params = new URLSearchParams({ q, sort, offset: String(offset) });
    const res = await fetch(proxied(`/api/search?${params}`), {
      headers: nicoPass ? { 'x-nico-pass': nicoPass } : {},
    });
    if (!res.ok) throw new Error(`search failed: ${res.status}`);
    return (await res.json()) as SearchResult;
  },
});

const player = new NicoPlayer(playerEl, (videoId, playerId) => {
  const params = new URLSearchParams({
    jsapi: '1',
    playerId,
    noRelatedVideo: '1',
    noShare: '1',
    persistence: '1',
  });
  // Discord 内（中継経由）では、プレイヤーはこれを元に postMessage の宛先オリジンを決める（無いと 'null//null' になる）。
  // ローカル確認用の直接埋め込みでは逆に付けるとニコニコに 403 で拒否される
  if (inDiscord) params.set('referer', location.href);
  // Discord 内では埋め込み HTML を自前サーバーで書き換えて配信する (server/src/nico.ts)
  return inDiscord
    ? `/.proxy/nico/${nicoPass ?? 'none'}/nico-embed/${videoId}?${params}`
    : `https://embed.nicovideo.jp/watch/${videoId}?${params}`;
});

setupViewport();

attachPlayerDocHooks(player.iframe, { onTag: searchFor, onLink: openExternal });
watchErrors(player.iframe);
for (const ev of ['load', 'play', 'pause', 'ended'] as const) player.on(ev, () => devlog(`player ${ev}`));

/** 再接続しても同じメンバーとして扱ってもらうための ID（ページを開き直すと変わる） */
const clientId = crypto.randomUUID();
let conn: RoomConnection | null = null;
const engine = new SyncEngine(player, (msg) => conn?.send(msg), () => showError(t('loadFailed')), setPlayerCover);

/** ユーザー操作（追加・削除・スキップ）。部屋に入れていなければ、動画の追加以外は受け付けない */
function request(msg: ClientMsg) {
  if (!conn?.request(msg)) showError(t('notConnected'));
}

/** 部屋の再生状態を、画面・プレイヤー・Discord の表示に反映する */
function applyState(state: PlaybackState) {
  renderState(state);
  engine.update(state);
  presence?.setState(state);
}

function applyMembers(members: Member[]) {
  renderMembers(members);
  presence?.setMembers(members.length);
}

function onMessage(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome':
      clearTimeout(slowTimer);
      hideLoading();
      if (loginFailed) {
        loginFailed = false;
        showError(t('loginRequired'));
      }
      engine.setClockOffset(conn!.clock.offset);
      renderQueue(msg.queue, msg.history);
      applyMembers(msg.members);
      applyState(msg.state);
      engine.resendLoadReport();
      return;
    case 'state':
      applyState(msg.state);
      return;
    case 'queue':
      renderQueue(msg.queue, msg.history);
      return;
    case 'members':
      applyMembers(msg.members);
      return;
    case 'error':
      devlog(`server error: ${msg.code}`);
      showError(serverErrorText(msg.code, msg.params));
      return;
    case 'pong':
      engine.setClockOffset(conn!.clock.offset);
      return;
  }
}

/** Discord にログインできなかった（通行証がない）。部屋に入れたときに案内を出す */
let loginFailed = false;

let slowTimer: number | undefined;

/** 部屋に入るまでこれ以上かかったら、時間がかかっていると伝える */
const SLOW_CONNECT_MS = 10_000;

function connect(roomId: string, name: string, pass?: string) {
  slowTimer = window.setTimeout(slowLoading, SLOW_CONNECT_MS);
  conn = new RoomConnection({ roomId, name, clientId, pass, onMessage, onWaiting: renderConnecting });
  conn.start();
}

/** 見ている動画を Discord のアクティビティに表示する（ログインできたときだけ） */
let presence: ReturnType<typeof createPresence> | null = null;
/** Discord の SDK（Discord の外で開いたときは null） */
let sdk: DiscordSDK | null = null;

async function main() {
  if (!inDiscord) {
    // 通常のブラウザ: 全タブ共通の部屋で動作確認できるようにする
    connect('local-dev', `ブラウザ${Math.floor(Math.random() * 100)}`);
    return;
  }
  const discord = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
  sdk = discord;
  await discord.ready();
  let name = getLang() === 'ja' ? 'ゲスト' : 'Guest';
  let pass: string | undefined;
  try {
    ({ name, pass, nicoPass } = await authenticate(discord));
    presence = createPresence(discord, () => Date.now() + (conn?.clock.offset ?? 0), isPresenceEnabled());
  } catch (e) {
    // 名前が取れなくても視聴はできるようにする
    devlog(`authenticate failed: ${describeError(e)}`);
  }
  // 通行証がないと、動画の読み込みと検索ができない
  // （起動中は画面全体を覆う表示の下になって読めないので、部屋に入れてから出す）
  loginFailed = !nicoPass;
  watchLayout(discord, setCompact);
  devlog(`ready as ${name} (instance ${discord.instanceId})`);
  connect(discord.instanceId, name, pass);
}

main().catch((e) => {
  hideLoading();
  devlog(`main failed: ${describeError(e)}`);
  showError(t('startFailed', { msg: e instanceof Error ? e.message : String(e) }));
});
