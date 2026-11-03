import { HEARTBEAT } from '../../../shared/protocol';
import type { RoomContext, RoomSocket, RoomStorage } from '../room/host';
import type { Identity } from '../auth';
import { Room } from '../room/room';

/** 部屋の保存先（メモリ）とアラーム（タイマー） */
class MemoryStorage implements RoomStorage {
  readonly data = new Map<string, unknown>();
  private alarmAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private onAlarm: () => void,
    initial?: Record<string, unknown>,
  ) {
    for (const [k, v] of Object.entries(initial ?? {})) this.data.set(k, v);
  }

  async get(keys: string[]) {
    const out = new Map<string, unknown>();
    for (const k of keys) if (this.data.has(k)) out.set(k, structuredClone(this.data.get(k)));
    return out;
  }

  async put(entries: Record<string, unknown>) {
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v));
  }

  async delete(keys: string[]) {
    for (const k of keys) this.data.delete(k);
  }

  async deleteAll() {
    this.data.clear();
    this.cancelAlarm();
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async setAlarm(at: number) {
    clearTimeout(this.timer);
    this.alarmAt = at;
    this.timer = setTimeout(() => {
      this.alarmAt = null;
      this.onAlarm();
    }, Math.max(0, at - Date.now()));
    // 部屋のタイマーだけでは、プロセスを止めない（停止の合図で閉じるため）
    this.timer.unref?.();
  }

  cancelAlarm() {
    clearTimeout(this.timer);
    this.alarmAt = null;
  }
}

/** ws の WebSocket を、部屋が使う形にしたもの */
function wrapSocket(raw: import('ws').WebSocket): RoomSocket {
  return {
    get readyState() {
      return raw.readyState;
    },
    send: (data) => raw.send(data),
    close: (code, reason) => raw.close(code, reason),
  };
}

/**
 * 保存済みの中身から作り直した部屋に、誰も入らなかったときに消すまでの時間
 * （部屋の全員が退出してから消すまでの猶予と同じ。room.ts の EMPTY_ROOM_TTL_MS）
 */
const RESTORED_ROOM_TTL_MS = 60_000;

/** 部屋の準備ができるまでに届いたメッセージを、溜めておく数の上限（正規のクライアントは join の 1 通だけ） */
const MAX_EARLY_MESSAGES = 8;

interface Entry {
  room: Room;
  storage: MemoryStorage;
  sockets: Set<RoomSocket>;
}

/** 部屋の保存済みの内容を取り出す（node/persist.ts）。取り出したら、保存済みからは消す */
export type TakeSaved = (roomId: string) => Record<string, unknown> | undefined;

/** 動いている部屋の一覧。部屋の ID ごとに、部屋・保存先・接続を持つ */
export class RoomHost {
  private rooms = new Map<string, Promise<Entry>>();
  /** 部屋ごとの、部屋の準備を待っている接続の数 */
  private joining = new Map<string, number>();

  constructor(private takeSaved: TakeSaved = () => undefined) {}

  private entry(roomId: string): Promise<Entry> {
    let p = this.rooms.get(roomId);
    if (!p) {
      const created = this.create(roomId);
      this.rooms.set(roomId, created);
      // 作れなかった部屋は残さない（次の接続で作り直せるように）
      created.catch(() => {
        if (this.rooms.get(roomId) === created) this.rooms.delete(roomId);
      });
      p = created;
    }
    return p;
  }

  private async create(roomId: string): Promise<Entry> {
    const sockets = new Set<RoomSocket>();
    // アラームは、作った保存先ごとに結びつける（部屋が破棄されたあとに古い保存先のアラームが鳴っても、
    // 同じ ID で作り直された新しい部屋には効かないように）
    const saved = this.takeSaved(roomId);
    const storage: MemoryStorage = new MemoryStorage(
      () => this.onAlarm(roomId, storage).catch((err) => console.error('room alarm failed', err)),
      saved,
    );
    // 保存済みの中身から作った部屋は、誰も入らなければ消えるよう、先にアラームを張る
    // （入ってくれば、部屋のアラームの処理が、入室した人がいる部屋を残す）
    if (saved) await storage.setAlarm(Date.now() + RESTORED_ROOM_TTL_MS);
    const ctx: RoomContext = {
      id: roomId,
      storage,
      acceptWebSocket: (ws) => sockets.add(ws),
      getWebSockets: () => [...sockets],
    };
    return { room: await Room.create(ctx), storage, sockets };
  }

