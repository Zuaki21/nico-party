/**
 * サーバーのログ。1 行 1 件の JSON を標準出力に出す（Coolify の Logs で見られる）。
 * 秘密（通行証・トークン）や動画の中身は入れない。部屋・メンバーの ID と、起きたことだけ
 */
export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
