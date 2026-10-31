import { Common, DiscordSDK } from '@discord/embedded-app-sdk';
import {
  type ClientMsg,
  type Member,
  type PlaybackState,
  type SearchResult,
  type ServerMsg,
} from '../../shared/protocol';
import { describeError, devlog, watchErrors } from './devlog';
import { inDiscord, proxied } from './env';
import { getLang, serverErrorText, t } from './i18n';
import { NicoPlayer } from './nicoPlayer';
import { renderQueue } from './playlist';
import { RoomConnection } from './roomConnection';
import { createPresence } from './presence';
import { isPresenceEnabled } from './settings';
import { SyncEngine } from './sync';
import { mountUi, renderConnecting, renderMembers, renderState, setCompact, showError } from './ui';

const playerEl = mountUi(document.querySelector<HTMLElement>('#app')!, {
  enqueue: (url) => request({ t: 'enqueue', url }),
  remove: (id) => request({ t: 'remove', id }),
  skip: (itemId) => request({ t: 'next', itemId }),
  prev: (itemId) => request({ t: 'prev', itemId }),
  move: (id, index) => request({ t: 'move', id, index }),
  jump: (id) => request({ t: 'jump', id }),
  mode: (m) => request({ t: 'mode', ...m }),
  openLink: (url) => {
    // Discord 内では iframe から外のページへ移れないので、Discord の「外部リンクを開く」を使う
    if (sdk) sdk.commands.openExternalLink({ url }).catch(() => {});
    else window.open(url, '_blank', 'noopener');
  },
  setPresence: (enabled) => presence?.setEnabled(enabled),
  search: async (q, sort, offset) => {
    const params = new URLSearchParams({ q, sort, offset: String(offset) });
    const res = await fetch(proxied(`/api/search?${params}`));
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
    ? `/.proxy/nico/nico-embed/${videoId}?${params}`
    : `https://embed.nicovideo.jp/watch/${videoId}?${params}`;
});

// キーボードが出たときは、実際に見えている高さに画面を合わせる（iPhone は画面を縮めずに重ねて出すため）。
// あわせて、入力欄を見せるためにページがずらされたら元の位置に戻す（画面の配置は動かさない）
const fitViewport = () => {
  const vv = window.visualViewport;
  if (vv) document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
};
window.addEventListener('scroll', fitViewport);
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
fitViewport();

// 右クリックのメニュー（「検証」など）は出さない。入力欄では貼り付けに使うので残す
document.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
});

watchErrors(player.iframe);
for (const ev of ['load', 'play', 'pause', 'ended'] as const) player.on(ev, () => devlog(`player ${ev}`));

/** 再接続しても同じメンバーとして扱ってもらうための ID（ページを開き直すと変わる） */
const clientId = crypto.randomUUID();
let conn: RoomConnection | null = null;
const engine = new SyncEngine(player, (msg) => conn?.send(msg), () => showError(t('loadFailed')));

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

function connect(roomId: string, name: string) {
  conn = new RoomConnection({ roomId, name, clientId, onMessage, onWaiting: renderConnecting });
  conn.start();
}

/** 見ている動画を Discord のアクティビティに表示する（ログインできたときだけ） */
let presence: ReturnType<typeof createPresence> | null = null;
/** Discord の SDK（Discord の外で開いたときは null） */
let sdk: DiscordSDK | null = null;

/** Discord にログインしてもらい、表示名を取得する */
async function authenticate(sdk: DiscordSDK): Promise<string> {
  const authorize = (prompt?: 'none') =>
    sdk.commands.authorize({
      client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
      response_type: 'code',
      state: '',
      ...(prompt ? { prompt } : {}),
      // rpc.activities.write: 見ている動画を Discord のアクティビティ（〇〇を視聴中）に表示するため
      scope: ['identify', 'rpc.activities.write'],
    });
  // 許可済みなら確認画面なしで通る。未許可・権限が増えた人は失敗するので、確認画面を出して取り直す
  const { code } = await authorize('none').catch(() => authorize());
  const res = await fetch(proxied('/api/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { access_token } = (await res.json()) as { access_token?: string };
  if (!access_token) throw new Error('token exchange failed');
  const { user } = await sdk.commands.authenticate({ access_token });
  return user.global_name ?? user.username;
}

/** PiP（チャットを開いて小さく表示されている状態）やグリッド表示では動画だけを表示する */
function watchLayout(sdk: DiscordSDK) {
  sdk
    .subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', ({ layout_mode }) => {
      devlog(`layout mode ${layout_mode}`);
      // PiP と、参加者がタイル状に並ぶグリッド表示では、動画だけを枠いっぱいに出す
      setCompact(
        layout_mode === Common.LayoutModeTypeObject.PIP ||
          layout_mode === Common.LayoutModeTypeObject.GRID,
      );
    })
    .catch((e) => devlog(`layout subscribe failed: ${describeError(e)}`));
}

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
  try {
    name = await authenticate(discord);
    presence = createPresence(discord, () => Date.now() + (conn?.clock.offset ?? 0), isPresenceEnabled());
  } catch (e) {
    // 名前が取れなくても視聴はできるようにする
    devlog(`authenticate failed: ${describeError(e)}`);
  }
  watchLayout(discord);
  devlog(`ready as ${name} (instance ${discord.instanceId})`);
  connect(discord.instanceId, name);
}

main().catch((e) => {
  devlog(`main failed: ${describeError(e)}`);
  showError(t('startFailed', { msg: e instanceof Error ? e.message : String(e) }));
});
