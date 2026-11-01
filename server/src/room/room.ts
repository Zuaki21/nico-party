import { DurableObject } from 'cloudflare:workers';
import { CLOSE_EVICTED, HEARTBEAT, type ClientMsg, type QueueItem } from '../../../shared/protocol';
import { parseVideoId } from '../../../shared/video';
import { VERIFIED_NAME_HEADER, VERIFIED_UID_HEADER, type Env } from '../env';
import { fetchEmbedError, fetchVideoInfo, UpstreamError } from '../nico/nicoApi';
import { sha256Hex } from '../pass';
import { EnqueueQueue } from './enqueue';
import { everyoneFailed, reportLoad } from './loadReport';
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
import { MessageLimiter } from './limiter';
import { send, sendError, Sockets, type Attachment } from './sockets';
import { parseClientMsg } from './validate';

/**
 * ログインできなかった人の表示名として、クライアントが送ってくる名前（他の名前の申告は受け付けない）。
 * 本番では全員ログイン済みで通らない経路（通行証なしの接続を許すローカル確認用）
 */
const GUEST_NAMES = ['ゲスト', 'Guest'];
/** 全員が退出してから部屋を消すまでの猶予。通信が一瞬切れただけで再生リストが消えないように */
const EMPTY_ROOM_TTL_MS = 60_000;
/** 1 つの部屋につながれる接続の数（ほかの部屋や本番の動きに影響しないよう、極端な接続を断る） */
const MAX_CONNECTIONS = 60;
/**
 * 1 人（ログインしたユーザー）がつなげる接続の数。再接続の直前の古い接続が残っていても足りるようにしてある。
 * 超えたら、古い接続から切る（1 人が部屋の枠や処理量を占有できないように）
 */
