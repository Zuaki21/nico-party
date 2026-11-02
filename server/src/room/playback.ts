import { jumpTo, reorder } from '../../../shared/playlist';
import type { PlaybackState, QueueItem, RepeatMode } from '../../../shared/protocol';

/**
 * 再生リスト全体（視聴済み + 再生中 + これから再生）の上限。
 * 超える分は動画を追加するときに古い視聴済みから消す（全曲リピートや並べ替えでは消さない）
 */
export const LIST_LIMIT = 150;
/**
 * 動画を切り替えたとき、再生開始をこれだけ先の時刻にする。
 * 各自のプレイヤーの読み込みに数秒かかるので、すぐ開始にすると冒頭が飛ばされてしまう
 */
export const START_DELAY_MS = 3000;
/** 動画の開始からこの時間は、自動送り（動画の終了）を受け付けない */
export const AUTO_NEXT_GUARD_MS = 3000;

/** 部屋の再生状態・これから再生する動画・視聴済みの動画 */
export interface Snapshot {
  state: PlaybackState;
  queue: QueueItem[];
  history: QueueItem[];
}

/** 操作した人 */
export interface Actor {
  id: string;
  name: string;
}

/**
 * 状態遷移の結果。変わったものだけが入る。
 * 再生リストが変わるときは、キューと視聴済みが必ずそろう（片方だけ変わる遷移はない）
 */
export type Change =
  | { state: PlaybackState; queue?: undefined; history?: undefined }
  | { state?: undefined; queue: QueueItem[]; history: QueueItem[] }
  | { state: PlaybackState; queue: QueueItem[]; history: QueueItem[] };

/** 時刻・ID・乱数。テストでは固定したものを渡す */
export interface Deps {
  now: number;
  newId: () => string;
  random: () => number;
}

export function newItemId() {
  return crypto.randomUUID().slice(0, 8);
}

export const realDeps = (): Deps => ({ now: Date.now(), newId: newItemId, random: Math.random });

/** これから再生する動画から次の1本を取り出す（queue から取り除く）。シャッフルならランダムに選ぶ */
export function takeNext(queue: QueueItem[], shuffle: boolean, random: () => number): QueueItem | null {
  const index = shuffle && queue.length > 1 ? Math.floor(random() * queue.length) : 0;
  return queue.splice(index, 1)[0] ?? null;
}

/**
 * 今の動画を視聴済みに回し、次に再生する動画を取り出す。
 * 全曲リピートなら最後まで来たら最初に戻り、シャッフルならランダムに選ぶ。
 * 渡した配列は書き換えず、新しい queue と history を返す
 */
export function advance(
  s: PlaybackState,
  queue: QueueItem[],
  history: QueueItem[],
  d: Deps,
): { item: QueueItem | null; queue: QueueItem[]; history: QueueItem[] } {
  let nextQueue = [...queue];
  let nextHistory = [...history];
  if (s.current) nextHistory.push(s.current);
  // 全曲リピート: 最後まで来たら視聴済みを全部これから再生する側に戻す
  if (nextQueue.length === 0 && s.repeat === 'all') {
    nextQueue = nextHistory.map((q) => ({ ...q, id: d.newId() }));
    nextHistory = [];
  }
  const item = takeNext(nextQueue, !!s.shuffle, d.random);
  return { item, queue: nextQueue, history: nextHistory };
}

/** 上限を超える分を、古い視聴済みから消す */
export function trimHistory(history: QueueItem[], hasCurrent: boolean, queueLength: number): QueueItem[] {
  const over = history.length + (hasCurrent ? 1 : 0) + queueLength - LIST_LIMIT;
  return over > 0 ? history.slice(over) : history;
}

/** 動画をもう1本追加できるか（視聴済みは追加するときに消せるので数えない） */
export function hasRoom(snap: Snapshot): boolean {
  return (snap.state.current ? 1 : 0) + snap.queue.length < LIST_LIMIT;
}

/** 状態に、操作した人と時刻を記録する。delayMs は再生位置の基準時刻を先にずらす量 */
function stamp(s: PlaybackState, by: Actor, now: number, delayMs = 0): PlaybackState {
  return { ...s, updatedAt: now + delayMs, by: by.id, byName: by.name };
}

/** item の再生を先頭から始める（null なら停止）。開始時刻は START_DELAY_MS 先にする */
export function startItem(s: PlaybackState, item: QueueItem | null, by: Actor, d: Deps): PlaybackState {
  const next = { ...s, current: item, playing: item !== null, position: 0, startedAt: d.now };
  return stamp(next, by, d.now, item ? START_DELAY_MS : 0);
}

/** シーク・再生・一時停止。動画が切り替わった直後に届いた、前の動画への操作は捨てる（null） */
export function control(
  s: PlaybackState,
  msg: { itemId: string; playing: boolean; position: number },
  by: Actor,
  d: Deps,
): PlaybackState | null {
  if (!s.current || s.current.id !== msg.itemId) return null;
  // 動画の長さを超える位置は、長さに丸める（壊れたプレイヤーの値で、位置が飛ばないように）
  const max = s.current.length && s.current.length > 0 ? s.current.length : Infinity;
  return stamp({ ...s, playing: msg.playing, position: Math.min(max, Math.max(0, msg.position)) }, by, d.now);
}

