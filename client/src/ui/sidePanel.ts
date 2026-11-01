import { $ } from './dom';
import { t } from '../core/i18n';
import { getUiScale } from './settings';
import { load, save } from '../core/storage';

/** 横に広いときは再生リスト欄を右、狭いときは下に置く（styles/responsive.css の media query と揃える） */
const wideQuery = window.matchMedia('(min-width: 900px)');
/**
 * 再生リスト欄の最小の高さ（縦並びのとき。数行見える高さ）。
 * 横並びのときの最小の幅は CSS の min-width（見出しが折り返さない幅）をそのまま読む
 */
const MIN_SIDE_HEIGHT = 120;
/** 再生リスト欄を広げても動画側にこれだけは残す */
const MIN_MAIN = 200;
const HIDDEN_KEY = 'nico-party:side-hidden';
/** 分割線をキーボードで動かすときの 1 回の量 (px)。Shift を押していると大きく動かす */
const KEY_STEP = 24;
const KEY_STEP_LARGE = 96;

/** 再生リスト欄のドラッグでのサイズ変更と表示・非表示 */
export function setupSidePanel(root: HTMLElement): { show: () => void } {
  const side = $('side');
  const splitter = $('splitter');
  const toggle = $('toggle-side');
  // 横並びのときは幅、縦並びのときは高さを別々に覚える
  const sizeKey = () => (wideQuery.matches ? 'nico-party:side-width' : 'nico-party:side-height');
  const minSide = () => (wideQuery.matches ? parseFloat(getComputedStyle(side).minWidth) || 0 : MIN_SIDE_HEIGHT * getUiScale());
  const totalSize = () => (wideQuery.matches ? root.getBoundingClientRect().width : root.getBoundingClientRect().height);
  const currentSize = () => (wideQuery.matches ? side.offsetWidth : side.offsetHeight);
  /** 大きさは CSS 変数で渡す（インラインの flex-basis を直接書くと、CSS 側が !important でしか勝てない） */
  const setSize = (px: number | null) => {
    if (px === null) side.style.removeProperty('--side-size');
    else side.style.setProperty('--side-size', `${px}px`);
    syncAria();
  };
  const clampSize = (px: number) => Math.round(Math.max(minSide(), Math.min(totalSize() - MIN_MAIN, px)));
  /** 分割線の現在値を、支援技術に伝える */
  const syncAria = () => {
    splitter.setAttribute('aria-orientation', wideQuery.matches ? 'vertical' : 'horizontal');
    const min = Math.round(minSide());
    splitter.setAttribute('aria-valuemin', String(min));
    // 狭い画面では、動画側に残す分を引くと最小を下回ることがある
    splitter.setAttribute('aria-valuemax', String(Math.max(min, Math.round(totalSize() - MIN_MAIN))));
    splitter.setAttribute('aria-valuenow', String(currentSize()));
    splitter.setAttribute('aria-valuetext', `${currentSize()}px`);
  };

  const applySize = () => {
    const saved = Number(load(sizeKey()));
    // 以前に今より小さい最小値で保存された大きさは、今の最小値まで広げる
    setSize(saved > 0 ? Math.max(minSide(), saved) : null);
  };

  const setHidden = (hidden: boolean) => {
    root.classList.toggle('side-hidden', hidden);
    // 名前は固定（「再生リスト」）にして、表示中かどうかは aria-expanded で伝える。title には次の操作を出す
    toggle.dataset.i18nTitle = hidden ? 'showList' : 'hideList';
    toggle.title = t(hidden ? 'showList' : 'hideList');
    toggle.setAttribute('aria-expanded', String(!hidden));
    save(HIDDEN_KEY, hidden ? '1' : '');
    syncAria();
  };

  toggle.addEventListener('click', () => setHidden(!root.classList.contains('side-hidden')));
  wideQuery.addEventListener('change', () => {
    applySize();
    syncAria();
  });
  new ResizeObserver(syncAria).observe(root);
  setHidden(load(HIDDEN_KEY) === '1');
  applySize();

  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    // ドラッグ中にポインタが iframe に入るとイベントを取られるので無効にしておく
    root.classList.add('resizing');
    const rect = root.getBoundingClientRect();
    const wide = wideQuery.matches;

    const onMove = (ev: PointerEvent) => {
      const raw = wide ? rect.right - ev.clientX : rect.bottom - ev.clientY;
      setSize(clampSize(raw));
    };
    const onUp = () => {
      root.classList.remove('resizing');
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.removeEventListener('pointercancel', onUp);
      save(sizeKey(), String(parseInt(side.style.getPropertyValue('--side-size')) || ''));
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    splitter.addEventListener('pointercancel', onUp);
  });

  // キーボードでも大きさを変えられる（矢印キーで 24px ずつ、Shift で大きく。縦並びのときは上下、横並びのときは左右。
  // Home で最小、End で最大）
  splitter.addEventListener('keydown', (e) => {
    const wide = wideQuery.matches;
    const grow = wide ? 'ArrowLeft' : 'ArrowUp';
    const shrink = wide ? 'ArrowRight' : 'ArrowDown';
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let size: number;
    if (e.key === grow) size = clampSize(currentSize() + step);
    else if (e.key === shrink) size = clampSize(currentSize() - step);
    else if (e.key === 'Home') size = clampSize(0);
    else if (e.key === 'End') size = clampSize(Infinity);
    else return;
    e.preventDefault();
    setSize(size);
    save(sizeKey(), String(size));
  });

  // ダブルクリック時にブラウザが周りを選択状態にしないようにする
  splitter.addEventListener('mousedown', (e) => e.preventDefault());
  // ダブルクリックで既定の大きさに戻す
  splitter.addEventListener('dblclick', () => {
    setSize(null);
    save(sizeKey(), '');
  });

  return { show: () => setHidden(false) };
}
