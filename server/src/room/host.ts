/**
 * 部屋（room.ts）が、動いている場所（node/roomHost.ts）に頼む窓口。
 * 部屋は、WebSocket・保存先・アラームだけをここ越しに使う。Node 以外で動かす（テストなど）ときも、これを満たせばよい。
 */

/** 部屋につながっている 1 本の WebSocket */
export interface RoomSocket {
  /** 接続の状態。1 のとき、送れる */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** 接続ごとの情報（メンバーの ID・名前など）を、この接続に持たせる */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** WebSocket の readyState が OPEN のときの値 */
export const SOCKET_OPEN = 1;

/** 部屋の保存先。値は、そのまま保存して返す（呼び出し側が、受け取ったものを書き換えない前提） */
export interface RoomStorage {
  get(keys: string[]): Promise<Map<string, unknown>>;
  /** 渡した項目を、まとめて 1 回で保存する。メモリには、呼んだ時点で反映される */
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<void>;
  deleteAll(): Promise<void>;
  /** 次に alarm を呼ぶ時刻 (ms)。予約が無ければ null */
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
}

/** 部屋が使う、動いている場所の機能 */
export interface RoomContext {
  storage: RoomStorage;
  /** 接続を、この部屋の接続として受け入れる */
  acceptWebSocket(ws: RoomSocket): void;
  /** この部屋の接続（閉じたものを含まなくてよい） */
  getWebSockets(): RoomSocket[];
}