/** リピート・シャッフルの切り替え。再生位置の基準 (updatedAt) は変えない。何も変わらないなら null */
export function setMode(s: PlaybackState, msg: { repeat?: RepeatMode; shuffle?: boolean }): PlaybackState | null {
  const repeat = msg.repeat ?? s.repeat;
  const shuffle = msg.shuffle ?? s.shuffle;
  if (repeat === s.repeat && shuffle === s.shuffle) return null;
  return {
    ...s,
    ...(msg.repeat ? { repeat: msg.repeat } : {}),
    ...(msg.shuffle !== undefined ? { shuffle: msg.shuffle } : {}),
  };
}

/** 今の動画を視聴済みに残さず手放して、次の動画へ進める */
function dropCurrent(snap: Snapshot, by: Actor, d: Deps): Change {
  const { state, queue, history } = snap;
  const next = advance({ ...state, current: null }, queue, history, d);
  return { state: startItem(state, next.item, by, d), queue: next.queue, history: next.history };
}

/** 動画を再生リストから消す。再生中の動画を消したら、視聴済みには残さず、次の動画へ進める */
export function removeItem(snap: Snapshot, id: string, by: Actor, d: Deps): Change | null {
  const { state, queue, history } = snap;
  if (state.current?.id === id) return dropCurrent(snap, by, d);
  const nextQueue = queue.filter((q) => q.id !== id);
  const nextHistory = history.filter((q) => q.id !== id);
  if (nextQueue.length === queue.length && nextHistory.length === history.length) return null;
  return { queue: nextQueue, history: nextHistory };
}

/** 並べ替え */
export function moveItem(snap: Snapshot, id: string, index: number): Change | null {
  return reorder(snap.history, snap.state.current, snap.queue, id, index);
}

/** 直前に視聴した動画に戻る。戻る先がなければ、今の動画を最初から（ID を変えて、前の再生の終了で届く next を無視できるようにする） */
export function prevItem(snap: Snapshot, itemId: string, by: Actor, d: Deps): Change | null {
  const { state, queue, history } = snap;
  if (!state.current || state.current.id !== itemId) return null;
  const rest = [...history];
  const prev = rest.pop();
  if (!prev) return { state: startItem(state, { ...state.current, id: d.newId() }, by, d) };
  // 今の動画はキューの先頭に戻す
  return { state: startItem(state, prev, by, d), queue: [state.current, ...queue], history: rest };
}

/** 視聴済み・キューの中から選んだ動画から再生する（並び順は変えない） */
export function jumpItem(snap: Snapshot, id: string, by: Actor, d: Deps): Change | null {
  const { state, queue, history } = snap;
  if (state.current?.id === id) return null;
  const result = jumpTo(history, state.current, queue, id);
  if (!result) return null;
  return { state: startItem(state, result.current, by, d), queue: result.queue, history: result.history };
}

/**
 * 次の動画へ進める。複数人から同時に届いても 1 回だけ進める（動画の ID が合わなければ null）。
 * auto は動画が最後まで再生されて自動で進むとき（1 曲リピートではこのときだけ同じ動画を繰り返す）
 */
export function nextItem(snap: Snapshot, msg: { itemId: string | null; auto?: boolean }, by: Actor, d: Deps): Change | null {
  const { state, queue, history } = snap;
  if ((state.current?.id ?? null) !== msg.itemId) return null;
  // 動画が切り替わった直後の自動送りは、前の動画の終了通知が遅れて届いたものなので捨てる
  // （全員の終了通知が少しずつずれるため、次の動画の ID で届いて一気に飛んでしまう）。
  // 本当に短い動画は、クライアント側の「終わっているのに進まない」確認が進める
  if (msg.auto && d.now - (state.startedAt ?? 0) < AUTO_NEXT_GUARD_MS) return null;
  // 1 曲リピート: 最後まで再生されたときは同じ動画をもう一度（ID を変えて、重複した next を無視できるようにする）
  if (msg.auto && state.repeat === 'one' && state.current) {
    return { state: startItem(state, { ...state.current, id: d.newId() }, by, d) };
  }
  const next = advance(state, queue, history, d);
  return { state: startItem(state, next.item, by, d), queue: next.queue, history: next.history };
}

/**
 * 動画を再生リストの最後に足す。何も再生していなければ、すぐ再生する
 * （再生リストの最後まで行った後に再生待ちへ戻した動画があれば、そちらが先）
 */
export function addItem(snap: Snapshot, item: QueueItem, by: Actor, d: Deps): Change {
  const { state } = snap;
  const queue = [...snap.queue, item];
  const history = trimHistory(snap.history, state.current !== null, queue.length);
  if (state.current) return { queue, history };
  const next = takeNext(queue, !!state.shuffle, d.random);
  return { state: startItem(state, next, by, d), queue, history };
}

/** 全員が読み込めなかった動画を、視聴済みに残さず、再生リストから外して次へ進める */
export function skipUnloadable(snap: Snapshot, by: Actor, d: Deps): Change {
  return dropCurrent(snap, by, d);
}
