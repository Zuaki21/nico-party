import {
  parseVideoId,
  type Member,
  type PlaybackState,
  type QueueItem,
  type RepeatMode,
  type SearchResult,
  type SearchSort,
} from '../../shared/protocol';
import { $, markSeg, onSeg } from './dom';
import { APP_VERSION } from './env';
import { applyI18n, onLangChange, t } from './i18n';
import { LIST_ICON, NEXT_ICON, PREV_ICON, REPEAT_ICON, SETTINGS_ICON, SHUFFLE_ICON } from './icons';
import { renderPlaylist, setPlayback, setupPlaylist } from './playlist';
import { setupSearch } from './search';
import { setupSettings } from './settings';
import { setupSidePanel } from './sidePanel';

/**
 * 画面の骨組み。各部分の動きは playlist.ts（再生リスト）・search.ts（検索）・settings.ts（設定画面）・
 * sidePanel.ts（再生リスト欄の大きさ）に分けてある
 */

export interface UiHandlers {
  enqueue: (url: string) => void;
  remove: (id: string) => void;
  skip: (itemId: string) => void;
  prev: (itemId: string) => void;
  /** id の動画を、視聴済み + 再生中 + キューを並べたリストの index 番目に移動する */
  move: (id: string, index: number) => void;
  search: (q: string, sort: SearchSort, offset: number) => Promise<SearchResult>;
  /** 視聴済み・キューの中から id の動画を選んで、そこから再生する */
  jump: (id: string) => void;
  /** リピート・シャッフルの切り替え（部屋全員に反映される） */
  mode: (m: { repeat?: RepeatMode; shuffle?: boolean }) => void;
  /** 外部のページを開く（Discord 内では Discord の確認画面を通す） */
  openLink: (url: string) => void;
  /** Discord のアクティビティに視聴中の動画を表示するかの切り替え */
  setPresence: (enabled: boolean) => void;
}

/** 設定画面から開くページ */
const SITE_URL = 'https://nico-party.zuaki.dev';

/** スマホなどタッチ操作の端末か */
const touchQuery = window.matchMedia('(pointer: coarse)');

/** 言語を切り替えたときに描き直すため、最後に受け取った再生中の動画とメンバー */
let current: QueueItem | null = null;
let lastMembers: Member[] | null = null;

/** 指定した言葉で検索する（プレイヤー内のタグのクリックから呼ばれる） */
export function searchFor(q: string) {
  searchByTag?.(q);
}
let searchByTag: ((q: string) => void) | null = null;

