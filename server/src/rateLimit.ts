/** 呼び出し回数の制限（固定の窓。このサーバー内の集計なので目安。大量の呼び出しを抑えるためのもの） */
const windows = new Map<string, { start: number; count: number }>();

/** @returns 制限内なら true */
export function withinRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    // 古い集計が溜まり続けないよう、新しい窓を作るときに掃除する
    if (windows.size > 5000) for (const [k, v] of windows) if (now - v.start >= windowMs) windows.delete(k);
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  return ++w.count <= limit;
}
