import type { PlaybackState, QueueItem } from '../../shared/protocol';

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

export function newItemId() {
  return crypto.randomUUID().slice(0, 8);
}

/** これから再生する動画から次の1本を取り出す（queue から取り除く）。シャッフルならランダムに選ぶ */
export function takeNext(queue: QueueItem[], shuffle = false): QueueItem | null {
  const index = shuffle && queue.length > 1 ? Math.floor(Math.random() * queue.length) : 0;
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
): { item: QueueItem | null; queue: QueueItem[]; history: QueueItem[] } {
  let nextQueue = [...queue];
  let nextHistory = [...history];
  if (s.current) nextHistory.push(s.current);
  // 全曲リピート: 最後まで来たら視聴済みを全部これから再生する側に戻す
  if (nextQueue.length === 0 && s.repeat === 'all') {
    nextQueue = nextHistory.map((q) => ({ ...q, id: newItemId() }));
    nextHistory = [];
  }
  const item = takeNext(nextQueue, s.shuffle);
  return { item, queue: nextQueue, history: nextHistory };
}

/** 上限を超える分を、古い視聴済みから消す */
export function trimHistory(history: QueueItem[], hasCurrent: boolean, queueLength: number): QueueItem[] {
  const over = history.length + (hasCurrent ? 1 : 0) + queueLength - LIST_LIMIT;
  return over > 0 ? history.slice(over) : history;
}
