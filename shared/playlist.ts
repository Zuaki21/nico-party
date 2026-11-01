import type { QueueItem } from './protocol';

/** 視聴済み → 再生中 → キューの順に並べた1本のリスト（画面の再生リストと同じ並び） */
function flatten(history: QueueItem[], current: QueueItem | null, queue: QueueItem[]) {
  return [...history, ...(current ? [current] : []), ...queue];
}

/**
 * 視聴済み・再生中・キューを1本のリストとみなして id の動画を index 番目（自分を抜いた後の位置）に移す。
 * 再生中の動画は動かしても再生中のまま。それより前に置いた動画は視聴済み、後ろはキューになる。
 * 何も変わらないときは null。
 */
export function reorder(
  history: QueueItem[],
  current: QueueItem | null,
  queue: QueueItem[],
  id: string,
  index: number,
): { history: QueueItem[]; queue: QueueItem[] } | null {
  const all = flatten(history, current, queue);
  const from = all.findIndex((q) => q.id === id);
  if (from < 0) return null;
  const [item] = all.splice(from, 1);
  const to = Math.max(0, Math.min(all.length, Math.trunc(index) || 0));
  if (to === from) return null;
  all.splice(to, 0, item);

  if (current) {
    const ci = all.findIndex((q) => q.id === current.id);
    return { history: all.slice(0, ci), queue: all.slice(ci + 1) };
  }
  // 再生中が無いときは、元の視聴済みとキューの境目を基準に振り分ける
  const fromHistory = from < history.length;
  const boundary = history.length - (fromHistory ? 1 : 0);
  const toHistory = to < boundary || (to === boundary && fromHistory);
  const historyLen = boundary + (toHistory ? 1 : 0);
  return { history: all.slice(0, historyLen), queue: all.slice(historyLen) };
}

/**
 * 視聴済み・再生中・キューを1本のリストとみなして、id の動画を再生中にする。
 * リスト上でそれより前はすべて視聴済み、後ろはすべてキューになる（並び順は変えない）。見つからなければ null。
 */
export function jumpTo(
  history: QueueItem[],
  current: QueueItem | null,
  queue: QueueItem[],
  id: string,
): { history: QueueItem[]; current: QueueItem; queue: QueueItem[] } | null {
  const all = flatten(history, current, queue);
  const i = all.findIndex((q) => q.id === id);
  if (i < 0) return null;
  return { history: all.slice(0, i), current: all[i], queue: all.slice(i + 1) };
}