const MAX_CONNECTIONS_PER_USER = 5;
/** 接続してから入室（join）するまで待つ上限。過ぎた接続は、枠を空けるため切る */
const JOIN_TIMEOUT_MS = 15_000;
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
  /** constructor の blockConcurrencyWhile で読み込む。読み込みが終わるまで、メッセージは処理されない */
  private store!: RoomStore;
  private sockets: Sockets;
  /** 再生の操作などのメッセージの量の制限（ユーザーごと）と、生存確認の ping の量の制限 */
  private limiter = new MessageLimiter(20, 40);
  private pingLimiter = new MessageLimiter(4, 10);
  /** 部屋全体の操作の量の制限（人数が多くても、保存と配信が増えすぎないように） */
  private roomLimiter = new MessageLimiter(100, 200);
  /** 届いたメッセージの量の制限。解析する前にかける（壊れたメッセージを大量に送られても、解析と処理を重ねないため） */
  private rawLimiter = new MessageLimiter(60, 120);
  private enqueues = new EnqueueQueue();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sockets = new Sockets(ctx);
    ctx.blockConcurrencyWhile(async () => {
      this.store = await RoomStore.load(ctx.storage);
    });
    // 生存確認には部屋を起こさずに自動で返事をする
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const uid = request.headers.get(VERIFIED_UID_HEADER);
    this.closeStale(uid);
    if (this.sockets.open().length >= MAX_CONNECTIONS) {
      return new Response('Room is full', { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // 入室しないまま居座る接続を、時間がたったら切る（すでにアラームがあれば、そのときに一緒に掃除する）
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + JOIN_TIMEOUT_MS + 1000);
    const verifiedName = request.headers.get(VERIFIED_NAME_HEADER);
    const attachment: Attachment = {
      // メンバーの ID はサーバーが決める（クライアントの申告にすると、他の人の ID を名乗れてしまう）
      id: crypto.randomUUID().slice(0, 8),
      name: verifiedName !== null ? Array.from(decodeURIComponent(verifiedName)).slice(0, 32).join('') : 'guest',
      joined: false,
      connectedAt: Date.now(),
      ...(verifiedName !== null && uid !== null ? { uid } : {}),
    };
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 入室しないまま居座っている接続を切る。uid があれば、同じユーザーの古い接続も、上限に収まるまで切る
   * （1 人が部屋の枠を使い切らないように。切られたクライアントは、繋ぎ直さない）
   */
  private closeStale(uid: string | null) {
    const now = Date.now();
    const mine: { ws: WebSocket; connectedAt: number; joined: boolean }[] = [];
    for (const ws of this.sockets.open()) {
      const a = this.sockets.attachment(ws);
      if (!a.joined && now - a.connectedAt > JOIN_TIMEOUT_MS) ws.close(1008, 'join timeout');
      else if (uid !== null && a.uid === uid) mine.push({ ws, connectedAt: a.connectedAt, joined: a.joined });
    }
    // これから 1 本増えるので、上限より 1 本少なくなるまで、古いものから切る
    mine.sort((x, y) => Number(x.joined) - Number(y.joined) || x.connectedAt - y.connectedAt);
    for (const { ws } of mine.slice(0, Math.max(0, mine.length - (MAX_CONNECTIONS_PER_USER - 1)))) {
      ws.close(CLOSE_EVICTED, 'too many connections');
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_LENGTH) return;
    const attachment = this.sockets.attachment(ws);
    if (!this.rawLimiter.take(attachment.uid ?? attachment.id)) return;
    let msg: ClientMsg | null;
    try {
      msg = parseClientMsg(JSON.parse(raw));
    } catch {
      return;
    }
    if (!msg) return;
    const a = this.sockets.attachment(ws);
    // 量の制限は、ログインした人ならユーザーごと（接続を何本つないでも増やせない）。そうでなければ接続ごと
    const limitKey = a.uid ?? a.id;
    if (msg.t === 'ping') {
      if (this.pingLimiter.take(limitKey)) send(ws, { t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
      return;
    }
    // join より前に届いた部屋の操作は受け付けない
    if (msg.t !== 'join' && !a.joined) return;
    if (!this.limiter.take(limitKey)) return;
    // 部屋全体の制限に断られたときは、その人の分は数えない（ほかの人の連投で、自分の枠が減らないように）
    if (!this.roomLimiter.take('room')) return this.limiter.refund(limitKey);
    const by: Actor = { id: a.id, name: a.name };

    switch (msg.t) {
      case 'join': {
        // 入室済みのソケットから届いた join で、ID や名前が途中で変わらないようにする
        if (a.joined) return;
        // 確かめられた名前はそのまま使う。ログインできなかった人は、他の人の名前を名乗れないよう定型のゲスト名だけ受け付ける
        if (!a.uid) a.name = GUEST_NAMES.includes(msg.name) ? msg.name : 'guest';
        // 確かめられた人は、再接続しても同じメンバーとして扱えるよう、ユーザー ID と接続元の ID から決めた ID にする
        // （どちらかが分からないと作れないので、他の人の ID は名乗れない）。ログインしていない人は、毎回新しい ID
        if (a.uid && msg.clientId) a.id = (await sha256Hex(`${a.uid}:${msg.clientId}`)).slice(0, 8);
        // ID を作っている間に、同じ接続から 2 通目の join が届いていないか確かめ直す
        if (this.sockets.attachment(ws).joined) return;
        a.joined = true;
        ws.serializeAttachment(a);
        const snap = this.snapshot();
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
        const state = control(this.store.getState(), msg, by, realDeps());
        if (state) await this.commit({ state });
        return;
      }

      case 'enqueue': {
        const url = msg.url;
        // 部屋の中の順番待ちは、ログインした人ごと（接続が変わっても同じ枠）に数える
        const job = this.enqueues.submit(limitKey, () => this.enqueue(ws, by, url));
        if (!job) return sendError(ws, 'too_fast');
        await job;
        return;
      }

      case 'remove':
        return this.apply((snap, d) => removeItem(snap, msg.id, by, d));

      case 'move':
        return this.apply((snap) => moveItem(snap, msg.id, msg.index));

      case 'prev':
        return this.apply((snap, d) => prevItem(snap, msg.itemId, by, d));

      case 'jump':
        return this.apply((snap, d) => jumpItem(snap, msg.id, by, d));

      case 'next':
        return this.apply((snap, d) => nextItem(snap, msg, by, d));

      case 'loadFailed':
      case 'loadOk': {
        // 一人の読み込みが遅いだけで全員の動画を飛ばさないよう、部屋にいる全員が読み込めなかったときだけ次へ進める
        const current = this.store.getState().current;
        if (!current || current.id !== msg.itemId) return;
        await this.store.setLoadFailed(reportLoad(this.store.getLoadFailed(), msg.itemId, a.id, msg.t === 'loadFailed'));
        await this.skipIfNobodyLoaded(by);
        return;
      }

      case 'mode': {
        const state = setMode(this.store.getState(), msg);
        if (state) await this.commit({ state });
        return;
      }

      default: {
        // ClientMsg に種類を足したのに、ここを直し忘れたら、型エラーになる
        const unhandled: never = msg;
        return unhandled;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onLeave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onLeave(ws);
  }

  /**
   * アラームは 2 つの用途がある。入室しない接続の掃除と、全員が退出してからの部屋の破棄。
   * 掃除のあとで、入室済みの人も入室待ちの接続もいなければ、部屋を破棄する。入室待ちが残っていれば、もう一度掃除する
   */
  async alarm(): Promise<void> {
    this.closeStale(null);
    const open = this.sockets.open();
    if (open.length === 0) await this.store.deleteAll();
    else if (open.length > this.sockets.joined().length) await this.ctx.storage.setAlarm(Date.now() + JOIN_TIMEOUT_MS + 1000);
  }

  /** 動画を 1 本、再生リストに追加する（enqueue の列から 1 件ずつ呼ばれる） */
  private async enqueue(ws: WebSocket, by: Actor, url: string) {
    const videoId = parseVideoId(url);
    if (!videoId) return sendError(ws, 'invalid_url');
    if (!hasRoom(this.snapshot())) return sendError(ws, 'queue_full');
    let info: Awaited<ReturnType<typeof fetchVideoInfo>>;
    let embedError: string | null;
    try {
      [info, embedError] = await Promise.all([fetchVideoInfo(videoId), fetchEmbedError(videoId)]);
    } catch (e) {
      if (e instanceof UpstreamError) return sendError(ws, 'upstream_error');
      throw e;
    }
    if (!info) return sendError(ws, 'not_found', { id: videoId });
    if (embedError) return sendError(ws, 'unplayable', { title: info.title, reason: embedError });
    if (!info.embeddable) return sendError(ws, 'not_embeddable', { title: info.title });
    const { embeddable: _embeddable, ...meta } = info;
    const item: QueueItem = { id: newItemId(), videoId, addedBy: by.name, ...meta };
    // ニコニコへの問い合わせの await 中に他の操作が入っている可能性があるので、取り直す
    const snap = this.snapshot();
    if (!hasRoom(snap)) return sendError(ws, 'queue_full');
    await this.commit(addItem(snap, item, by, realDeps()));
    // 追加を待っている間に全員が退出して、部屋が破棄されていたら、書き込んだデータが残る。破棄を予約し直す
    if (this.sockets.joined().length === 0) await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
  }

  private async onLeave(ws: WebSocket) {
    try {
      ws.close(1000, 'bye');
    } catch {
      // 既に閉じている
    }
    const leaver = this.sockets.attachment(ws);
    // 入室していなかった接続（入室待ちのまま切れた・掃除された）は、部屋の人に関係しない
    if (!leaver.joined) return;
    if (this.sockets.joined(ws).length === 0) {
      // 全員退出したら、少し待ってから部屋を破棄する（すぐ再接続してきたら残す）
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
      return;
    }
    this.sockets.broadcastMembers(ws);
    // まだ報告していなかった人が抜けて、残りが全員「読み込めなかった」になったかもしれない
    await this.skipIfNobodyLoaded({ id: leaver.id, name: leaver.name }, ws);
  }

  /**
   * 部屋にいる全員が今の動画を読み込めなかったと報告していたら、その動画を再生リストから外して次へ進める
   * （視聴済みに残すと、全曲リピートで何度も読み込み直してしまうため）
   */
  private async skipIfNobodyLoaded(by: Actor, exclude?: WebSocket) {
    const snap = this.snapshot();
    const memberIds = this.sockets.members(exclude).map((m) => m.id);
    if (!everyoneFailed(this.store.getLoadFailed(), snap.state.current?.id, memberIds)) return;
    await this.commit(skipUnloadable(snap, by, realDeps()));
  }

  private snapshot(): Snapshot {
    return { state: this.store.getState(), queue: this.store.getQueue(), history: this.store.getHistory() };
  }

  /** 状態遷移の関数（playback.ts）を、今の状態に当てて、変わったものを保存・配信する */
  private async apply(transition: (snap: Snapshot, d: Deps) => Change | null) {
    const change = transition(this.snapshot(), realDeps());
    if (change) await this.commit(change);
  }

  /**
   * 変わったもの（状態・キュー・視聴済み）を、1 回の書き込みで保存してから、全員に送る
   * （動画が切り替わるときの、前の動画の読み込み失敗の記録の削除も、RoomStore が同じ書き込みでやる）。
   * 状態の版は保存するときに進むので、配信するのは保存された状態
   */
  private async commit(change: Change) {
    const { state, written } = this.store.commit(change);
    // 再生リスト → 状態の順に送る（先に状態を送ると、再生中の動画が一瞬リストにも並んで見える）。
    // 書き込みの完了を待たずに送ってよい（送ったメッセージは、書き込みが終わるまで相手に届かない）。
    // 待たないので、別のメッセージの処理が間に入って、配信の順番が入れ替わることもない
    if (change.queue) this.sockets.broadcast({ t: 'queue', queue: change.queue, history: change.history });
    if (state) this.sockets.broadcast({ t: 'state', state });
    await written;
  }
}
