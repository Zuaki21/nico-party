import { createServer, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { authorizeRoom, isLocalPeer, WS_PATH_PATTERN } from '../auth';
import { loadEnv } from './env';
import { savedRooms, saveRooms } from './persist';
import { RoomHost } from './roomHost';
import { route } from './routes';

const env = loadEnv();
const PORT = Number(process.env.PORT ?? 8787);
/**
 * 待ち受けるアドレス。手元では自分自身からの接続だけにする（開発用のログインを、同じネットワークの他人に使われないように）。
 * 本番の Docker では、cloudflared のコンテナから届くよう HOST=0.0.0.0 にする（server/Dockerfile）
 */
const HOST = process.env.HOST ?? '127.0.0.1';
const ROOMS_FILE = process.env.ROOMS_FILE ?? './data/rooms.json';
/** サーバーが再起動するときに、接続を閉じるコード（Service Restart。クライアントは繋ぎ直す） */
const CLOSE_RESTART = 1012;
/** 受け付けるメッセージの大きさの上限（正規のメッセージは数百バイト。部屋（room.ts）は、さらに小さい上限で捨てる） */
const WS_MAX_PAYLOAD = 8192;

const host = new RoomHost(savedRooms(ROOMS_FILE));
/** 停止の合図を受けたか */
let stopping = false;
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

/** Node のリクエストを、Web 標準の Request にする */
function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);
}

const server = createServer(async (req, res) => {
  try {
    const response = await route(toRequest(req), env, isLocalPeer(req.socket.remoteAddress, req.headers));
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('response failed', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.on('upgrade', async (req, socket, head) => {
  // upgrade のソケットには、Node がエラーの受け手を付けていない。認可を待つ間などに相手が切ると、
  // 受け手のないエラーでプロセスごと落ちるので、ここで受けて閉じる
  socket.on('error', () => socket.destroy());
  const reject = (status: number, text: string) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  // 停止の途中に来た接続は受けない（部屋を書き出したあとの操作は失われるので、繋ぎ直してもらう）
  if (stopping) return reject(503, 'Service Unavailable');
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const roomId = url.pathname.match(WS_PATH_PATTERN)?.[1];
    if (!roomId) return reject(404, 'Not Found');
    const local = isLocalPeer(req.socket.remoteAddress, req.headers);
    const identity = await authorizeRoom(url.searchParams.get('pass'), env, roomId, local);
    if (!identity) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (raw) => {
      host.join(roomId, raw, identity).then((ok) => {
        if (!ok) raw.close(1013, 'Room is full');
      }, (e) => {
        console.error('join failed', e);
        raw.close(1011, 'error');
      });
    });
  } catch (e) {
    console.error('upgrade failed', e);
    reject(500, 'Internal Server Error');
  }
});

server.listen(PORT, HOST, () => console.log(`nico-party server listening on ${HOST}:${PORT}`));

/** 停止の合図を受けたら、全部屋をファイルに書き出して、接続を閉じて終わる */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: saving rooms`);
  try {
    saveRooms(ROOMS_FILE, await host.exportAll());
    await host.closeAll(CLOSE_RESTART, 'server restarting');
  } catch (e) {
    console.error('shutdown failed', e);
  }
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
