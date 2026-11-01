import { SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE, type SearchItem, type SearchSort } from '../../../shared/search';
import { $, bodyEl, countsMeta, markSeg, noteEl, onSeg, thumbEl } from './dom';
import { formatDate, getLang, t, unplayableReason } from '../core/i18n';
import { TRASH_ICON } from './icons';
import { findAddedItem, isInPlaylist, onPlaylistChange } from './playlistStore';
import type { UiHandlers } from './ui';

type SearchView = 'loading' | 'done' | 'error';

/**
 * キーワード検索。結果は再生リスト欄の場所に切り替えて表示し、「＋」で再生リストに追加する。
 * 検索はニコニコのスナップショット検索 API（1 日 1 回更新）なので、投稿直後の動画は出てこない
 */
export function setupSearch(h: Pick<UiHandlers, 'search' | 'enqueue' | 'remove'>, onOpen: () => void) {
  const list = $('results');
  let query = '';
  let sort: SearchSort = 'popular';
  let items: SearchItem[] = [];
  let total = 0;
  /** 古い検索の結果が後から届いても無視するための番号 */
  let seq = 0;
  /**
   * ボタンの ✓（追加済み）は、再生リストの中にあるかで決める（他の人が消した・追加したときも合う）。
   * ただし、押した直後はサーバーから再生リストが届くまで少し間があるので、その間だけ押した結果を優先する
   */
  const pending = new Map<string, { added: boolean; until: number }>();
  /** 押した結果を優先する時間 (ms) */
  const PENDING_MS = 3000;
  const isAdded = (videoId: string) => {
    const p = pending.get(videoId);
    if (p && Date.now() < p.until) return p.added;
    pending.delete(videoId);
    return isInPlaylist(videoId);
  };
  /** 並んでいる結果の、ボタンの表示を更新する関数（並べ直すたびに作り直す） */
  const refreshers = new Set<() => void>();
  /** 言語を切り替えたときに同じ状態で描き直す */
  let lastView: SearchView = 'done';
  /** 画面に並べ終えた結果の数（「もっと見る」では、これより後ろの分だけを足す） */
  let shown = 0;
  /** 結果の後ろに付けている行（「検索中…」「もっと見る」など。更新のたびに付け替える） */
  let tail: HTMLElement[] = [];

  /** 並んでいる行をすべて消して、最初から並べ直せる状態にする */
  const reset = () => {
    list.replaceChildren();
    shown = 0;
    tail = [];
    refreshers.clear();
  };

  /** 「もっと見る」の行。取得中は同じボタンを押せなくして文言だけ変える */
  const moreEl = (loading: boolean) => {
    const li = document.createElement('li');
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'secondary more';
    more.textContent = t(loading ? 'fetching' : 'loadMore');
    more.disabled = loading;
    more.addEventListener('click', () => fetchPage(items.length));
    li.append(more);
    return li;
  };

  /** @param rebuild true なら、並べ終えた結果も作り直す（言語の切り替え） */
  const render = (view: SearchView, rebuild = false) => {
    lastView = view;
    $('search-title').textContent =
      view === 'done'
        ? t('searchCount', { q: query, n: total.toLocaleString(getLang() === 'ja' ? 'ja-JP' : 'en-US') })
        : t('searchQuery', { q: query });
    markSeg('search-sort', 'sort', sort);
    // 新しい検索になったときや作り直すときだけ全部を並べ直す。それ以外は後ろに足すだけで、スクロール位置も動かさない
    if (rebuild || items.length < shown) reset();
    for (const el of tail) el.remove();
    list.append(...items.slice(shown).map(resultEl));
    shown = items.length;
    const rows: HTMLElement[] = [];
    // 「もっと見る」の取得中は、同じ場所に同じ大きさのボタンを出したままにして、表示が動かないようにする
    if (view === 'loading') rows.push(items.length > 0 ? moreEl(true) : noteEl(t('searching')));
    else if (view === 'error') {
      rows.push(noteEl(t('searchFailed')));
      // 「もっと見る」の取得に失敗したときは、もう一度試せるようにする
      if (items.length > 0) rows.push(moreEl(false));
    }
    else if (items.length === 0) {
      rows.push(noteEl(t('searchNone')));
    } else if (items.length < Math.min(total, SEARCH_MAX_OFFSET + SEARCH_PAGE_SIZE)) {
      // 検索 API はある程度より先の結果を返さないので、そこまでで「もっと見る」を出さない
      rows.push(moreEl(false));
    }
    list.append(...rows);
    tail = rows;
  };

  const resultEl = (r: SearchItem) => {
    const li = document.createElement('li');
    li.append(
      thumbEl(r.thumbnail, r.length),
      bodyEl(r.title, r.videoId, [
        ...countsMeta(r.views, r.comments),
        r.startTime ? formatDate(r.startTime) : null,
      ]),
    );
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add';
    // 追加済みの ✓ を押すと、間違えて追加したものを再生リストから外して元に戻せる
    const mark = (done: boolean) => {
      // 追加済みは ✓、そこにマウスを乗せるとゴミ箱（style.css）。どちらも置いておき、見た目は CSS で切り替える
      add.innerHTML = done ? `<span class="when-idle">✓</span><span class="when-hover">${TRASH_ICON}</span>` : '＋';
      add.title = t(done ? 'removeAdded' : 'addToList');
      // 結果が並ぶので、どの動画への操作かが分かる名前にする（見た目の「＋」「✓」は名前にしない）
      add.setAttribute('aria-label', t(done ? 'removeAddedItem' : 'addItem', { title: r.title }));
      add.classList.toggle('done', done);
    };
    const refresh = () => mark(isAdded(r.videoId));
    refresh();
    if (r.unplayable) {
      // 再生できない動画は選べないようにする（サーバーでも追加を断る）
      const reason = unplayableReason(r.unplayable);
      li.classList.add('unplayable');
      li.title = reason;
      add.disabled = true;
      add.title = reason;
      add.setAttribute('aria-label', t('itemReason', { title: r.title, reason }));
      const badge = document.createElement('span');
      badge.className = 'badge unplayable-badge';
      badge.textContent = t('unplayableBadge');
      li.querySelector('.thumb')!.append(badge);
    }
    add.addEventListener('click', () => {
      if (isAdded(r.videoId)) {
        // 追加してすぐ再生が始まった動画も、そのまま外せる（サーバーが次の動画へ進める）
        const target = findAddedItem(r.videoId);
        if (target) h.remove(target.id);
        pending.set(r.videoId, { added: false, until: Date.now() + PENDING_MS });
      } else {
        h.enqueue(r.videoId);
        pending.set(r.videoId, { added: true, until: Date.now() + PENDING_MS });
      }
      refresh();
    });
    if (!r.unplayable) refreshers.add(refresh);
    li.append(add);
    return li;
  };

  const fetchPage = async (offset: number) => {
    const my = ++seq;
    // 「もっと見る」を押したあとは、取得中にボタンが作り直される。フォーカスは、新しく足された結果に移す
    const refocus = offset > 0 && tail.some((el) => el.contains(document.activeElement));
    const before = items.length;
    if (offset === 0) {
      items = [];
      // 最初の検索では案内の文や前の検索の結果を消す
      reset();
      list.scrollTop = 0;
    }
    render('loading');
    try {
      const res = await h.search(query, sort, offset);
      if (my !== seq) return;
      total = res.total;
      items = offset === 0 ? res.items : [...items, ...res.items.slice(0, SEARCH_PAGE_SIZE)];
      render('done');
      // 取得を待っている間に、利用者が別の場所へ移っていたら、フォーカスは奪わない
      const focusLost = document.activeElement === document.body || list.contains(document.activeElement);
      if (refocus && focusLost) {
        // 足された結果のどれかのボタン。すべて再生できない動画だったら、「もっと見る」か、一覧そのもの
        const target =
          list.children[before]?.querySelector<HTMLElement>('button:not(:disabled)') ?? list.querySelector<HTMLElement>('button.more');
        (target ?? list).focus({ preventScroll: true });
      }
    } catch {
      if (my === seq) {
        render('error');
        // 押した「もっと見る」が消えているので、作り直された再試行ボタンにフォーカスを移す
        const focusLost = document.activeElement === document.body || list.contains(document.activeElement);
        if (refocus && focusLost) list.querySelector<HTMLElement>('button.more')?.focus({ preventScroll: true });
      }
    }
  };

  onSeg('search-sort', 'sort', (next) => {
    if ((next === 'popular' || next === 'new' || next === 'likes') && next !== sort) {
      sort = next;
      fetchPage(0);
    }
  });

  /** まだ検索していないときの案内 */
  const showHint = () => {
    $('search-title').textContent = '';
    markSeg('search-sort', 'sort', sort);
    reset();
    list.append(noteEl(t('searchHint')));
  };
  showHint();

  onPlaylistChange(() => {
    for (const [id, p] of pending) if (isInPlaylist(id) === p.added) pending.delete(id);
    for (const refresh of refreshers) refresh();
  });

  return {
    rerender() {
      if (query) render(lastView, true);
      else showHint();
    },
    open(q: string) {
      query = q;
      pending.clear();
      onOpen();
      fetchPage(0);
    },
  };
}
