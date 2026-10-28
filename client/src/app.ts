import { Common, DiscordSDK } from '@discord/embedded-app-sdk';
import { HEARTBEAT, type ClientMsg, type SearchResult, type ServerMsg } from '../../shared/protocol';
import { ClockSync } from './clock';
import { devlog, watchErrors } from './devlog';
import { inDiscord, proxied } from './env';
import { NicoPlayer } from './nicoPlayer';
import { createPresence } from './presence';
import { SyncEngine } from './sync';
import {
  mountUi,
  renderConnecting,
  renderMembers,
  renderQueue,
  renderState,
  setCompact,
  showError,
} from './ui';


/**
 * 接続の生存確認の間隔。何も流れない WebSocket は途中で切られることがあるので送っておく。
 * サーバー側は自動応答で返すので、部屋 (Durable Object) を起こさない
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_MAX_MS = 10_000;

const playerEl = mountUi(document.querySelector<HTMLElement>('#app')!, {
  enqueue: (url) => request({ t: 'enqueue', url }),
  remove: (id) => request({ t: 'remove', id }),
  skip: (itemId) => request({ t: 'next', itemId }),
  prev: (itemId) => request({ t: 'prev', itemId }),
  move: (id, index) => request({ t: 'move', id, index }),
  jump: (id) => request({ t: 'jump', id }),
  mode: (m) => request({ t: 'mode', ...m }),
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

// 右クリックのメニュー（「検証」など）は出さない。入力欄では貼り付けに使うので残す
document.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
});

watchErrors(player.iframe);
for (const ev of ['load', 'play', 'pause', 'ended'] as const) player.on(ev, () => devlog(`player ${ev}`));

let ws: WebSocket | null = null;
/** welcome を受け取り、部屋に入れている */
let joined = false;
/** 部屋に入る前（起動直後・再接続中）に行われたユーザー操作。入れたらまとめて送る */
const pending: ClientMsg[] = [];
const clock = new ClockSync();
const engine = new SyncEngine(player, send);

function sendRaw(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** 同期エンジンからの送信。部屋に入っていないときの再生操作は意味がないので捨てる */
function send(msg: ClientMsg) {
  if (joined) sendRaw(msg);
}

/** ユーザー操作（追加・削除・スキップ）。接続前なら取っておく */
function request(msg: ClientMsg) {
  if (joined) {
    sendRaw(msg);
  } else {
    pending.push(msg);
    renderConnecting(pending.length);
  }
}

function ping() {
  sendRaw({ t: 'ping', clientTime: Date.now() });
}

function connect(roomId: string, name: string) {
  let retry = 0;
  let heartbeatTimer: number | undefined;

  const open = () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${scheme}://${location.host}${proxied(`/ws/${roomId}`)}`);
    ws = sock;

    sock.onopen = () => {
      retry = 0;
      clock.reset();
      sendRaw({ t: 'join', name });
      // 時計のずれは接続直後に数回測るだけにする（短時間ではほとんど変わらないため）。
      // 定期的に測り直すと部屋がずっと起きたままになり、Durable Objects の稼働時間がかさむ
      for (let i = 0; i < 4; i++) setTimeout(ping, i * 300);
      heartbeatTimer = window.setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(HEARTBEAT);
      }, HEARTBEAT_INTERVAL_MS);
    };

    sock.onmessage = (e) => {
      if (e.data === HEARTBEAT) return;
      const msg = JSON.parse(e.data) as ServerMsg;
      switch (msg.t) {
        case 'welcome':
          clock.sample(Date.now(), msg.serverTime);
          engine.setClockOffset(clock.offset);
          renderQueue(msg.queue, msg.history);
          renderMembers(msg.members);
          renderState(msg.state);
          engine.update(msg.state);
          presence?.setMembers(msg.members.length);
          presence?.setState(msg.state);
          joined = true;
          for (const m of pending.splice(0)) sendRaw(m);
          return;
        case 'state':
          renderState(msg.state);
          engine.update(msg.state);
          presence?.setState(msg.state);
          return;
        case 'queue':
          renderQueue(msg.queue, msg.history);
          return;
        case 'members':
          renderMembers(msg.members);
          presence?.setMembers(msg.members.length);
          return;
        case 'error':
          devlog(`server error: ${msg.message}`);
          showError(msg.message);
          return;
        case 'pong':
          clock.sample(msg.clientTime, msg.serverTime);
          engine.setClockOffset(clock.offset);
          return;
      }
    };

    sock.onclose = () => {
      clearInterval(heartbeatTimer);
      if (ws !== sock) return;
      ws = null;
      joined = false;
      renderConnecting(pending.length);
      const delay = Math.min(RECONNECT_MAX_MS, 500 * 2 ** retry++);
      setTimeout(open, delay);
    };
  };

  open();
}

/** 見ている動画を Discord のアクティビティに表示する（ログインできたときだけ） */
let presence: ReturnType<typeof createPresence> | null = null;

/** Discord にログインしてもらい、表示名を取得する */
async function authenticate(sdk: DiscordSDK): Promise<string> {
  const { code } = await sdk.commands.authorize({
    client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    // rpc.activities.write: 見ている動画を Discord のアクティビティ（〇〇を視聴中）に表示するため
    scope: ['identify', 'rpc.activities.write'],
  });
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

/** PiP（チャットを開いて小さく表示されている状態）では動画だけを表示する */
function watchLayout(sdk: DiscordSDK) {
  sdk
    .subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', ({ layout_mode }) => {
      devlog(`layout mode ${layout_mode}`);
      setCompact(layout_mode === Common.LayoutModeTypeObject.PIP);
    })
    .catch((e) => devlog(`layout subscribe failed: ${e instanceof Error ? e.message : JSON.stringify(e)}`));
}

async function main() {
  if (!inDiscord) {
    // 通常のブラウザ: 全タブ共通の部屋で動作確認できるようにする
    connect('local-dev', `ブラウザ${Math.floor(Math.random() * 100)}`);
    return;
  }
  const sdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);
  await sdk.ready();
  let name = 'ゲスト';
  try {
    name = await authenticate(sdk);
    presence = createPresence(sdk, () => Date.now() + clock.offset);
  } catch (e) {
    // 名前が取れなくても視聴はできるようにする
    devlog(`authenticate failed: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  }
  watchLayout(sdk);
  devlog(`ready as ${name} (instance ${sdk.instanceId})`);
  connect(sdk.instanceId, name);
}

main().catch((e) => {
  devlog(`main failed: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  showError(`起動に失敗しました: ${e instanceof Error ? e.message : e}`);
});
