import { BodyTooLargeError, readLimited } from './body';
import type { Env } from './env';
import { exchangeCode, fetchMe } from './discord';
import { sha256Hex } from './hash';
import { checkParticipation } from './instanceCheck';
import { ConfigError, issuePass, passSecret } from './pass';
import { withinRateLimit } from './rateLimit';
import { ROOM_ID } from './wsAuth';

const ROOM_PATTERN = new RegExp(`^${ROOM_ID}$`);
/** /api/token の入力の上限（認可コードや部屋 ID は短い文字列。大きな本文は読まずに断る） */
const TOKEN_BODY_MAX = 2048;
const CODE_PATTERN = /^[\w.-]{1,512}$/;
/**
 * /api/token を全体で 1 分間に受け付ける回数。1 回ごとに Discord へ 2 回問い合わせるので、
 * 大量に叩かれて Discord 側の制限に達し、全員のログインが失敗するのを防ぐ
 * （Discord のプロキシ経由だと接続元の IP は全員同じなので、人ごとには分けられない）。
 * 入力の形が正しいものだけを数える（形の悪い呼び出しで、正規のログインの枠を使い切られないように）
 */
const TOKEN_LIMIT_PER_MIN = 120;
/** ボットトークンが無いという警告を、何度も出さないための印 */
let warnedNoBotToken = false;

/** Discord SDK の authorize で得た code をアクセストークンに交換し、通行証を発行する */
export async function exchangeToken(request: Request, env: Env): Promise<Response> {
  // 鍵が未登録なら、Discord に問い合わせる前に失敗させる（無駄な問い合わせと、半端な処理を避ける）
  const secret = passSecret(env);
  if (!env.DISCORD_CLIENT_SECRET) throw new ConfigError('DISCORD_CLIENT_SECRET is not set');
  if (!env.DISCORD_BOT_TOKEN && !warnedNoBotToken) {
    warnedNoBotToken = true;
    console.warn('DISCORD_BOT_TOKEN is not set: skipping the check that the user is in the activity instance');
  }
  let body: { code?: unknown; room?: unknown } = {};
  try {
    body = JSON.parse(await readLimited(request, TOKEN_BODY_MAX));
  } catch (e) {
    if (e instanceof BodyTooLargeError) return Response.json({ error: 'too large' }, { status: 413 });
  }
  const { code, room } = body ?? {};
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    return Response.json({ error: 'code is required' }, { status: 400 });
  }
  if (typeof room !== 'string' || !ROOM_PATTERN.test(room)) {
    return Response.json({ error: 'room is required' }, { status: 400 });
  }
  if (!withinRateLimit('token', TOKEN_LIMIT_PER_MIN, 60_000)) {
    return Response.json({ error: 'too many requests' }, { status: 429 });
  }
  const accessToken = await exchangeCode({
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    code,
  });
  if (!accessToken) return Response.json({ error: 'token exchange failed' }, { status: 400 });
  // 名前はサーバーが Discord から取得する（クライアントの申告は信用しない）
  const me = await fetchMe(accessToken);
  const name = me?.global_name ?? me?.username ?? 'guest';
  // トークンの交換に成功した時点で、ログインはできている。ユーザー情報が取れなくても、通行証は発行する
  // （無いと、部屋に入れず、動画も再生できなくなるため）。ID が取れなければ、トークンから作った識別子で代える
  const uid = me?.id ?? (await sha256Hex(accessToken)).slice(0, 18);
  // 申告された部屋（Activity インスタンス）の参加者でなければ、その部屋の通行証は渡さない。
  // ボットトークンが未登録のとき、ユーザー ID が取れなかったとき、Discord に確かめられなかったときは確かめずに通す
  if (env.DISCORD_BOT_TOKEN && me?.id) {
    const participation = await checkParticipation({
      botToken: env.DISCORD_BOT_TOKEN,
      applicationId: env.DISCORD_CLIENT_ID,
      instanceId: room,
      userId: me.id,
    });
    if (participation === 'not_member') return Response.json({ error: 'not in this activity' }, { status: 403 });
  }
  const [pass, nicoPass] = await Promise.all([
    issuePass(secret, 'ws', { u: uid, n: name, r: room }),
    issuePass(secret, 'nico', { u: uid }),
  ]);
  return Response.json({ access_token: accessToken, pass, nicoPass });
}
