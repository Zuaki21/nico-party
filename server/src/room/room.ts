import { DurableObject } from 'cloudflare:workers';
import { HEARTBEAT, type ClientMsg, type QueueItem } from '../../../shared/protocol';
import { parseVideoId } from '../../../shared/video';
import { VERIFIED_NAME_HEADER, VERIFIED_UID_HEADER, type Env } from '../env';
import { fetchEmbedError, fetchVideoInfo } from '../nico/nicoApi';
import { sha256Hex } from '../pass';
import { EnqueueQueue } from './enqueue';
import {
  addItem,
  control,
  hasRoom,
  jumpItem,
  moveItem,
  newItemId,
  nextItem,
  prevItem,
  realDeps,
  removeItem,
  setMode,
  skipUnloadable,
  type Actor,
  type Change,
  type Deps,
  type Snapshot,
} from './playback';
import { RoomStore } from './roomStore';
import { MessageLimiter, send, sendError, Sockets, type Attachment } from './sockets';
import { parseClientMsg } from './validate';

/** ログインできなかった人の表示名として、クライアントが送ってくる名前（他の名前の申告は受け付けない） */
const GUEST_NAMES = ['ゲスト', 'Guest'];
/** 全員が退出してから部屋を消すまでの猶予。通信が一瞬切れただけで再生リストが消えないように */
const EMPTY_ROOM_TTL_MS = 60_000;
/** 1 つの部屋につながれる接続の数（ほかの部屋や本番の動きに影響しないよう、極端な接続を断る） */
const MAX_CONNECTIONS = 60;
/** 受け付けるメッセージの大きさの上限（正規のメッセージは数百バイト） */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * 1部屋 (= Activity の instanceId) = 1 Durable Object。
 * WebSocket Hibernation API を使うので、誰も操作していない間はメモリから退避される。
 * 退避されても復元できるよう、再生状態・キュー・視聴履歴は storage（roomStore.ts）、
 * メンバー情報は各 WebSocket の attachment（sockets.ts）に保持する。
 * ここには、受け取ったメッセージごとの処理を置く。再生の状態遷移そのものは playback.ts の関数
 */
