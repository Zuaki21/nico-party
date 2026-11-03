import { externalUrl } from '../core/env';
import { COMMENT_ICON, VIEWS_ICON } from './icons';
import { formatCount, t } from '../core/i18n';

/** id から要素を取る。無ければすぐ分かるよう例外にする（id の付け間違いが、あとで別の場所で壊れる形で出ないように） */
export const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

/** 切り替えボタン（.seg）のうち、data-<key> が value のボタンを選択中の見た目にする */
export function markSeg(id: string, key: string, value: string) {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>('button')) {
    const selected = b.dataset[key] === value;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-pressed', String(selected));
  }
}

/** 切り替えボタン（.seg）が押されたら、そのボタンの data-<key> を渡す */
export function onSeg(id: string, key: string, fn: (value: string) => void) {
  $(id).addEventListener('click', (e) => {
    const value = (e.target as HTMLElement).closest<HTMLElement>(`[data-${key}]`)?.dataset[key];
    if (value !== undefined) fn(value);
  });
}

/** リストの中の、薄い文字の1行（「空です」「検索中…」など） */
export function noteEl(text: string) {
  const li = document.createElement('li');
  li.className = 'muted';
  li.textContent = text;
  return li;
}

/** サムネイル（右下に動画の長さ） */
export function thumbEl(thumbnail: string | undefined, length: number | undefined) {
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (thumbnail) {
    const img = document.createElement('img');
    img.src = externalUrl(thumbnail);
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
  }
  if (length) {
    const len = document.createElement('span');
    len.className = 'len';
    len.textContent = formatTime(length);
    thumb.append(len);
  }
  return thumb;
}

/** タイトルと、その下に「·」区切りで並べる情報（無い項目は飛ばす） */
export function bodyEl(titleText: string, videoId: string, meta: (string | Node | null | undefined)[]) {
  const body = document.createElement('div');
  body.className = 'q-body';
  const title = document.createElement('div');
  title.className = 'q-title';
  title.textContent = titleText;
  title.title = `${titleText}\n${videoId}`;
  const m = document.createElement('div');
  m.className = 'q-meta';
  // 項目の間に「·」を挟む（間隔は CSS の .sep）
  meta.filter((x): x is string | Node => !!x).forEach((x, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      m.append(sep);
    }
    m.append(x);
  });
  body.append(title, m);
  return body;
}

/** 追加した人のアイコン（読み込めなかったら名前の頭文字）。アイコンが無い古い項目は、名前の文字で出す */
export function adderEl(name: string, avatar: string | undefined, iconOnly = false) {
  const el = document.createElement('span');
  el.className = 'adder';
  const label = t('addedByIcon', { name });
  if (!avatar && !iconOnly) {
    el.textContent = t('addedBy', { name });
    return el;
  }
  el.title = label;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', label);
  if (!avatar) {
    // アイコンが無い項目は、サムネイルの上でも誰か分かるよう、名前の頭文字の丸にする
    el.classList.add('fallback');
    el.textContent = Array.from(name)[0] ?? '?';
    return el;
  }
  const img = document.createElement('img');
  img.src = avatar;
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => {
    img.remove();
    el.classList.add('fallback');
    el.textContent = Array.from(name)[0] ?? '?';
  });
  el.append(img);
  return el;
}

/** 再生数・コメント数（bodyEl の meta に入れる） */
export function countsMeta(views: number | undefined, comments: number | undefined) {
  const stat = (icon: string, n: number) => {
    const el = document.createElement('span');
    el.className = 'stat';
    el.innerHTML = icon;
    el.append(formatCount(n));
    return el;
  };
  return [
    views !== undefined ? stat(VIEWS_ICON, views) : null,
    comments !== undefined ? stat(COMMENT_ICON, comments) : null,
  ];
}

export function formatTime(sec: number) {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * 画面には出さず、読み上げだけする（ui.ts が置く sr-status）。
 * 同じ文言が続いても読み上げられるよう、いったん空にしてから入れる
 */
export function announce(message: string) {
  const el = document.getElementById('sr-status');
  if (!el) return;
  el.textContent = '';
  requestAnimationFrame(() => (el.textContent = message));
}
