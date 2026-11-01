import type { Member, PlaybackState, QueueItem, RepeatMode } from '../../shared/protocol';
import type { SearchResult, SearchSort } from '../../shared/search';
import { parseVideoId } from '../../shared/video';
import { $, markSeg, onSeg } from './dom';
import { applyI18n, onLangChange, t } from './i18n';
import { LIST_ICON, NEXT_ICON, PREV_ICON, REPEAT_ICON, SETTINGS_ICON, SHUFFLE_ICON } from './icons';
import { renderPlaylist, setPlayback, setupPlaylist } from './playlist';
import { setupSearch } from './search';
import { settingsHtml, setupSettings } from './settings';
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
      ${settingsHtml()}
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
  const searchFor = (q: string) => {
    sidePanel.show();
    input.value = q;
    updateSubmit();
    search.open(q);
  };

  /** 動画の下の「▶ タイトル（追加した人）」と、何も再生していないときの案内 */
  const renderNow = () => {
    $('empty').hidden = !!current;
    $('now-title').textContent = current ? t('nowPlaying', { title: current.title, name: current.addedBy }) : '';
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
  };
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
