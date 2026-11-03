import { readLimited } from './body';
import type { Env } from './env';
import { sha256Hex } from './hash';
import { issuePass, passSecret } from './pass';
import { isLocalRequest, ROOM_ID } from './wsAuth';

const ROOM_PATTERN = new RegExp(`^${ROOM_ID}$`);

/**
 * 開発用のログイン。Discord を通さずに、通常のブラウザで開いた画面へ通行証を発行する
 * （検索や不具合の報告など、通行証が要る機能をローカルで試せるように）。
 * ALLOW_ANON_WS=true で、しかも接続元が自分自身（127.0.0.1）のときだけ使える。本番では 404 になる
 */
export async function issueDevToken(request: Request, env: Env): Promise<Response> {
  if (!(env.ALLOW_ANON_WS === 'true' && isLocalRequest(request))) return new Response('Not found', { status: 404 });
  let body: { name?: unknown; room?: unknown } = {};
  try {
    body = JSON.parse(await readLimited(request, 1024));
  } catch {
    // 空でもよい
  }
  const name = typeof body?.name === 'string' && body.name.trim() ? Array.from(body.name.trim()).slice(0, 32).join('') : 'dev';
  const room = typeof body?.room === 'string' && ROOM_PATTERN.test(body.room) ? body.room : 'local-dev';
  // 名前ごとに、別の人として扱う（同じ名前のタブは、同じ人の別の接続になる）
  const uid = `dev-${(await sha256Hex(name)).slice(0, 12)}`;
  const secret = passSecret(env);
  const [pass, nicoPass] = await Promise.all([
    issuePass(secret, 'ws', { u: uid, n: name, r: room }),
    issuePass(secret, 'nico', { u: uid }),
  ]);
  return Response.json({ pass, nicoPass });
}
