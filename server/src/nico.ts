/**
 * ニコニコ埋め込みプレイヤーを Discord Activity 内で動かすための中継。
 *
 * Activity 内では Discord のプロキシ (/.proxy/...) 以外への通信が CSP でブロックされる。
 * そこで埋め込み HTML・プレイヤー JS・API の JSON・m3u8 を取得し、中の URL を
 * `/.proxy/external/<host を -- で連結>`（Discord の URL Mapping）に書き換えて返す。
 * 動画セグメント本体は Discord のプロキシが直接ニコニコから取得するので、ここは通らない。
 *
 * 書き換えルールは kikoune (https://github.com/sevenc-nanashi/kikoune) の
 * packages/backend/src/routes/nicoEdit.ts を移植したもの。
 * Copyright (c) 2024 sevenc7c — MIT License（THIRD_PARTY_NOTICES.md）
 */

import { SEARCH_PAGE_SIZE, type SearchResult, type SearchSort } from '../../shared/protocol';

export interface NicoEnv {
  DISCORD_CLIENT_ID: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const NICO_HEADERS = {
  origin: 'https://embed.nicovideo.jp',
  referer: 'https://embed.nicovideo.jp/',
};

function rewriter(host: string) {
  return (src: string) =>
    src
      .replace(
        /https?:\/\/delivery\.domand\.nicovideo\.jp\/hlsext\/(.+?)\.m3u8/g,
        host + '/.proxy/nico/delivery-domand-nicovideo-jp/hlsext/$1.m3u8',
      )
      .replace(/https?:\/\/assets\.embed\.res\.nimg\.jp\/js\/(.+?).js/g, '/nico/watch/$1')
      .replace('https://stella.nicovideo.jp', '/.proxy/nico/stella')
      .replace(/\/users/g, '/../../nico/users')
      .replace(/\/v1\/watch\/(?!non)/g, '/../../nico/v1-watch/')
      .replace(/\/v4\/watch\/(?!non)/g, '/../../nico/v4-watch/')
      .replace(
        /https?:(?:\/\/|\\\/\\\/)([^/]+?(?:\.nicovideo\.jp|\.nimg\.jp))/g,
        (_m, p1: string) => host + '/.proxy/external/' + p1.replaceAll('.', '--'),
      );
}

/** リクエストヘッダーのうち指定したものだけを引き継ぐ（無いものは送らない） */
function pick(req: Request, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = req.headers.get(n);
    if (v !== null) out[n] = v;
  }
  return out;
}

const NVAPI_HEADERS = [
  'user-agent',
  'x-access-right-key',
  'x-frontend-id',
  'x-frontend-version',
  'x-request-with',
];

const text = (body: string, type: string) =>
  new Response(body, { headers: { 'content-type': `${type}; charset=utf-8` } });

/** /nico/* を処理する。path は `/nico` を除いた残り */
export async function handleNico(req: Request, env: NicoEnv, path: string): Promise<Response> {
  const url = new URL(req.url);
  const query = url.search;
  const replace = rewriter(`https://${env.DISCORD_CLIENT_ID}.discordsays.com`);
  // User-Agent が無いとニコニコの CDN に 403 で弾かれるので、視聴者のものを引き継ぐ
  const ua = req.headers.get('user-agent') ?? DEFAULT_UA;
  const nf = (input: string, init: RequestInit = {}) =>
    fetch(input, {
      ...init,
      headers: { 'user-agent': ua, ...(init.headers as Record<string, string> | undefined) },
    });
  let m: RegExpMatchArray | null;

  // 埋め込みプレイヤーの HTML
  if (req.method === 'GET' && (m = path.match(/^\/nico-embed\/([a-z]{2}\d+)$/))) {
    const html = await nf(`https://embed.nicovideo.jp/watch/${m[1]}${query}`, {
      headers: { 'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' },
    }).then((r) => r.text());
    return text(replace(html), 'text/html');
  }

  // プレイヤーの JS
  if (req.method === 'GET' && (m = path.match(/^\/watch\/(.+)$/))) {
    const js = await nf(`https://assets.embed.res.nimg.jp/js/${m[1]}.js`).then((r) => r.text());
    return text(
      replace(js)
        .replace(/\/api\/watch/g, '/.proxy/nico/api-watch')
        .replace(/\/v1\/recommend\?/g, '/../../nico/nvapi-recommend?'),
      'application/javascript',
    );
  }

  if (req.method === 'POST' && (m = path.match(/^\/stella\/v1\/watch\/(.+)$/))) {
    const res = await nf(`https://stella.nicovideo.jp/v1/watch/${m[1]}`, {
      method: 'POST',
      headers: {
        ...pick(req, ['cookie', 'user-agent', 'x-frontend-id']),
        ...NICO_HEADERS,
        'content-type': 'application/json',
      },
      body: await req.text(),
    });
    return text(await res.text(), 'application/json');
  }

  if (req.method === 'GET' && (m = path.match(/^\/users\/(.+)$/))) {
    const body = await nf(`https://embed.nicovideo.jp/users/${m[1]}`).then((r) => r.text());
    return text(replace(body), 'application/json');
  }

  // 視聴権限 (HLS の URL を発行する API)
  if (req.method === 'POST' && (m = path.match(/^\/v1-watch\/([^/]+)\/.+$/))) {
    const res = await nf(
      `https://nvapi.nicovideo.jp/v1/watch/${m[1]}/access-rights/hls?` +
        new URLSearchParams({ actionTrackId: url.searchParams.get('actionTrackId') ?? '' }),
      {
        method: 'POST',
        headers: { ...pick(req, NVAPI_HEADERS), ...NICO_HEADERS, 'content-type': 'application/json' },
        body: await req.text(),
      },
    );
    return text(replace(await res.text()), 'application/json');
  }

  if (req.method === 'POST' && (m = path.match(/^\/v4-watch\/(.+)$/))) {
    const res = await nf(
      `https://nvapi.nicovideo.jp/v4/watch/${m[1]}?` +
        new URLSearchParams({ actionTrackId: url.searchParams.get('actionTrackId') ?? '' }),
      {
        method: 'POST',
        headers: { ...pick(req, NVAPI_HEADERS), ...NICO_HEADERS, 'content-type': 'application/json' },
        body: await req.text(),
      },
    );
    return text(replace(await res.text()), 'application/json');
  }

  if (req.method === 'GET' && (m = path.match(/^\/api-watch\/(.+)$/))) {
    const res = await nf(`https://www.nicovideo.jp/api/watch/${m[1]}${query}`, {
      headers: NICO_HEADERS,
    });
    return text(replace(await res.text()), 'application/json');
  }

  // HLS のプレイリスト（中のセグメント URL を Discord プロキシ経由に書き換える）
  if (req.method === 'GET' && (m = path.match(/^\/delivery-domand-nicovideo-jp\/(.+)$/))) {
    const res = await nf(`https://delivery.domand.nicovideo.jp/${m[1]}${query}`);
    return new Response(replace(await res.text()), {
      status: res.status,
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    });
  }

  if (req.method === 'GET' && path === '/nvapi-recommend') {
    const res = await nf(`https://nvapi.nicovideo.jp/v1/recommend${query}`);
    return text(replace(await res.text()), 'application/json');
  }

  return new Response('Not found', { status: 404 });
}

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

