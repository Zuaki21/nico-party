import {
  parseVideoId,
  reorder,
  SEARCH_PAGE_SIZE,
  type Member,
  type PlaybackState,
  type QueueItem,
  type RepeatMode,
  type SearchItem,
  type SearchResult,
  type SearchSort,
} from '../../shared/protocol';
import { externalUrl } from './env';
import {
  applyI18n,
  formatCount,
  formatDate,
  getLang,
  onLangChange,
  setLang,
  t,
  unplayableReason,
  type Lang,
} from './i18n';

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

/** 設定画面の歯車 */
const SETTINGS_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></g></svg>`;

/** 設定画面から開くページ */
const SITE_URL = 'https://nico-party.zuaki.dev';

const PREV_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 5a1 1 0 0 1 1 1v4.9l9.5-5.8A1 1 0 0 1 18 6v12a1 1 0 0 1-1.5.9L7 13.1V18a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Z"/></svg>`;
const NEXT_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 5a1 1 0 0 0-1 1v4.9L7.5 5.1A1 1 0 0 0 6 6v12a1 1 0 0 0 1.5.9l9.5-5.8V18a1 1 0 1 0 2 0V6a1 1 0 0 0-1-1Z"/></svg>`;
/** 再生リストの表示・非表示 */
const LIST_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/></g><g fill="currentColor"><circle cx="4.5" cy="6" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="4.5" cy="18" r="1.5"/></g></svg>`;

const SHUFFLE_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h3.5c2 0 3.2 1 4.3 2.7l2.4 4.6c1.1 1.7 2.3 2.7 4.3 2.7H21M3 18h3.5c1.4 0 2.4-.5 3.2-1.3M14.3 7.3c.8-.8 1.8-1.3 3.2-1.3H21M18 3l3 3-3 3M18 15l3 3-3 3"/></g></svg>`;
const REPEAT_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/></g></svg>`;
const REPEAT_LABEL = { off: 'repeatOff', all: 'repeatAll', one: 'repeatOne' } as const;
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

/** キューの「削除」ボタン（ゴミ箱）。文字色で描く */
const TRASH_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 1.8h7a2 2 0 0 0 2-1.8l1-12M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7"/></g></svg>`;

/** キューの「ここから再生」ボタン。文字色で描く */
const PLAY_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 画面の骨組みを作り、プレイヤーを入れる要素を返す */
export function mountUi(root: HTMLElement, h: UiHandlers): HTMLElement {
  root.innerHTML = `
    <main class="main">
      <div class="player" id="player">
        <div class="empty" id="empty" data-i18n="empty"></div>
      </div>
      <div class="now">
        <div class="now-title" id="now-title"></div>
        <div class="controls">
          <button id="prev" class="secondary icon-button" data-i18n-title="prev" disabled>${PREV_ICON}</button>
          <button id="skip" class="secondary icon-button" data-i18n-title="next" disabled>${NEXT_ICON}</button>
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
      <div class="queue-head">
        <span data-i18n="playlist"></span>
        <button id="shuffle" class="mode" aria-pressed="false"></button>
        <button id="repeat" class="mode" aria-pressed="false"></button>
        <span class="muted members" id="members"></span>
      </div>
      <ol class="queue" id="queue"><li class="muted" data-i18n="connecting"></li></ol>
      <div class="search" id="search" hidden>
        <div class="search-head">
          <button type="button" class="icon" id="search-close" data-i18n-title="searchClose">×</button>
          <span class="search-title" id="search-title"></span>
          <div class="seg" id="search-sort" data-i18n-title="sortTitle">
            <button type="button" data-sort="popular" data-i18n="sortPopular"></button>
            <button type="button" data-sort="new" data-i18n="sortNew"></button>
          </div>
        </div>
        <ol class="queue" id="results"></ol>
      </div>
    </aside>
  `;
  applyI18n(root);

  const search = setupSearch(h);
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
  $('queue').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const remove = target.closest<HTMLElement>('[data-remove]')?.dataset.remove;
    if (remove) h.remove(remove);
    const play = target.closest<HTMLElement>('[data-play]')?.dataset.play;
    if (play) h.jump(play);
  });
  // 項目のダブルクリックでも、そこから再生する（ボタンやつまみの上は除く）
  $('queue').addEventListener('dblclick', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, .handle')) return;
    const li = target.closest<HTMLElement>('li[data-id]');
    if (li && !li.classList.contains('current')) h.jump(li.dataset.id!);
  });
  $('skip').addEventListener('click', () => {
    const id = lists.current?.id;
    if (id) h.skip(id);
  });
  $('shuffle').addEventListener('click', () => h.mode({ shuffle: !lists.shuffle }));
  $('repeat').addEventListener('click', () => h.mode({ repeat: NEXT_REPEAT[lists.repeat] }));
  renderMode();
  $('prev').addEventListener('click', () => {
    const id = lists.current?.id;
    if (id) h.prev(id);
  });
  setupSidePanel(root);
  setupReorder(h.move);
  setupSettings(h);

  // 言語が変わったら、固定の文言を書き換え、あとから描いた部分を描き直す
  onLangChange(() => {
    applyI18n(root);
    updateSubmit();
    if (lastState) renderState(lastState);
    else renderList();
    if (lastMembers) renderMembers(lastMembers);
    search.rerender();
  });

  return $('player');
}

