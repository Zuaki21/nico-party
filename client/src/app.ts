import { DiscordSDK } from '@discord/embedded-app-sdk';
import type { ClientMsg, Member, PlaybackState, ServerMsg } from '../../shared/protocol';
import { describeError, devlog, watchErrors } from './core/devlog';
import { inDiscord } from './core/env';
import { getLang, serverErrorText, t } from './core/i18n';
import { searchNico } from './net/api';
import { authenticate, openExternal, watchLayout } from './net/discord';
import { createPresence } from './net/presence';
import { RoomConnection } from './net/roomConnection';
import { nicoEmbedUrl } from './player/embedUrl';
import { NicoPlayer } from './player/nicoPlayer';
import { attachPlayerDocHooks } from './player/playerDocHooks';
import { SyncEngine } from './player/sync';
import { failLoading, hideLoading, setCompact, setPlayerCover, showError, slowLoading } from './ui/overlays';
import { renderQueue } from './ui/playlist';
import { isPresenceEnabled } from './ui/settings';
import { mountUi } from './ui/ui';
import { setupViewport } from './ui/viewport';

/**
 * 起動の流れ（接続・Discord のログイン・画面・プレイヤー・同期）を結びつける。
 * 起動の途中で決まるもの（Discord の SDK・通行証・部屋との接続・Discord への表示）は、session にまとめる
 */
const session: {
  /** Discord の SDK（Discord の外で開いたときは null） */
  sdk: DiscordSDK | null;
  /** サーバーが発行した、ニコニコの中継と検索を使うための通行証（Discord にログインできたときだけ） */
  nicoPass?: string;
  conn: RoomConnection | null;
  /** 見ている動画を Discord のアクティビティに表示する（ログインできたときだけ） */
  presence: ReturnType<typeof createPresence> | null;
} = { sdk: null, conn: null, presence: null };

/** 再接続しても同じメンバーとして扱ってもらうための ID（ページを開き直すと変わる） */
const clientId = crypto.randomUUID();
/** 今のサーバー時刻 (ms)。同期エンジンと Discord への表示が、同じ時計を使う */
const serverNow = () => Date.now() + (session.conn?.clock.offset ?? 0);

/** ユーザー操作（追加・削除・スキップ）。部屋に入れていなければ、動画の追加以外は受け付けない */
function request(msg: ClientMsg) {
  if (!session.conn?.request(msg)) showError(t('notConnected'));
}

const ui = mountUi(document.querySelector<HTMLElement>('#app')!, {
  enqueue: (url) => request({ t: 'enqueue', url }),
  remove: (id) => request({ t: 'remove', id }),
  skip: (itemId) => request({ t: 'next', itemId }),
  prev: (itemId) => request({ t: 'prev', itemId }),
  move: (id, index) => request({ t: 'move', id, index }),
  jump: (id) => request({ t: 'jump', id }),
  mode: (m) => request({ t: 'mode', ...m }),
  openLink: (url) => openExternal(session.sdk, url),
  setPresence: (enabled) => session.presence?.setEnabled(enabled),
  search: (q, sort, offset) => searchNico(session.nicoPass, q, sort, offset),
});

const player = new NicoPlayer(ui.player, (videoId, playerId) => nicoEmbedUrl(videoId, playerId, session.nicoPass));
const engine = new SyncEngine(
  player,
  (msg) => session.conn?.send(msg),
  () => showError(t('loadFailed')),
  setPlayerCover,
  serverNow,
);

setupViewport();
attachPlayerDocHooks(player.iframe, { onTag: ui.searchFor, onLink: (url) => openExternal(session.sdk, url) });
watchErrors(player.iframe);
for (const ev of ['load', 'play', 'pause', 'ended'] as const) player.on(ev, () => devlog(`player ${ev}`));

/** 部屋の再生状態を、画面・プレイヤー・Discord の表示に反映する */
function applyState(state: PlaybackState) {
  ui.renderState(state);
  engine.update(state);
  session.presence?.setState(state);
}

function applyMembers(members: Member[]) {
  ui.renderMembers(members);
  session.presence?.setMembers(members.length);
}

let slowTimer: number | undefined;
/** 部屋に入るまでこれ以上かかったら、時間がかかっていると伝える */
const SLOW_CONNECT_MS = 10_000;

function onMessage(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome':
      clearTimeout(slowTimer);
      hideLoading();
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
      // 時計のずれの推定は、RoomConnection が更新済み。同期エンジンは serverNow() で毎回それを使う
      return;
  }
}

function connect(roomId: string, name: string, pass?: string) {
  slowTimer = window.setTimeout(slowLoading, SLOW_CONNECT_MS);
  session.conn = new RoomConnection({ roomId, name, clientId, pass, onMessage, onWaiting: ui.renderConnecting });
  session.conn.start();
}

async function main() {
  if (!inDiscord) {
    // 通常のブラウザ: 全タブ共通の部屋で動作確認できるようにする
    connect('local-dev', `ブラウザ${Math.floor(Math.random() * 100)}`);
    return;
  }
  const discord = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
  session.sdk = discord;
  await discord.ready();
  let name = getLang() === 'ja' ? 'ゲスト' : 'Guest';
  let pass: string | undefined;
  try {
    ({ name, pass, nicoPass: session.nicoPass } = await authenticate(discord));
    session.presence = createPresence(discord, serverNow, isPresenceEnabled());
  } catch (e) {
    devlog(`authenticate failed: ${describeError(e)}`);
  }
  watchLayout(discord, setCompact);
  // 通行証がないと、部屋に入れず、動画の読み込みも検索もできない。ローディングのまま止まらないよう、理由を出す
  if (!pass || !session.nicoPass) {
    failLoading(t('loginRequired'));
    return;
  }
  devlog(`ready as ${name} (instance ${discord.instanceId})`);
  connect(discord.instanceId, name, pass);
}

main().catch((e) => {
  devlog(`main failed: ${describeError(e)}`);
  failLoading(t('startFailed', { msg: describeError(e) }));
});
