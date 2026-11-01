/** Discord の API の入口。oauth2 と users は版なし、activity-instances だけ /v10（instanceCheck.ts） */
export const DISCORD_API = 'https://discord.com/api';

/** 認可コードをアクセストークンに交換する。失敗したら null */
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<string | null> {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: 'authorization_code',
      code: opts.code,
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  const data = await res?.json<{ access_token?: string }>().catch(() => null);
  return data?.access_token ?? null;
}

export interface DiscordUser {
  id?: string;
  global_name?: string | null;
  username?: string;
}

/** アクセストークンの持ち主を取得する。取れなければ null */
export function fetchMe(accessToken: string): Promise<DiscordUser | null> {
  return fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => (r.ok ? r.json<DiscordUser>() : null))
    .catch(() => null);
}