  private async onAlarm(roomId: string, storage: MemoryStorage) {
    // 作れなかった部屋（reject）は、もう置き場から外れているので何もしない
    const e = await this.rooms.get(roomId)?.catch(() => null);
    if (!e || e.storage !== storage) return;
    try {
      await e.room.alarm();
    } catch (err) {
      console.error('room alarm failed', err);
    }
    await this.dropIfUnused(roomId, e);
  }

  /**
   * 誰もいなくて、中身も無い部屋は、置いておく意味がないので消す。
   * 入ろうとしている接続がある部屋は消さない（消した部屋に入ってしまい、同じ ID の部屋が 2 つできないように）
   */
  private async dropIfUnused(roomId: string, e: Entry) {
    const p = this.rooms.get(roomId);
    if (!p || (await p.catch(() => null)) !== e || this.rooms.get(roomId) !== p) return;
    if ((this.joining.get(roomId) ?? 0) > 0) return;
    if (!e.room.hasConnections() && e.storage.data.size === 0) this.rooms.delete(roomId);
  }

  private countJoining(roomId: string, delta: number) {
    const n = (this.joining.get(roomId) ?? 0) + delta;
    if (n > 0) this.joining.set(roomId, n);
    else this.joining.delete(roomId);
  }

  /**
   * 認可された接続を、部屋に入れる。入れなかったら（部屋がいっぱい）false。
   * 受け取りの準備は、部屋の準備を待つ前に済ませる（待っている間に届いた join や切断を、取りこぼさないように）
   */
  async join(roomId: string, raw: import('ws').WebSocket, who: Identity): Promise<boolean> {
    const ws = wrapSocket(raw);
    /** 部屋に入ったら、その部屋。入るまでに届いたメッセージは early に溜めておく */
    let entered: Entry | null = null;
    const early: string[] = [];
    let left = false;
    const deliver = (e: Entry, text: string) => {
      e.room.webSocketMessage(ws, text).catch((err) => console.error('room message failed', err));
    };
    const leaveRoom = (e: Entry) => {
      e.room
        .webSocketClose(ws)
        .catch((err) => console.error('room close failed', err))
        .finally(() => e.sockets.delete(ws));
    };
    raw.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      // 生存確認には、部屋を通さずにすぐ返事をする
      if (text === HEARTBEAT) {
        raw.send(HEARTBEAT);
        return;
      }
      if (entered) deliver(entered, text);
      else if (early.length < MAX_EARLY_MESSAGES) early.push(text);
    });
    const leave = () => {
      if (left) return;
      left = true;
      if (entered) leaveRoom(entered);
    };
    raw.on('close', leave);
    raw.on('error', leave);

    this.countJoining(roomId, 1);
    let e: Entry;
    let accepted: boolean;
    try {
      e = await this.entry(roomId);
      // 部屋の準備を待っている間に切れていたら、入れない
      accepted = !left && (await e.room.connect(ws, who));
    } finally {
      this.countJoining(roomId, -1);
    }
    if (!accepted) {
      // この接続のために作った部屋なら、片づける
      this.dropIfUnused(roomId, e).catch((err) => console.error('room cleanup failed', err));
      // 切れていたなら、閉じるものは無い。そうでなければ部屋がいっぱい
      return left;
    }
    entered = e;
    // 部屋に入る処理の間に切れていたら、すぐ出す
    if (left) leaveRoom(e);
    else for (const text of early.splice(0)) deliver(e, text);
    return true;
  }

  /** 作り終えた部屋の一覧（作れなかった部屋は飛ばす。1 つの部屋の失敗で、停止のときの保存を止めないように） */
  private async ready(): Promise<[string, Entry][]> {
    const all = [...this.rooms];
    const settled = await Promise.allSettled(all.map(([, p]) => p));
    return settled.flatMap((r, i) => (r.status === 'fulfilled' ? [[all[i]![0], r.value] as [string, Entry]] : []));
  }

  /** 全部屋の保存内容（停止するとき、ファイルに書き出すもの） */
  async exportAll(): Promise<Record<string, Record<string, unknown>>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, e] of await this.ready()) {
      if (e.storage.data.size > 0) out[id] = Object.fromEntries(e.storage.data);
    }
    return out;
  }

  /** つながっている接続を、すべて閉じる（クライアントは繋ぎ直す） */
  async closeAll(code: number, reason: string) {
    for (const [, e] of await this.ready()) {
      for (const ws of e.sockets) ws.close(code, reason);
    }
  }

  /** 部屋の数と接続の数（確認用） */
  async stats() {
    let connections = 0;
    for (const [, e] of await this.ready()) connections += e.sockets.size;
    return { rooms: this.rooms.size, connections };
  }
}