/** スマホなどタッチ操作の端末か */
const touchQuery = window.matchMedia('(pointer: coarse)');

/** 横に広いときはキュー欄を右、狭いときは下に置く（style.css の media query と揃える） */
const wideQuery = window.matchMedia('(min-width: 900px)');
/**
 * キュー欄の最小の大きさ。横並びのときは見出し（再生リスト・シャッフル・リピート・人数）が
 * 折り返さない幅、縦並びのときは数行見える高さ
 */
const MIN_SIDE_WIDTH = 260;
const MIN_SIDE_HEIGHT = 120;
const minSide = () => (wideQuery.matches ? MIN_SIDE_WIDTH : MIN_SIDE_HEIGHT);
/** キュー欄を広げても動画側にこれだけは残す */
const MIN_MAIN = 200;

/** キュー欄のドラッグでのサイズ変更と表示・非表示 */
function setupSidePanel(root: HTMLElement) {
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
    save('nico-party:side-hidden', hidden ? '1' : '');
  };

  toggle.addEventListener('click', () => setHidden(!root.classList.contains('side-hidden')));
  wideQuery.addEventListener('change', applySize);
  setHidden(load('nico-party:side-hidden') === '1');
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

type Theme = 'light' | 'dark';
/** auto: Discord のテーマ（無ければ OS の設定）に合わせる */
type ThemeChoice = 'auto' | Theme;
const THEME_KEY = 'nico-party:theme';
const PRESENCE_KEY = 'nico-party:presence';

