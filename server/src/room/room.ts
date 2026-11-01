import { DurableObject } from 'cloudflare:workers';
import { jumpTo, reorder } from '../../../shared/playlist';
import { HEARTBEAT, type ClientMsg, type PlaybackState, type QueueItem } from '../../../shared/protocol';
import { parseVideoId } from '../../../shared/video';
import { EnqueueQueue } from './enqueue';
import { VERIFIED_NAME_HEADER, VERIFIED_UID_HEADER, type Env } from '../env';
import { fetchEmbedError, fetchVideoInfo } from '../nico/nicoApi';
import { sha256Hex } from '../pass';
import { advance, AUTO_NEXT_GUARD_MS, LIST_LIMIT, newItemId, START_DELAY_MS, takeNext, trimHistory } from './playback';
import { RoomStore } from './roomStore';
import { MessageLimiter, send, sendError, Sockets, type Attachment } from './sockets';
import { parseClientMsg } from './validate';

/** ログインできなかった人の表示名として、クライアントが送ってくる名前（他の名前の申告は受け付けない） */
const GUEST_NAMES = ['ゲスト', 'Guest'];
/** 全員が退出してから部屋を消すまでの猶予。通信が一瞬切れただけで再生リストが消えないように */
const EMPTY_ROOM_TTL_MS = 60_000;

/**
 * 1部屋 (= Activity の instanceId) = 1 Durable Object。
 * WebSocket Hibernation API を使うので、誰も操作していない間はメモリから退避される。
 * 退避されても復元できるよう、再生状態・キュー・視聴履歴は storage（roomStore.ts）、
 * メンバー情報は各 WebSocket の attachment（sockets.ts）に保持する。
 * ここには、受け取ったメッセージごとの処理を置く
 */
