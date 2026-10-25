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
