import { handleNico } from './nico/nico';
import { searchVideos } from './nico/nicoApi';
import { issuePass, sha256Hex, verifyPass, withinRateLimit } from './pass';
import { VERIFIED_NAME_HEADER, VERIFIED_UID_HEADER, type Env } from './env';

export { Room } from './room/room';

/** 1 人が 1 分間にできる検索の回数 */
const SEARCH_LIMIT_PER_MIN = 30;

const ROOM_PATH = /^\/ws\/([A-Za-z0-9_-]{1,128})$/;
/** /api/token の入力の上限（認可コードや部屋 ID は短い文字列。大きな本文は読まずに断る） */
const TOKEN_BODY_MAX = 2048;
const CODE_PATTERN = /^[\w.-]{1,512}$/;
const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      const claims = await verifyPass(env.DISCORD_CLIENT_SECRET, 'nico', request.headers.get('x-nico-pass'));
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
      // Discord でログインした人だけが入れる。通行証は、入ろうとしている部屋のものでなければならない
      // （別の部屋の通行証の使い回しを防ぐ）。確かめた名前を部屋に渡す。外から来た同名のヘッダーは信用しない
      const headers = new Headers(request.headers);
      headers.delete(VERIFIED_NAME_HEADER);
      headers.delete(VERIFIED_UID_HEADER);
      const claims = await verifyPass(env.DISCORD_CLIENT_SECRET, 'ws', url.searchParams.get('pass'));
      if (claims && claims.r === match[1] && claims.n !== undefined) {
        headers.set(VERIFIED_NAME_HEADER, encodeURIComponent(claims.n));
        headers.set(VERIFIED_UID_HEADER, claims.u);
      } else if (env.ALLOW_ANON_WS !== 'true') {
        return new Response('Unauthorized', { status: 401 });
      }
      const id = env.ROOM.idFromName(match[1]);
      return env.ROOM.get(id).fetch(new Request(request, { headers }));
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** Discord SDK の authorize で得た code をアクセストークンに交換し、通行証を発行する */
async function exchangeToken(request: Request, env: Env): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > TOKEN_BODY_MAX) {
    return Response.json({ error: 'too large' }, { status: 413 });
  }
  const body = await request.json<{ code?: unknown; room?: unknown }>().catch(() => ({}) as { code?: unknown; room?: unknown });
  const { code, room } = body;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    return Response.json({ error: 'code is required' }, { status: 400 });
  }
  if (typeof room !== 'string' || !ROOM_PATTERN.test(room)) {
    return Response.json({ error: 'room is required' }, { status: 400 });
  }
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  const data = await res?.json<{ access_token?: string }>().catch(() => ({ access_token: undefined }));
  if (!data?.access_token) return Response.json({ error: 'token exchange failed' }, { status: 400 });
  // 名前はサーバーが Discord から取得する（クライアントの申告は信用しない）
  const me = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `Bearer ${data.access_token}` },
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => (r.ok ? r.json<{ id?: string; global_name?: string | null; username?: string }>() : null))
    .catch(() => null);
  const name = me?.global_name ?? me?.username ?? 'guest';
  // トークンの交換に成功した時点で、ログインはできている。ユーザー情報が取れなくても、通行証は発行する
  // （無いと、部屋に入れず、動画も再生できなくなるため）。ID が取れなければ、トークンから作った識別子で代える
  const uid = me?.id ?? (await sha256Hex(data.access_token)).slice(0, 18);
  const [pass, nicoPass] = await Promise.all([
    issuePass(env.DISCORD_CLIENT_SECRET, 'ws', { u: uid, n: name, r: room }),
    issuePass(env.DISCORD_CLIENT_SECRET, 'nico', { u: uid }),
  ]);
  return Response.json({ access_token: data.access_token, pass, nicoPass });
}