export class Room extends DurableObject<Env> {
  private store: RoomStore;
  private sockets: Sockets;
  private limiter = new MessageLimiter();
  private enqueues = new EnqueueQueue();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage);
    this.sockets = new Sockets(ctx);
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
    const verifiedName = request.headers.get(VERIFIED_NAME_HEADER);
    const uid = request.headers.get(VERIFIED_UID_HEADER);
    const attachment: Attachment = {
      // メンバーの ID はサーバーが決める（クライアントの申告にすると、他の人の ID を名乗れてしまう）
      id: crypto.randomUUID().slice(0, 8),
      name: verifiedName !== null ? decodeURIComponent(verifiedName).slice(0, 32) : 'guest',
      joined: false,
      ...(verifiedName !== null && uid !== null ? { verified: true, uid } : {}),
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
    const a = this.sockets.attachment(ws);
    if (msg.t === 'ping') {
      send(ws, { t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
      return;
    }
    // join より前に届いた部屋の操作は受け付けない
    if (msg.t !== 'join' && !a.joined) return;
    if (!this.limiter.take(ws)) return;

    switch (msg.t) {
      case 'join': {
        // 入室済みのソケットから届いた join で、ID や名前が途中で変わらないようにする
        if (a.joined) return;
        // 確かめられた名前はそのまま使う。ログインできなかった人は、他の人の名前を名乗れないよう定型のゲスト名だけ受け付ける
        if (!a.verified) a.name = GUEST_NAMES.includes(msg.name) ? msg.name : 'guest';
        // 確かめられた人は、再接続しても同じメンバーとして扱えるよう、ユーザー ID と接続元の ID から決めた ID にする
        // （どちらかが分からないと作れないので、他の人の ID は名乗れない）。ログインしていない人は、毎回新しい ID
        if (a.uid && msg.clientId) a.id = (await sha256Hex(`${a.uid}:${msg.clientId}`)).slice(0, 8);
        a.joined = true;
        ws.serializeAttachment(a);
        send(ws, {
          t: 'welcome',
          id: a.id,
          state: await this.store.getState(),
          queue: await this.store.getQueue(),
          history: await this.store.getHistory(),
          members: this.sockets.members(),
          serverTime: Date.now(),
        });
        this.sockets.broadcastMembers();
        return;
      }

      case 'control': {
        const s = await this.store.getState();
        // 動画が切り替わった直後に届いた、前の動画への操作は捨てる
        if (!s.current || s.current.id !== msg.itemId) return;
        s.playing = msg.playing;
        s.position = Math.max(0, msg.position);
        await this.commit(s, a);
        return;
      }

      case 'enqueue': {
        const url = msg.url;
        const job = this.enqueues.submit(a.id, () => this.enqueue(ws, a, url));
        if (!job) return sendError(ws, 'too_fast');
        await job;
        return;
      }

      case 'remove': {
        // 再生中の動画を消したら、視聴済みには残さず、次の動画へ進める
        const s = await this.store.getState();
        if (s.current?.id === msg.id) {
          await this.start(s, await this.pickNext({ ...s, current: null }), a);
          return;
        }
        // これから再生する動画・視聴済みのどちらからでも消せる
        const queue = await this.store.getQueue();
        const history = await this.store.getHistory();
        const nextQueue = queue.filter((q) => q.id !== msg.id);
        const nextHistory = history.filter((q) => q.id !== msg.id);
        if (nextQueue.length !== queue.length || nextHistory.length !== history.length) {
          await this.putLists({ queue: nextQueue, history: nextHistory });
        }
        return;
      }

      case 'move': {
        const s = await this.store.getState();
        const result = reorder(
          await this.store.getHistory(),
          s.current,
          await this.store.getQueue(),
          msg.id,
          msg.index,
        );
        if (!result) return;
        await this.putLists(result);
        return;
      }

      case 'prev': {
        const s = await this.store.getState();
        if (!s.current || s.current.id !== msg.itemId) return;
        const history = await this.store.getHistory();
        const prev = history.pop();
        if (!prev) {
          // 戻る先がなければ今の動画を最初から（ID を変えて、前の再生の終了で届く next を無視できるようにする）
          await this.start(s, { ...s.current, id: newItemId() }, a);
          return;
        }
        // 今の動画はキューの先頭に戻す
        const queue = await this.store.getQueue();
        queue.unshift(s.current);
        await this.putLists({ queue, history });
        await this.start(s, prev, a);
        return;
      }

      case 'jump': {
        const s = await this.store.getState();
        if (s.current?.id === msg.id) return;
        const result = jumpTo(await this.store.getHistory(), s.current, await this.store.getQueue(), msg.id);
        if (!result) return;
        await this.putLists({ queue: result.queue, history: result.history });
        await this.start(s, result.current, a);
        return;
      }

      case 'next': {
        const s = await this.store.getState();
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
        const s = await this.store.getState();
        if (!s.current || s.current.id !== msg.itemId) return;
        const prev = await this.store.getLoadFailed();
        const ids = new Set(prev?.itemId === msg.itemId ? prev.ids : []);
        if (msg.t === 'loadFailed') ids.add(a.id);
        else ids.delete(a.id);
        await this.store.putLoadFailed({ itemId: msg.itemId, ids: [...ids] });
        await this.skipIfNobodyLoaded(a);
        return;
      }

      case 'mode': {
        const s = await this.store.getState();
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

  async alarm(): Promise<void> {
    if (this.sockets.open().length === 0) await this.store.deleteAll();
  }

  /** 動画を 1 本、再生リストに追加する（enqueue の列から 1 件ずつ呼ばれる） */
  private async enqueue(ws: WebSocket, a: Attachment, url: string) {
    const videoId = parseVideoId(url);
    if (!videoId) return sendError(ws, 'invalid_url');
    if (!(await this.hasRoom())) return sendError(ws, 'queue_full');
    const [info, embedError] = await Promise.all([fetchVideoInfo(videoId), fetchEmbedError(videoId)]);
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
    const s = await this.store.getState();
    const queue = await this.store.getQueue();
    queue.push(item);
    const history = trimHistory(await this.store.getHistory(), s.current !== null, queue.length);
    if (s.current) {
      await this.putLists({ queue, history });
      return;
    }
    // 何も再生していなければすぐ再生する（再生リストの最後まで行った後に再生待ちへ戻した動画があれば、そちらが先）
    const next = takeNext(queue, s.shuffle);
    await this.putLists({ queue, history });
    await this.start(s, next, a);
  }

  private async onLeave(ws: WebSocket) {
    try {
      ws.close(1000, 'bye');
    } catch {
      // 既に閉じている
    }
    if (this.sockets.open(ws).length === 0) {
      // 全員退出したら、少し待ってから部屋を破棄する（すぐ再接続してきたら残す）
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
      return;
    }
    this.sockets.broadcastMembers(ws);
    // まだ報告していなかった人が抜けて、残りが全員「読み込めなかった」になったかもしれない
    await this.skipIfNobodyLoaded(this.sockets.attachment(ws), ws);
  }

  /**
   * 部屋にいる全員が今の動画を読み込めなかったと報告していたら、その動画を再生リストから外して次へ進める
   * （視聴済みに残すと、全曲リピートで何度も読み込み直してしまうため）
   */
  private async skipIfNobodyLoaded(by: Attachment, exclude?: WebSocket) {
    const s = await this.store.getState();
    const failed = await this.store.getLoadFailed();
    if (!s.current || failed?.itemId !== s.current.id) return;
    const members = this.sockets.members(exclude);
    if (members.length === 0 || !members.every((m) => failed.ids.includes(m.id))) return;
    await this.store.putLoadFailed(undefined);
    await this.start(s, await this.pickNext({ ...s, current: null }), by);
  }

  /** 動画をもう1本追加できるか（視聴済みは追加するときに消せるので数えない） */
  private async hasRoom() {
    const s = await this.store.getState();
    return (s.current ? 1 : 0) + (await this.store.getQueue()).length < LIST_LIMIT;
  }

  /** item の再生を先頭から始める（null なら停止）。開始時刻は START_DELAY_MS 先にする */
  private async start(s: PlaybackState, item: QueueItem | null, by: Attachment) {
    s.current = item;
    s.playing = item !== null;
    s.position = 0;
    s.startedAt = Date.now();
    await this.commit(s, by, item ? START_DELAY_MS : 0);
  }

  /** 今の動画を視聴済みに回し、次に再生する動画を取り出す（再生リストも保存する） */
  private async pickNext(s: PlaybackState): Promise<QueueItem | null> {
    const { item, queue, history } = advance(s, await this.store.getQueue(), await this.store.getHistory());
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
    await this.store.putState(s);
    this.sockets.broadcast({ t: 'state', state: s });
  }

  /** 渡されたリストを保存し、キューと履歴の両方を全員に送る */
  private async putLists(lists: { queue?: QueueItem[]; history?: QueueItem[] }) {
    await this.store.putLists(lists);
    this.sockets.broadcast({
      t: 'queue',
      queue: lists.queue ?? (await this.store.getQueue()),
      history: lists.history ?? (await this.store.getHistory()),
    });
  }
}
