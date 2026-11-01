/** この画面のバージョン（client/package.json の version をビルド時に埋め込む） */
declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;

/** Discord の Activity として開かれているか（通常のブラウザで開いたときはローカル確認用モード） */
export const inDiscord = new URLSearchParams(location.search).has('frame_id');

/** Discord 内では自分のサーバーへのリクエストも /.proxy 経由にする */
export const proxied = (path: string) => (inDiscord ? `/.proxy${path}` : path);

/**
 * ニコニコの画像などの URL を Discord 内から読めるようにする。
 * URL Mapping の `/external/<host を -- で連結>` を使う（server/src/nico/nico.ts と同じ形式）。
 */
export function externalUrl(url: string): string {
  if (!inDiscord) return url;
  try {
    const u = new URL(url);
    return `/.proxy/external/${u.host.replaceAll('.', '--')}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
