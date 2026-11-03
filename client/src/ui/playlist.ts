import { flatten } from '../../../shared/playlist';
import type { PlaybackState, QueueItem, RepeatMode } from '../../../shared/protocol';
import { adderEl } from './avatar';
import { $, announce, noteEl } from './dom';
import { bodyEl, countsMeta, thumbEl } from './itemParts';
import { setupNavPreview, type NavKind, type NavPreview } from './navPreview';
import { PLAY_ICON, TRASH_ICON } from './icons';
import { t } from '../core/i18n';
import { lists, navTarget, setLists, setPlaybackState } from './playlistStore';
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
  reordering = setupReorder(h.move, renderList, (id, index, total) => {
    const q = flatten(lists.history, lists.current, lists.queue).find((x) => x.id === id);
    if (q) announce(t('movedTo', { title: q.title, n: String(index + 1), total: String(total) }));
  });
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
  // シャッフルは名前を固定し、オン・オフは aria-pressed で伝える（title にも状態を出す）
  const shuffle = $('shuffle');
  shuffle.title = t(lists.shuffle ? 'shuffleOn' : 'shuffleOff');
  shuffle.setAttribute('aria-label', t('shuffleLabel'));
  shuffle.setAttribute('aria-pressed', String(lists.shuffle));
  // リピートは 3 つの状態（オフ・全体・1曲）なので、aria-pressed ではなく名前に状態を含める
  const repeat = $('repeat');
  // 1曲リピートはボタンの右上に「1」のバッジを付ける（style.css）
  repeat.dataset.repeat = lists.repeat;
  repeat.title = t(REPEAT_LABEL[lists.repeat]);
  repeat.setAttribute('aria-label', repeat.title);
}

/** 視聴済み → 再生中 → これから再生、の順に並べる */
function renderList(scrollToFocus = false) {
  const { history, current, queue } = lists;
  // 前へ・次へは常に表示し、戻る先・進む先が無いときは押せなくする
  $<HTMLButtonElement>('prev').disabled = !current || history.length === 0;
  // 全曲リピート中は、次が無くても最初に戻れる
  $<HTMLButtonElement>('skip').disabled = !current || (queue.length === 0 && lists.repeat !== 'all');
  refreshNavPreview();
  // 並べ替えのドラッグ中に描き直すと掴んでいる要素が消えるので、終わってから描く
  if (reordering?.isDragging()) return;
  const ol = $('queue');
  const focused = focusedControl(ol);
  ol.replaceChildren(
    ...history.map((q) => itemEl(q, 'done')),
    ...(current ? [itemEl(current, 'current')] : []),
    ...queue.map((q) => itemEl(q, 'next')),
  );
  if (ol.childElementCount === 0) ol.append(noteEl(t('listEmpty')));
  // 描き直しで消えたフォーカスを、同じ動画の同じ操作に戻す（他の人の操作で描き直されても、キーボード操作が途切れない）
  restoreFocus(ol, focused, scrollToFocus);
  // 再生中の動画が変わったら、それが見える位置までスクロールする
  const curId = current?.id ?? null;
  if (curId !== scrolledTo) {
    scrolledTo = curId;
    ol.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }
}

/** 再生リストの中でフォーカスされている操作（どの動画の、どのボタンか） */
type FocusedControl = { id: string; selector: string; index: number };
const CONTROL_SELECTORS = ['.handle', '[data-play]', '[data-remove]'];

function focusedControl(ol: HTMLElement): FocusedControl | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !ol.contains(el)) return null;
  const id = el.closest<HTMLElement>('li[data-id]')?.dataset.id;
  const selector = CONTROL_SELECTORS.find((s) => el.matches(s));
  const index = [...ol.querySelectorAll('li[data-id]')].findIndex((x) => (x as HTMLElement).dataset.id === id);
  return id && selector ? { id, selector, index } : null;
}

function restoreFocus(ol: HTMLElement, focused: FocusedControl | null, scroll: boolean) {
  if (!focused) return;
  const items = [...ol.querySelectorAll<HTMLElement>('li[data-id]')];
  const li = items.find((x) => x.dataset.id === focused.id);
  // 同じボタンが無くなっていたら（再生中になって「ここから再生」が消えたなど）、同じ動画のつまみに
  let target = li?.querySelector<HTMLElement>(focused.selector) ?? li?.querySelector<HTMLElement>('.handle');
  // 動画が消えたとき（削除など）は、同じ位置に来た動画に移る。空になったら入力欄に
  target ??= items[Math.min(focused.index, items.length - 1)]?.querySelector<HTMLElement>('.handle') ?? document.getElementById('url');
  // キーボードで動かした先が画面の外にならないよう、見える位置まで動かす
  target?.focus({ preventScroll: true });
  // 自分でキーボード操作したときだけ追従する（他の人の操作で描き直されたときに、見ている場所から引き戻さない）
  if (scroll) target?.scrollIntoView({ block: 'nearest' });
}

type ItemKind = 'done' | 'current' | 'next';

function itemEl(q: QueueItem, kind: ItemKind) {
  const li = document.createElement('li');
  li.className = kind;
  li.dataset.id = q.id;
  if (kind === 'current') li.setAttribute('aria-current', 'true');

  // つまみをドラッグして並べ替えられる（視聴済み・再生中も含めて自由に動かせる）
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'handle';
  handle.textContent = '⋮⋮';
  // キーボードでも、フォーカスして上下の矢印キーで並べ替えられる（setupReorder の keydown）
  handle.title = t('dragToReorder');
  handle.setAttribute('aria-label', t('reorderItem', { title: q.title }));
  handle.setAttribute('aria-describedby', 'reorder-hint');

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
  ]);

  // 追加した人のアイコンは、サムネイルの左下に重ねる
  thumb.append(adderEl(q.addedBy, q.addedByAvatar));
  li.append(handle, thumb, body);
  // 「ここから再生」と「削除」。マウスを乗せたときだけ、動画情報の右端に重ねて出す
  // （再生中の動画は、すでに再生しているので「ここから再生」は出さない。削除すると次の動画へ進む）
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (kind !== 'current') {
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'icon play';
    play.dataset.play = q.id;
    play.title = t('playFromHere');
    play.setAttribute('aria-label', t('playItem', { title: q.title }));
    play.innerHTML = PLAY_ICON;
    actions.append(play);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'icon remove';
  del.dataset.remove = q.id;
  del.title = t('removeFromList');
  del.setAttribute('aria-label', t('removeItem', { title: q.title }));
  del.innerHTML = TRASH_ICON;
  actions.append(del);
  li.append(actions);
  return li;
}
