import { DurableObject } from 'cloudflare:workers';
import { jumpTo, reorder } from '../../shared/playlist';
import {
  HEARTBEAT,
  type ClientMsg,
  type ErrorCode,
  type Member,
  type PlaybackState,
  type QueueItem,
  type ServerMsg,
} from '../../shared/protocol';
import { parseVideoId } from '../../shared/video';
import { VERIFIED_NAME_HEADER, VERIFIED_UID_HEADER, type Env } from './env';
import { initialState } from './state';
import { parseClientMsg } from './validate';
import { sha256Hex } from './pass';
import { fetchEmbedError, fetchVideoInfo } from './nicoApi';

type LoadFailed = { itemId: string; ids: string[] };

interface Attachment extends Member {
  joined: boolean;
  /** 名前が Discord のものとして確かめられている */
  verified?: boolean;
  /** 確かめられた Discord のユーザー ID（メンバーの ID を作るのに使う。他のメンバーには見せない） */
  uid?: string;
}

/** ログインできなかった人の表示名として、クライアントが送ってくる名前（他の名前の申告は受け付けない） */
const GUEST_NAMES = ['ゲスト', 'Guest'];

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
/** 動画の追加の順番待ちが、部屋全体・1 人あたりでこれだけ溜まっていたら、新しい追加は断る */
const ENQUEUE_WAITING_LIMIT = 20;
const ENQUEUE_WAITING_PER_MEMBER = 8;
/** 1 つの接続から受け付けるメッセージの量（1 秒あたりの補充数と、溜められる最大数）。再生の操作は 1 秒に数回で足りる */
const MESSAGE_REFILL_PER_SEC = 20;
const MESSAGE_BURST = 40;

/**
 * 1部屋 (= Activity の instanceId) = 1 Durable Object。
 * WebSocket Hibernation API を使うので、誰も操作していない間はメモリから退避される。
 * 退避されても復元できるよう、再生状態・キュー・視聴履歴は storage、メンバー情報は
 * 各 WebSocket の attachment に保持する。
 */
