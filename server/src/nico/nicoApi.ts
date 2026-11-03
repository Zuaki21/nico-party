/**
 * ニコニコの公開 API から、再生リストに表示する動画情報と検索結果を取得する。
 * （埋め込みプレイヤーの中継は nico.ts）
 */

import { SEARCH_MAX_OFFSET, SEARCH_PAGE_SIZE, type SearchResult, type SearchSort } from '../../../shared/search';

/** User-Agent が無いとニコニコの CDN に 403 で弾かれるので、サーバーから問い合わせるときに付ける */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** 埋め込みページを読む上限。エラーコードはこれより手前にある */
const EMBED_READ_LIMIT = 80_000;

/** 検索結果を覚えておく数の上限 */
const SEARCH_CACHE_MAX = 500;
const searchCache = new Map<string, { at: number; body: string }>();

/** 検索結果をキャッシュする時間。スナップショット検索のデータは 1 日 1 回の更新なので短すぎなくてよい */
const SEARCH_CACHE_SECONDS = 600;

export interface VideoInfo {
  title: string;
  thumbnail?: string;
  author?: string;
  views?: number;
  comments?: number;
  /** 秒 */
  length?: number;
  /** 外部サイトへの埋め込みが許可されているか */
  embeddable: boolean;
}

/** ニコニコへの問い合わせを待つ上限（応答しない相手で、リクエストが溜まり続けないように） */
const FETCH_TIMEOUT_MS = 8000;

/** ニコニコに問い合わせられなかった（通信の失敗・タイムアウト・想定外の応答）。動画が無いこととは区別する */
export class UpstreamError extends Error {}

/** 保存して全員に配信するので、ニコニコから来た文字列の長さには上限をかける */
const TITLE_MAX = 200;
const NAME_MAX = 100;
const URL_MAX = 500;

/**
 * キュー表示用の動画情報を取得する。存在しない・削除された動画なら null。
 * ニコニコに問い合わせられなかったときは UpstreamError
 */
