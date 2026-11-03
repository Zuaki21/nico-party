/* 不具合の報告に送る記録（core/devlog.ts）に、入れてはいけないものを入れないための処理 */

/**
 * 通行証（URL やエラーの文に入っていることがある）を伏せる。不具合の報告で、サーバーに送る前にかける
 * （通行証は「英数字の長い列.英数字の長い列」の形。URL の ?pass= の値も伏せる）
 */
export function scrubSecrets(text: string): string {
  return text.replace(/[\w-]{20,}\.[\w-]{20,}/g, '[pass]').replace(/([?&]pass=)[^&\s]+/g, '$1[pass]');
}

/**
 * URL の、どこから来たかだけを残す（記録に、他の人のアイコンの URL などを入れないため）。
 * Discord のプロキシ経由なら、どの経路か（/.proxy/external/<ホスト> など）まで残す。それ以外のパスとクエリは捨てる
 */
export function urlSource(url: string | undefined, base = location.href): string {
  if (!url) return '-';
  try {
    const u = new URL(url, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol;
    const proxied = u.pathname.match(/^\/\.proxy\/(?:external\/[^/]+|[^/]+)/)?.[0] ?? '';
    return `${u.host}${proxied}`;
  } catch {
    return '(invalid url)';
  }
}
