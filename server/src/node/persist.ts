import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TakeSaved } from './roomHost';

type Saved = Record<string, Record<string, unknown>>;

function read(file: string): Saved {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Saved) : {};
  } catch (e) {
    console.error('rooms file unreadable', e);
    return {};
  }
}

/** 全部屋の保存内容を、ファイルに書く（書きかけのファイルが残らないよう、一時ファイルに書いてから置き換える） */
export function saveRooms(file: string, rooms: Saved): void {
  if (Object.keys(rooms).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(rooms));
  renameSync(tmp, file);
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
    if (!mine) return undefined;
    delete all[roomId];
    saveRooms(file, all);
    return mine;
  };
}
