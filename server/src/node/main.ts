import { createServer, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { ROOM_ID, authorizeRoom } from '../wsAuth';
import { VERIFIED_NAME_HEADER, VERIFIED_UID_HEADER } from '../env';
import { loadEnv } from './env';
import { savedRooms, saveRooms } from './persist';
import { RoomHost } from './roomHost';
import { route } from './routes';

const env = loadEnv();
const PORT = Number(process.env.PORT ?? 8787);
const ROOMS_FILE = process.env.ROOMS_FILE ?? './data/rooms.json';
/** サーバーが再起動するときに、接続を閉じるコード（Service Restart。クライアントは繋ぎ直す） */
const CLOSE_RESTART = 1012;
/** 受け付けるメッセージの大きさの上限（正規のメッセージは数百バイト。room.ts にも同じ上限がある） */
const WS_MAX_PAYLOAD = 8192;

const host = new RoomHost(savedRooms(ROOMS_FILE));
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

/**
 * 接続元の IP。Cloudflare Tunnel を通ったものは、cloudflared が CF-Connecting-IP に実際の IP を入れる。
 * 通っていない直接の接続（ローカル開発）は、接続元のアドレスを入れる（ローカルの確認用の判定に使う。wsAuth.ts）
 */
function remoteIp(req: IncomingMessage): string {
  const header = req.headers['cf-connecting-ip'];
  // IPv4 の接続は、::ffff:127.0.0.1 の形で届くことがある
  return ((Array.isArray(header) ? header[0] : header) ?? req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/** Node のリクエストを、Web 標準の Request にする */
function toRequest(req: IncomingMessage, withBody: boolean): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  headers.set('cf-connecting-ip', remoteIp(req));
  const method = req.method ?? 'GET';
  const hasBody = withBody && method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);
}

const server = createServer(async (req, res) => {
  try {
    const response = await route(toRequest(req, true), env);
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
  const reject = (status: number, text: string) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  try {
    const match = new URL(req.url ?? '/', 'http://x').pathname.match(new RegExp(`^/ws/(${ROOM_ID})$`));
    if (!match) return reject(404, 'Not Found');
    const authorized = await authorizeRoom(toRequest(req, false), env, match[1]!);
    if (authorized instanceof Response) return reject(authorized.status, 'Unauthorized');
    const name = authorized.headers.get(VERIFIED_NAME_HEADER);
    const identity = { uid: authorized.headers.get(VERIFIED_UID_HEADER), name: name === null ? null : decodeURIComponent(name) };
    wss.handleUpgrade(req, socket, head, (raw) => {
      host.join(match[1]!, raw, identity).then((ok) => {
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

server.listen(PORT, () => console.log(`nico-party server listening on :${PORT}`));

/** 停止の合図を受けたら、全部屋をファイルに書き出して、接続を閉じて終わる */
let stopping = false;
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
