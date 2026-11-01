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

import type { Env } from './env';
import { verifyPass, withinRateLimit } from './pass';
import { DEFAULT_UA } from './nicoApi';

/** ニコニコへの問い合わせを待つ上限（応答しない相手で、リクエストが溜まり続けないように） */
const UPSTREAM_TIMEOUT_MS = 15_000;

/** 1 人が 1 分間にできる中継の回数（動画 1 本の再生で十数回。先読みや再読み込みを見込んで余裕を持たせる） */
const NICO_LIMIT_PER_MIN = 300;

const NICO_HEADERS = {
  origin: 'https://embed.nicovideo.jp',
  referer: 'https://embed.nicovideo.jp/',
};

/**
 * 中継のパスは /nico/<通行証>/... の形にする。書き換えで作る中継の URL にも、必ず同じ通行証を入れる
 * （通行証のない呼び出しは受け付けないため。通行証は英数字と - _ . だけなので、置換文字列の中でそのまま使える）
 */
function rewriter(host: string, pass: string) {
  const nico = `nico/${pass}`;
  const replace = (src: string) =>
    src
      .replace(
        /https?:\/\/delivery\.domand\.nicovideo\.jp\/hlsext\/(.+?)\.m3u8/g,
        `${host}/.proxy/${nico}/delivery-domand-nicovideo-jp/hlsext/$1.m3u8`,
      )
      .replace(/https?:\/\/assets\.embed\.res\.nimg\.jp\/js\/(.+?).js/g, `/${nico}/watch/$1`)
      .replace('https://stella.nicovideo.jp', `/.proxy/${nico}/stella`)
      .replace(/\/users/g, `/../../${nico}/users`)
      .replace(/\/v1\/watch\/(?!non)/g, `/../../${nico}/v1-watch/`)
      .replace(/\/v4\/watch\/(?!non)/g, `/../../${nico}/v4-watch/`)
      .replace(
        /https?:(?:\/\/|\\\/\\\/)([^/]+?(?:\.nicovideo\.jp|\.nimg\.jp))/g,
        (_m, p1: string) => host + '/.proxy/external/' + p1.replaceAll('.', '--'),
      );
  // プレイヤーの JS だけにある、API の呼び先の書き換え（同じ通行証の入った中継の URL にする）
  const replaceJs = (src: string) =>
    replace(src)
      .replace(/\/api\/watch/g, `/.proxy/${nico}/api-watch`)
      .replace(/\/v1\/recommend\?/g, `/../../${nico}/nvapi-recommend?`);
  return { replace, replaceJs };
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
export async function handleNico(req: Request, env: Pick<Env, 'DISCORD_CLIENT_ID' | 'DISCORD_CLIENT_SECRET'>, path: string): Promise<Response> {
  // 中継先の URL に連結するので、パスをたどって別の場所へ行ける文字（.. や %）は受け付けない
  if (!/^[\w\-./]*$/.test(path) || path.split('/').includes('..')) {
    return new Response('Not found', { status: 404 });
  }
  // 先頭の部分が通行証。ログインしていない人・回数が多すぎる人には中継しない
  const passed = path.match(/^\/([\w-]+\.[\w-]+)(\/.*)?$/);
  const claims = passed && (await verifyPass(env.DISCORD_CLIENT_SECRET, 'nico', passed[1]));
  if (!passed || !claims) return new Response('Unauthorized', { status: 401 });
  if (!withinRateLimit(`nico:${claims.u}`, NICO_LIMIT_PER_MIN, 60_000)) {
    return new Response('Too many requests', { status: 429 });
  }
  const pass = passed[1];
  path = passed[2] ?? '';
  const url = new URL(req.url);
  const query = url.search;
  const { replace, replaceJs } = rewriter(`https://${env.DISCORD_CLIENT_ID}.discordsays.com`, pass);
  // User-Agent が無いとニコニコの CDN に 403 で弾かれるので、視聴者のものを引き継ぐ
  const ua = req.headers.get('user-agent') ?? DEFAULT_UA;
  const nf = (input: string, init: RequestInit = {}) =>
    fetch(input, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
    return text(replaceJs(js), 'application/javascript');
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

  /** nvapi への POST を中継する（actionTrackId だけ引き継ぐ） */
  const nvapiPost = async (apiPath: string) => {
    const res = await nf(
      `https://nvapi.nicovideo.jp${apiPath}?` +
        new URLSearchParams({ actionTrackId: url.searchParams.get('actionTrackId') ?? '' }),
      {
        method: 'POST',
        headers: { ...pick(req, NVAPI_HEADERS), ...NICO_HEADERS, 'content-type': 'application/json' },
        body: await req.text(),
      },
    );
    return text(replace(await res.text()), 'application/json');
  };

  // 視聴権限 (HLS の URL を発行する API)
  if (req.method === 'POST' && (m = path.match(/^\/v1-watch\/([^/]+)\/.+$/))) {
    return nvapiPost(`/v1/watch/${m[1]}/access-rights/hls`);
  }

  if (req.method === 'POST' && (m = path.match(/^\/v4-watch\/(.+)$/))) {
    return nvapiPost(`/v4/watch/${m[1]}`);
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
