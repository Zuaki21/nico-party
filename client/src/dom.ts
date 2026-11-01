import { externalUrl } from './env';
import { formatCount } from './i18n';

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 切り替えボタン（.seg）のうち、data-<key> が value のボタンを選択中の見た目にする */
export function markSeg(id: string, key: string, value: string) {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>('button')) {
    b.classList.toggle('active', b.dataset[key] === value);
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
export function bodyEl(titleText: string, videoId: string, meta: (string | null | undefined)[]) {
  const body = document.createElement('div');
  body.className = 'q-body';
  const title = document.createElement('div');
  title.className = 'q-title';
  title.textContent = titleText;
  title.title = `${titleText}\n${videoId}`;
  const m = document.createElement('div');
  m.className = 'q-meta';
  m.textContent = meta.filter(Boolean).join('  ·  ');
  body.append(title, m);
  return body;
}

/** 再生数・コメント数（bodyEl の meta に入れる） */
export function countsMeta(views: number | undefined, comments: number | undefined) {
  return [
    views !== undefined ? `▶ ${formatCount(views)}` : null,
    comments !== undefined ? `💬 ${formatCount(comments)}` : null,
  ];
}

function formatTime(sec: number) {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
