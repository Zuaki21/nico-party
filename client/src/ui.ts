import { reorder, type Member, type PlaybackState, type QueueItem } from '../../shared/protocol';
import { externalUrl } from './env';

export interface UiHandlers {
  enqueue: (url: string) => void;
  remove: (id: string) => void;
  skip: (itemId: string) => void;
  prev: (itemId: string) => void;
  /** id の動画を、視聴済み + 再生中 + キューを並べたリストの index 番目に移動する */
  move: (id: string, index: number) => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 画面の骨組みを作り、プレイヤーを入れる要素を返す */
export function mountUi(root: HTMLElement, h: UiHandlers): HTMLElement {
  root.innerHTML = `
    <main class="main">
      <div class="player" id="player">
        <div class="empty" id="empty">キュー欄に動画のURLを入れてください</div>
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
        <input type="text" id="url" placeholder="ニコニコ動画のURL または sm番号" autocomplete="off" />
        <button type="submit">追加</button>
      </form>
      <div class="error" id="error" hidden></div>
      <div class="queue-head">
        <span>キュー</span>
        <span class="muted" id="members"></span>
      </div>
      <ol class="queue" id="queue"><li class="muted">接続中…</li></ol>
    </aside>
  `;

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('url');
    const url = input.value.trim();
    if (!url) return;
    h.enqueue(url);
    input.value = '';
  });
  $('queue').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]')?.dataset.remove;
    if (id) h.remove(id);
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

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (q.thumbnail) {
    const img = document.createElement('img');
    img.src = externalUrl(q.thumbnail);
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
  }
  if (kind === 'current') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '▶ 再生中';
    thumb.append(badge);
  }
  if (q.length) {
    const len = document.createElement('span');
    len.className = 'len';
    len.textContent = formatTime(q.length);
    thumb.append(len);
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
