import { DISCORD_API } from './discord';

/** その人が、その Activity インスタンスに参加しているか */
export type Participation = 'member' | 'not_member' | 'unknown';

interface CheckOptions {
  /** ボットトークン（Developer Portal の Bot のページで発行する） */
  botToken: string;
  applicationId: string;
  instanceId: string;
  userId: string;
  /** 参加者の一覧にまだ反映されていないときの、取り直しの回数と間隔 */
  retries?: number;
  delayMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Discord の「Activity インスタンスの情報を取得する」API で、userId がその instanceId の参加者かを確かめる。
 * 部屋の通行証は、クライアントが申告した instanceId に対して発行されるので、
 * 他人の部屋の instanceId を知っていても、参加していなければ通行証を渡さないために使う。
 *
 * 一覧が取れて、その人がいないと分かったときだけ not_member。
 * 取得できなかったとき（通信の失敗・ボットトークンの不備・インスタンスが見つからない・想定外の応答）は unknown で、
 * 呼び出し側は通す（Discord 側の事情で、正規の利用者がログインできなくなるのを避けるため）
 */
export async function checkParticipation(opts: CheckOptions): Promise<Participation> {
  const { botToken, applicationId, instanceId, userId, retries = 2, delayMs = 500, fetchFn = fetch } = opts;
  let result: Participation = 'unknown';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const res = await fetchFn(
        `${DISCORD_API}/v10/applications/${applicationId}/activity-instances/${encodeURIComponent(instanceId)}`,
        { headers: { authorization: `Bot ${botToken}` }, signal: AbortSignal.timeout(5000) },
      );
      if (!res.ok) return 'unknown';
      const body = (await res.json()) as { users?: unknown };
      if (!Array.isArray(body.users)) return 'unknown';
      if (body.users.includes(userId)) return 'member';
      // 参加した直後は、一覧に反映されるまで少しかかるかもしれない。取り直してから判断する
      result = 'not_member';
    } catch {
      return 'unknown';
    }
  }
  return result;
}