export async function fetchVideoInfo(videoId: string): Promise<VideoInfo | null> {
  let xml: string;
  try {
    xml = await fetch(`https://ext.nicovideo.jp/api/getthumbinfo/${videoId}`, {
      headers: { 'user-agent': DEFAULT_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).then((r) => r.text());
  } catch {
    throw new UpstreamError('getthumbinfo failed');
  }
  if (xml.includes('status="fail"')) return null;
  if (!xml.includes('status="ok"')) throw new UpstreamError('getthumbinfo unexpected response');
  const tag = (name: string) => {
    const v = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
    return v === undefined ? undefined : decodeXml(v);
  };
  const num = (name: string) => {
    const v = Number(tag(name));
    return Number.isFinite(v) ? v : undefined;
  };
  const [min, sec] = (tag('length') ?? '').split(':').map(Number);
  return {
    title: (tag('title') ?? videoId).slice(0, TITLE_MAX),
    thumbnail: tag('thumbnail_url')?.slice(0, URL_MAX),
    author: (tag('user_nickname') ?? tag('ch_name'))?.slice(0, NAME_MAX),
    views: num('view_counter'),
    comments: num('comment_num'),
    length: Number.isFinite(min) && Number.isFinite(sec) ? min * 60 + sec : undefined,
    embeddable: tag('embeddable') !== '0',
  };
}

/**
 * 埋め込みプレイヤーで再生できない動画なら、その理由（埋め込みページのエラーコード）を返す。
 * センシティブな動画（sensitive_video）や、権利者が外部での再生を禁止した動画（externally_unwatchable）など。
 * getthumbinfo の embeddable が 1 でも再生できないことがあるので、実際の埋め込みページで確かめる
 */
export async function fetchEmbedError(videoId: string): Promise<string | null> {
  // 動画ごとの判定はキャッシュしない。Workers 無料プランのサブリクエスト上限（1 回の処理で 50）に
  // キャッシュの読み書きも数えられ、検索 20 件分だと超えてしまうため（検索結果全体は 10 分キャッシュしている）
  try {
    const res = await fetch(`https://embed.nicovideo.jp/watch/${videoId}`, {
      headers: { 'user-agent': DEFAULT_UA, 'accept-language': 'ja-JP,ja;q=0.9' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // エラーコードは先頭から 44KB ほどの data-props に入っているので、そこまで読んだら打ち切る
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < EMBED_READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      const props = html.indexOf('data-props="');
      if (props >= 0 && html.length > props + 500) break;
    }
    reader.cancel().catch(() => {});
    return html.match(/errorParams&quot;:\{&quot;code&quot;:&quot;([a-z_]+)&quot;/)?.[1] ?? null;
  } catch {
    // 確認できなかったときは再生できるものとして扱う（再生時にクライアント側の保険で飛ばす）
    return null;
  }
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const SORT_FIELD: Record<SearchSort, string> = {
  popular: '-viewCounter',
  new: '-startTime',
  likes: '-likeCounter',
};

/**
 * ニコニコのスナップショット検索 API（公式）でキーワード検索する。
 * データは 1 日 1 回の更新なので、投稿されたばかりの動画は出てこない。
 * https://site.nicovideo.jp/search-api-docs/snapshot
 */
export async function searchVideos(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const sortParam = url.searchParams.get('sort');
  const sort: SearchSort = sortParam === 'new' || sortParam === 'likes' ? sortParam : 'popular';
  const offset = Math.max(0, Math.min(SEARCH_MAX_OFFSET, Math.trunc(Number(url.searchParams.get('offset'))) || 0));
  if (!q) return Response.json({ total: 0, items: [] } satisfies SearchResult);

  // 同じ検索は覚えておいて返す（ニコニコへの問い合わせを抑える）
  const cacheKey = JSON.stringify([q, sort, offset]);
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_SECONDS * 1000) return searchResponse(hit.body);

  const api = new URL('https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search');
  api.search = new URLSearchParams({
    q,
    targets: 'title,description,tags',
    fields: 'contentId,title,viewCounter,commentCounter,lengthSeconds,thumbnailUrl,startTime',
    _sort: SORT_FIELD[sort],
    _offset: String(offset),
    _limit: String(SEARCH_PAGE_SIZE),
    _context: 'nico-party',
  }).toString();
  const res = await fetch(api, {
    headers: { 'user-agent': 'nico-party (https://nico-party.zuaki.dev)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => null);
  if (!res?.ok) return Response.json({ error: 'search failed' }, { status: 502 });

  const json = (await res.json().catch(() => null)) as {
    meta?: { totalCount?: number };
    data?: {
      contentId: string;
      title: string;
      thumbnailUrl?: string;
      viewCounter?: number;
      commentCounter?: number;
      lengthSeconds?: number;
      startTime?: string;
    }[];
  } | null;
  if (!json?.meta) return Response.json({ error: 'search failed' }, { status: 502 });
  const data = json.data ?? [];
  // 再生できない動画（センシティブ・外部再生禁止など）は、選べないよう事前に印を付ける
  const errors = await Promise.all(data.map((d) => fetchEmbedError(d.contentId)));
  const result: SearchResult = {
    total: json.meta.totalCount ?? 0,
    items: data.map((d, i) => ({
      videoId: d.contentId,
      title: d.title,
      thumbnail: d.thumbnailUrl,
      views: d.viewCounter,
      comments: d.commentCounter,
      length: d.lengthSeconds,
      startTime: d.startTime,
      ...(errors[i] ? { unplayable: errors[i]! } : {}),
    })),
  };
  const body = JSON.stringify(result);
  searchCache.delete(cacheKey);
  searchCache.set(cacheKey, { at: Date.now(), body });
  // 古いものから捨てる（Map は入れた順に並ぶ）
  for (const key of searchCache.keys()) {
    if (searchCache.size <= SEARCH_CACHE_MAX) break;
    searchCache.delete(key);
  }
  return searchResponse(body);
}

const searchResponse = (body: string) =>
  new Response(body, {
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${SEARCH_CACHE_SECONDS}` },
  });
