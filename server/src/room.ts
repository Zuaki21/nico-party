import { DurableObject } from 'cloudflare:workers';
import {
  HEARTBEAT,
  initialState,
  jumpTo,
  parseClientMsg,
  parseVideoId,
  reorder,
  type ClientMsg,
  type ErrorCode,
  type Member,
  type PlaybackState,
  type QueueItem,
  type ServerMsg,
} from '../../shared/protocol';
import type { NicoEnv } from './nico';
import { fetchEmbedError, fetchVideoInfo } from './nicoApi';

interface Attachment extends Member {
  joined: boolean;
  /** 最後に動画を追加した時刻（連打で外部への問い合わせが増えないようにする） */
  lastEnqueueAt?: number;
}

export interface Env extends NicoEnv {
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  DISCORD_CLIENT_SECRET: string;
}

/** 動画の開始からこの時間は、自動送り（動画の終了）を受け付けない */
const AUTO_NEXT_GUARD_MS = 3000;
const STATE_KEY = 'state';
const QUEUE_KEY = 'queue';
const HISTORY_KEY = 'history';
/** 読み込めなかったと報告してきたメンバー（全員そろったら次へ進める） */
const LOAD_FAILED_KEY = 'loadFailed';
/**
 * 再生リスト全体（視聴済み + 再生中 + これから再生）の上限。
 * 超える分は動画を追加するときに古い視聴済みから消す（全曲リピートや並べ替えでは消さない）
 */
const LIST_LIMIT = 150;
/** 全員が退出してから部屋を消すまでの猶予。通信が一瞬切れただけで再生リストが消えないように */
const EMPTY_ROOM_TTL_MS = 60_000;
/**
 * 動画を切り替えたとき、再生開始をこれだけ先の時刻にする。
 * 各自のプレイヤーの読み込みに数秒かかるので、すぐ開始にすると冒頭が飛ばされてしまう
 */
