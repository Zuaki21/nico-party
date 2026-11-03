import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireNicoPass } from './auth';
import { asRecord, readJson } from './body';
import type { Env } from './env';
import { log } from './log';

/** 受け取るログの大きさの上限（クライアントが貯める数百行で、数十 KB） */
const LOG_BODY_MAX = 96 * 1024;
/** 1 人が 1 分間に送れる回数 */
const LOG_LIMIT_PER_MIN = 5;
/** ログのファイルがこの大きさを超えたら、古い方を .1 に回す（ディスクを使い切らないように） */
const LOG_FILE_MAX = 8 * 1024 * 1024;

const LOG_FILE = () => process.env.CLIENT_LOG_FILE ?? './data/client-logs.jsonl';

function save(line: string) {
  const file = LOG_FILE();
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > LOG_FILE_MAX) renameSync(file, `${file}.1`);
    } catch {
      // まだ無い
    }
    appendFileSync(file, `${line}\n`);
  } catch (e) {
    console.error('client log save failed', e);
  }
}

/**
 * 利用者の画面から送られた、不具合調査用のログを受け取る。通行証（nico）が要る。
 * 受け取ったら報告 ID を返す。利用者がその ID を伝えると、ファイルと標準出力から該当のログを探せる
 */
export async function receiveClientLog(request: Request, env: Env): Promise<Response> {
  const claims = await requireNicoPass(request.headers.get('x-nico-pass'), env, 'clientlog', LOG_LIMIT_PER_MIN);
  if (claims instanceof Response) return claims;
  const json = await readJson(request, LOG_BODY_MAX);
  if (json instanceof Response) return json;
  const body = asRecord(json.value);
  if (typeof body.text !== 'string') return new Response('Bad Request', { status: 400 });
  const id = crypto.randomUUID().slice(0, 8).toUpperCase();
  const short = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const entry = {
    at: new Date().toISOString(),
    id,
    uid: claims.u,
    version: short(body.version, 32),
    room: short(body.room, 128),
    reason: short(body.reason, 32),
    note: short(body.note, 1000),
    text: body.text.slice(0, LOG_BODY_MAX),
  };
  save(JSON.stringify(entry));
  log('client log', { id, uid: claims.u, bytes: entry.text.length, reason: entry.reason });
  return Response.json({ id });
}
