/**
 * ニコニコ埋め込みプレイヤーを Discord Activity 内で動かすための中継。
 *
 * Activity 内では Discord のプロキシ (/.proxy/...) 以外への通信が CSP でブロックされる。
 * そこで埋め込み HTML・プレイヤー JS・API の JSON・m3u8 を取得し、中の URL を書き換えて返す
 * （書き換えは nicoRewrite.ts、中継する経路の一覧は nicoRoutes.ts）。
 * 動画セグメント本体は Discord のプロキシが直接ニコニコから取得するので、ここは通らない。
 */

import { requireNicoPass } from '../auth';
import { BodyTooLargeError, readLimited } from '../body';
import type { Env } from '../env';
import { ConfigError } from '../pass';
import { DEFAULT_UA } from './nicoApi';
import { rewriter } from './nicoRewrite';
import { matchRoute, type Upstream } from './nicoRoutes';

/** ニコニコへの問い合わせを待つ上限（応答しない相手で、リクエストが溜まり続けないように） */
const UPSTREAM_TIMEOUT_MS = 15_000;

/** 中継してよい上流のホスト（リダイレクトの先も含めて確かめる） */
const ALLOWED_HOST = /(^|\.)(nicovideo\.jp|nimg\.jp)$/;
/** 上流の応答の大きさの上限（HLS のプレイリストやプレイヤーの JS は、数 MB 以下） */
const RESPONSE_MAX = 10 * 1024 * 1024;

/** 1 人が 1 分間にできる中継の回数（動画 1 本の再生で十数回。先読みや再読み込みを見込んで余裕を持たせる） */
const NICO_LIMIT_PER_MIN = 300;

type NicoRouteEnv = Pick<Env, 'DISCORD_CLIENT_ID' | 'PASS_SECRET'>;

/** 本文を持てない応答のステータス（本文を付けて Response を作ると例外になる） */
const NULL_BODY_STATUS = [101, 204, 205, 304];

/** 書き換えたあとの応答 */
interface Relayed {
  status: number;
  /** 書き換えた本文 */
  body: string | null;
  type: string;
}

/**
 * 覚えておく応答は、通行証の代わりにこの目印を入れて書き換える（通行証は人ごとに違うので、返すときに差し込む）。
 * 通行証と同じ形（英数字と . だけ）で、プレイヤーの JS などには現れない文字列にする
 */
const PASS_MARK = 'cachedpass.cachedpass';
/** 覚えておく時間と数（プレイヤーの JS は数 MB あるので、数を絞る） */
const RELAY_CACHE_TTL_MS = 60 * 60 * 1000;
const RELAY_CACHE_MAX = 20;
/** 取得中のものも入れておく。同時に何人が取りに来ても、ニコニコへの問い合わせと書き換えは 1 回になる */
const relayCache = new Map<string, { at: number; result: Promise<Relayed> }>();

/**
 * ニコニコからの応答を、本文だけ書き換える。上流のステータス（404・500 など）はそのまま伝える
 * （伝えないと、エラーの応答がプレイヤーには成功として届いてしまう）。
 * 想定外に大きな応答は、全部は読み込まずに null にする
 */
async function readRelayed(res: Response, up: Upstream): Promise<Relayed | null> {
  if (NULL_BODY_STATUS.includes(res.status)) return { status: res.status, body: null, type: up.type };
  let text: string;
  try {
    text = await readLimited(res, RESPONSE_MAX);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return null;
    throw e;
  }
  return { status: res.status, body: (up.rewrite ?? ((b: string) => b))(text), type: up.type };
}

/** @param pass 覚えておいた応答（PASS_MARK 入り）に差し込む、その人の通行証 */
function toResponse(r: Relayed, pass?: string): Response {
  const body = r.body !== null && pass !== undefined ? r.body.replaceAll(PASS_MARK, pass) : r.body;
  return new Response(body, { status: r.status, headers: { 'content-type': `${r.type}; charset=utf-8` } });
}

/** /nico/* を処理する。path は `/nico` を除いた残り。上流に繋がらない・時間がかかりすぎるときは 502・504 を返す */
export async function handleNico(req: Request, env: NicoRouteEnv, path: string): Promise<Response> {
  try {
    return await relay(req, env, path);
  } catch (e) {
    // 秘密の未登録など、設定の不備は、上流の不調（502）にせず、外側の 500 に任せる
    if (e instanceof ConfigError) throw e;
    // POST の本文（nicoRoutes.ts が読む）が大きすぎた
    if (e instanceof BodyTooLargeError) return new Response('Payload too large', { status: 413 });
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    if (!timedOut) console.error('nico relay failed', e);
    return new Response(timedOut ? 'Gateway timeout' : 'Bad gateway', { status: timedOut ? 504 : 502 });
  }
}

