import { APP_VERSION } from '../core/env';
import { $, markSeg, onSeg } from './dom';
import { getLang, setLang } from '../core/i18n';
import { load, save } from '../core/storage';
import type { UiHandlers } from './ui';

type Theme = 'light' | 'dark';
/** auto: Discord のテーマ（無ければ OS の設定）に合わせる */
type ThemeChoice = 'auto' | Theme;
const THEME_KEY = 'nico-party:theme';
const PRESENCE_KEY = 'nico-party:presence';

/** UI サイズ（画面全体の拡大率）。style.css は rem で書いてあり、--ui-scale で一括で変わる */
const SCALE_KEY = 'nico-party:scale';
const SCALES = [0.85, 1, 1.15, 1.3];
let uiScale = 1;

export function getUiScale() {
  return uiScale;
}

/** Discord に視聴中の動画を表示するか（各自の設定。既定はオン） */
export function isPresenceEnabled() {
  return load(PRESENCE_KEY) !== 'off';
}

function applyScale(scale: number) {
  uiScale = SCALES.includes(scale) ? scale : 1;
  document.documentElement.style.setProperty('--ui-scale', String(uiScale));
}

/** テーマを当てる。auto なら Discord のテーマ（Activity の URL の theme）、無ければ OS の設定に合わせる */
function applyTheme(choice: ThemeChoice) {
  const discord = new URLSearchParams(location.search).get('theme');
  const theme: Theme =
    choice !== 'auto'
      ? choice
      : discord === 'light' || discord === 'dark'
        ? discord
        : window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
  document.documentElement.dataset.theme = theme;
}

/**
 * 設定画面（テーマ・UI サイズ・言語・Discord への表示・リンク）。設定は各自の画面だけに効き、次回も引き継ぐ。
 * 保存されているテーマと UI サイズもここで当てる
 */
export function setupSettings(h: Pick<UiHandlers, 'openLink' | 'setPresence'>) {
  const dialog = $('settings');
  applyScale(Number(load(SCALE_KEY)) || 1);
  const saved = load(THEME_KEY);
  let theme: ThemeChoice = saved === 'light' || saved === 'dark' ? saved : 'auto';
  applyTheme(theme);

  const renderSettings = () => {
    markSeg('theme-seg', 'theme', theme);
    markSeg('scale-seg', 'scale', String(uiScale));
    markSeg('lang-seg', 'lang', getLang());
    $<HTMLInputElement>('presence-toggle').checked = isPresenceEnabled();
  };

  const button = $('open-settings');
  /** 動画の右下（設定ボタンのすぐ上）に吹き出しのように開く。開いている間はボタンをオンの見た目にする */
  const setOpen = (open: boolean) => {
    if (open) renderSettings();
    dialog.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
    // キーボードで操作している人のために、開いたら中へ、閉じたら開いたボタンへフォーカスを移す
    if (open) $('settings-close').focus({ preventScroll: true });
    else if (dialog.contains(document.activeElement)) button.focus({ preventScroll: true });
  };

  button.addEventListener('click', () => setOpen(dialog.hidden));
  $('settings-close').addEventListener('click', () => setOpen(false));
  // 設定画面の外をクリック、または Esc で閉じる
  document.addEventListener('pointerdown', (e) => {
    if (dialog.hidden) return;
    const target = e.target as Node;
    if (!dialog.contains(target) && !button.contains(target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dialog.hidden) setOpen(false);
  });

  onSeg('theme-seg', 'theme', (next) => {
    if (next !== 'auto' && next !== 'light' && next !== 'dark') return;
    theme = next;
    save(THEME_KEY, next === 'auto' ? '' : next);
    applyTheme(next);
    renderSettings();
  });
  onSeg('scale-seg', 'scale', (value) => {
    const next = Number(value);
    if (!SCALES.includes(next)) return;
    applyScale(next);
    save(SCALE_KEY, next === 1 ? '' : String(next));
    renderSettings();
  });
  onSeg('lang-seg', 'lang', (next) => {
    if (next !== 'ja' && next !== 'en') return;
    setLang(next);
    renderSettings();
  });
  $<HTMLInputElement>('presence-toggle').addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    save(PRESENCE_KEY, enabled ? '' : 'off');
    h.setPresence(enabled);
  });
  dialog.querySelector('.settings-links')!.addEventListener('click', (e) => {
    const url = (e.target as HTMLElement).closest<HTMLElement>('[data-url]')?.dataset.url;
    if (url) h.openLink(url);
  });
}

/** 設定画面から開くページ */
const SITE_URL = 'https://nico-party.zuaki.dev';

/** 設定画面の HTML（画面の骨組み ui.ts の中に入れる。中の動きは setupSettings が受け持つ） */
export function settingsHtml(): string {
  return `
  <div class="settings" id="settings" role="dialog" aria-labelledby="settings-title" hidden>
    <div class="settings-head">
      <div>
        <h2 id="settings-title" data-i18n="settingsTitle"></h2>
        <p class="setting-note" data-i18n="settingsNote"></p>
      </div>
      <button type="button" class="icon" id="settings-close" data-i18n-title="close">×</button>
    </div>
    <div class="setting-row">
      <span class="setting-label" id="theme-label" data-i18n="theme"></span>
      <div class="seg" id="theme-seg" role="group" aria-labelledby="theme-label">
        <button type="button" data-theme="auto" data-i18n="themeAuto"></button>
        <button type="button" data-theme="light" data-i18n="themeLight"></button>
        <button type="button" data-theme="dark" data-i18n="themeDark"></button>
      </div>
    </div>
    <div class="setting-row">
      <span class="setting-label" id="scale-label" data-i18n="uiSize"></span>
      <div class="seg" id="scale-seg" role="group" aria-labelledby="scale-label">
        <button type="button" data-scale="0.85" data-i18n="sizeSmall"></button>
        <button type="button" data-scale="1" data-i18n="sizeNormal"></button>
        <button type="button" data-scale="1.15" data-i18n="sizeLarge"></button>
        <button type="button" data-scale="1.3" data-i18n="sizeXLarge"></button>
      </div>
    </div>
    <div class="setting-row">
      <span class="setting-label" id="lang-label" data-i18n="language"></span>
      <div class="seg" id="lang-seg" role="group" aria-labelledby="lang-label">
        <button type="button" data-lang="ja">日本語</button>
        <button type="button" data-lang="en">English</button>
      </div>
    </div>
    <div class="setting-row">
      <span>
        <span class="setting-label" id="presence-label" data-i18n="presence"></span>
        <span class="setting-desc" data-i18n="presenceDesc"></span>
      </span>
      <input type="checkbox" class="switch" id="presence-toggle" aria-labelledby="presence-label" />
    </div>
    <div class="settings-links">
      <span class="version">ver ${APP_VERSION}</span>
      <button type="button" class="link" data-url="${SITE_URL}/" data-i18n="about"></button>
    </div>
  </div>
  `;
}
