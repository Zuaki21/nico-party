import { APP_VERSION } from './env';

/**
 * 不具合の原因を集めるためのログ。直近の出来事を画面の中に貯めておき（本番でも）、
 * 設定画面の「不具合を報告」で、サーバーに送れる。開発中は、さらに Vite の /__log に送って
 * client/dev.log に書き出す（Discord 内では DevTools を開きにくいため）。
 * 動画のタイトルや URL などの内容は入れない（ID と状態だけ）
 */
const MAX_LINES = 400;
const lines: string[] = [];

/** 通行証（URL に入っていることがある）は、ログに残さない */
const scrub = (text: string) => text.replace(/[\w-]{20,}\.[\w-]{20,}/g, '[pass]').replace(/([?&]pass=)[^&\s]+/g, '$1[pass]');

export function devlog(raw: string) {
  const text = scrub(raw);
  const line = `${new Date().toISOString().slice(11, 23)} ${text}`.slice(0, 500);
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  if (!import.meta.env.DEV) return;
  console.log('[nico-party]', text);
  fetch('/__log', {
    method: 'POST',
    body: `${new Date().toLocaleTimeString()} ${text}`,
  }).catch(() => {});
}

/**
 * この環境で再生できる形式（ニコニコの動画は H.264 + AAC。Linux 版の Discord などで足りないことがある）。
 * MSE（hls.js が使う）と、video 要素で直接再生できるか
 */
const CODECS = ['video/mp4; codecs="avc1.4d401f"', 'video/mp4; codecs="avc1.640028"', 'audio/mp4; codecs="mp4a.40.2"'];
function codecSupport(): string[] {
  const video = document.createElement('video');
  return CODECS.map((type) => {
    let mse = 'n/a';
    try {
      mse = typeof MediaSource !== 'undefined' ? String(MediaSource.isTypeSupported(type)) : 'no MediaSource';
    } catch {
      // 調べられない環境
    }
    return `codec ${type} mse=${mse} canPlay=${video.canPlayType(type) || 'no'}`;
  });
}

/** 送るログ全体（環境の情報＋貯めた行） */
export function collectLog(): string {
  const env = [
    `version ${APP_VERSION}`,
    `ua ${navigator.userAgent}`,
    `lang ${navigator.language}`,
    `screen ${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    `online ${navigator.onLine}`,
    ...codecSupport(),
    `at ${new Date().toISOString()}`,
  ];
  return [...env, '---', ...lines].join('\n');
}

/** catch した値をログ用の文字列にする（Discord SDK のエラーは Error ではなくオブジェクトで届く） */
export function describeError(e: unknown) {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** ページと埋め込みプレイヤー (同一オリジンで配信している場合) のエラーを拾う */
export function watchErrors(iframe: HTMLIFrameElement) {
  const hook = (w: Window, where: string) => {
    w.addEventListener('error', (e) => devlog(`ERR(${where}) ${e.message}`));
    // script / img などの読み込み失敗はキャプチャフェーズでしか拾えない
    w.addEventListener(
      'error',
      (e) => {
        const el = e.target as HTMLElement & { src?: string; href?: string };
        if (!el || el === (w as unknown)) return;
        // 動画・音声は、なぜ再生できなかったか（MediaError の code と message）も残す
        const media = el as Partial<HTMLMediaElement>;
        const why = media.error ? ` error=${media.error.code} ${media.error.message}` : '';
        devlog(`LOADFAIL(${where}) <${el.tagName}> ${el.src ?? el.href}${why}`);
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
