import type { LoadFailed } from './roomStore';

/**
 * 「読み込めなかった」「読み込めた」の報告を、記録に反映する。
 * itemId が前の記録と違う動画なら、前の記録は捨てて作り直す。変わらないなら同じ内容を返す
 */
export function reportLoad(prev: LoadFailed | undefined, itemId: string, memberId: string, failed: boolean): LoadFailed {
  const ids = new Set(prev?.itemId === itemId ? prev.ids : []);
  if (failed) ids.add(memberId);
  else ids.delete(memberId);
  return { itemId, ids: [...ids] };
}

/** 今の動画を、部屋にいる全員が読み込めなかったか（誰もいなければ false） */
export function everyoneFailed(failed: LoadFailed | undefined, currentId: string | undefined, memberIds: string[]): boolean {
  if (!currentId || failed?.itemId !== currentId) return false;
  return memberIds.length > 0 && memberIds.every((id) => failed.ids.includes(id));
}