export class Room extends DurableObject<Env> {
  private store: RoomStore;
  private sockets: Sockets;
  /** 再生の操作などのメッセージの量の制限と、生存確認の ping の量の制限 */
  private limiter = new MessageLimiter(20, 40);
  private pingLimiter = new MessageLimiter(4, 10);
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
    if (this.sockets.open().length >= MAX_CONNECTIONS) {
      return new Response('Room is full', { status: 503 });
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
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_LENGTH) return;
    let msg: ClientMsg | null;
    try {
      msg = parseClientMsg(JSON.parse(raw));
    } catch {
      return;
    }
    if (!msg) return;
    const a = this.sockets.attachment(ws);
    if (msg.t === 'ping') {
      if (this.pingLimiter.take(ws)) send(ws, { t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
      return;
    }
    // join より前に届いた部屋の操作は受け付けない
    if (msg.t !== 'join' && !a.joined) return;
    if (!this.limiter.take(ws)) return;
    const by: Actor = { id: a.id, name: a.name };

    switch (msg.t) {
      case 'join': {
        // 入室済みのソケットから届いた join で、ID や名前が途中で変わらないようにする
        if (a.joined) return;
        // 確かめられた名前はそのまま使う。ログインできなかった人は、他の人の名前を名乗れないよう定型のゲスト名だけ受け付ける
        if (!a.verified) a.name = GUEST_NAMES.includes(msg.name) ? msg.name : 'guest';
        // 確かめられた人は、再接続しても同じメンバーとして扱えるよう、ユーザー ID と接続元の ID から決めた ID にする
        // （どちらかが分からないと作れないので、他の人の ID は名乗れない）。ログインしていない人は、毎回新しい ID
        if (a.uid && msg.clientId) a.id = (await sha256Hex(`${a.uid}:${msg.clientId}`)).slice(0, 8);
        // ID を作っている間に、同じ接続から 2 通目の join が届いていないか確かめ直す
        if (this.sockets.attachment(ws).joined) return;
        a.joined = true;
        ws.serializeAttachment(a);
        const snap = await this.snapshot();
        send(ws, {
          t: 'welcome',
          id: a.id,
          state: snap.state,
          queue: snap.queue,
          history: snap.history,
          members: this.sockets.members(),
          serverTime: Date.now(),
        });
        this.sockets.broadcastMembers();
        return;
      }

      case 'control': {
        const state = control((await this.store.getState()), msg, by, realDeps());
        if (state) await this.commit({ state });
        return;
      }

      case 'enqueue': {
        const url = msg.url;
        // 部屋の中の順番待ちは、ログインした人ごと（接続が変わっても同じ枠）に数える
        const job = this.enqueues.submit(a.uid ?? a.id, () => this.enqueue(ws, by, url));
        if (!job) return sendError(ws, 'too_fast');
        await job;
        return;
      }

      case 'remove': {
        await this.apply(removeItem, msg.id, by);
        return;
      }

      case 'move': {
        const snap = await this.snapshot();
        const change = moveItem(snap, msg.id, msg.index);
        if (change) await this.commit(change, snap);
        return;
      }

      case 'prev': {
        await this.apply(prevItem, msg.itemId, by);
        return;
      }

      case 'jump': {
        await this.apply(jumpItem, msg.id, by);
        return;
      }

      case 'next': {
        const snap = await this.snapshot();
        const change = nextItem(snap, msg, by, realDeps());
        if (change) await this.commit(change, snap);
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
        await this.store.commit({ failed: { itemId: msg.itemId, ids: [...ids] } });
        await this.skipIfNobodyLoaded(by);
        return;
      }

      case 'mode': {
        await this.commit({ state: setMode(await this.store.getState(), msg) });
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
  private async enqueue(ws: WebSocket, by: Actor, url: string) {
    const videoId = parseVideoId(url);
    if (!videoId) return sendError(ws, 'invalid_url');
    if (!hasRoom(await this.snapshot())) return sendError(ws, 'queue_full');
    const [info, embedError] = await Promise.all([fetchVideoInfo(videoId), fetchEmbedError(videoId)]);
    if (!info) return sendError(ws, 'not_found', { id: videoId });
    if (embedError) return sendError(ws, 'unplayable', { title: info.title, reason: embedError });
    if (!info.embeddable) return sendError(ws, 'not_embeddable', { title: info.title });
    const { embeddable: _embeddable, ...meta } = info;
    const item: QueueItem = { id: newItemId(), videoId, addedBy: by.name, ...meta };
    // タイトル取得の await 中に他の操作が入っている可能性があるので、取り直す
    const snap = await this.snapshot();
    if (!hasRoom(snap)) return sendError(ws, 'queue_full');
    await this.commit(addItem(snap, item, by, realDeps()), snap);
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
    const leaver = this.sockets.attachment(ws);
    await this.skipIfNobodyLoaded({ id: leaver.id, name: leaver.name }, ws);
  }

  /**
   * 部屋にいる全員が今の動画を読み込めなかったと報告していたら、その動画を再生リストから外して次へ進める
   * （視聴済みに残すと、全曲リピートで何度も読み込み直してしまうため）
   */
  private async skipIfNobodyLoaded(by: Actor, exclude?: WebSocket) {
    const snap = await this.snapshot();
    const failed = await this.store.getLoadFailed();
    if (!snap.state.current || failed?.itemId !== snap.state.current.id) return;
    const members = this.sockets.members(exclude);
    if (members.length === 0 || !members.every((m) => failed.ids.includes(m.id))) return;
    await this.commit(skipUnloadable(snap, by, realDeps()), snap, true);
  }

  private async snapshot(): Promise<Snapshot> {
    return {
      state: await this.store.getState(),
      queue: await this.store.getQueue(),
      history: await this.store.getHistory(),
    };
  }

  /** 状態遷移の関数（playback.ts）を、今の状態に当てて、変わったものを保存・配信する */
  private async apply(
    transition: (snap: Snapshot, arg: string, by: Actor, d: Deps) => Change | null,
    arg: string,
    by: Actor,
  ) {
    const snap = await this.snapshot();
    const change = transition(snap, arg, by, realDeps());
    if (change) await this.commit(change, snap);
  }

  /**
   * 変わったもの（状態・キュー・視聴済み）を、1 回の書き込みで保存してから、全員に送る。
   * 動画が切り替わったとき（clearFailed も同様）は、前の動画の読み込み失敗の記録も、同じ書き込みで消す
   */
  private async commit(change: Change, before?: Snapshot, clearFailed = false) {
    const switched = !!change.state && !!before && change.state.current?.id !== before.state.current?.id;
    const dropFailed = (clearFailed || switched) && !!(await this.store.getLoadFailed());
    await this.store.commit({ ...change, ...(dropFailed ? { failed: null } : {}) });
    // 再生リスト → 状態の順に送る（先に状態を送ると、再生中の動画が一瞬リストにも並んで見える）
    if (change.queue || change.history) {
      this.sockets.broadcast({
        t: 'queue',
        queue: change.queue ?? (await this.store.getQueue()),
        history: change.history ?? (await this.store.getHistory()),
      });
    }
    if (change.state) this.sockets.broadcast({ t: 'state', state: change.state });
  }
}
