import type { Env } from './env';
import { passSecret, verifyPass, type PassClaims } from './pass';
import { withinRateLimit } from './rateLimit';
import type { Identity } from './room/room';

/** 部屋 = Activity の instanceId */
const ROOM_ID = '[A-Za-z0-9_-]{1,128}';
export const ROOM_PATTERN = new RegExp(`^${ROOM_ID}$`);
/** 部屋への WebSocket の経路（/ws/<部屋>） */
export const WS_PATH_PATTERN = new RegExp(`^/ws/(${ROOM_ID})$`);

/** プロキシやトンネルを通ったことを示すヘッダー（cloudflared・ngrok などが付ける。Vite の開発用サーバーの中継は付けない） */
const FORWARDED_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'x-real-ip'];

/**
 * 手元からの直接の接続か（ALLOW_ANON_WS を、誤って本番に設定しても効かないようにする）。
 * 接続元のアドレスが自分自身で、しかもプロキシやトンネルを通った印が無いとき。
 * - トンネル（cloudflared・ngrok など）で公開した開発用サーバーへの外からの接続は、印が付くので当たらない
 * - 本番（Docker）では、cloudflared が別のコンテナから接続するので、接続元が自分自身にならない
 * @param remoteAddress ソケットの接続元のアドレス
 */
export function isLocalPeer(remoteAddress: string | undefined, headers: Record<string, unknown>): boolean {
  // IPv4 の接続は、::ffff:127.0.0.1 の形で届くことがある
  const addr = (remoteAddress ?? '').replace(/^::ffff:/, '');
  return (addr === '127.0.0.1' || addr === '::1') && !FORWARDED_HEADERS.some((h) => headers[h] !== undefined);
}

/**
 * 部屋への WebSocket 接続を、通行証で認可する。Discord でログインした人だけが入れる。
 * 通行証は、入ろうとしている部屋のものでなければならない（別の部屋の通行証の使い回しを防ぐ）。
 * @param local 手元からの直接の接続か（isLocalPeer）。ALLOW_ANON_WS=true なら、通行証なしでも入れる
 * @returns 確かめた身元。認可できなければ null
 */
export async function authorizeRoom(
  pass: string | null,
  env: Pick<Env, 'PASS_SECRET' | 'ALLOW_ANON_WS'>,
  roomId: string,
  local: boolean,
): Promise<Identity | null> {
  const claims = await verifyPass(passSecret(env), 'ws', pass);
  if (claims && claims.r === roomId && claims.n !== undefined) {
    return { uid: claims.u, name: claims.n, avatar: claims.a ?? null };
  }
  if (env.ALLOW_ANON_WS === 'true' && local) return { uid: null, name: null };
  return null;
}

/**
 * 通行証（nico）を確かめ、1 人あたりの回数を数える。
 * 検索と報告は x-nico-pass ヘッダーで、中継は URL の中で通行証を送ってくる
 * @param bucket 回数を数える単位の名前（検索・報告など、用途ごとに別に数える）
 * @returns 通行証の中身。通せなければ 401・429 の Response
 */
export async function requireNicoPass(
  pass: string | null | undefined,
  env: Pick<Env, 'PASS_SECRET'>,
  bucket: string,
  limitPerMin: number,
): Promise<PassClaims | Response> {
  const claims = await verifyPass(passSecret(env), 'nico', pass);
  if (!claims) return new Response('Unauthorized', { status: 401 });
  if (!withinRateLimit(`${bucket}:${claims.u}`, limitPerMin, 60_000)) {
    return new Response('Too many requests', { status: 429 });
  }
  return claims;
}
