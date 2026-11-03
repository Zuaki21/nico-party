import { requireNicoPass } from '../auth';
import { receiveClientLog } from '../clientLog';
import { issueDevToken } from '../devToken';
import type { Env } from '../env';
import { handleNico } from '../nico/nico';
import { searchVideos } from '../nico/nicoApi';
import { exchangeToken } from '../token';

/** 1 人が 1 分間にできる検索の回数 */
const SEARCH_LIMIT_PER_MIN = 30;
/**
 * 検索結果を、受け取った画面が覚えておいてよい時間（サーバーの中でも 10 分覚えている）。
 * 検索には通行証が要るので、共有のキャッシュ（プロキシ）には置かせない
 */
const SEARCH_MAX_AGE_S = 600;

/**
 * HTTP のリクエストを振り分ける（WebSocket は main.ts）
 * @param local 手元からの直接の接続か（auth.ts の isLocalPeer）
 */
export async function route(request: Request, env: Env, local: boolean): Promise<Response> {
  try {
    return await dispatch(request, env, local);
  } catch (e) {
    // 秘密の未登録など。原因をログに残して、素の例外にならないようにする
    console.error('request failed', e);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function dispatch(request: Request, env: Env, local: boolean): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/healthz') return new Response('ok');

  if (path.startsWith('/nico/')) return handleNico(request, env, path.slice('/nico'.length));

  if (path === '/api/search' && request.method === 'GET') {
    // 検索は 1 回でニコニコへ多数の問い合わせをするので、ログインした人だけ・回数を制限して受け付ける
    const claims = await requireNicoPass(request.headers.get('x-nico-pass'), env, 'search', SEARCH_LIMIT_PER_MIN);
    if (claims instanceof Response) return claims;
    const result = await searchVideos(url.searchParams);
    if (!result) return Response.json({ error: 'search failed' }, { status: 502 });
    return new Response(result, {
      headers: { 'content-type': 'application/json', 'cache-control': `private, max-age=${SEARCH_MAX_AGE_S}` },
    });
  }

  if (path === '/api/log' && request.method === 'POST') return receiveClientLog(request, env);

  if (path === '/api/dev-token' && request.method === 'POST') return issueDevToken(request, env, local);

  if (path === '/api/token' && request.method === 'POST') return exchangeToken(request, env);

  return new Response('Not found', { status: 404 });
}
