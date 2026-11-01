/**
 * プレイヤーの中のリンクを、外部のブラウザで開く本当の URL にする。
 * 中継は URL を `<自分のオリジン>/.proxy/external/<ホストの . を -- にしたもの>/...`（Discord の URL Mapping）に
 * 書き換えているので、それを元に戻す。ニコニコ以外のサイトへのリンクは書き換えられていないので、そのまま使う
 */
export function realUrl(href: string, base: string, ownOrigin: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  const m = u.pathname.match(/^\/(?:\.proxy\/)?external\/([^/]+)(\/.*)?$/);
  if (m && u.origin === ownOrigin) {
    u = new URL(`https://${m[1].replaceAll('--', '.')}${m[2] ?? '/'}${u.search}${u.hash}`);
  }
  // 開くのは http(s) だけ（javascript: などは開かない）。Discord が開く前に確認の画面を出す
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return u.href;
}
