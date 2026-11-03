import { externalUrl } from '../core/env';
import { formatCount, formatTime } from '../core/i18n';
import { COMMENT_ICON, VIEWS_ICON } from './icons';

/* 再生リストと検索結果の、1 行の部品 */

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
