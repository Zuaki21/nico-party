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

  /** 入室済みのメンバー（他のメンバーに見せない項目は除く） */
  members(exclude?: WebSocket): Member[] {
    return this.open(exclude)
      .map((ws) => this.attachment(ws))
      .filter((a) => a.joined)
      .map(({ joined: _joined, verified: _verified, uid: _uid, ...m }) => m);
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

export function send(ws: WebSocket, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

/** 操作した本人にだけエラーを返す */
export function sendError(ws: WebSocket, code: ErrorCode, params?: Record<string, string>) {
  send(ws, { t: 'error', code, ...(params ? { params } : {}) });
}

/** 1 つの接続から受け付けるメッセージの量（1 秒あたりの補充数と、溜められる最大数）。再生の操作は 1 秒に数回で足りる */
const MESSAGE_REFILL_PER_SEC = 20;
const MESSAGE_BURST = 40;

/** 接続ごとのメッセージの受け付け残り（連投で保存と配信が増えないようにする） */
export class MessageLimiter {
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  /** メッセージを 1 件受け付けられるか（連投されたら false） */
  take(ws: WebSocket): boolean {
    const now = Date.now();
    const b = this.buckets.get(ws) ?? { tokens: MESSAGE_BURST, at: now };
    b.tokens = Math.min(MESSAGE_BURST, b.tokens + ((now - b.at) / 1000) * MESSAGE_REFILL_PER_SEC);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }
}
