import { receiveClientLog } from '../clientLog';
import type { Env } from '../env';
import { handleNico } from '../nico/nico';
import { searchVideos } from '../nico/nicoApi';
import { passSecret, verifyPass } from '../pass';
import { withinRateLimit } from '../rateLimit';
import { exchangeToken } from '../token';

/** 1 人が 1 分間にできる検索の回数 */
const SEARCH_LIMIT_PER_MIN = 30;

/** HTTP のリクエストを振り分ける（WebSocket は main.ts） */
export async function route(request: Request, env: Env): Promise<Response> {
  try {
    return await dispatch(request, env);
  } catch (e) {
    // 秘密の未登録など。原因をログに残して、素の例外にならないようにする
    console.error('request failed', e);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function dispatch(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === '/healthz') return new Response('ok');

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
    return searchVideos(request);
  }

  if (path === '/api/log' && request.method === 'POST') return receiveClientLog(request, env);

  if (path === '/api/token' && request.method === 'POST') {
    return exchangeToken(request, env);
  }

  return new Response('Not found', { status: 404 });
}