export class Room extends DurableObject<Env> {
  /** 動画の追加を 1 件ずつ処理するための列と、順番待ちの数 */
  private enqueueChain: Promise<void> = Promise.resolve();
  private enqueueWaiting = 0;
  private enqueueWaitingBy = new Map<string, number>();
  /** 接続ごとのメッセージの受け付け残り（連投で保存と配信が増えないようにする） */
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  private cache: {
    state?: PlaybackState;
    queue?: QueueItem[];
    history?: QueueItem[];
    failed?: LoadFailed;
    failedLoaded: boolean;
  } = { failedLoaded: false };

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
    const a = ws.deserializeAttachment() as Attachment;
    if (msg.t === 'ping') {
      send(ws, { t: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
      return;
    }
    // join より前に届いた部屋の操作は受け付けない
    if (msg.t !== 'join' && !a.joined) return;
    if (!this.takeToken(ws)) return;

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
        s.playing = msg.playing;
        s.position = Math.max(0, msg.position);
        await this.commit(s, a);
        return;
      }

      case 'enqueue': {
        // 動画の追加は、受け取った順に 1 件ずつ処理する（続けて追加しても弾かず、順番どおりに並ぶ）。
        // 溜まりすぎている（自動化など）ときだけ断る
        const mine = this.enqueueWaitingBy.get(a.id) ?? 0;
        if (this.enqueueWaiting >= ENQUEUE_WAITING_LIMIT || mine >= ENQUEUE_WAITING_PER_MEMBER) {
          return sendError(ws, 'too_fast');
        }
        this.enqueueWaiting++;
        this.enqueueWaitingBy.set(a.id, mine + 1);
        const url = msg.url;
        const job = this.enqueueChain.then(() => this.enqueue(ws, a, url));
        this.enqueueChain = job
          .catch(() => {})
          .finally(() => {
            this.enqueueWaiting--;
            const left = (this.enqueueWaitingBy.get(a.id) ?? 1) - 1;
            if (left > 0) this.enqueueWaitingBy.set(a.id, left);
            else this.enqueueWaitingBy.delete(a.id);
          });
        await this.enqueueChain;
        return;
      }

      case 'remove': {
        // 再生中の動画を消したら、視聴済みには残さず、次の動画へ進める
        const current = await this.getState();
        if (current.current?.id === msg.id) {
          await this.start(current, await this.pickNext({ ...current, current: null }), a);
          return;
        }
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
          msg.id,
          msg.index,
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
        await this.putLoadFailed({ itemId: msg.itemId, ids: [...ids] });
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

  /** 動画を 1 本、再生リストに追加する（enqueue の列から 1 件ずつ呼ばれる） */
  private async enqueue(ws: WebSocket, a: Attachment, url: string) {
    const videoId = parseVideoId(url);
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

  /** この接続からのメッセージを 1 件受け付けられるか（連投されたら捨てる） */
  private takeToken(ws: WebSocket): boolean {
    const now = Date.now();
    const b = this.buckets.get(ws) ?? { tokens: MESSAGE_BURST, at: now };
    b.tokens = Math.min(MESSAGE_BURST, b.tokens + ((now - b.at) / 1000) * MESSAGE_REFILL_PER_SEC);
    b.at = now;
    this.buckets.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
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
    if (!this.cache.failedLoaded) {
      this.cache.failed = await this.ctx.storage.get<LoadFailed>(LOAD_FAILED_KEY);
      this.cache.failedLoaded = true;
    }
    return this.cache.failed;
  }

  private async putLoadFailed(failed: LoadFailed | undefined) {
    if (failed) await this.ctx.storage.put(LOAD_FAILED_KEY, failed);
    else await this.ctx.storage.delete(LOAD_FAILED_KEY);
    // 書き込めてからメモリを更新する（失敗したときに、メモリだけ新しくならないように）
    this.cache.failed = failed;
    this.cache.failedLoaded = true;
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
    await this.putLoadFailed(undefined);
    await this.start(s, await this.pickNext({ ...s, current: null }), by);
  }

  async alarm(): Promise<void> {
    if (this.sockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.cache = { failedLoaded: false };
    }
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
    this.cache.state = { ...s };
    this.broadcast({ t: 'state', state: s });
  }

  // 読み込みは、起こされてから最初の1回だけ storage に行き、あとはメモリのものを使う（書き込むときに両方更新する）。
  // 呼び出し側が受け取ったものを書き換えても、メモリの中身が勝手に変わらないようにコピーを返す
  private async getState(): Promise<PlaybackState> {
    this.cache.state ??= (await this.ctx.storage.get<PlaybackState>(STATE_KEY)) ?? initialState();
    return { ...this.cache.state };
  }

  private async getQueue(): Promise<QueueItem[]> {
    this.cache.queue ??= (await this.ctx.storage.get<QueueItem[]>(QUEUE_KEY)) ?? [];
    return [...this.cache.queue];
  }

  private async getHistory(): Promise<QueueItem[]> {
    this.cache.history ??= (await this.ctx.storage.get<QueueItem[]>(HISTORY_KEY)) ?? [];
    return [...this.cache.history];
  }

  /** 渡されたリストを保存し、キューと履歴の両方を全員に送る */
  private async putLists(lists: { queue?: QueueItem[]; history?: QueueItem[] }) {
    const entries: Record<string, QueueItem[]> = {};
    if (lists.queue) entries[QUEUE_KEY] = [...lists.queue];
    if (lists.history) entries[HISTORY_KEY] = [...lists.history];
    if (Object.keys(entries).length > 0) await this.ctx.storage.put(entries);
    if (lists.queue) this.cache.queue = entries[QUEUE_KEY];
    if (lists.history) this.cache.history = entries[HISTORY_KEY];
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
      .map(({ joined: _joined, verified: _verified, uid: _uid, ...m }) => m);
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
