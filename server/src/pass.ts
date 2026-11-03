/**
 * Discord でログインした人であることを示す「通行証」（HMAC 署名つき）。
 * /api/token でトークンを交換したときに、サーバーが Discord からユーザーの情報を取得して発行する。
 * 署名の鍵には PASS_SECRET を使う（サーバーしか知らない。Discord のクライアントシークレットとは別にしてある）。
 *
 * 用途ごとに scope を分けて、取り違えて使えないようにしている。
 *   ws:   WebSocket の接続に付ける。名前を確かめたものとして部屋に渡す
 *   nico: ニコニコの中継 (/nico/<通行証>/...) と検索の呼び出しに付ける。名前は入れない（URL に載るため）
 */

/** 秘密の未登録など、サーバーの設定の不備（利用者や上流のせいではない）。外側で 500 にする */
export class ConfigError extends Error {}

/** 通行証の署名の鍵。登録されていなければ例外（鍵なしで署名や検証をしない） */
export function passSecret(env: { PASS_SECRET?: string }): string {
  if (!env.PASS_SECRET) throw new ConfigError('PASS_SECRET is not set');
  return env.PASS_SECRET;
}

export type PassScope = 'ws' | 'nico';

export interface PassClaims {
  /** Discord のユーザー ID（レート制限の単位） */
  u: string;
  /** 表示名（ws の通行証のみ） */
  n?: string;
  /** 入れる部屋（Activity の instanceId）。ws の通行証のみ。別の部屋への使い回しを防ぐ */
  r?: string;
}

/** 通行証の有効期間。Activity を開きっぱなしの間は同じものを使い続けるので、長めにしておく */
const PASS_TTL_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const fromBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

/** 中継の 1 回ごとに鍵を作り直さないよう、取り込んだ鍵は覚えておく */
const keys = new Map<string, Promise<import('node:crypto').webcrypto.CryptoKey>>();

function hmacKey(secret: string): Promise<import('node:crypto').webcrypto.CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, key);
  }
  return key;
}

/** 通行証を作る */
export async function issuePass(secret: string, scope: PassScope, claims: PassClaims): Promise<string> {
  const body = { ...claims, s: scope, exp: Date.now() + PASS_TTL_MS };
  const payload = toBase64Url(encoder.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
}

/** 通行証を確かめて中身を返す。無い・壊れている・期限切れ・署名や scope が合わない場合は null */
export async function verifyPass(
  secret: string,
  scope: PassScope,
  pass: string | null | undefined,
): Promise<PassClaims | null> {
  if (!pass) return null;
  const [payload, sig, ...rest] = pass.split('.');
  if (!payload || !sig || rest.length > 0) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64Url(sig),
      encoder.encode(payload),
    );
    if (!ok) return null;
    const body = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Record<string, unknown>;
    if (body.s !== scope || typeof body.exp !== 'number' || body.exp < Date.now()) return null;
    if (typeof body.u !== 'string') return null;
    return {
      u: body.u,
      ...(typeof body.n === 'string' ? { n: body.n } : {}),
      ...(typeof body.r === 'string' ? { r: body.r } : {}),
    };
  } catch {
    return null;
  }
}
