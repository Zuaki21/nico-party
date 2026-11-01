/**
 * ニコニコ埋め込みプレイヤーを Discord Activity 内で動かすための中継。
 *
 * Activity 内では Discord のプロキシ (/.proxy/...) 以外への通信が CSP でブロックされる。
 * そこで埋め込み HTML・プレイヤー JS・API の JSON・m3u8 を取得し、中の URL を書き換えて返す
 * （書き換えは nicoRewrite.ts、中継する経路の一覧は nicoRoutes.ts）。
 * 動画セグメント本体は Discord のプロキシが直接ニコニコから取得するので、ここは通らない。
 */

import { BodyTooLargeError } from '../body';
import type { Env } from '../env';
import { passSecret, verifyPass, withinRateLimit } from '../pass';
import { DEFAULT_UA } from './nicoApi';
import { rewriter } from './nicoRewrite';
import { matchRoute, type Upstream } from './nicoRoutes';

/** ニコニコへの問い合わせを待つ上限（応答しない相手で、リクエストが溜まり続けないように） */
const UPSTREAM_TIMEOUT_MS = 15_000;

/** 1 人が 1 分間にできる中継の回数（動画 1 本の再生で十数回。先読みや再読み込みを見込んで余裕を持たせる） */
const NICO_LIMIT_PER_MIN = 300;

type NicoRouteEnv = Pick<Env, 'DISCORD_CLIENT_ID' | 'PASS_SECRET'>;

/** 本文を持てない応答のステータス（本文を付けて Response を作ると例外になる） */
const NULL_BODY_STATUS = [101, 204, 205, 304];

/**
 * ニコニコからの応答を、本文だけ書き換えて返す。上流のステータス（404・500 など）はそのまま伝える
 * （伝えないと、エラーの応答がプレイヤーには成功として届いてしまう）
 */
async function relay(res: Response, up: Upstream): Promise<Response> {
  const body = NULL_BODY_STATUS.includes(res.status) ? null : (up.rewrite ?? ((b: string) => b))(await res.text());
  return new Response(body, {
    status: res.status,
    headers: { 'content-type': `${up.type}; charset=utf-8` },
  });
}

/** /nico/* を処理する。path は `/nico` を除いた残り。上流に繋がらない・時間がかかりすぎるときは 502・504 を返す */
export async function handleNico(req: Request, env: NicoRouteEnv, path: string): Promise<Response> {
  try {
    return await route(req, env, path);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return new Response('Payload too large', { status: 413 });
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    if (!timedOut) console.error('nico relay failed', e);
    return new Response(timedOut ? 'Gateway timeout' : 'Bad gateway', { status: timedOut ? 504 : 502 });
  }
}

async function route(req: Request, env: NicoRouteEnv, path: string): Promise<Response> {
  // 中継先の URL に連結するので、パスをたどって別の場所へ行ける文字（.. や %）は受け付けない
  if (!/^[\w\-./]*$/.test(path) || path.split('/').includes('..')) {
    return new Response('Not found', { status: 404 });
  }
  // 先頭の部分が通行証。ログインしていない人・回数が多すぎる人には中継しない
  const passed = path.match(/^\/([\w-]+\.[\w-]+)(\/.*)?$/);
  const claims = passed && (await verifyPass(passSecret(env), 'nico', passed[1]));
  if (!passed || !claims) return new Response('Unauthorized', { status: 401 });
  if (!withinRateLimit(`nico:${claims.u}`, NICO_LIMIT_PER_MIN, 60_000)) {
    return new Response('Too many requests', { status: 429 });
  }
  const matched = matchRoute(req.method, passed[2] ?? '');
  if (!matched) return new Response('Not found', { status: 404 });

  const rewrite = rewriter(`https://${env.DISCORD_CLIENT_ID}.discordsays.com`, passed[1]);
  const up = await matched.route.upstream(matched.m, { req, query: new URL(req.url).search, rewrite });
  // User-Agent が無いとニコニコの CDN に 403 で弾かれるので、視聴者のものを引き継ぐ
  const ua = req.headers.get('user-agent') ?? DEFAULT_UA;
  const res = await fetch(up.url, {
    ...up.init,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'user-agent': ua, ...up.init?.headers },
  });
  return relay(res, up);
}
