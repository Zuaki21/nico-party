/**
 * 開発用: Discord 内では DevTools を開きにくいので、ログを Vite の /__log に送って
 * client/dev.log に書き出す。本番ビルドでは何もしない。
 */
export function devlog(text: string) {
  if (!import.meta.env.DEV) return;
  console.log('[nico-party]', text);
  fetch('/__log', {
    method: 'POST',
    body: `${new Date().toLocaleTimeString()} ${text}`,
  }).catch(() => {});
}

/** catch した値をログ用の文字列にする（Discord SDK のエラーは Error ではなくオブジェクトで届く） */
export function describeError(e: unknown) {
  return e instanceof Error ? e.message : JSON.stringify(e);
}

/** ページと埋め込みプレイヤー (同一オリジンで配信している場合) のエラーを拾う */
export function watchErrors(iframe: HTMLIFrameElement) {
  if (!import.meta.env.DEV) return;
  const hook = (w: Window, where: string) => {
    w.addEventListener('error', (e) => devlog(`ERR(${where}) ${e.message}`));
    // script / img などの読み込み失敗はキャプチャフェーズでしか拾えない
    w.addEventListener(
      'error',
      (e) => {
        const el = e.target as HTMLElement & { src?: string; href?: string };
        if (el && el !== (w as unknown)) devlog(`LOADFAIL(${where}) <${el.tagName}> ${el.src ?? el.href}`);
      },
      true,
    );
    w.addEventListener('unhandledrejection', (e) => devlog(`REJ(${where}) ${e.reason}`));
    w.document.addEventListener('securitypolicyviolation', (e) =>
      devlog(`CSP(${where}) ${e.violatedDirective} ${e.blockedURI}`),
    );
  };
  hook(window, 'page');
  iframe.addEventListener('load', () => {
    if (!iframe.src) return;
    devlog(`iframe load ${iframe.src}`);
    try {
      hook(iframe.contentWindow!, 'player');
    } catch {
      // 別オリジン（ローカル確認時の直接埋め込み）
    }
  });
}
