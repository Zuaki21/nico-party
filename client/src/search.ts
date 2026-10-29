import { SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE, type SearchItem, type SearchSort } from '../../shared/protocol';
import { $, bodyEl, countsMeta, markSeg, noteEl, onSeg, thumbEl } from './dom';
import { formatDate, getLang, t, unplayableReason } from './i18n';
import type { UiHandlers } from './ui';

type SearchView = 'loading' | 'done' | 'error';

/**
 * キーワード検索。結果は再生リスト欄の場所に切り替えて表示し、「＋」で再生リストに追加する。
 * 検索はニコニコのスナップショット検索 API（1 日 1 回更新）なので、投稿直後の動画は出てこない
 */
export function setupSearch(h: Pick<UiHandlers, 'search' | 'enqueue'>) {
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
  /** 言語を切り替えたときに同じ状態で描き直す */
  let lastView: SearchView = 'done';

  const render = (view: SearchView) => {
    lastView = view;
    $('search-title').textContent =
      view === 'done'
        ? t('searchCount', { q: query, n: total.toLocaleString(getLang() === 'ja' ? 'ja-JP' : 'en-US') })
        : t('searchQuery', { q: query });
    markSeg('search-sort', 'sort', sort);
    const rows: HTMLElement[] = items.map(resultEl);
    if (view === 'loading') rows.push(noteEl(t('searching')));
    else if (view === 'error') rows.push(noteEl(t('searchFailed')));
    else if (items.length === 0) {
      rows.push(noteEl(t('searchNone')));
    } else if (items.length < Math.min(total, SEARCH_MAX_OFFSET + SEARCH_PAGE_SIZE)) {
      // 検索 API はある程度より先の結果を返さないので、そこまでで「もっと見る」を出さない
      const li = document.createElement('li');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'secondary more';
      more.textContent = t('loadMore');
      more.addEventListener('click', () => fetchPage(items.length));
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
  onSeg('search-sort', 'sort', (next) => {
    if ((next === 'popular' || next === 'new') && next !== sort) {
      sort = next;
      fetchPage(0);
    }
  });

  return {
    rerender() {
      if (!$('search').hidden) render(lastView);
    },
    open(q: string) {
      query = q;
      added.clear();
      side.classList.add('searching');
      $('search').hidden = false;
      fetchPage(0);
    },
  };
}
