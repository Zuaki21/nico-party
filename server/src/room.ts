import { DurableObject } from 'cloudflare:workers';
import {
  HEARTBEAT,
  initialState,
  jumpTo,
  parseVideoId,
  reorder,
  type ClientMsg,
  type Member,
  type PlaybackState,
  type QueueItem,
  type ServerMsg,
} from '../../shared/protocol';
import { fetchEmbedError, fetchVideoInfo, type NicoEnv } from './nico';

interface Attachment extends Member {
  joined: boolean;
}

export interface Env extends NicoEnv {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  DISCORD_CLIENT_SECRET: string;
}

const STATE_KEY = 'state';
const QUEUE_KEY = 'queue';
const HISTORY_KEY = 'history';
const QUEUE_LIMIT = 100;
/** 視聴済みとして残す本数 */
const HISTORY_LIMIT = 50;
/**
 * 動画を切り替えたとき、再生開始をこれだけ先の時刻にする。
 * 各自のプレイヤーの読み込みに数秒かかるので、すぐ開始にすると冒頭が飛ばされてしまう
 */
const START_DELAY_MS = 3000;

/**
 * 1部屋 (= Activity の instanceId) = 1 Durable Object。
 * WebSocket Hibernation API を使うので、誰も操作していない間はメモリから退避される。
 * 退避されても復元できるよう、再生状態・キュー・視聴履歴は storage、メンバー情報は
 * 各 WebSocket の attachment に保持する。
 */
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 生存確認には部屋を起こさずに自動で返事をする
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = {
      id: crypto.randomUUID().slice(0, 8),
      name: 'guest',
      joined: false,
    };
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const a = ws.deserializeAttachment() as Attachment;

    switch (msg.t) {
      case 'ping':
        send(ws, { t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
        return;

      case 'join': {
        a.name = String(msg.name ?? '').trim().slice(0, 32) || 'guest';
        a.joined = true;
        ws.serializeAttachment(a);
        send(ws, {
          t: 'welcome',
          id: a.id,
          state: await this.getState(),
          queue: await this.getQueue(),
          history: await this.getHistory(),
          members: this.members(),
          serverTime: Date.now(),
        });
        this.broadcastMembers();
        return;
      }

      case 'control': {
        if (!a.joined) return;
        const s = await this.getState();
        // 動画が切り替わった直後に届いた、前の動画への操作は捨てる
        if (!s.current || s.current.id !== msg.itemId) return;
        s.playing = !!msg.playing;
        s.position = Math.max(0, Number(msg.position) || 0);
        await this.commit(s, a);
        return;
      }

      case 'enqueue': {
        if (!a.joined) return;
        const videoId = parseVideoId(String(msg.url ?? ''));
        if (!videoId) {
          send(ws, { t: 'error', code: 'invalid_url' });
          return;
        }
        const queue = await this.getQueue();
        if (queue.length >= QUEUE_LIMIT) {
          send(ws, { t: 'error', code: 'queue_full' });
          return;
        }
        const [info, embedError] = await Promise.all([
          fetchVideoInfo(videoId),
          fetchEmbedError(videoId),
        ]);
        if (!info) {
          send(ws, { t: 'error', code: 'not_found', params: { id: videoId } });
          return;
        }
        if (embedError) {
          send(ws, { t: 'error', code: 'unplayable', params: { title: info.title, reason: embedError } });
          return;
        }
        if (!info.embeddable) {
          send(ws, { t: 'error', code: 'not_embeddable', params: { title: info.title } });
          return;
        }
        const { embeddable: _embeddable, ...meta } = info;
        const item: QueueItem = {
          id: newItemId(),
          videoId,
          addedBy: a.name,
          ...meta,
        };
        const s = await this.getState();
        if (!s.current) {
          // 何も再生していなければすぐ再生
          await this.start(s, item, a);
        } else {
          // タイトル取得の await 中に他の操作が入っている可能性があるので取り直す
          const latest = await this.getQueue();
          latest.push(item);
          await this.putLists({ queue: latest });
        }
        return;
      }

      case 'remove': {
        if (!a.joined) return;
        // これから再生する動画・視聴済みのどちらからでも消せる
        const queue = await this.getQueue();
        const history = await this.getHistory();
        const nextQueue = queue.filter((q) => q.id !== msg.id);
        const nextHistory = history.filter((q) => q.id !== msg.id);
        if (nextQueue.length !== queue.length || nextHistory.length !== history.length) {
          await this.putLists({ queue: nextQueue, history: nextHistory });
        }
        return;
      }

      case 'move': {
        if (!a.joined) return;
        const s = await this.getState();
        const result = reorder(
          await this.getHistory(),
          s.current,
          await this.getQueue(),
          String(msg.id),
          Number(msg.index) || 0,
        );
        if (!result) return;
        await this.putLists({ queue: result.queue, history: result.history.slice(-HISTORY_LIMIT) });
        return;
      }

      case 'prev': {
        if (!a.joined) return;
        const s = await this.getState();
        if (!s.current || s.current.id !== msg.itemId) return;
        const history = await this.getHistory();
        const prev = history.pop();
        if (!prev) {
          // 戻る先がなければ今の動画を最初から
          await this.start(s, s.current, a);
          return;
        }
        // 今の動画はキューの先頭に戻す
        const queue = await this.getQueue();
        queue.unshift(s.current);
        await this.putLists({ queue, history });
        await this.start(s, prev, a);
        return;
      }

      case 'jump': {
        if (!a.joined) return;
        const s = await this.getState();
        if (s.current?.id === msg.id) return;
        const result = jumpTo(await this.getHistory(), s.current, await this.getQueue(), String(msg.id));
        if (!result) return;
        await this.putLists({ queue: result.queue, history: result.history.slice(-HISTORY_LIMIT) });
        await this.start(s, result.current, a);
        return;
      }

      case 'next': {
        if (!a.joined) return;
        const s = await this.getState();
        // 複数人から同時に届いても1回だけ進める
        if ((s.current?.id ?? null) !== msg.itemId) return;
        // 1曲リピート: 最後まで再生されたときは同じ動画をもう一度（ID を変えて、重複した next を無視できるようにする）
        if (msg.auto && s.repeat === 'one' && s.current) {
          await this.start(s, { ...s.current, id: newItemId() }, a);
          return;
        }
        await this.start(s, await this.pickNext(s), a);
        return;
      }

      case 'mode': {
        if (!a.joined) return;
        const s = await this.getState();
        if (msg.repeat === 'off' || msg.repeat === 'all' || msg.repeat === 'one') s.repeat = msg.repeat;
        if (typeof msg.shuffle === 'boolean') s.shuffle = msg.shuffle;
        // 再生位置の基準 (updatedAt) は変えずに設定だけ配信する
        s.version++;
        await this.ctx.storage.put(STATE_KEY, s);
        this.broadcast({ t: 'state', state: s });
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onLeave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onLeave(ws);
  }

  private async onLeave(ws: WebSocket) {
    try {
      ws.close(1000, 'bye');
    } catch {
      // 既に閉じている
    }
    if (this.sockets(ws).length === 0) {
      // 全員退出したら部屋を破棄
      await this.ctx.storage.deleteAll();
      return;
    }
    this.broadcastMembers(ws);
  }

  /** item の再生を先頭から始める（null なら停止）。開始時刻は START_DELAY_MS 先にする */
  private async start(s: PlaybackState, item: QueueItem | null, by: Attachment) {
    s.current = item;
    s.playing = item !== null;
    s.position = 0;
    await this.commit(s, by, item ? START_DELAY_MS : 0);
  }

  /**
   * 今の動画を視聴済みに回し、次に再生する動画を取り出す（再生リストも保存する）。
   * 全曲リピートなら最後まで来たら最初に戻り、シャッフルならランダムに選ぶ
   */
  private async pickNext(s: PlaybackState): Promise<QueueItem | null> {
    let queue = await this.getQueue();
    let history = await this.getHistory();
    if (s.current) history.push(s.current);
    // 全曲リピート: 最後まで来たら視聴済みを全部これから再生する側に戻す
    if (queue.length === 0 && s.repeat === 'all') {
      queue = history.map((q) => ({ ...q, id: newItemId() }));
      history = [];
    }
    // シャッフル: これから再生する動画の中からランダムに選ぶ
    const index = s.shuffle && queue.length > 1 ? Math.floor(Math.random() * queue.length) : 0;
    const item = queue.splice(index, 1)[0] ?? null;
    await this.putLists({ queue, history: history.slice(-HISTORY_LIMIT) });
    return item;
  }

  /** @param delayMs position の基準時刻を今からずらす量（再生開始を遅らせるとき） */
  private async commit(s: PlaybackState, by: Attachment, delayMs = 0) {
    s.updatedAt = Date.now() + delayMs;
    s.version++;
    s.by = by.id;
    s.byName = by.name;
    await this.ctx.storage.put(STATE_KEY, s);
    this.broadcast({ t: 'state', state: s });
  }

  private async getState(): Promise<PlaybackState> {
    return (await this.ctx.storage.get<PlaybackState>(STATE_KEY)) ?? initialState();
  }

  private async getQueue(): Promise<QueueItem[]> {
    return (await this.ctx.storage.get<QueueItem[]>(QUEUE_KEY)) ?? [];
  }

  private async getHistory(): Promise<QueueItem[]> {
    return (await this.ctx.storage.get<QueueItem[]>(HISTORY_KEY)) ?? [];
  }

  /** 渡されたリストを保存し、キューと履歴の両方を全員に送る */
  private async putLists(lists: { queue?: QueueItem[]; history?: QueueItem[] }) {
    if (lists.queue) await this.ctx.storage.put(QUEUE_KEY, lists.queue);
    if (lists.history) await this.ctx.storage.put(HISTORY_KEY, lists.history);
    this.broadcast({
      t: 'queue',
      queue: lists.queue ?? (await this.getQueue()),
      history: lists.history ?? (await this.getHistory()),
    });
  }

  private sockets(exclude?: WebSocket): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN);
  }

  private members(exclude?: WebSocket): Member[] {
    return this.sockets(exclude)
      .map((ws) => ws.deserializeAttachment() as Attachment)
      .filter((a) => a.joined)
      .map(({ joined: _joined, ...m }) => m);
  }

  private broadcast(msg: ServerMsg, exclude?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets(exclude)) {
      try {
        ws.send(data);
      } catch {
        // 切断済みのソケットは close ハンドラで処理される
      }
    }
  }

  private broadcastMembers(exclude?: WebSocket) {
    this.broadcast({ t: 'members', members: this.members(exclude) }, exclude);
  }
}

function newItemId() {
  return crypto.randomUUID().slice(0, 8);
}

function send(ws: WebSocket, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}
