/**
 * Discord でログインした人の名前を、サーバーが確かめたものとして部屋に渡すための「通行証」。
 * /api/token でトークンを交換したときにサーバーが Discord から名前を取得して署名し、
 * WebSocket の接続に付けて返してもらう。クライアントが申告する名前は信用しない。
 * 署名の鍵には DISCORD_CLIENT_SECRET を使う（サーバーしか知らない）。
 */

/** 通行証の有効期間。Activity を開いている間は再接続のたびに使うので、長めにしておく */
const PASS_TTL_MS = 12 * 60 * 60 * 1000;

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const fromBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

async function hmacKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** 名前入りの通行証を作る */
export async function issuePass(secret: string, name: string): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ n: name, exp: Date.now() + PASS_TTL_MS })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
}

/** 通行証を確かめて名前を返す。無い・壊れている・期限切れ・署名が合わない場合は null */
export async function verifyPass(secret: string, pass: string | null): Promise<string | null> {
  if (!pass) return null;
  const [payload, sig, ...rest] = pass.split('.');
  if (!payload || !sig || rest.length > 0) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      fromBase64Url(sig),
      encoder.encode(payload),
    );
    if (!ok) return null;
    const { n, exp } = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { n?: unknown; exp?: unknown };
    if (typeof n !== 'string' || typeof exp !== 'number' || exp < Date.now()) return null;
    return n;
  } catch {
    return null;
  }
}
