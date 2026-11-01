import { $ } from './dom';
import { t } from '../core/i18n';

/**
 * 最初に部屋に入れるまで、画面全体を覆う表示を出している。入れたら外す。
 * 途中で接続が切れたときは出さない（動画の再生中に覆ってしまうため）
 */
export function hideLoading() {
  // 再接続のたびに呼ばれるので、すでに無いときは何もしない
  document.getElementById('loading')?.remove();
}

/** 途中参加で位置が合うまで、プレイヤーを黒く覆う（最初から再生される映像を見せない） */
export function setPlayerCover(on: boolean) {
  $('player-cover').hidden = !on;
}

/** 起動できなかった。ローディングのままにせず、読めるよう文言を出したままにする（スピナーは止める） */
export function failLoading(message: string) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.add('failed');
  const text = document.getElementById('loading-text');
  if (text) text.textContent = message;
}

/** 接続に時間がかかっているときの文言に変える */
export function slowLoading() {
  const text = document.getElementById('loading-text');
  if (text) text.textContent = t('loadingSlow');
}

/** PiP など小さく表示されているときは動画だけを出す（設定画面は CSS でも出さない） */
export function setCompact(compact: boolean) {
  document.getElementById('app')!.classList.toggle('compact', compact);
}

let errorTimer: number | undefined;
/** エラーを表示しておく時間。下端のバー（style.css の .error::after）もこの時間で縮む */
const ERROR_MS = 3000;

export function showError(message: string) {
  const el = $('error');
  el.textContent = message;
  el.hidden = false;
  el.style.setProperty('--error-ms', `${ERROR_MS}ms`);
  // 続けて表示したときもバーを最初から縮め直す
  el.classList.remove('timing');
  void el.offsetWidth;
  el.classList.add('timing');
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => (el.hidden = true), ERROR_MS);
}
