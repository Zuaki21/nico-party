import { VERIFIED_NAME_HEADER, VERIFIED_UID_HEADER, type Env } from './env';
import { passSecret, verifyPass } from './pass';

/** 部屋 = Activity の instanceId */
export const ROOM_ID = '[A-Za-z0-9_-]{1,128}';

/**
 * ローカルでの確認用の接続か（ALLOW_ANON_WS を、誤って本番に設定しても効かないようにする）。
 * 接続元の IP が自分自身のとき。本番では Cloudflare Tunnel が実際の接続元の IP で CF-Connecting-IP を上書きするので、外から偽装できない
 * （Tunnel を通らない直接の接続には、node/main.ts が接続元のアドレスを入れる）
 */
function isLocalRequest(request: Request): boolean {
  const ip = request.headers.get('cf-connecting-ip');
  return ip === '127.0.0.1' || ip === '::1';
}

/**
 * 部屋への WebSocket 接続を、通行証で認可する。Discord でログインした人だけが入れる。
 * 通行証は、入ろうとしている部屋のものでなければならない（別の部屋の通行証の使い回しを防ぐ）。
 * 確かめた名前とユーザー ID を、部屋に渡すリクエストのヘッダーに入れる。外から来た同名のヘッダーは信用しない。
 * @returns 部屋に渡すリクエスト。認可できなければ 401 の Response
 */
export async function authorizeRoom(
  request: Request,
  env: Pick<Env, 'PASS_SECRET' | 'ALLOW_ANON_WS'>,
  roomId: string,
): Promise<Request | Response> {
  const headers = new Headers(request.headers);
  headers.delete(VERIFIED_NAME_HEADER);
  headers.delete(VERIFIED_UID_HEADER);
  const pass = new URL(request.url).searchParams.get('pass');
  const claims = await verifyPass(passSecret(env), 'ws', pass);
  if (claims && claims.r === roomId && claims.n !== undefined) {
    headers.set(VERIFIED_NAME_HEADER, encodeURIComponent(claims.n));
    headers.set(VERIFIED_UID_HEADER, claims.u);
  } else if (!(env.ALLOW_ANON_WS === 'true' && isLocalRequest(request))) {
    return new Response('Unauthorized', { status: 401 });
  }
  return new Request(request, { headers });
}