/** キュー表示用の動画情報を取得する。存在しない・削除された動画なら null */
export async function fetchVideoInfo(videoId: string): Promise<VideoInfo | null> {
  let xml: string;
  try {
    xml = await fetch(`https://ext.nicovideo.jp/api/getthumbinfo/${videoId}`, {
      headers: { 'user-agent': DEFAULT_UA },
    }).then((r) => r.text());
  } catch {
    return null;
  }
  if (!xml.includes('status="ok"')) return null;
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
    title: tag('title') ?? videoId,
    thumbnail: tag('thumbnail_url'),
    author: tag('user_nickname') ?? tag('ch_name'),
    views: num('view_counter'),
    comments: num('comment_num'),
    length: Number.isFinite(min) && Number.isFinite(sec) ? min * 60 + sec : undefined,
    embeddable: tag('embeddable') !== '0',
  };
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 検索結果をキャッシュする時間。スナップショット検索のデータは 1 日 1 回の更新なので短すぎなくてよい */
const SEARCH_CACHE_SECONDS = 600;

/**
 * ニコニコのスナップショット検索 API（公式）でキーワード検索する。
 * データは 1 日 1 回の更新なので、投稿されたばかりの動画は出てこない。
 * https://site.nicovideo.jp/search-api-docs/snapshot
 */
export async function searchVideos(
  req: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const sort: SearchSort = url.searchParams.get('sort') === 'new' ? 'new' : 'popular';
  const offset = Math.max(0, Math.min(1000, Number(url.searchParams.get('offset')) || 0));
  if (!q) return Response.json({ total: 0, items: [] } satisfies SearchResult);

  // 同じ検索は Cloudflare のキャッシュから返す（ニコニコへの問い合わせとリクエスト数を抑える）
  const cacheKey = new Request(
    `https://nico-party.cache/search?${new URLSearchParams({ q, sort, offset: String(offset) })}`,
  );
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const api = new URL('https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search');
  api.search = new URLSearchParams({
    q,
    targets: 'title,description,tags',
    fields: 'contentId,title,viewCounter,commentCounter,lengthSeconds,thumbnailUrl,startTime',
    _sort: sort === 'new' ? '-startTime' : '-viewCounter',
    _offset: String(offset),
    _limit: String(SEARCH_PAGE_SIZE),
    _context: 'nico-party',
  }).toString();
  const res = await fetch(api, { headers: { 'user-agent': 'nico-party (https://nico-party.zuaki.dev)' } });
  if (!res.ok) return Response.json({ error: 'search failed' }, { status: 502 });

  const json = await res.json<{
    meta: { totalCount?: number };
    data?: {
      contentId: string;
      title: string;
      thumbnailUrl?: string;
      viewCounter?: number;
      commentCounter?: number;
      lengthSeconds?: number;
      startTime?: string;
    }[];
  }>();
  const result: SearchResult = {
    total: json.meta.totalCount ?? 0,
    items: (json.data ?? []).map((d) => ({
      videoId: d.contentId,
      title: d.title,
      thumbnail: d.thumbnailUrl,
      views: d.viewCounter,
      comments: d.commentCounter,
      length: d.lengthSeconds,
      startTime: d.startTime,
    })),
  };
  const out = Response.json(result, {
    headers: { 'cache-control': `public, max-age=${SEARCH_CACHE_SECONDS}` },
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}
