import { asRecord, readJson } from './body';
import type { Env } from './env';
import { sha256Hex } from './hash';
import { issuePass, passSecret } from './pass';
import { ROOM_PATTERN } from './auth';

/**
 * 開発用のログイン。Discord を通さずに、通常のブラウザで開いた画面へ通行証を発行する
 * （検索や不具合の報告など、通行証が要る機能をローカルで試せるように）。
 * ALLOW_ANON_WS=true で、しかも手元からの直接の接続（auth.ts の isLocalPeer）のときだけ使える。本番では 404 になる
 */
export async function issueDevToken(request: Request, env: Env, local: boolean): Promise<Response> {
  if (!(env.ALLOW_ANON_WS === 'true' && local)) return new Response('Not found', { status: 404 });
  const json = await readJson(request, 1024);
  if (json instanceof Response) return json;
  const body = asRecord(json.value);
  const name = typeof body.name === 'string' && body.name.trim() ? Array.from(body.name.trim()).slice(0, 32).join('') : 'dev';
  const room = typeof body.room === 'string' && ROOM_PATTERN.test(body.room) ? body.room : 'local-dev';
  // 名前ごとに、別の人として扱う（同じ名前のタブは、同じ人の別の接続になる）
  const uid = `dev-${(await sha256Hex(name)).slice(0, 12)}`;
  const secret = passSecret(env);
  const [pass, nicoPass] = await Promise.all([
    issuePass(secret, 'ws', { u: uid, n: name, r: room }),
    issuePass(secret, 'nico', { u: uid }),
  ]);
  return Response.json({ pass, nicoPass });
}
