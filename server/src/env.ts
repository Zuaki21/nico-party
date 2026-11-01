import type { Room } from './room/room';

/** Worker の環境（wrangler.toml の設定と、`wrangler secret put` で登録した秘密） */
export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  DISCORD_CLIENT_ID: string;
  /** 通行証の署名の鍵にも使う（サーバーしか知らない） */
  DISCORD_CLIENT_SECRET: string;
}

/** index.ts が通行証を確かめたとき、その名前（URL エンコード済み）を部屋に渡すヘッダー */
export const VERIFIED_NAME_HEADER = 'x-nico-party-verified-name';
/** 同じく、確かめられた Discord のユーザー ID を渡すヘッダー */
export const VERIFIED_UID_HEADER = 'x-nico-party-verified-uid';
