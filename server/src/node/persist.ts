import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TakeSaved } from './roomHost';

type Saved = Record<string, Record<string, unknown>>;

/** 部屋ごとに、書き出した時刻を入れておく項目（部屋の保存内容とは別。取り出すときに外す） */
const SAVED_AT = '__savedAt';
/** 書き出してから、これだけ誰も入らなかった部屋は捨てる（ファイルが増え続けないように） */
const KEEP_MS = 24 * 60 * 60 * 1000;

function read(file: string): Saved {
  try {
    const saved: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    return typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? (saved as Saved) : {};
  } catch (e) {
    console.error('rooms file unreadable', e);
    return {};
  }
}

/**
 * ファイルを丸ごと書く（書きかけのファイルが残らないよう、一時ファイルに書いてから置き換える）。空なら消す。
 * 入れ替えのときは古いプロセスと新しいプロセスが同時に書くことがあるので、一時ファイルはプロセスごとに分ける
 */
function write(file: string, rooms: Saved): void {
  if (Object.keys(rooms).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rooms));
  renameSync(tmp, file);
}

/**
 * 停止するときに、このプロセスの全部屋をファイルに書き足す。
 * 前のプロセスが書いて、まだ誰も入っていない部屋も残す（続けて再起動しても消えないように）。古すぎるものは捨てる
 */
export function saveRooms(file: string, rooms: Saved): void {
  const now = Date.now();
  const merged: Saved = {};
  for (const [id, room] of Object.entries(read(file))) {
    if (typeof room !== 'object' || room === null) continue;
    // 時刻の無いもの（この仕組みより前の版が書いたもの）は、今書いたものとして扱う
    const at = typeof room[SAVED_AT] === 'number' ? room[SAVED_AT] : now;
    if (now - at < KEEP_MS) merged[id] = { ...room, [SAVED_AT]: at };
  }
  for (const [id, room] of Object.entries(rooms)) merged[id] = { ...room, [SAVED_AT]: now };
  write(file, merged);
}

/**
 * 部屋を作るときに、保存済みの内容を取り出す（取り出したものは、ファイルから消す）。
 * 起動時にまとめて読まないのは、入れ替えのとき、古いプロセスが書き出す前に新しいプロセスが起動しているため
 * （部屋に最初の接続が来たときに読めば、古いプロセスが書いたあとになる）
 */
export function savedRooms(file: string): TakeSaved {
  return (roomId) => {
    const all = read(file);
    const mine = all[roomId];
    if (typeof mine !== 'object' || mine === null) return undefined;
    delete all[roomId];
    write(file, all);
    const { [SAVED_AT]: _savedAt, ...room } = mine;
    return room;
  };
}
