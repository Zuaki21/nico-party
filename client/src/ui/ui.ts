import type { Member, NoticeEvent, PlaybackState, QueueItem, RepeatMode } from '../../../shared/protocol';
import type { SearchResult, SearchSort } from '../../../shared/search';
import { parseVideoId } from '../../../shared/video';
import { APP_VERSION } from '../core/env';
import { $, adderEl, onSeg } from './dom';
import { applyI18n, onLangChange, t } from '../core/i18n';
import { LIST_ICON, NEXT_ICON, PREV_ICON, REPEAT_ICON, SETTINGS_ICON, SHUFFLE_ICON } from './icons';
import { renderPlaylist, setPlayback, setupPlaylist } from './playlist';
import { showNotice } from './notices';
import { setupSearch } from './search';
import { isNoticeEnabled, settingsHtml, setupSettings } from './settings';
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
  /** 不具合調査用のログをサーバーに送る。報告 ID を返す */
  sendLog: (note: string) => Promise<string>;
}

/** スマホなどタッチ操作の端末か */
const touchQuery = window.matchMedia('(pointer: coarse)');

/** mountUi が返す、画面を操作するための関数 */
export interface Ui {
  /** プレイヤー（iframe）を入れる要素 */
  player: HTMLElement;
  /** 指定した言葉で検索する（プレイヤー内のタグのクリックから呼ばれる。再生リスト欄が隠れていれば出す） */
  searchFor: (q: string) => void;
  renderState: (s: PlaybackState) => void;
  renderMembers: (members: Member[]) => void;
  /** 部屋に入れていない間の表示。waiting は接続後に送る操作の数 */
  renderConnecting: (waiting?: number) => void;
  /** 設定画面を閉じる */
  closeSettings: () => void;
  /** 他の人の操作を知らせる（設定でオフなら出さない） */
  showNotice: (by: Member, ev: NoticeEvent) => void;
}