const START_DELAY_MS = 3000;
/** 同じ人が動画を追加できる間隔 */
const ENQUEUE_COOLDOWN_MS = 1500;

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
    let msg: ClientMsg | null;
    try {
      msg = parseClientMsg(JSON.parse(raw));
    } catch {
      return;
    }
    if (!msg) return;
    const a = ws.deserializeAttachment() as Attachment;
    if (msg.t === 'ping') {
      send(ws, { t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
      return;
    }
    // join より前に届いた部屋の操作は受け付けない
    if (msg.t !== 'join' && !a.joined) return;

    switch (msg.t) {
      case 'join': {
        // 入室済みのソケットから届いた join で、ID や名前が途中で変わらないようにする
        if (a.joined) return;
        a.name = String(msg.name ?? '').trim().slice(0, 32) || 'guest';
        // 再接続しても同じメンバーとして扱えるよう、クライアントが決めた ID を使う
        if (typeof msg.clientId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(msg.clientId)) a.id = msg.clientId;
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
        const s = await this.getState();
        // 動画が切り替わった直後に届いた、前の動画への操作は捨てる
        if (!s.current || s.current.id !== msg.itemId) return;
        s.playing = !!msg.playing;
        const position = Number(msg.position);
        s.position = Number.isFinite(position) ? Math.max(0, position) : 0;
        await this.commit(s, a);
        return;
      }

      case 'enqueue': {
        if (a.lastEnqueueAt && Date.now() - a.lastEnqueueAt < ENQUEUE_COOLDOWN_MS) {
          return sendError(ws, 'too_fast');
        }
        a.lastEnqueueAt = Date.now();
        ws.serializeAttachment(a);
        const videoId = parseVideoId(String(msg.url ?? ''));
        if (!videoId) return sendError(ws, 'invalid_url');
        if (!(await this.hasRoom())) return sendError(ws, 'queue_full');
        const [info, embedError] = await Promise.all([
          fetchVideoInfo(videoId),
          fetchEmbedError(videoId),
        ]);
        if (!info) return sendError(ws, 'not_found', { id: videoId });
        if (embedError) return sendError(ws, 'unplayable', { title: info.title, reason: embedError });
        if (!info.embeddable) return sendError(ws, 'not_embeddable', { title: info.title });
        const { embeddable: _embeddable, ...meta } = info;
        const item: QueueItem = {
          id: newItemId(),
          videoId,
          addedBy: a.name,
          ...meta,
        };
        // タイトル取得の await 中に他の操作が入っている可能性があるので取り直す
        if (!(await this.hasRoom())) return sendError(ws, 'queue_full');
        const s = await this.getState();
        const queue = await this.getQueue();
        queue.push(item);
        // 上限を超える分は古い視聴済みから消す
        let history = await this.getHistory();
        const over = history.length + (s.current ? 1 : 0) + queue.length - LIST_LIMIT;
        if (over > 0) history = history.slice(over);
        if (s.current) {
          await this.putLists({ queue, history });
          return;
        }
        // 何も再生していなければすぐ再生する（再生リストの最後まで行った後に再生待ちへ戻した動画があれば、そちらが先）
        const next = takeNext(queue, s.shuffle);
        await this.putLists({ queue, history });
        await this.start(s, next, a);
        return;
      }

      case 'remove': {
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
        const s = await this.getState();
        const result = reorder(
          await this.getHistory(),
          s.current,
          await this.getQueue(),
          String(msg.id),
          Number(msg.index) || 0,
        );
        if (!result) return;
        await this.putLists(result);
        return;
      }

      case 'prev': {
        const s = await this.getState();
        if (!s.current || s.current.id !== msg.itemId) return;
        const history = await this.getHistory();
        const prev = history.pop();
        if (!prev) {
          // 戻る先がなければ今の動画を最初から（ID を変えて、前の再生の終了で届く next を無視できるようにする）
          await this.start(s, { ...s.current, id: newItemId() }, a);
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
        const s = await this.getState();
        if (s.current?.id === msg.id) return;
        const result = jumpTo(await this.getHistory(), s.current, await this.getQueue(), String(msg.id));
        if (!result) return;
        await this.putLists({ queue: result.queue, history: result.history });
        await this.start(s, result.current, a);
        return;
      }

      case 'next': {
        const s = await this.getState();
        // 複数人から同時に届いても1回だけ進める
        if ((s.current?.id ?? null) !== msg.itemId) return;
        // 動画が切り替わった直後の自動送りは、前の動画の終了通知が遅れて届いたものなので捨てる
        // （全員の終了通知が少しずつずれるため、次の動画の ID で届いて一気に飛んでしまう）。
        // 本当に短い動画は、クライアント側の「終わっているのに進まない」確認が進める
        if (msg.auto && Date.now() - (s.startedAt ?? 0) < AUTO_NEXT_GUARD_MS) return;
        // 1曲リピート: 最後まで再生されたときは同じ動画をもう一度（ID を変えて、重複した next を無視できるようにする）
        if (msg.auto && s.repeat === 'one' && s.current) {
          await this.start(s, { ...s.current, id: newItemId() }, a);
          return;
        }
        await this.start(s, await this.pickNext(s), a);
        return;
      }

      case 'loadFailed':
      case 'loadOk': {
        // 一人の読み込みが遅いだけで全員の動画を飛ばさないよう、部屋にいる全員が読み込めなかったときだけ次へ進める
        const s = await this.getState();
        if (!s.current || s.current.id !== msg.itemId) return;
        const prev = await this.getLoadFailed();
        const ids = new Set(prev?.itemId === msg.itemId ? prev.ids : []);
        if (msg.t === 'loadFailed') ids.add(a.id);
        else ids.delete(a.id);
        await this.ctx.storage.put(LOAD_FAILED_KEY, { itemId: msg.itemId, ids: [...ids] });
        await this.skipIfNobodyLoaded(a);
        return;
      }

      case 'mode': {
        const s = await this.getState();
        if (msg.repeat) s.repeat = msg.repeat;
        if (msg.shuffle !== undefined) s.shuffle = msg.shuffle;
        // 再生位置の基準 (updatedAt) は変えずに設定だけ配信する
        await this.putState(s);
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
      // 全員退出したら、少し待ってから部屋を破棄する（すぐ再接続してきたら残す）
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
      return;
    }
    this.broadcastMembers(ws);
    // まだ報告していなかった人が抜けて、残りが全員「読み込めなかった」になったかもしれない
    await this.skipIfNobodyLoaded(ws.deserializeAttachment() as Attachment, ws);
  }

  private async getLoadFailed() {
    return this.ctx.storage.get<{ itemId: string; ids: string[] }>(LOAD_FAILED_KEY);
  }

  /**
   * 部屋にいる全員が今の動画を読み込めなかったと報告していたら、その動画を再生リストから外して次へ進める
   * （視聴済みに残すと、全曲リピートで何度も読み込み直してしまうため）
   */
  private async skipIfNobodyLoaded(by: Attachment, exclude?: WebSocket) {
    const s = await this.getState();
    const failed = await this.getLoadFailed();
    if (!s.current || failed?.itemId !== s.current.id) return;
    const members = this.members(exclude);
    if (members.length === 0 || !members.every((m) => failed.ids.includes(m.id))) return;
    await this.ctx.storage.delete(LOAD_FAILED_KEY);
    await this.start(s, await this.pickNext({ ...s, current: null }), by);
  }

  async alarm(): Promise<void> {
    if (this.sockets().length === 0) await this.ctx.storage.deleteAll();
  }

  /** 動画をもう1本追加できるか（視聴済みは追加するときに消せるので数えない） */
  private async hasRoom() {
    const s = await this.getState();
    return (s.current ? 1 : 0) + (await this.getQueue()).length < LIST_LIMIT;
  }

  /** item の再生を先頭から始める（null なら停止）。開始時刻は START_DELAY_MS 先にする */
  private async start(s: PlaybackState, item: QueueItem | null, by: Attachment) {
    s.current = item;
    s.playing = item !== null;
    s.position = 0;
    s.startedAt = Date.now();
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
    const item = takeNext(queue, s.shuffle);
    await this.putLists({ queue, history });
    return item;
  }

  /** @param delayMs position の基準時刻を今からずらす量（再生開始を遅らせるとき） */
  private async commit(s: PlaybackState, by: Attachment, delayMs = 0) {
    s.updatedAt = Date.now() + delayMs;
    s.by = by.id;
    s.byName = by.name;
    await this.putState(s);
  }

  /** 版を進めて保存し、全員に送る */
  private async putState(s: PlaybackState) {
    s.version++;
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
      .map(({ joined: _joined, lastEnqueueAt: _last, ...m }) => m);
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

/** これから再生する動画から次の1本を取り出す。シャッフルならランダムに選ぶ */
function takeNext(queue: QueueItem[], shuffle = false): QueueItem | null {
  const index = shuffle && queue.length > 1 ? Math.floor(Math.random() * queue.length) : 0;
  return queue.splice(index, 1)[0] ?? null;
}

function send(ws: WebSocket, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

/** 操作した本人にだけエラーを返す */
function sendError(ws: WebSocket, code: ErrorCode, params?: Record<string, string>) {
  send(ws, { t: 'error', code, ...(params ? { params } : {}) });
}
