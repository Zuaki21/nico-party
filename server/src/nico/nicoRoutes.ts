import { readLimited } from '../body';
import type { rewriter } from './nicoRewrite';

/** POST の本文の上限（プレイヤーが送るのは小さな JSON） */
const BODY_MAX = 65_536;

const NICO_HEADERS = {
  origin: 'https://embed.nicovideo.jp',
  referer: 'https://embed.nicovideo.jp/',
};

const NVAPI_HEADERS = ['x-access-right-key', 'x-frontend-id', 'x-frontend-version', 'x-request-with'];

/** ニコニコに送る問い合わせと、その応答の返し方 */
export interface Upstream {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
  /** 返す content-type */
  type: string;
  /** 応答の本文の書き換え（無ければそのまま） */
  rewrite?: (body: string) => string;
}

/** 経路が上流の問い合わせを組み立てるのに使うもの */
export interface RouteContext {
  req: Request;
  /** 元のリクエストのクエリ（? 付き。無ければ空） */
  query: string;
  rewrite: ReturnType<typeof rewriter>;
}

interface Route {
  method: 'GET' | 'POST';
  /** 通行証を除いたパスに当てる */
  path: RegExp;
  upstream(m: RegExpMatchArray, c: RouteContext): Upstream | Promise<Upstream>;
  /**
   * 誰が取っても同じ内容になる応答の、覚えておくときの名前（無ければ覚えない）。
   * 内容が公開されている変わらないもの（ファイル名に版が入ったプレイヤーの JS）だけにする
   */
  cacheKey?: (m: RegExpMatchArray) => string;
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

/** nvapi への POST（actionTrackId だけ引き継ぐ） */
const nvapiPost = async (apiPath: string, c: RouteContext): Promise<Upstream> => ({
  url:
    `https://nvapi.nicovideo.jp${apiPath}?` +
    new URLSearchParams({ actionTrackId: new URLSearchParams(c.query).get('actionTrackId') ?? '' }),
  init: {
    method: 'POST',
    headers: { ...pick(c.req, NVAPI_HEADERS), ...NICO_HEADERS, 'content-type': 'application/json' },
    body: await readLimited(c.req, BODY_MAX),
  },
  type: 'application/json',
  rewrite: c.rewrite.replace,
});

/** 中継する経路の一覧。上から順に当てる */
const ROUTES: Route[] = [
  // 埋め込みプレイヤーの HTML
  {
    method: 'GET',
    path: /^\/nico-embed\/([a-z]{2}\d+)$/,
    upstream: (m, c) => ({
      url: `https://embed.nicovideo.jp/watch/${m[1]}${c.query}`,
      init: { headers: { 'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' } },
      type: 'text/html',
      rewrite: c.rewrite.replace,
    }),
  },
  // プレイヤーの JS
  {
    method: 'GET',
    path: /^\/watch\/(.+)$/,
    cacheKey: (m) => `js:${m[1]}`,
    upstream: (m, c) => ({
      url: `https://assets.embed.res.nimg.jp/js/${m[1]}.js`,
      type: 'application/javascript',
      rewrite: c.rewrite.replaceJs,
    }),
  },
  {
    method: 'POST',
    path: /^\/stella\/v1\/watch\/(.+)$/,
    upstream: async (m, c) => ({
      url: `https://stella.nicovideo.jp/v1/watch/${m[1]}`,
      init: {
        method: 'POST',
        headers: { ...pick(c.req, ['x-frontend-id']), ...NICO_HEADERS, 'content-type': 'application/json' },
        body: await readLimited(c.req, BODY_MAX),
      },
      type: 'application/json',
    }),
  },
  {
    method: 'GET',
    path: /^\/users\/(.+)$/,
    upstream: (m, c) => ({ url: `https://embed.nicovideo.jp/users/${m[1]}`, type: 'application/json', rewrite: c.rewrite.replace }),
  },
  // 視聴権限 (HLS の URL を発行する API)
  { method: 'POST', path: /^\/v1-watch\/([\w-]+)\/.+$/, upstream: (m, c) => nvapiPost(`/v1/watch/${m[1]}/access-rights/hls`, c) },
  { method: 'POST', path: /^\/v4-watch\/(.+)$/, upstream: (m, c) => nvapiPost(`/v4/watch/${m[1]}`, c) },
  {
    method: 'GET',
    path: /^\/api-watch\/(.+)$/,
    upstream: (m, c) => ({
      url: `https://www.nicovideo.jp/api/watch/${m[1]}${c.query}`,
      init: { headers: NICO_HEADERS },
      type: 'application/json',
      rewrite: c.rewrite.replace,
    }),
  },
  // HLS のプレイリスト（中のセグメント URL を Discord プロキシ経由に書き換える）
  {
    method: 'GET',
    path: /^\/delivery-domand-nicovideo-jp\/(.+)$/,
    upstream: (m, c) => ({
      url: `https://delivery.domand.nicovideo.jp/${m[1]}${c.query}`,
      type: 'application/vnd.apple.mpegurl',
      rewrite: c.rewrite.replace,
    }),
  },
  {
    method: 'GET',
    path: /^\/nvapi-recommend$/,
    upstream: (_m, c) => ({ url: `https://nvapi.nicovideo.jp/v1/recommend${c.query}`, type: 'application/json', rewrite: c.rewrite.replace }),
  },
];

/** パス（通行証を除いたもの）に合う経路を探す */
export function matchRoute(method: string, path: string): { route: Route; m: RegExpMatchArray } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const m = path.match(route.path);
    if (m) return { route, m };
  }
  return null;
}
