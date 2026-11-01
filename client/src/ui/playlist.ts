import type { PlaybackState, QueueItem, RepeatMode } from '../../../shared/protocol';
import { $, bodyEl, countsMeta, noteEl, thumbEl } from './dom';
import { setupNavPreview, type NavKind, type NavPreview } from './navPreview';
import { PLAY_ICON, TRASH_ICON } from './icons';
import { t } from '../core/i18n';
import { lists, navTarget, notifyPlaylistChange, setLists, setPlaybackState } from './playlistStore';
import { setupReorder, type Reordering } from './reorder';
import type { UiHandlers } from './ui';

const REPEAT_LABEL = { off: 'repeatOff', all: 'repeatAll', one: 'repeatOne' } as const;
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

let scrolledTo: string | null = null;
/** 並べ替え（ドラッグ・キーボード）。setupPlaylist で作る */
let reordering: Reordering | null = null;
/** ボタンに乗せて出しているカードを、再生リストが変わったときに更新する */
let refreshNavPreview: () => void = () => {};
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
  reordering = setupReorder(h.move, renderList);
  refreshNavPreview = setupNavPreview(navPreview);
}

/** 前へ・次へのボタンに乗せたときに出す、移動先 */
function navPreview(kind: NavKind): NavPreview {
  const target = navTarget(kind);
  if (!target) return null;
  return 'random' in target ? { text: t('nextRandom') } : { item: target.item };
}

export function setPlayback(s: PlaybackState) {
  setPlaybackState(s);
  renderPlaylist();
}

export function renderQueue(queue: QueueItem[], history: QueueItem[]) {
  setLists(queue, history);
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
  notifyPlaylistChange();
  // 並べ替えのドラッグ中に描き直すと掴んでいる要素が消えるので、終わってから描く
  if (reordering?.isDragging()) return;
  const ol = $('queue');
  ol.replaceChildren(
    ...history.map((q) => itemEl(q, 'done')),
    ...(current ? [itemEl(current, 'current')] : []),
    ...queue.map((q) => itemEl(q, 'next')),
  );
  if (ol.childElementCount === 0) ol.append(noteEl(t('listEmpty')));
  // キーボードで並べ替えたあとは、描き直しで消えたフォーカスを、同じ動画のつまみに戻す
  reordering?.restoreFocus(ol);
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
