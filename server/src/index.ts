import { handleNico, searchVideos } from './nico';
import type { Env } from './room';

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
      const id = env.ROOM.idFromName(match[1]);
      return env.ROOM.get(id).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** Discord SDK の authorize で得た code をアクセストークンに交換する */
async function exchangeToken(request: Request, env: Env): Promise<Response> {
  const { code } = await request.json<{ code?: string }>();
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
  return Response.json({ access_token: data.access_token });
}
