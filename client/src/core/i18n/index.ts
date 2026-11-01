/**
 * 画面の文言（日本語 / 英語）。言語は設定画面で選べ、選んでいなければブラウザの言語で決める。
 * 固定の文言は HTML に data-i18n / data-i18n-title / data-i18n-placeholder を付けて applyI18n で書き換え、
 * あとから描く部分は t() で組み立てて、言語が変わったら描き直す（onLangChange）
 */

import type { ErrorCode } from '../../../../shared/protocol';
import { load, save } from '../storage';
import { en } from './en';
import { ja, type Key } from './ja';

export type Lang = 'ja' | 'en';

const DICT: Record<Lang, Record<Key, string>> = { ja, en };
const LANG_KEY = 'nico-party:lang';

function initialLang(): Lang {
  const saved = load(LANG_KEY);
  if (saved === 'ja' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

let lang: Lang = initialLang();
document.documentElement.lang = lang;
const listeners: (() => void)[] = [];

export function getLang() {
  return lang;
}

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  save(LANG_KEY, next);
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void) {
  listeners.push(fn);
}

/** 文言を取り出す。{name} のような部分は params で置き換える */
export function t(key: Key, params: Record<string, string | number> = {}) {
  return DICT[lang][key].replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
}

/** 再生できない理由（埋め込みページのエラーコード）の説明 */
export function unplayableReason(code: string) {
  if (code === 'sensitive_video') return t('unplayable_sensitive_video');
  if (code === 'externally_unwatchable') return t('unplayable_externally_unwatchable');
  return t('unplayable_other');
}

/** サーバーから届いたエラー（shared/protocol.ts の ErrorCode）を、選んでいる言語の文に組み立てる */
export function serverErrorText(code: ErrorCode, params: Record<string, string> = {}) {
  switch (code) {
    case 'invalid_url':
      return t('err_invalid_url');
    case 'too_fast':
      return t('err_too_fast');
    case 'queue_full':
      return t('err_queue_full');
    case 'not_found':
      return t('err_not_found', { id: params.id });
    case 'unplayable':
      return t('err_unplayable', { title: params.title, reason: unplayableReason(params.reason) });
    case 'not_embeddable':
      return t('err_not_embeddable', { title: params.title });
    default:
      return code;
  }
}

/** data-i18n（文字）/ data-i18n-title / data-i18n-placeholder の付いた要素を今の言語に書き換える */
export function applyI18n(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n as Key);
  }
  // 画面に出すカードで説明するボタン（title だとブラウザの吹き出しと重なるので、読み上げ用の名前だけ付ける）
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel as Key));
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle as Key);
    // アイコンだけのボタンなどは、読み上げの名前にも同じ文言を使う（title だけだと読み上げられないことがある）
    if (!el.textContent?.trim()) el.setAttribute('aria-label', el.title);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder as Key);
  }
}

/** 12345 → 1.2万 / 12.3K のように短く表示する */
export function formatCount(n: number) {
  const short = (v: number, unit: string) => `${v.toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (lang === 'ja') {
    if (n >= 100_000_000) return short(n / 100_000_000, '億');
    if (n >= 10_000) return short(n / 10_000, '万');
    return n.toLocaleString('ja-JP');
  }
  if (n >= 1_000_000) return short(n / 1_000_000, 'M');
  if (n >= 1_000) return short(n / 1_000, 'K');
  return n.toLocaleString('en-US');
}

/** 2024-05-01T12:00:00+09:00 → 2024/5/1 / May 1, 2024 */
export function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return lang === 'ja'
    ? `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