async function relay(req: Request, env: NicoRouteEnv, path: string): Promise<Response> {
  // 中継先の URL に連結するので、パスをたどって別の場所へ行ける文字（.. や %）は受け付けない
  if (!/^[\w\-./]*$/.test(path) || path.split('/').includes('..')) {
    return new Response('Not found', { status: 404 });
  }
  // 先頭の部分が通行証。ログインしていない人・回数が多すぎる人には中継しない
  const [, pass, rest = ''] = path.match(/^\/([\w-]+\.[\w-]+)(\/.*)?$/) ?? [];
  if (!pass) return new Response('Unauthorized', { status: 401 });
  const claims = await requireNicoPass(pass, env, 'nico', NICO_LIMIT_PER_MIN);
  if (claims instanceof Response) return claims;
  const matched = matchRoute(req.method, rest);
  if (!matched) return new Response('Not found', { status: 404 });

  const host = `https://${env.DISCORD_CLIENT_ID}.discordsays.com`;
  // User-Agent が無いとニコニコの CDN に 403 で弾かれるので、視聴者のものを引き継ぐ
  const ua = req.headers.get('user-agent') ?? DEFAULT_UA;
  const query = new URL(req.url).search;

  /**
   * ニコニコから取って、書き換える。取れなければ null
   * @param passInBody 書き換えた URL に入れる通行証（覚えておく応答では、目印の PASS_MARK）
   */
  const fetchRelayed = async (passInBody: string): Promise<Relayed | null> => {
    const up = await matched.route.upstream(matched.m, { req, query, rewrite: rewriter(host, passInBody) });
    const res = await fetchUpstream(up, ua);
    return res && readRelayed(res, up);
  };

  const cacheKey = matched.route.cacheKey?.(matched.m);
  if (cacheKey === undefined) {
    const r = await fetchRelayed(pass);
    return r ? toResponse(r) : new Response('Bad gateway', { status: 502 });
  }

  // 誰が取っても同じ応答は、覚えておいて返す（部屋の全員が同時に同じ動画を始めても、取得と書き換えは 1 回）
  let entry = relayCache.get(cacheKey);
  if (!entry || Date.now() - entry.at > RELAY_CACHE_TTL_MS) {
    const result = fetchRelayed(PASS_MARK).then((r) => {
      // 成功したものだけ覚える（失敗や 404 を、長い間返し続けない）
      if (!r || r.status !== 200) throw new RelayNotCached(r);
      return r;
    });
    const mine = { at: Date.now(), result };
    entry = mine;
    relayCache.set(cacheKey, mine);
    result.catch(() => {
      if (relayCache.get(cacheKey) === mine) relayCache.delete(cacheKey);
    });
    for (const key of relayCache.keys()) {
      if (relayCache.size <= RELAY_CACHE_MAX) break;
      relayCache.delete(key);
    }
  }
  try {
    return toResponse(await entry.result, pass);
  } catch (e) {
    if (!(e instanceof RelayNotCached)) throw e;
    // 覚えなかった応答（404 など）は、そのまま伝える
    return e.relayed ? toResponse(e.relayed, pass) : new Response('Bad gateway', { status: 502 });
  }
}

/** 覚えない応答（失敗・200 以外）。待っている全員に、そのまま伝える */
class RelayNotCached extends Error {
  constructor(readonly relayed: Relayed | null) {
    super('not cached');
  }
}

const REDIRECT_STATUS = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 3;

/**
 * ニコニコへ問い合わせる。リダイレクトは、行き先がニコニコのホストだと確かめてから辿る
 * （上流にオープンリダイレクトがあっても、外部のホストに問い合わせず、外部の内容を中継しない）。
 * 辿れない・行き先が許可されていないときは null
 */
async function fetchUpstream(up: Upstream, ua: string): Promise<Response | null> {
  let url = up.url;
  let init = up.init;
  // 待つ時間は、リダイレクトを含めた全体で数える（ホップごとに取り直すと、最悪で何倍も滞留する）
  const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal,
      headers: { 'user-agent': ua, ...init?.headers },
    });
    const location = res.headers.get('location');
    if (!REDIRECT_STATUS.includes(res.status) || !location) return res;
    await res.body?.cancel().catch(() => {});
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || !ALLOWED_HOST.test(next.hostname)) {
      // 上流の仕様変更で、正規の行き先が増えたときに気づけるように
      console.warn(`nico relay: refused redirect to ${next.protocol}//${next.hostname} (hop ${hop + 1})`);
      return null;
    }
    url = next.toString();
    // 307・308 以外は、GET に切り替えて本文を捨てる（通常のリダイレクトの扱い）
    if (res.status !== 307 && res.status !== 308) init = { ...init, method: 'GET', body: undefined };
  }
  console.warn(`nico relay: too many redirects from ${new URL(up.url).hostname}`);
  return null;
}
