import { DiscordSDK } from '@discord/embedded-app-sdk';
import type { ClientMsg, Member, PlaybackState, ServerMsg } from '../../shared/protocol';
import type { SearchResult } from '../../shared/search';
import { authenticate, watchLayout } from './net/discord';
import { describeError, devlog, watchErrors } from './core/devlog';
import { inDiscord, proxied } from './core/env';
import { getLang, serverErrorText, t } from './core/i18n';
import { NicoPlayer } from './player/nicoPlayer';
import { attachPlayerDocHooks } from './player/playerDocHooks';
import { renderQueue } from './ui/playlist';
import { RoomConnection } from './net/roomConnection';
import { createPresence } from './core/presence';
import { isPresenceEnabled } from './ui/settings';
import { setupViewport } from './ui/viewport';
import { SyncEngine } from './player/sync';
import { failLoading, hideLoading, setCompact, setPlayerCover, showError, slowLoading } from './ui/overlays';
import { mountUi } from './ui/ui';

/** Discord 内では iframe から外のページへ移れないので、Discord の「外部リンクを開く」を使う */
function openExternal(url: string) {
  if (sdk) sdk.commands.openExternalLink({ url }).catch(() => {});
  else window.open(url, '_blank', 'noopener');
}

/** サーバーが発行した、ニコニコの中継と検索を使うための通行証（Discord にログインできたときだけ） */
let nicoPass: string | undefined;

const ui = mountUi(document.querySelector<HTMLElement>('#app')!, {
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

const player = new NicoPlayer(ui.player, (videoId, playerId) => {
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
  // Discord 内では埋め込み HTML を自前サーバーで書き換えて配信する (server/src/nico/nico.ts)
  return inDiscord
    ? `/.proxy/nico/${nicoPass ?? 'none'}/nico-embed/${videoId}?${params}`
    : `https://embed.nicovideo.jp/watch/${videoId}?${params}`;
});

setupViewport();

attachPlayerDocHooks(player.iframe, { onTag: ui.searchFor, onLink: openExternal });
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
  ui.renderState(state);
  engine.update(state);
  presence?.setState(state);
}

function applyMembers(members: Member[]) {
  ui.renderMembers(members);
  presence?.setMembers(members.length);
}

function onMessage(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome':
      clearTimeout(slowTimer);
      hideLoading();
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

let slowTimer: number | undefined;

/** 部屋に入るまでこれ以上かかったら、時間がかかっていると伝える */
const SLOW_CONNECT_MS = 10_000;

function connect(roomId: string, name: string, pass?: string) {
  slowTimer = window.setTimeout(slowLoading, SLOW_CONNECT_MS);
  conn = new RoomConnection({ roomId, name, clientId, pass, onMessage, onWaiting: ui.renderConnecting });
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
  watchLayout(discord, setCompact);
  // 通行証がないと、部屋に入れず、動画の読み込みも検索もできない。ローディングのまま止まらないよう、理由を出す
  if (!pass || !nicoPass) {
    failLoading(t('loginRequired'));
    return;
  }
  devlog(`ready as ${name} (instance ${discord.instanceId})`);
  connect(discord.instanceId, name, pass);
}

main().catch((e) => {
  devlog(`main failed: ${describeError(e)}`);
  failLoading(t('startFailed', { msg: e instanceof Error ? e.message : String(e) }));
});
