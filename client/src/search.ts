import { SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE, type SearchItem, type SearchSort } from '../../shared/protocol';
import { $, bodyEl, countsMeta, markSeg, noteEl, onSeg, thumbEl } from './dom';
import { formatDate, getLang, t, unplayableReason } from './i18n';
import type { UiHandlers } from './ui';

type SearchView = 'loading' | 'done' | 'error';

/**
 * キーワード検索。結果は再生リスト欄の場所に切り替えて表示し、「＋」で再生リストに追加する。
 * 検索はニコニコのスナップショット検索 API（1 日 1 回更新）なので、投稿直後の動画は出てこない
 */
export function setupSearch(h: Pick<UiHandlers, 'search' | 'enqueue'>, onOpen: () => void) {
  const list = $('results');
  let query = '';
  let sort: SearchSort = 'popular';
  let items: SearchItem[] = [];
  let total = 0;
  /** 古い検索の結果が後から届いても無視するための番号 */
  let seq = 0;
  /** この検索中に追加した動画（ボタンを ✓ にする） */
  const added = new Set<string>();
  /** 言語を切り替えたときに同じ状態で描き直す */
  let lastView: SearchView = 'done';
  /** 画面に並べ終えた結果の数（「もっと見る」では、これより後ろの分だけを足す） */
  let shown = 0;
  /** 結果の後ろに付けている行（「検索中…」「もっと見る」など。更新のたびに付け替える） */
  let tail: HTMLElement[] = [];

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
    if (rebuild || items.length < shown) {
      list.replaceChildren();
      shown = 0;
      tail = [];
    }
    for (const el of tail) el.remove();
    list.append(...items.slice(shown).map(resultEl));
    shown = items.length;
    const rows: HTMLElement[] = [];
    // 「もっと見る」の取得中は、同じ場所に同じ大きさのボタンを出したままにして、表示が動かないようにする
    if (view === 'loading') rows.push(items.length > 0 ? moreEl(true) : noteEl(t('searching')));
    else if (view === 'error') rows.push(noteEl(t('searchFailed')));
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

  const fetchPage = async (offset: number) => {
    const my = ++seq;
    if (offset === 0) {
      items = [];
      // 最初の検索では案内の文や前の検索の結果を消す
      list.replaceChildren();
      shown = 0;
      tail = [];
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
    list.replaceChildren(noteEl(t('searchHint')));
    shown = 0;
    tail = [];
  };
  showHint();

  return {
    rerender() {
      if (query) render(lastView, true);
      else showHint();
    },
    open(q: string) {
      query = q;
      added.clear();
      onOpen();
      fetchPage(0);
    },
  };
}
