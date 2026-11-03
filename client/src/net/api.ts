import type { SearchResult, SearchSort } from '../../../shared/search';
import { devlog } from '../core/devlog';
import { backend } from '../core/env';

/* サーバーの HTTP の API（server/src/node/routes.ts）の呼び出し */

/** サーバーが発行する通行証（WebSocket 用・ニコニコの中継と検索用） */
export interface Passes {
  pass: string;
  nicoPass: string;
}

/** 通行証を発行してもらう部屋（Activity インスタンス）の参加者ではない */
export class NotInActivityError extends Error {}

/**
 * Discord のログインで得た認可コードを、サーバーでアクセストークンに交換し、通行証を発行してもらう。
 * @param room 通行証は、この部屋（Activity の instanceId）のものとして発行してもらう（別の部屋への使い回しを防ぐ）
 */
export async function exchangeToken(code: string, room: string): Promise<Passes & { accessToken: string }> {
  const res = await fetch(backend('/api/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, room }),
  });
  // この部屋（Activity インスタンス）の参加者ではない、とサーバーに断られた
  if (res.status === 403) throw new NotInActivityError();
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const { access_token, pass, nicoPass } = (await res.json()) as { access_token?: string; pass?: string; nicoPass?: string };
  if (!access_token) throw new Error('token exchange failed');
  if (!pass || !nicoPass) throw new Error('no pass issued');
  return { accessToken: access_token, pass, nicoPass };
}

/** 開発用のログイン（server/src/devToken.ts）。使えなければ null（通行証なしで部屋に入る） */
export async function devLogin(name: string, room: string): Promise<Passes | null> {
  try {
    const res = await fetch(backend('/api/dev-token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, room }),
    });
    if (!res.ok) return null;
    devlog('dev login ok');
    return (await res.json()) as Passes;
  } catch {
    return null;
  }
}

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
export async function sendLog(pass: string | undefined, body: { note: string; text: string; version: string; room?: string; reason: string }): Promise<string> {
  if (!pass) throw new Error('not logged in');
  const res = await fetch(backend('/api/log'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nico-pass': pass },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`log failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}