/** 画面の骨組みを作り、プレイヤーを入れる要素を返す */
export function mountUi(root: HTMLElement, h: UiHandlers): HTMLElement {
  root.innerHTML = `
    <main class="main">
      <div class="player" id="player">
        <div class="empty" id="empty" data-i18n="empty"></div>
        <div class="player-cover" id="player-cover" hidden><div class="spinner" aria-hidden="true"></div></div>
      </div>
      <div class="now">
        <div class="now-title" id="now-title"></div>
        <div class="controls">
          <button id="prev" class="secondary icon-button" data-i18n-label="prev" disabled>${PREV_ICON}</button>
          <button id="skip" class="secondary icon-button" data-i18n-label="next" disabled>${NEXT_ICON}</button>
        </div>
        <div class="controls">
          <button id="open-settings" class="secondary icon-button" data-i18n-title="settings" aria-pressed="false">${SETTINGS_ICON}</button>
          <button id="toggle-side" class="secondary icon-button">${LIST_ICON}</button>
        </div>
      </div>
      <div class="settings" id="settings" role="dialog" aria-labelledby="settings-title" hidden>
        <div class="settings-head">
          <div>
            <h2 id="settings-title" data-i18n="settingsTitle"></h2>
            <p class="setting-note" data-i18n="settingsNote"></p>
          </div>
          <button type="button" class="icon" id="settings-close" data-i18n-title="close">×</button>
        </div>
        <div class="setting-row">
          <span class="setting-label" data-i18n="theme"></span>
          <div class="seg" id="theme-seg">
            <button type="button" data-theme="auto" data-i18n="themeAuto"></button>
            <button type="button" data-theme="light" data-i18n="themeLight"></button>
            <button type="button" data-theme="dark" data-i18n="themeDark"></button>
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-label" data-i18n="uiSize"></span>
          <div class="seg" id="scale-seg">
            <button type="button" data-scale="0.85" data-i18n="sizeSmall"></button>
            <button type="button" data-scale="1" data-i18n="sizeNormal"></button>
            <button type="button" data-scale="1.15" data-i18n="sizeLarge"></button>
            <button type="button" data-scale="1.3" data-i18n="sizeXLarge"></button>
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-label" data-i18n="language"></span>
          <div class="seg" id="lang-seg">
            <button type="button" data-lang="ja">日本語</button>
            <button type="button" data-lang="en">English</button>
          </div>
        </div>
        <div class="setting-row">
          <span>
            <span class="setting-label" data-i18n="presence"></span>
            <span class="setting-desc" data-i18n="presenceDesc"></span>
          </span>
          <input type="checkbox" class="switch" id="presence-toggle" data-i18n-title="presence" />
        </div>
        <div class="settings-links">
          <span class="version">ver ${APP_VERSION}</span>
          <button type="button" class="link" data-url="${SITE_URL}/" data-i18n="about"></button>
        </div>
      </div>
    </main>
    <div class="splitter" id="splitter" data-i18n-title="resize"></div>
    <aside class="side" id="side">
      <form class="bar" id="form">
        <input type="text" id="url" data-i18n-placeholder="inputPlaceholder" autocomplete="off" />
        <button type="submit" id="submit"></button>
        <div class="error" id="error" role="alert" hidden></div>
      </form>
      <div class="tabs" id="side-tabs" role="tablist">
        <button type="button" role="tab" data-tab="list" data-i18n="tabList"></button>
        <button type="button" role="tab" data-tab="search" data-i18n="tabSearch"></button>
      </div>
      <div class="queue-head">
        <button id="shuffle" class="mode" aria-pressed="false">${SHUFFLE_ICON}</button>
        <button id="repeat" class="mode" aria-pressed="false">${REPEAT_ICON}</button>
        <span class="muted members" id="members"></span>
      </div>
      <ol class="queue" id="queue"><li class="muted" data-i18n="connecting"></li></ol>
      <div class="search" id="search">
        <div class="search-head">
          <span class="search-title" id="search-title"></span>
          <div class="seg" id="search-sort" data-i18n-title="sortTitle">
            <button type="button" data-sort="popular" data-i18n="sortPopular"></button>
            <button type="button" data-sort="new" data-i18n="sortNew"></button>
            <button type="button" data-sort="likes" data-i18n="sortLikes"></button>
          </div>
        </div>
        <ol class="queue" id="results"></ol>
      </div>
    </aside>
    <div class="loading" id="loading" role="status">
      <img class="loading-icon" src="/img/icon-256.png" alt="" />
      <div class="spinner" aria-hidden="true"></div>
      <!-- 普段は文字を出さない。接続に時間がかかっているときだけ、slowLoading() で案内を出す -->
      <div id="loading-text"></div>
    </div>
  `;
  applyI18n(root);
  // 再生リスト欄の最小幅などが UI サイズで変わるので、保存されている設定を最初に当てておく
  setupSettings(h);

  const showTab = setupTabs();
  const search = setupSearch(h, () => showTab('search'));
  const input = $<HTMLInputElement>('url');
  // URL や sm 番号ならそのまま追加、それ以外は検索。ボタンの表示も入力に合わせて変える
  const updateSubmit = () => {
    const text = input.value.trim();
    $('submit').textContent = !text || parseVideoId(text) ? t('add') : t('search');
  };
  updateSubmit();
  input.addEventListener('input', updateSubmit);
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (parseVideoId(text)) {
      h.enqueue(text);
      input.value = '';
      updateSubmit();
    } else {
      search.open(text);
    }
    // スマホでは Enter でキーボードを閉じる（パソコンでは続けて入力できるよう閉じない）
    if (touchQuery.matches) input.blur();
  });
  setupPlaylist(h);
  const sidePanel = setupSidePanel(root);
  // プレイヤー内のタグを押したときは、そのタグで検索する（欄が隠れていれば出す）
  searchByTag = (tag) => {
    sidePanel.show();
    input.value = tag;
    updateSubmit();
    search.open(tag);
  };

  // 言語が変わったら、固定の文言を書き換え、あとから描いた部分を描き直す
  onLangChange(() => {
    applyI18n(root);
    updateSubmit();
    renderNow();
    renderPlaylist();
    if (lastMembers) renderMembers(lastMembers);
    search.rerender();
  });

  return $('player');
}

/** 再生リストと検索結果の切り替え。切り替え関数を返す */
function setupTabs() {
  const side = $('side');
  const show = (tab: string) => {
    side.dataset.tab = tab;
    markSeg('side-tabs', 'tab', tab);
    for (const b of $('side-tabs').querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    }
  };
  onSeg('side-tabs', 'tab', show);
  show('list');
  return show;
}

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

/** 接続に時間がかかっているときの文言に変える */
export function slowLoading() {
  const text = document.getElementById('loading-text');
  if (text) text.textContent = t('loadingSlow');
}

export function renderState(s: PlaybackState) {
  current = s.current;
  renderNow();
  setPlayback(s);
}

/** 動画の下の「▶ タイトル（追加した人）」と、何も再生していないときの案内 */
function renderNow() {
  $('empty').hidden = !!current;
  $('now-title').textContent = current ? t('nowPlaying', { title: current.title, name: current.addedBy }) : '';
}

/** PiP など小さく表示されているときは動画だけを出す */
export function setCompact(compact: boolean) {
  document.getElementById('app')!.classList.toggle('compact', compact);
}

/** 部屋に入れていない間の表示。waiting は接続後に送る操作の数 */
export function renderConnecting(waiting = 0) {
  $('members').textContent = waiting > 0 ? t('connectingPending', { n: waiting }) : t('connecting');
  $('members').title = '';
}

export function renderMembers(members: Member[]) {
  lastMembers = members;
  $('members').textContent = t('watching', { n: members.length });
  $('members').title = members.map((m) => m.name).join(', ');
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
