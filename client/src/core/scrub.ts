/**
 * 通行証（URL やエラーの文に入っていることがある）を伏せる。不具合の報告で、サーバーに送る前にかける
 * （通行証は「英数字の長い列.英数字の長い列」の形。URL の ?pass= の値も伏せる）
 */
export function scrubSecrets(text: string): string {
  return text.replace(/[\w-]{20,}\.[\w-]{20,}/g, '[pass]').replace(/([?&]pass=)[^&\s]+/g, '$1[pass]');
}
