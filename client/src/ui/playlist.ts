import { reorder } from '../../../shared/playlist';
import type { PlaybackState, QueueItem, RepeatMode } from '../../../shared/protocol';
import { $, bodyEl, countsMeta, noteEl, thumbEl } from './dom';
import { setupNavPreview, type NavKind, type NavPreview } from './navPreview';
import { PLAY_ICON, TRASH_ICON } from './icons';
import { t } from '../core/i18n';
import type { UiHandlers } from './ui';

const REPEAT_LABEL = { off: 'repeatOff', all: 'repeatAll', one: 'repeatOne' } as const;
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

/** 再生リスト欄に並べる内容。どれかが変わるたびに全体を描き直す */
const lists = {
  history: [] as QueueItem[],
  current: null as QueueItem | null,
  queue: [] as QueueItem[],
  repeat: 'off' as RepeatMode,
  shuffle: false,
};
let scrolledTo: string | null = null;
/** キーボードで並べ替えた動画の ID（描き直したあと、そのつまみにフォーカスを戻す） */
let focusHandleOf: { id: string; until: number } | null = null;
/** 並べ替えたあと、サーバーの返事で再び描き直されても、フォーカスを戻し続ける時間 (ms) */
const FOCUS_KEEP_MS = 2000;
/** ボタンに乗せて出しているカードを、再生リストが変わったときに更新する */
let refreshNavPreview: () => void = () => {};
/** 並べ替えのドラッグ中 */
let dragging = false;
/** ドラッグ中、リストの端に近づいたら自動でスクロールする範囲 (px) */
const AUTO_SCROLL_EDGE = 32;

