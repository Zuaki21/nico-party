import type { ErrorCode, Member, ServerMsg } from '../../../shared/protocol';

export interface Attachment extends Member {
  joined: boolean;
  /** 接続した時刻（入室しないまま居座る接続を切るのに使う） */
  connectedAt: number;
  /**
   * 確かめられた Discord のユーザー ID。ログインした人だけにある（これがあれば名前も確かめられている）。
   * メンバーの ID を作るのと、接続数・メッセージ量の制限の単位に使う。他のメンバーには見せない
   */
  uid?: string;
}

/** 他のメンバーに見せる項目だけにする */
export function toMember(a: Attachment): Member {
  const { joined: _joined, connectedAt: _connectedAt, uid: _uid, ...member } = a;
  return member;
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

  /** 入室済みの接続 */
  joined(exclude?: WebSocket): WebSocket[] {
    return this.open(exclude).filter((ws) => this.attachment(ws).joined);
  }

  /** 入室済みのメンバー（他のメンバーに見せない項目は除く。同じ ID の接続が重なっていたら 1 人として数える） */
  members(exclude?: WebSocket): Member[] {
    const seen = new Set<string>();
    const members: Member[] = [];
    for (const ws of this.open(exclude)) {
      const a = this.attachment(ws);
      if (!a.joined || seen.has(a.id)) continue;
      seen.add(a.id);
      members.push(toMember(a));
    }
    return members;
  }

  /** 入室済みの全員に送る（入室の途中の接続には、welcome で最新の状態を渡すので送らない） */
  broadcast(msg: ServerMsg, exclude?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.open(exclude)) {
      if (!this.attachment(ws).joined) continue;
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
