import { reorder } from '../../../shared/playlist';
import type { PlaybackState, QueueItem, RepeatMode } from '../../../shared/protocol';

const state = {
  history: [] as QueueItem[],
  current: null as QueueItem | null,
  queue: [] as QueueItem[],
  repeat: 'off' as RepeatMode,
  shuffle: false,
};
/** 再生リスト欄に並べる内容（画面の再生リストの状態）。サーバーから届くたびに、このファイルの関数が書き換える */
export const lists: Readonly<typeof state> = state;

/** 再生リストが変わったときに呼ぶ関数（検索結果の「追加済み」の表示を更新するため） */
const changeListeners: (() => void)[] = [];
export function onPlaylistChange(fn: () => void) {
  changeListeners.push(fn);
}
function notifyPlaylistChange() {
  for (const fn of changeListeners) fn();
}

export function setPlaybackState(s: PlaybackState) {
  state.current = s.current;
  state.repeat = s.repeat ?? 'off';
  state.shuffle = s.shuffle ?? false;
  notifyPlaylistChange();
}

export function setLists(queue: QueueItem[], history: QueueItem[]) {
  state.queue = queue;
  state.history = history;
  notifyPlaylistChange();
}

/**
 * id の動画を、視聴済み + 再生中 + キューを並べたリストの index 番目に移す（サーバーと同じ規則）。
 * サーバーの返事を待たずに画面を確定させるために使う。並びが変わらなければ false
 */
export function applyReorder(id: string, index: number): boolean {
  const result = reorder(lists.history, lists.current, lists.queue, id, index);
  if (!result) return false;
  setLists(result.queue, result.history);
  return true;
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

/** 前へ・次へで移る先。random は、シャッフル中で、次の動画が決まっていないとき */
export type NavTarget = { item: QueueItem } | { random: true } | null;

export function navTarget(kind: 'prev' | 'next'): NavTarget {
  const { history, current, queue } = lists;
  if (kind === 'prev') {
    const prev = history[history.length - 1];
    return prev ? { item: prev } : null;
  }
  if (lists.shuffle && queue.length > 1) return { random: true };
  if (queue.length > 0) return { item: queue[0] };
  // 全曲リピートで最後まで来ていたら、視聴済みと再生中を戻して、その最初から（シャッフルならその中からランダム。サーバーの advance と同じ）
  if (lists.repeat === 'all') {
    if (lists.shuffle && history.length + (current ? 1 : 0) > 1) return { random: true };
    const first = history[0] ?? current;
    return first ? { item: first } : null;
  }
  return null;
}