/** 再生リスト欄の操作（再生・削除・並べ替え）と、前へ・次へ・リピート・シャッフルのボタン */
export function setupPlaylist(h: Pick<UiHandlers, 'remove' | 'jump' | 'skip' | 'prev' | 'mode' | 'move'>) {
  const ol = $('queue');
  ol.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const remove = target.closest<HTMLElement>('[data-remove]')?.dataset.remove;
    if (remove) h.remove(remove);
    const play = target.closest<HTMLElement>('[data-play]')?.dataset.play;
    if (play) h.jump(play);
  });
  // 項目のダブルクリックでも、そこから再生する（ボタンやつまみの上は除く）
  ol.addEventListener('dblclick', (e) => {
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
  $('shuffle').addEventListener('click', () => h.mode({ shuffle: !lists.shuffle }));
  $('repeat').addEventListener('click', () => h.mode({ repeat: NEXT_REPEAT[lists.repeat] }));
  renderMode();
  setupReorder(h.move);
  refreshNavPreview = setupNavPreview(navPreview);
}

/** 再生リストが変わったときに呼ぶ関数（検索結果の「追加済み」の表示を更新するため） */
const changeListeners: (() => void)[] = [];
export function onPlaylistChange(fn: () => void) {
  changeListeners.push(fn);
}

/** videoId の動画が、これから再生する中か再生中にあるか（視聴済みは含めない。もう一度追加したいことがあるため） */
export function isInPlaylist(videoId: string): boolean {
  return lists.current?.videoId === videoId || lists.queue.some((q) => q.videoId === videoId);
}

/**
 * 再生リストの中から、videoId の動画を探す（検索結果の「追加済み」を取り消すため）。
 * 同じ動画が複数あれば、あとから追加されたもの（これから再生する中の後ろ）を優先する
 */
export function findAddedItem(videoId: string): { id: string } | null {
  const { history, current, queue } = lists;
  const last = (list: QueueItem[]) => [...list].reverse().find((q) => q.videoId === videoId);
  const upcoming = last(queue);
  if (upcoming) return { id: upcoming.id };
  if (current?.videoId === videoId) return { id: current.id };
  const done = last(history);
  return done ? { id: done.id } : null;
}

/** 前へ・次へのボタンに乗せたときに出す、移動先 */
function navPreview(kind: NavKind): NavPreview {
  const { history, current, queue } = lists;
  if (kind === 'prev') {
    const prev = history[history.length - 1];
    return prev ? { item: prev } : null;
  }
  if (lists.shuffle && queue.length > 1) return { text: t('nextRandom') };
  if (queue.length > 0) return { item: queue[0] };
  // 全曲リピートで最後まで来ていたら、視聴済みの最初に戻る
  if (lists.repeat === 'all') {
    const first = history[0] ?? current;
    return first ? { item: first } : null;
  }
  return null;
}

export function setPlayback(s: PlaybackState) {
  lists.current = s.current;
  lists.repeat = s.repeat ?? 'off';
  lists.shuffle = s.shuffle ?? false;
  renderPlaylist();
}

export function renderQueue(queue: QueueItem[], history: QueueItem[]) {
  lists.queue = queue;
  lists.history = history;
  renderList();
}

/** 再生リスト欄全体を描き直す（言語を切り替えたときなど） */
export function renderPlaylist() {
  renderMode();
  renderList();
}

/** リピート・シャッフルのボタンの見た目 */
function renderMode() {
  const shuffle = $('shuffle');
  shuffle.title = t(lists.shuffle ? 'shuffleOn' : 'shuffleOff');
  shuffle.setAttribute('aria-pressed', String(lists.shuffle));
  const repeat = $('repeat');
  // 1曲リピートはボタンの右上に「1」のバッジを付ける（style.css）
  repeat.dataset.repeat = lists.repeat;
  repeat.title = t(REPEAT_LABEL[lists.repeat]);
  repeat.setAttribute('aria-pressed', String(lists.repeat !== 'off'));
}

/** 視聴済み → 再生中 → これから再生、の順に並べる */
function renderList() {
  const { history, current, queue } = lists;
  // 前へ・次へは常に表示し、戻る先・進む先が無いときは押せなくする
  $<HTMLButtonElement>('prev').disabled = !current || history.length === 0;
  // 全曲リピート中は、次が無くても最初に戻れる
  $<HTMLButtonElement>('skip').disabled = !current || (queue.length === 0 && lists.repeat !== 'all');
  refreshNavPreview();
  for (const fn of changeListeners) fn();
  // 並べ替えのドラッグ中に描き直すと掴んでいる要素が消えるので、終わってから描く
  if (dragging) return;
  const ol = $('queue');
  ol.replaceChildren(
    ...history.map((q) => itemEl(q, 'done')),
    ...(current ? [itemEl(current, 'current')] : []),
    ...queue.map((q) => itemEl(q, 'next')),
  );
  if (ol.childElementCount === 0) ol.append(noteEl(t('listEmpty')));
  // キーボードで並べ替えたあとは、描き直しで消えたフォーカスを、同じ動画のつまみに戻す
  if (focusHandleOf) {
    if (Date.now() < focusHandleOf.until) ol.querySelector<HTMLElement>(`li[data-id="${focusHandleOf.id}"] .handle`)?.focus();
    else focusHandleOf = null;
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
  // キーボードでも、フォーカスして上下の矢印キーで並べ替えられる（setupReorder の keydown）
  handle.tabIndex = 0;
  handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', t('dragToReorder'));

  const thumb = thumbEl(q.thumbnail, q.length);
  if (kind === 'current') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = t('playingBadge');
    thumb.append(badge);
  }

  const body = bodyEl(q.title, q.videoId, [
    q.author,
    ...countsMeta(q.views, q.comments),
    t('addedBy', { name: q.addedBy }),
  ]);

  li.append(handle, thumb, body);
  // 「ここから再生」と「削除」。マウスを乗せたときだけ、動画情報の右端に重ねて出す
  // （再生中の動画は、すでに再生しているので「ここから再生」は出さない。削除すると次の動画へ進む）
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (kind !== 'current') {
    const play = document.createElement('button');
    play.className = 'icon play';
    play.dataset.play = q.id;
    play.title = t('playFromHere');
    play.setAttribute('aria-label', t('playFromHere'));
    play.innerHTML = PLAY_ICON;
    actions.append(play);
  }
  const del = document.createElement('button');
  del.className = 'icon remove';
  del.dataset.remove = q.id;
  del.title = t('removeFromList');
  del.setAttribute('aria-label', t('removeFromList'));
  del.innerHTML = TRASH_ICON;
  actions.append(del);
  li.append(actions);
  return li;
}

/**
 * 再生リストのつまみ (⋮⋮) をドラッグして並べ替える。マウスでもタッチでも動くよう pointer events で実装。
 * 掴んだ項目はポインタに付いて動き、ほかの項目は transform でスライドして場所を空ける。
 * DOM 上の並びは変えず（変えるとポインタの追跡が切れる）、離したときに確定する。
 */
function setupReorder(move: (id: string, index: number) => void) {
  const ol = $('queue');
  const app = ol.closest<HTMLElement>('#app')!;

  // キーボード: つまみにフォーカスして、上下の矢印キーで 1 つずつ動かす
  ol.addEventListener('keydown', (e) => {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('.handle');
    const li = handle?.closest<HTMLLIElement>('li[data-id]');
    if (!handle || !li || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const items = [...ol.querySelectorAll<HTMLLIElement>('li[data-id]')];
    const from = items.indexOf(li);
    const to = Math.max(0, Math.min(items.length - 1, from + (e.key === 'ArrowUp' ? -1 : 1)));
    if (to === from) return;
    const id = li.dataset.id!;
    const result = reorder(lists.history, lists.current, lists.queue, id, to);
    if (!result) return;
    lists.history = result.history;
    lists.queue = result.queue;
    move(id, to);
    focusHandleOf = { id, until: Date.now() + FOCUS_KEEP_MS };
    renderList();
  });

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
