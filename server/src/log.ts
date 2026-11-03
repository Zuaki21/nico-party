/**
 * サーバーのログ。1 行 1 件の JSON を標準出力に出す（Coolify の Logs で見られる）。
 * 秘密（通行証・トークン）や動画の中身は入れない。部屋・メンバーの ID と、起きたことだけ
 * （入室・退出だけは、問い合わせのときに誰のことか分かるよう、表示名も入れる。privacy.html に書いてある）
 */
export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
