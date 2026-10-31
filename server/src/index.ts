import { handleNico } from './nico';
import { searchVideos } from './nicoApi';
import { issuePass, verifyPass } from './pass';
import { VERIFIED_NAME_HEADER, type Env } from './room';

export { Room } from './room';

const ROOM_PATH = /^\/ws\/([A-Za-z0-9_-]{1,128})$/;

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
      return searchVideos(request, ctx);
    }

    if (path === '/api/token' && request.method === 'POST') {
      return exchangeToken(request, env);
    }

    // 部屋 = Activity の instanceId。同じボイスチャンネルで起動した人は同じ部屋に入る
    const match = path.match(ROOM_PATH);
    if (match) {
      // 通行証があれば、Discord のものとして確かめた名前を部屋に渡す。外から来た同名のヘッダーは信用しない
      const headers = new Headers(request.headers);
      headers.delete(VERIFIED_NAME_HEADER);
      const name = await verifyPass(env.DISCORD_CLIENT_SECRET, url.searchParams.get('pass'));
      if (name !== null) headers.set(VERIFIED_NAME_HEADER, encodeURIComponent(name));
      const id = env.ROOM.idFromName(match[1]);
      return env.ROOM.get(id).fetch(new Request(request, { headers }));
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** Discord SDK の authorize で得た code をアクセストークンに交換する */
async function exchangeToken(request: Request, env: Env): Promise<Response> {
  const { code } = await request.json<{ code?: string }>().catch(() => ({ code: undefined }));
  if (!code) return Response.json({ error: 'code is required' }, { status: 400 });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = await res.json<{ access_token?: string }>();
  if (!data.access_token) return Response.json({ error: 'token exchange failed' }, { status: 400 });
  // 名前はサーバーが Discord から取得する（クライアントの申告は信用しない）。取れなくても視聴はできるよう、通行証なしで返す
  const me = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `Bearer ${data.access_token}` },
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => (r.ok ? r.json<{ global_name?: string | null; username?: string }>() : null))
    .catch(() => null);
  const name = me?.global_name ?? me?.username;
  const pass = name ? await issuePass(env.DISCORD_CLIENT_SECRET, name) : undefined;
  return Response.json({ access_token: data.access_token, pass });
}
