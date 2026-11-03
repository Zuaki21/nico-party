/** サーバーの環境（環境変数から作る。node/main.ts） */
export interface Env {
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  /**
   * 通行証の署名の鍵（サーバーしか知らない）。環境変数 PASS_SECRET で渡す。
   * DISCORD_CLIENT_SECRET とは別にしてあるので、どちらかを変えても、もう一方は影響を受けない
   * （これを変えると、発行済みの通行証はすべて無効になる）
   */
  PASS_SECRET: string;
  /**
   * Discord のボットトークン（環境変数 DISCORD_BOT_TOKEN）。通行証を渡す前に、
   * その人が申告した部屋（Activity インスタンス）の参加者か確かめるのに使う。未登録なら確かめない
   */
  DISCORD_BOT_TOKEN?: string;
  /**
   * 'true' のときだけ、通行証のない WebSocket 接続を受け付ける（ローカル確認用。server/.env に書く）。
   * 本番では設定しない。誤って設定されても、localhost への接続でしか効かない
   */
  ALLOW_ANON_WS?: string;
}

/** index.ts が通行証を確かめたとき、その名前（URL エンコード済み）を部屋に渡すヘッダー */
export const VERIFIED_NAME_HEADER = 'x-nico-party-verified-name';
/** 同じく、確かめられた Discord のユーザー ID を渡すヘッダー */
export const VERIFIED_UID_HEADER = 'x-nico-party-verified-uid';
