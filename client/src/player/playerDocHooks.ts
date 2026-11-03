import { devlog } from '../core/devlog';
import { realUrl } from '../core/urls';

export interface PlayerDocHandlers {
  /** プレイヤーの上に出ているタグがクリックされた */
  onTag: (tag: string) => void;
  /** タグ以外のリンク（「ニコニコ動画で視聴」・タイトルなど）がクリックされた。開く先の本当の URL を渡す */
  onLink: (url: string) => void;
}

/**
 * プレイヤー（iframe）の中のページに、このアプリの動きを足す。
 * - リンクのクリックを、ニコニコのページを開く代わりに自分で受ける（タグは検索、それ以外は外部のブラウザ）
 * - 動画の詳細（説明文）の文字を選択できるようにする
 *
 * 中継経由（/.proxy/srv/nico/...）なら親と同じオリジンなので、中のページに触れる。
 * ニコニコの直接埋め込み（ローカル確認用）は別オリジンで触れないので、何もしない。
 * 動画を読み込み直すたびにページが入れ替わるので、iframe の load のたびにやり直す
 */
export function attachPlayerDocHooks(iframe: HTMLIFrameElement, h: PlayerDocHandlers) {
  iframe.addEventListener('load', () => hook(iframe, h));
}

function hook(iframe: HTMLIFrameElement, h: PlayerDocHandlers) {
  let doc: Document | null = null;
  try {
    doc = iframe.contentDocument;
  } catch {
    devlog('player doc hook: cannot access the player document (cross-origin)');
    return;
  }
  if (!doc) return;
  const baseUri = doc.baseURI;
  const onClick = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a');
    const href = a?.getAttribute('href');
    // ページ内の移動（#）や javascript: は、プレイヤー自身の操作なのでそのまま通す
    if (!a || !href || href.startsWith('#') || href.startsWith('javascript:')) return;
    // どのリンクも、プレイヤーの中でページを移させない（移ると動画が止まる）
    e.preventDefault();
    e.stopPropagation();
    // 左クリックだけを受ける（中クリックなどは、何も開かずに無視する）
    if (e.type !== 'click') return;
    const tag = href.match(/\/tag\/([^/?#]+)/)?.[1];
    if (tag) {
      devlog('tag click');
      let word: string;
      try {
        word = decodeURIComponent(tag);
      } catch {
        return; // 壊れた URL エンコード
      }
      h.onTag(word);
      return;
    }
    const url = realUrl(href, baseUri, location.origin);
    devlog(`link click -> ${url ? new URL(url).hostname : '(ignored)'}`);
    if (url) h.onLink(url);
  };
  allowSelectingDescription(doc);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
  devlog('player doc hook: attached');
}

/**
 * 動画の詳細（説明文）だけ、文字を選択できるようにする。
 * プレイヤーは説明文の要素に user-select: auto を付けているが、外側の要素が none なので、auto が none として働いて選べない。
 * 説明文のクラス名はビルドごとに変わる文字列なので、スタイルシートから user-select: auto を持つ規則を探して、その要素と中身を text にする。
 * 説明文以外（操作バー・再生時間など）はプレイヤーの設定のまま
 */
function allowSelectingDescription(doc: Document) {
  const selectors: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const r = rule as CSSStyleRule;
      if (r.selectorText && r.style?.getPropertyValue('user-select') === 'auto') selectors.push(r.selectorText);
    }
  }
  devlog(`selectable description rules: ${selectors.join(', ') || '(none)'}`);
  if (selectors.length === 0) return;
  const style = doc.createElement('style');
  style.textContent = selectors
    .flatMap((sel) => [sel, `${sel} *`])
    .join(', ') + ' { -webkit-user-select: text !important; -moz-user-select: text !important; user-select: text !important; }';
  (doc.head ?? doc.documentElement).append(style);
}