/** Discord に視聴中の動画を表示するか（各自の設定。既定はオン） */
export function isPresenceEnabled() {
  return load(PRESENCE_KEY) !== 'off';
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

/** 設定画面（テーマ・言語・Discord への表示・リンク）。設定は各自の画面だけに効き、次回も引き継ぐ */
function setupSettings(h: UiHandlers) {
  const dialog = $('settings');
  const saved = load(THEME_KEY);
  let theme: ThemeChoice = saved === 'light' || saved === 'dark' ? saved : 'auto';
  applyTheme(theme);

  const renderSettings = () => {
    for (const b of $('theme-seg').querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('active', b.dataset.theme === theme);
    }
    for (const b of $('lang-seg').querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('active', b.dataset.lang === getLang());
    }
    $<HTMLInputElement>('presence-toggle').checked = isPresenceEnabled();
  };

  const button = $('open-settings');
  /** 動画の右下（設定ボタンのすぐ上）に吹き出しのように開く。開いている間はボタンをオンの見た目にする */
  const setOpen = (open: boolean) => {
    if (open) renderSettings();
    dialog.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
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

  $('theme-seg').addEventListener('click', (e) => {
    const next = (e.target as HTMLElement).closest<HTMLElement>('[data-theme]')?.dataset.theme;
    if (next !== 'auto' && next !== 'light' && next !== 'dark') return;
    theme = next;
    save(THEME_KEY, next === 'auto' ? '' : next);
    applyTheme(next);
    renderSettings();
  });
  $('lang-seg').addEventListener('click', (e) => {
    const next = (e.target as HTMLElement).closest<HTMLElement>('[data-lang]')?.dataset.lang;
    if (next !== 'ja' && next !== 'en') return;
    setLang(next as Lang);
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

// localStorage はプライベートモード等で使えないことがあるので失敗しても無視する
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // 保存できなくても動作には影響しない
  }
}

/** キュー欄に並べる内容。どれかが変わるたびに全体を描き直す */
const lists = {
  history: [] as QueueItem[],
  current: null as QueueItem | null,
  queue: [] as QueueItem[],
  repeat: 'off' as RepeatMode,
  shuffle: false,
};
let scrolledTo: string | null = null;
/** 言語を切り替えたときに描き直すため、最後に受け取った状態とメンバー */
let lastState: PlaybackState | null = null;
let lastMembers: Member[] | null = null;

export function renderState(s: PlaybackState) {
  lastState = s;
  const cur = s.current;
  $('empty').hidden = !!cur;
  $('now-title').textContent = cur ? t('nowPlaying', { title: cur.title, name: cur.addedBy }) : '';
  lists.current = cur;
  lists.repeat = s.repeat ?? 'off';
  lists.shuffle = s.shuffle ?? false;
  renderMode();
  renderList();
}

/** リピート・シャッフルのボタンの見た目 */
function renderMode() {
  const shuffle = $('shuffle');
  shuffle.innerHTML = SHUFFLE_ICON;
  shuffle.title = t(lists.shuffle ? 'shuffleOn' : 'shuffleOff');
  shuffle.setAttribute('aria-pressed', String(lists.shuffle));
  const repeat = $('repeat');
  repeat.innerHTML = REPEAT_ICON;
  // 1曲リピートはボタンの右上に「1」のバッジを付ける（style.css）
  repeat.dataset.repeat = lists.repeat;
  repeat.title = t(REPEAT_LABEL[lists.repeat]);
  repeat.setAttribute('aria-pressed', String(lists.repeat !== 'off'));
}

export function renderQueue(queue: QueueItem[], history: QueueItem[]) {
  lists.queue = queue;
  lists.history = history;
  renderList();
}

/** 視聴済み → 再生中 → これから再生、の順に並べる */
function renderList() {
  const { history, current, queue } = lists;
  // 前へ・次へは常に表示し、戻る先・進む先が無いときは押せなくする
  $<HTMLButtonElement>('prev').disabled = !current || history.length === 0;
  // 全曲リピート中は、次が無くても最初に戻れる
  $<HTMLButtonElement>('skip').disabled = !current || (queue.length === 0 && lists.repeat !== 'all');
  // 並べ替えのドラッグ中に描き直すと掴んでいる要素が消えるので、終わってから描く
  if (dragging) return;
  const ol = $('queue');
  ol.replaceChildren(
    ...history.map((q) => itemEl(q, 'done')),
    ...(current ? [itemEl(current, 'current')] : []),
    ...queue.map((q) => itemEl(q, 'next')),
  );
  if (ol.childElementCount === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = t('listEmpty');
    ol.append(li);
  }
  // 再生中の動画が変わったら、それが見える位置までスクロールする
  const curId = current?.id ?? null;
  if (curId !== scrolledTo) {
    scrolledTo = curId;
    ol.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }
}

type ItemKind = 'done' | 'current' | 'next';

function itemEl(q: QueueItem, kind: ItemKind) {
  const li = document.createElement('li');
  li.className = kind;
  li.dataset.id = q.id;

  // つまみをドラッグして並べ替えられる（視聴済み・再生中も含めて自由に動かせる）
  const handle = document.createElement('span');
  handle.className = 'handle';
  handle.textContent = '⋮⋮';
  handle.title = t('dragToReorder');

  const thumb = thumbEl(q.thumbnail, q.length);
  if (kind === 'current') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t('playingBadge');
    thumb.append(badge);
  }

  const body = document.createElement('div');
  body.className = 'q-body';
  const title = document.createElement('div');
  title.className = 'q-title';
  title.textContent = q.title;
  title.title = `${q.title}\n${q.videoId}`;
  const meta = document.createElement('div');
  meta.className = 'q-meta';
  meta.textContent = [
    q.author,
    q.views !== undefined ? `▶ ${formatCount(q.views)}` : null,
    q.comments !== undefined ? `💬 ${formatCount(q.comments)}` : null,
    t('addedBy', { name: q.addedBy }),
  ]
    .filter(Boolean)
    .join('  ·  ');
  body.append(title, meta);

  li.append(handle, thumb, body);
  // 再生中の動画は「前へ」「次へ」で操作する
  // 「ここから再生」と「削除」。マウスを乗せたときだけ、動画情報の右端に重ねて出す
  if (kind !== 'current') {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const play = document.createElement('button');
    play.className = 'icon play';
    play.dataset.play = q.id;
    play.title = t('playFromHere');
    play.innerHTML = PLAY_ICON;
    const del = document.createElement('button');
    del.className = 'icon remove';
    del.dataset.remove = q.id;
    del.title = t('removeFromList');
    del.innerHTML = TRASH_ICON;
    actions.append(play, del);
    li.append(actions);
  }
  return li;
}

function formatTime(sec: number) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

let dragging = false;
/** ドラッグ中、リストの端に近づいたら自動でスクロールする範囲 (px) */
const AUTO_SCROLL_EDGE = 32;

/**
 * キューのつまみ (⋮⋮) をドラッグして並べ替える。マウスでもタッチでも動くよう pointer events で実装。
 * 掴んだ項目はポインタに付いて動き、ほかの項目は transform でスライドして場所を空ける。
 * DOM 上の並びは変えず（変えるとポインタの追跡が切れる）、離したときに確定する。
 */
function setupReorder(move: (id: string, index: number) => void) {
  const ol = $('queue');
  const app = ol.closest<HTMLElement>('#app')!;

  ol.addEventListener('pointerdown', (e) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.handle');
    const li = handle?.closest<HTMLLIElement>('li[data-id]');
    if (!handle || !li || e.button !== 0) return;
    e.preventDefault(); // 文字列の選択を始めない
    dragging = true;
    app.classList.add('reordering');
    li.classList.add('dragging');

    const id = li.dataset.id!;
    const items = [...ol.querySelectorAll<HTMLLIElement>('li[data-id]')];
    const from = items.indexOf(li);
    // 位置はスクロールに影響されない offsetTop で持つ
    const tops = items.map((x) => x.offsetTop);
    const heights = items.map((x) => x.offsetHeight);
    // 掴んだ項目が抜けたときに詰める量（項目の高さ + 間隔）
    const gap = items.length > 1 ? Math.abs(tops[1] - tops[0]) : heights[from];
    const startY = e.clientY;
    const startScroll = ol.scrollTop;
    let lastY = e.clientY;
    /** 自分を抜いた後のリストでの差し込み位置 */
    let to = from;

    for (const x of items) if (x !== li) x.style.transition = 'transform 150ms ease';

    const update = (y: number) => {
      lastY = y;
      const dy = y - startY + (ol.scrollTop - startScroll);
      li.style.transform = `translateY(${dy}px)`;
      const center = tops[from] + heights[from] / 2 + dy;
      to = items.filter((x, i) => x !== li && tops[i] + heights[i] / 2 < center).length;
      items.forEach((x, i) => {
        if (x === li) return;
        let shift = 0;
        if (i > from && i - 1 < to) shift = -gap; // 掴んだ項目の後ろにあったものが上へ詰める
        else if (i < from && i >= to) shift = gap; // 前にあったものが下へ空ける
        x.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    // リストの端にポインタを置いている間は自動でスクロールし続ける
    const scrollTimer = window.setInterval(() => {
      const rect = ol.getBoundingClientRect();
      if (lastY < rect.top + AUTO_SCROLL_EDGE) ol.scrollTop -= 8;
      else if (lastY > rect.bottom - AUTO_SCROLL_EDGE) ol.scrollTop += 8;
      else return;
      update(lastY);
    }, 16);

    const onMove = (ev: PointerEvent) => update(ev.clientY);
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      clearInterval(scrollTimer);
      app.classList.remove('reordering');
      dragging = false;
      if (commit && to !== from) {
        // サーバーの返事を待たずに見た目を確定させておく（サーバーと同じ規則で並べ替える）
        const result = reorder(lists.history, lists.current, lists.queue, id, to);
        if (result) {
          lists.history = result.history;
          lists.queue = result.queue;
          move(id, to);
        }
      }
      // 描き直すと transform の付いていない新しい要素になるので、元に戻るアニメーションは出ない
      renderList();
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    // Esc で取り消し
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
  });
}

/** PiP など小さく表示されているときは動画だけを出す */
export function setCompact(compact: boolean) {
  document.getElementById('app')!.classList.toggle('compact', compact);
}

/**
 * キーワード検索。結果はキュー欄の場所に切り替えて表示し、「＋」でキューに追加する。
 * 検索はニコニコのスナップショット検索 API（1 日 1 回更新）なので、投稿直後の動画は出てこない
 */
function setupSearch(h: UiHandlers) {
  const side = $('side');
  const list = $('results');
  let query = '';
  let sort: SearchSort = 'popular';
  let items: SearchItem[] = [];
  let total = 0;
  /** 古い検索の結果が後から届いても無視するための番号 */
  let seq = 0;
  /** この検索中に追加した動画（ボタンを ✓ にする） */
  const added = new Set<string>();

  const note = (text: string) => {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = text;
    return li;
  };

  /** 言語を切り替えたときに同じ状態で描き直す */
  let lastRender: 'loading' | 'done' | 'error' = 'done';

  const render = (state: 'loading' | 'done' | 'error') => {
    lastRender = state;
    $('search-title').textContent =
      state === 'done'
        ? t('searchCount', { q: query, n: total.toLocaleString(getLang() === 'ja' ? 'ja-JP' : 'en-US') })
        : t('searchQuery', { q: query });
    for (const b of $('search-sort').querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('active', b.dataset.sort === sort);
    }
    const rows: HTMLElement[] = items.map(resultEl);
    if (state === 'loading') rows.push(note(t('searching')));
    else if (state === 'error') rows.push(note(t('searchFailed')));
    else if (items.length === 0) {
      rows.push(note(t('searchNone')));
    } else if (items.length < total) {
      const li = document.createElement('li');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'secondary more';
      more.textContent = t('loadMore');
      more.addEventListener('click', () => load(items.length));
      li.append(more);
      rows.push(li);
    }
    list.replaceChildren(...rows);
  };

  const resultEl = (r: SearchItem) => {
    const li = document.createElement('li');
    li.append(
      thumbEl(r.thumbnail, r.length),
      bodyEl(r.title, r.videoId, [
        r.views !== undefined ? `▶ ${formatCount(r.views)}` : null,
        r.comments !== undefined ? `💬 ${formatCount(r.comments)}` : null,
        r.startTime ? formatDate(r.startTime) : null,
      ]),
    );
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add';
    const mark = (done: boolean) => {
      add.textContent = done ? '✓' : '＋';
      add.title = t(done ? 'added' : 'addToList');
      add.disabled = done;
    };
    mark(added.has(r.videoId));
    if (r.unplayable) {
      // 再生できない動画は選べないようにする（サーバーでも追加を断る）
      const reason = unplayableReason(r.unplayable);
      li.classList.add('unplayable');
      li.title = reason;
      add.disabled = true;
      add.textContent = '＋';
      add.title = reason;
      const badge = document.createElement('span');
      badge.className = 'badge unplayable-badge';
      badge.textContent = t('unplayableBadge');
      li.querySelector('.thumb')!.append(badge);
    }
    add.addEventListener('click', () => {
      h.enqueue(r.videoId);
      added.add(r.videoId);
      mark(true);
    });
    li.append(add);
    return li;
  };

  const load = async (offset: number) => {
    const my = ++seq;
    if (offset === 0) {
      items = [];
      list.scrollTop = 0;
    }
    render('loading');
    try {
      const res = await h.search(query, sort, offset);
      if (my !== seq) return;
      total = res.total;
      items = offset === 0 ? res.items : [...items, ...res.items.slice(0, SEARCH_PAGE_SIZE)];
      render('done');
    } catch {
      if (my === seq) render('error');
    }
  };

  $('search-close').addEventListener('click', () => {
    seq++;
    side.classList.remove('searching');
    $('search').hidden = true;
  });
  $('search-sort').addEventListener('click', (e) => {
    const next = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]')?.dataset.sort;
    if ((next === 'popular' || next === 'new') && next !== sort) {
      sort = next;
      load(0);
    }
  });

  return {
    rerender() {
      if (!$('search').hidden) render(lastRender);
    },
    open(q: string) {
      query = q;
      added.clear();
      side.classList.add('searching');
      $('search').hidden = false;
      load(0);
    },
  };
}

function thumbEl(thumbnail: string | undefined, length: number | undefined) {
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

function bodyEl(titleText: string, videoId: string, meta: (string | null | undefined)[]) {
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
