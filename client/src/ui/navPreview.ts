import type { QueueItem } from '../../../shared/protocol';
import { $ } from './dom';
import { externalUrl } from '../core/env';
import { t } from '../core/i18n';

/** 前へ・次へのボタンに乗せたときに出す内容。item=動画 / text=動画が決まっていないときの説明 */
export type NavPreview = { item: QueueItem } | { text: string } | null;
export type NavKind = 'prev' | 'next';

/** ボタンとカードの間 (px) と、画面の端に残す余白 (px) */
const GAP = 8;
const MARGIN = 8;

/**
 * 前へ・次へのボタンにマウスを乗せたら、移動先の動画のサムネイルとタイトルをボタンの近くに出す。
 * @param source ボタンごとの移動先（再生リストの今の状態から求める）
 * @returns 再生リストが変わったときに、出している内容を更新する関数
 */
export function setupNavPreview(source: (kind: NavKind) => NavPreview): () => void {
  const card = document.createElement('div');
  card.className = 'nav-preview';
  card.hidden = true;
  card.setAttribute('role', 'tooltip');
  document.body.append(card);

  let active: NavKind | null = null;

  const render = () => {
    if (!active) return;
    const button = $(active === 'prev' ? 'prev' : 'skip');
    const preview = (button as HTMLButtonElement).disabled ? null : source(active);
    if (!preview) {
      card.hidden = true;
      return;
    }
    const label = document.createElement('div');
    label.className = 'nav-preview-label';
    label.textContent = t(active === 'prev' ? 'prevVideo' : 'nextVideo');
    const body = document.createElement('div');
    body.className = 'nav-preview-body';
    if ('item' in preview) {
      const thumb = document.createElement('div');
      thumb.className = 'nav-preview-thumb';
      if (preview.item.thumbnail) {
        const img = document.createElement('img');
        img.src = externalUrl(preview.item.thumbnail);
        img.alt = '';
        thumb.append(img);
      }
      const title = document.createElement('div');
      title.className = 'nav-preview-title';
      title.textContent = preview.item.title;
      body.append(thumb, title);
    } else {
      body.textContent = preview.text;
    }
    card.replaceChildren(label, body);
    card.hidden = false;
    place(card, button);
  };

  const hide = () => {
    active = null;
    card.hidden = true;
  };

  for (const kind of ['prev', 'next'] as const) {
    const button = $(kind === 'prev' ? 'prev' : 'skip');
    // マウスを乗せたときだけ（タッチ操作では出さない）。キーボードで選んだときも出す
    button.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      active = kind;
      render();
    });
    button.addEventListener('pointerleave', hide);
    button.addEventListener('focus', () => {
      if (!button.matches(':focus-visible')) return;
      active = kind;
      render();
    });
    button.addEventListener('blur', hide);
    // 押したら移動先が変わるので、いったん閉じる（次に乗せ直したときに最新の内容で出る）
    button.addEventListener('click', hide);
  }

  return render;
}

/** ボタンの上にカードを置く。画面の外にはみ出さないよう、横の位置を調整する */
function place(card: HTMLElement, button: HTMLElement) {
  const b = button.getBoundingClientRect();
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const left = Math.max(MARGIN, Math.min(window.innerWidth - w - MARGIN, b.left + b.width / 2 - w / 2));
  // 上に収まらないときは下に出す
  const above = b.top - GAP - h;
  const top = above >= MARGIN ? above : b.bottom + GAP;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}
