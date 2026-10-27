import {
  parseVideoId,
  reorder,
  SEARCH_PAGE_SIZE,
  type Member,
  type PlaybackState,
  type QueueItem,
  type SearchItem,
  type SearchResult,
  type SearchSort,
} from '../../shared/protocol';
import { externalUrl } from './env';

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
}

/** キューの「ここから再生」ボタン。文字色で描く */
const PLAY_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 画面の骨組みを作り、プレイヤーを入れる要素を返す */
export function mountUi(root: HTMLElement, h: UiHandlers): HTMLElement {
  root.innerHTML = `
    <main class="main">
      <div class="player" id="player">
        <div class="empty" id="empty">キュー欄に動画のURLを入れるか、キーワードで検索してください</div>
      </div>
      <div class="now">
        <div class="now-title" id="now-title"></div>
        <button id="prev" class="secondary" title="前の動画に戻る" hidden>⏮ 前へ</button>
        <button id="skip" class="secondary" title="次の動画へ" hidden>次へ ⏭</button>
        <button id="toggle-side" class="secondary"></button>
        <button id="toggle-theme" class="secondary"></button>
      </div>
    </main>
    <div class="splitter" id="splitter" title="ドラッグで大きさを変更"></div>
    <aside class="side" id="side">
      <form class="bar" id="form">
        <input type="text" id="url" placeholder="URL・sm番号 または キーワードで検索" autocomplete="off" />
        <button type="submit" id="submit">追加</button>
      </form>
      <div class="error" id="error" hidden></div>
      <div class="queue-head">
        <span>キュー</span>
        <span class="muted" id="members"></span>
      </div>
      <ol class="queue" id="queue"><li class="muted">接続中…</li></ol>
      <div class="search" id="search" hidden>
        <div class="search-head">
          <span class="search-title" id="search-title"></span>
          <div class="seg" id="search-sort">
            <button type="button" data-sort="popular">人気順</button>
            <button type="button" data-sort="new">新着順</button>
          </div>
          <button type="button" class="icon" id="search-close" title="検索を閉じてキューに戻る">×</button>
        </div>
        <ol class="queue" id="results"></ol>
      </div>
    </aside>
  `;

  const search = setupSearch(h);
  const input = $<HTMLInputElement>('url');
  // URL や sm 番号ならそのまま追加、それ以外は検索。ボタンの表示も入力に合わせて変える
  const updateSubmit = () => {
    const text = input.value.trim();
    $('submit').textContent = !text || parseVideoId(text) ? '追加' : '検索';
  };
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
  $('prev').addEventListener('click', () => {
    const id = lists.current?.id;
    if (id) h.prev(id);
  });
  setupSidePanel(root);
  setupReorder(h.move);
  setupTheme();

  return $('player');
}

/** 横に広いときはキュー欄を右、狭いときは下に置く（style.css の media query と揃える） */
const wideQuery = window.matchMedia('(min-width: 900px)');
const MIN_SIDE = 120;
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
    side.style.flexBasis = saved > 0 ? `${saved}px` : '';
  };

  const setHidden = (hidden: boolean) => {
    root.classList.toggle('side-hidden', hidden);
    toggle.textContent = hidden ? 'キューを表示' : 'キューを隠す';
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
      const size = Math.round(Math.max(MIN_SIDE, Math.min(total - MIN_MAIN, raw)));
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

  // ダブルクリックで既定の大きさに戻す
  splitter.addEventListener('dblclick', () => {
    side.style.flexBasis = '';
    save(sizeKey(), '');
  });
}

type Theme = 'light' | 'dark';

// 絵文字は環境によってカラー表示になるので、文字色で描く SVG にする
const SUN_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>`;
const MOON_ICON = `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.5 14.6A8.5 8.5 0 0 1 9.4 3.5a8.5 8.5 0 1 0 11.1 11.1Z"/></svg>`;
const THEME_KEY = 'nico-party:theme';

/**
 * ライト / ダークの切り替え。手動で選んだものを優先し、無ければ Discord のテーマ
 * （Activity の URL に theme=light などが付く）、それも無ければ OS の設定に合わせる
 */
