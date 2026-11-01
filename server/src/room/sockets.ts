import type { ErrorCode, Member, ServerMsg } from '../../../shared/protocol';

export interface Attachment extends Member {
  joined: boolean;
  /** 名前が Discord のものとして確かめられている */
  verified?: boolean;
  /** 確かめられた Discord のユーザー ID（メンバーの ID を作るのに使う。他のメンバーには見せない） */
  uid?: string;
}

/** 部屋につながっている WebSocket の一覧と、メンバー情報（各接続の attachment）・配信 */
export class Sockets {
  constructor(private ctx: DurableObjectState) {}

  open(exclude?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  attachment(ws: WebSocket): Attachment {
    return ws.deserializeAttachment() as Attachment;
  }

  /** 入室済みのメンバー（他のメンバーに見せない項目は除く。同じ ID の接続が重なっていたら 1 人として数える） */
  members(exclude?: WebSocket): Member[] {
    const seen = new Set<string>();
    const members: Member[] = [];
    for (const ws of this.open(exclude)) {
      const { joined, verified: _verified, uid: _uid, ...m } = this.attachment(ws);
      if (!joined || seen.has(m.id)) continue;
      seen.add(m.id);
      members.push(m);
    }
    return members;
  }

  broadcast(msg: ServerMsg, exclude?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.open(exclude)) {
      try {
        ws.send(data);
      } catch {
        // 切断済みのソケットは close ハンドラで処理される
      }
    }
  }

  broadcastMembers(exclude?: WebSocket) {
    this.broadcast({ t: 'members', members: this.members(exclude) }, exclude);
  }
}

/** 本人に送る。切断済みで送れなくても、処理は止めない */
export function send(ws: WebSocket, msg: ServerMsg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // 切断済みのソケットは close ハンドラで処理される
  }
}

/** 操作した本人にだけエラーを返す */
export function sendError(ws: WebSocket, code: ErrorCode, params?: Record<string, string>) {
  send(ws, { t: 'error', code, ...(params ? { params } : {}) });
}

/** 接続ごとのメッセージの受け付け残り（連投で保存と配信が増えないようにする） */
export class MessageLimiter {
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  /**
   * @param refillPerSec 1 秒あたりに補充される数
   * @param burst 溜められる最大数（短い間に続けて送れる数）
   */
  constructor(
    private refillPerSec: number,
    private burst: number,
  ) {}

  /** メッセージを 1 件受け付けられるか（連投されたら false） */
  take(ws: WebSocket): boolean {
    const now = Date.now();
    const b = this.buckets.get(ws) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }
}
