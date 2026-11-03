/** この画面のバージョン（client/package.json の version をビルド時に埋め込む） */
declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;

/** Discord の Activity として開かれているか（通常のブラウザで開いたときはローカル確認用モード） */
export const inDiscord = new URLSearchParams(location.search).has('frame_id');

/**
 * サーバー（OCI の Node。/api・/ws・/nico）への経路。Discord 内では URL Mapping の `/srv` 経由
 * （`/.proxy/srv/api/token` は、サーバーの `/api/token` に届く）。ローカルでは Vite が同じパスをサーバーに中継する
 */
export const SERVER_PREFIX = inDiscord ? '/.proxy/srv' : '';
export const backend = (path: string) => `${SERVER_PREFIX}${path}`;

/**
 * ニコニコの画像などの URL を Discord 内から読めるようにする。
 * URL Mapping の `/external/<host を -- で連結>` を使う（server/src/nico/nicoRewrite.ts と同じ形式）。
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
