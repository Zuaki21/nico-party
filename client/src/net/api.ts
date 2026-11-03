import type { SearchResult, SearchSort } from '../../../shared/search';
import { backend } from '../core/env';

/** キーワード検索（サーバー経由でニコニコのスナップショット検索 API を呼ぶ）。通行証が要る */
export async function searchNico(pass: string | undefined, q: string, sort: SearchSort, offset: number): Promise<SearchResult> {
  const params = new URLSearchParams({ q, sort, offset: String(offset) });
  const res = await fetch(backend(`/api/search?${params}`), {
    headers: pass ? { 'x-nico-pass': pass } : {},
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return (await res.json()) as SearchResult;
}

/** 不具合調査用のログをサーバーに送る。受け付けられた報告 ID を返す */
export async function sendLog(pass: string | undefined, body: { text: string; version: string; room?: string; reason: string }): Promise<string> {
  if (!pass) throw new Error('not logged in');
  const res = await fetch(backend('/api/log'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nico-pass': pass },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`log failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}
