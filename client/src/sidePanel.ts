import { $ } from './dom';
import { t } from './i18n';
import { getUiScale } from './settings';
import { load, save } from './storage';

/** 横に広いときは再生リスト欄を右、狭いときは下に置く（style.css の media query と揃える） */
const wideQuery = window.matchMedia('(min-width: 900px)');
/**
 * 再生リスト欄の最小の大きさ。横並びのときは見出し（再生リスト・シャッフル・リピート・人数）が
 * 折り返さない幅、縦並びのときは数行見える高さ
 */
const MIN_SIDE_WIDTH = 260;
const MIN_SIDE_HEIGHT = 120;
const minSide = () => (wideQuery.matches ? MIN_SIDE_WIDTH : MIN_SIDE_HEIGHT) * getUiScale();
/** 再生リスト欄を広げても動画側にこれだけは残す */
const MIN_MAIN = 200;
const HIDDEN_KEY = 'nico-party:side-hidden';

/** 再生リスト欄のドラッグでのサイズ変更と表示・非表示 */
export function setupSidePanel(root: HTMLElement) {
  const side = $('side');
  const splitter = $('splitter');
  const toggle = $('toggle-side');
  // 横並びのときは幅、縦並びのときは高さを別々に覚える
  const sizeKey = () => (wideQuery.matches ? 'nico-party:side-width' : 'nico-party:side-height');

  const applySize = () => {
    const saved = Number(load(sizeKey()));
    // 以前に今より小さい最小値で保存された大きさは、今の最小値まで広げる
    side.style.flexBasis = saved > 0 ? `${Math.max(minSide(), saved)}px` : '';
  };

  const setHidden = (hidden: boolean) => {
    root.classList.toggle('side-hidden', hidden);
    toggle.dataset.i18nTitle = hidden ? 'showList' : 'hideList';
    toggle.title = t(hidden ? 'showList' : 'hideList');
    toggle.setAttribute('aria-pressed', String(!hidden));
    save(HIDDEN_KEY, hidden ? '1' : '');
  };

  toggle.addEventListener('click', () => setHidden(!root.classList.contains('side-hidden')));
  wideQuery.addEventListener('change', applySize);
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
      const total = wide ? rect.width : rect.height;
      const raw = wide ? rect.right - ev.clientX : rect.bottom - ev.clientY;
      const size = Math.round(Math.max(minSide(), Math.min(total - MIN_MAIN, raw)));
      side.style.flexBasis = `${size}px`;
    };
    const onUp = () => {
      root.classList.remove('resizing');
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      splitter.removeEventListener('pointercancel', onUp);
      save(sizeKey(), String(parseInt(side.style.flexBasis) || ''));
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    splitter.addEventListener('pointercancel', onUp);
  });

  // ダブルクリック時にブラウザが周りを選択状態にしないようにする
  splitter.addEventListener('mousedown', (e) => e.preventDefault());
  // ダブルクリックで既定の大きさに戻す
  splitter.addEventListener('dblclick', () => {
    side.style.flexBasis = '';
    save(sizeKey(), '');
  });
}