/** 画面の骨組みを作る */
export function mountUi(root: HTMLElement, h: UiHandlers): Ui {
  // 言語を切り替えたときに描き直すため、最後に受け取った再生中の動画とメンバーを覚えておく
  let current: QueueItem | null = null;
  let lastMembers: Member[] | null = null;

  root.innerHTML = `
    <main class="main">
      <div class="player" id="player">
        <div class="empty" id="empty" data-i18n="empty"></div>
        <div class="player-cover" id="player-cover" hidden><div class="spinner" aria-hidden="true"></div></div>
        <div class="notices" id="notices" aria-hidden="true"></div>
      </div>
      <div class="now">
        <div class="now-title" id="now-title"></div>
        <div class="controls">
          <button type="button" id="prev" class="secondary icon-button" data-i18n-label="prev" disabled>${PREV_ICON}</button>
          <button type="button" id="skip" class="secondary icon-button" data-i18n-label="next" disabled>${NEXT_ICON}</button>
        </div>
        <div class="controls">
          <button type="button" id="open-settings" class="secondary icon-button" data-i18n-title="settings" aria-haspopup="dialog" aria-expanded="false" aria-controls="settings">${SETTINGS_ICON}</button>
          <button type="button" id="toggle-side" class="secondary icon-button" data-i18n-label="tabList" aria-expanded="true" aria-controls="side">${LIST_ICON}</button>
        </div>
      </div>
      ${settingsHtml()}
    </main>
    <div class="splitter" id="splitter" role="separator" tabindex="0" aria-controls="side" data-i18n-title="resize" data-i18n-label="resize"></div>
    <aside class="side" id="side">
      <form class="bar" id="form">
        <input type="text" id="url" data-i18n-placeholder="inputPlaceholder" autocomplete="off" />
        <button type="submit" id="submit"></button>
        <div class="error" id="error" role="alert" hidden></div>
      </form>
      <div class="tabs" id="side-tabs" role="tablist">
        <button type="button" role="tab" id="tab-list" data-tab="list" aria-controls="panel-list" data-i18n="tabList"></button>
        <button type="button" role="tab" id="tab-search" data-tab="search" aria-controls="search" data-i18n="tabSearch"></button>
      </div>
      <div class="panel-list" id="panel-list" role="tabpanel" aria-labelledby="tab-list">
        <div class="queue-head">
          <button type="button" id="shuffle" class="mode" aria-pressed="false">${SHUFFLE_ICON}</button>
          <button type="button" id="repeat" class="mode">${REPEAT_ICON}</button>
          <span class="muted members" id="members"></span>
        </div>
        <ol class="queue" id="queue"><li class="muted" data-i18n="connecting"></li></ol>
      </div>
      <div class="search" id="search" role="tabpanel" aria-labelledby="tab-search">
        <div class="search-head">
          <span class="search-title" id="search-title" role="status"></span>
          <div class="seg" id="search-sort" role="group" data-i18n-title="sortTitle" data-i18n-label="sortTitle">
            <button type="button" data-sort="popular" data-i18n="sortPopular"></button>
            <button type="button" data-sort="new" data-i18n="sortNew"></button>
            <button type="button" data-sort="likes" data-i18n="sortLikes"></button>
          </div>
        </div>
        <ol class="queue" id="results" tabindex="-1"></ol>
      </div>
    </aside>
    <!-- 並べ替えの結果など、画面には出さずに読み上げだけする -->
    <div class="sr-only" id="sr-status" role="status"></div>
    <span class="sr-only" id="reorder-hint" data-i18n="dragToReorder"></span>
    <div class="loading" id="loading" role="status">
      <img class="loading-icon" src="/img/icon-256.png" alt="" />
      <div class="spinner" aria-hidden="true"></div>
      <!-- 普段は文字を出さない。接続に時間がかかっているときだけ、slowLoading() で案内を出す -->
      <div id="loading-text"></div>
      <div class="loading-version">ver ${APP_VERSION}</div>
    </div>
  `;
  applyI18n(root);
  // 再生リスト欄の最小幅などが UI サイズで変わるので、保存されている設定を最初に当てておく
  const settings = setupSettings(h);

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
  const searchFor = (q: string) => {
    sidePanel.show();
    input.value = q;
    updateSubmit();
    search.open(q);
  };

  /** 動画の下の「▶ タイトル（追加した人）」と、何も再生していないときの案内 */
  const renderNow = () => {
    $('empty').hidden = !!current;
    const nowTitle = current ? t('nowPlaying', { title: current.title, name: current.addedBy }) : '';
    // 「▶ タイトル」（長ければ省略）の後ろに、追加した人のアイコン
    const label = document.createElement('span');
    label.className = 'now-label';
    label.textContent = current ? t('nowPlayingTitle', { title: current.title }) : '';
    $('now-title').replaceChildren(label, ...(current ? [adderEl(current.addedBy, current.addedByAvatar)] : []));
    // 長くて省略されても、全文を見られるようにする
    $('now-title').title = nowTitle;
  };
  const renderMembers = (members: Member[]) => {
    lastMembers = members;
    $('members').textContent = t('watching', { n: members.length });
    $('members').title = members.map((m) => m.name).join(', ');
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

  return {
    player: $('player'),
    searchFor,
    renderState: (state) => {
      current = state.current;
      renderNow();
      setPlayback(state);
    },
    renderMembers,
    renderConnecting: (waiting = 0) => {
      $('members').textContent = waiting > 0 ? t('connectingPending', { n: waiting }) : t('connecting');
      $('members').title = '';
    },
    closeSettings: settings.close,
    showNotice: (by, ev) => isNoticeEnabled() && showNotice(by, ev),
  };
}

/** 再生リストと検索結果の切り替え。切り替え関数を返す */
function setupTabs() {
  const side = $('side');
  const tabs = [...$('side-tabs').querySelectorAll<HTMLButtonElement>('button')];
  const show = (tab: string) => {
    side.dataset.tab = tab;
    // 選んでいるタブだけが Tab キーで止まる（タブの間は矢印キーで移る）
    for (const b of tabs) {
      const selected = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(selected));
      b.tabIndex = selected ? 0 : -1;
    }
  };
  onSeg('side-tabs', 'tab', show);
  // 矢印キーで隣のタブへ、Home / End で最初・最後のタブへ移る
  $('side-tabs').addEventListener('keydown', (e) => {
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowLeft' ? tabs[(at - 1 + tabs.length) % tabs.length]
      : e.key === 'ArrowRight' ? tabs[(at + 1) % tabs.length]
      : e.key === 'Home' ? tabs[0]
      : e.key === 'End' ? tabs[tabs.length - 1]
      : null;
    if (!next || at < 0) return;
    e.preventDefault();
    next.focus();
    show(next.dataset.tab!);
  });
  show('list');
  return show;
}
