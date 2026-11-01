import { handleNico } from './nico/nico';
import { searchVideos } from './nico/nicoApi';
import type { Env } from './env';
import { passSecret, verifyPass, withinRateLimit } from './pass';
import { exchangeToken } from './token';
import { authorizeRoom, ROOM_ID } from './wsAuth';

export { Room } from './room/room';

/** 1 人が 1 分間にできる検索の回数 */
const SEARCH_LIMIT_PER_MIN = 30;

const ROOM_PATH = new RegExp(`^/ws/(${ROOM_ID})$`);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      // 秘密の未登録など。原因をログに残して、素の例外（Cloudflare のエラーページ）にならないようにする
      console.error('request failed', e);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Discord は Activity を ?frame_id=... 付きで開く。それ以外（普通のブラウザ）には案内ページを返す
  if (path === '/') {
    if (url.searchParams.has('frame_id')) return env.ASSETS.fetch(request);
    return env.ASSETS.fetch(new Request(new URL('/landing', url), request));
  }

  if (path.startsWith('/nico/')) {
    return handleNico(request, env, path.slice('/nico'.length));
  }

  if (path === '/api/search' && request.method === 'GET') {
    // 検索は 1 回でニコニコへ多数の問い合わせをするので、ログインした人だけ・回数を制限して受け付ける
    const claims = await verifyPass(passSecret(env), 'nico', request.headers.get('x-nico-pass'));
    if (!claims) return new Response('Unauthorized', { status: 401 });
    if (!withinRateLimit(`search:${claims.u}`, SEARCH_LIMIT_PER_MIN, 60_000)) {
      return new Response('Too many requests', { status: 429 });
    }
    return searchVideos(request, ctx);
  }

  if (path === '/api/token' && request.method === 'POST') {
    return exchangeToken(request, env);
  }

  // 部屋 = Activity の instanceId。同じボイスチャンネルで起動した人は同じ部屋に入る
  const match = path.match(ROOM_PATH);
  if (match) {
    const authorized = await authorizeRoom(request, env, match[1]);
    if (authorized instanceof Response) return authorized;
    return env.ROOM.get(env.ROOM.idFromName(match[1])).fetch(authorized);
  }

  return new Response('Not found', { status: 404 });
}