function setupTheme() {
  const button = $('toggle-theme');
  const discord = new URLSearchParams(location.search).get('theme');
  const saved = load(THEME_KEY);
  const initial: Theme =
    saved === 'light' || saved === 'dark'
      ? saved
      : discord === 'light' || discord === 'dark'
        ? discord
        : window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';

  const apply = (theme: Theme) => {
    document.documentElement.dataset.theme = theme;
    // 押すと切り替わる先を表示する
    button.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON;
    button.title = theme === 'dark' ? 'ライトモードにする' : 'ダークモードにする';
  };

  apply(initial);
  button.addEventListener('click', () => {
    const next: Theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    save(THEME_KEY, next);
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
};
let scrolledTo: string | null = null;

export function renderState(s: PlaybackState) {
  const cur = s.current;
  $('empty').hidden = !!cur;
  $('now-title').textContent = cur ? `▶ ${cur.title}（${cur.addedBy}）` : '';
  $('skip').hidden = !cur;
  $('prev').hidden = !cur;
  lists.current = cur;
  renderList();
}

export function renderQueue(queue: QueueItem[], history: QueueItem[]) {
  lists.queue = queue;
  lists.history = history;
  renderList();
}

/** 視聴済み → 再生中 → これから再生、の順に並べる */
function renderList() {
  // 並べ替えのドラッグ中に描き直すと掴んでいる要素が消えるので、終わってから描く
  if (dragging) return;
  const { history, current, queue } = lists;
  const ol = $('queue');
  ol.replaceChildren(
    ...history.map((q) => itemEl(q, 'done')),
    ...(current ? [itemEl(current, 'current')] : []),
    ...queue.map((q) => itemEl(q, 'next')),
  );
  if (ol.childElementCount === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '（空です）';
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
  handle.title = 'ドラッグで並べ替え';

  const thumb = thumbEl(q.thumbnail, q.length);
  if (kind === 'current') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '▶ 再生中';
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
    `追加: ${q.addedBy}`,
  ]
    .filter(Boolean)
    .join('  ·  ');
  body.append(title, meta);

  li.append(handle, thumb, body);
  // 再生中の動画は「前へ」「次へ」で操作する
  if (kind !== 'current') {
    const play = document.createElement('button');
    play.className = 'icon play';
    play.dataset.play = q.id;
    play.title = 'ここから再生';
    play.innerHTML = PLAY_ICON;
    li.append(play);
    const del = document.createElement('button');
    del.className = 'icon';
    del.dataset.remove = q.id;
    del.title = kind === 'done' ? '履歴から削除' : 'キューから削除';
    del.textContent = '×';
    li.append(del);
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

/** 12345 → 1.2万 のように短く表示する */
function formatCount(n: number) {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}億`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  return n.toLocaleString('ja-JP');
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

  const render = (state: 'loading' | 'done' | 'error') => {
    $('search-title').textContent =
      state === 'done' ? `「${query}」 ${total.toLocaleString('ja-JP')}件` : `「${query}」`;
    for (const b of $('search-sort').querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('active', b.dataset.sort === sort);
    }
    const rows: HTMLElement[] = items.map(resultEl);
    if (state === 'loading') rows.push(note('検索中…'));
    else if (state === 'error') rows.push(note('検索に失敗しました。時間をおいて試してください'));
    else if (items.length === 0) {
      rows.push(note('見つかりませんでした（投稿されたばかりの動画は、URL を貼ると追加できます）'));
    } else if (items.length < total) {
      const li = document.createElement('li');
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'secondary more';
      more.textContent = 'もっと見る';
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
      add.title = done ? '追加しました' : 'キューに追加';
      add.disabled = done;
    };
    mark(added.has(r.videoId));
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

/** 2024-05-01T12:00:00+09:00 → 2024/5/1 */
function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 部屋に入れていない間の表示。waiting は接続後に送る操作の数 */
export function renderConnecting(waiting = 0) {
  $('members').textContent = waiting > 0 ? `接続中…（${waiting}件の操作を待機中）` : '接続中…';
  $('members').title = '';
}

export function renderMembers(members: Member[]) {
  $('members').textContent = `${members.length}人で視聴中`;
  $('members').title = members.map((m) => m.name).join(', ');
}

let errorTimer: number | undefined;
export function showError(message: string) {
  const el = $('error');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => (el.hidden = true), 5000);
}
