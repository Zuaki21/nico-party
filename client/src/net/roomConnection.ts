import { CLOSE_EVICTED, HEARTBEAT, type ClientMsg, type ServerMsg } from '../../../shared/protocol';
import { ClockSync } from './clock';
import { backend } from '../core/env';

/**
 * 接続の生存確認の間隔。何も流れない WebSocket は途中で切られることがあるので送っておく。
 * サーバー側は部屋を通さずにすぐ返す
 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** これだけ何も届かなければ、半開きで死んだ接続とみなして張り直す（生存確認の応答も届くので、通常は 30 秒以内に何か届く） */
const SILENCE_LIMIT_MS = HEARTBEAT_INTERVAL_MS * 2 + 5_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const RECONNECT_MAX_MS = 10_000;
/** 接続を始めてから、つながる（OPEN になる）までに待つ上限。途中で止まったまま onclose も来ないときのため */
const CONNECT_TIMEOUT_MS = 15_000;
/** 接続前に溜めておく操作（動画の追加）の上限と有効期限 */
const PENDING_LIMIT = 5;
const PENDING_TTL_MS = 30_000;

export interface RoomConnectionOptions {
  roomId: string;
  name: string;
  /** 再接続しても同じメンバーとして扱ってもらうための ID（ページを開き直すと変わる） */
  clientId: string;
  /** サーバーが名前を確かめた通行証（無いと、名前はゲスト扱いになる） */
  pass?: string;
  /** サーバーからのメッセージ（welcome の時点で入室済みになっている） */
  onMessage: (msg: ServerMsg) => void;
  /** 部屋に入っていない間に溜まっている操作の数が変わった（切断中・接続中の表示用） */
  onWaiting: (waiting: number) => void;
  /** 同じユーザーの別の接続が増えて、この接続が切られた（画面に戻るなどするまで、自動では繋ぎ直さない） */
  onEvicted?: () => void;
}

/**
 * 部屋との WebSocket 接続。再接続・生存確認・時計合わせ・接続前の操作の保留をまとめて持つ。
 */
export class RoomConnection {
  readonly clock = new ClockSync();
  private ws: WebSocket | null = null;
  /** welcome を受け取り、部屋に入れている */
  private joined = false;
  private pending: { msg: ClientMsg; at: number }[] = [];
  private retry = 0;
  private lastReceivedAt = 0;
  private reconnectTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private watchdogTimer: number | undefined;
  private connectTimer: number | undefined;
  private pingTimers: number[] = [];

  constructor(private opts: RoomConnectionOptions) {
    // 画面に戻ったとき・ネットワークが戻ったときは、待たずにすぐ繋ぎ直す
    const wake = () => {
      if (!this.ws) this.reconnectNow();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
    window.addEventListener('online', wake);
  }

  start() {
    this.open();
  }

  /** 同期エンジンからの送信。部屋に入っていないときの再生操作は意味がないので捨てる */
  send(msg: ClientMsg) {
    if (this.joined) this.sendRaw(msg);
  }

  /**
   * ユーザー操作。接続前なら、動画の追加だけ取っておく。
   * 次へ・戻る・削除などは、再接続したときには部屋の状態が変わっていて意図しない操作になるので捨てる
   * @returns 受け付けたか
   */
  request(msg: ClientMsg): boolean {
    if (this.joined) {
      this.sendRaw(msg);
      return true;
    }
    if (msg.t !== 'enqueue' || this.livePending().length >= PENDING_LIMIT) return false;
    this.pending.push({ msg, at: Date.now() });
    this.opts.onWaiting(this.pending.length);
    return true;
  }

  private livePending() {
    const now = Date.now();
    this.pending = this.pending.filter((p) => now - p.at < PENDING_TTL_MS);
    return this.pending;
  }

  private sendRaw(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ping() {
    this.sendRaw({ t: 'ping', clientTime: Date.now() });
  }

  private open() {
    const { roomId, name, clientId } = this.opts;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = this.opts.pass ? `?pass=${encodeURIComponent(this.opts.pass)}` : '';
    const sock = new WebSocket(`${scheme}://${location.host}${backend(`/ws/${roomId}`)}${query}`);
    this.ws = sock;
    // つながらないまま止まったら、あきらめて繋ぎ直す（そうしないと、this.ws が残って、画面に戻っても繋ぎ直されない）
    this.connectTimer = window.setTimeout(() => {
      if (sock.readyState !== WebSocket.OPEN) this.drop(sock);
    }, CONNECT_TIMEOUT_MS);

    sock.onopen = () => {
      clearTimeout(this.connectTimer);
      this.retry = 0;
      this.lastReceivedAt = Date.now();
      this.clock.reset();
      this.sendRaw({ t: 'join', name, clientId });
      // 時計のずれは接続直後に数回測るだけにする（短時間ではほとんど変わらないため）。
      // 定期的に測り直すと、サーバーへのメッセージが増え続ける
      this.pingTimers = [0, 1, 2, 3].map((i) => window.setTimeout(() => this.ping(), i * 300));
      this.heartbeatTimer = window.setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) sock.send(HEARTBEAT);
      }, HEARTBEAT_INTERVAL_MS);
      this.watchdogTimer = window.setInterval(() => {
        if (Date.now() - this.lastReceivedAt > SILENCE_LIMIT_MS) this.drop(sock);
      }, WATCHDOG_INTERVAL_MS);
    };

    sock.onmessage = (e) => {
      this.lastReceivedAt = Date.now();
      if (e.data === HEARTBEAT) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'pong') this.clock.sample(msg.clientTime, msg.serverTime);
      if (msg.t === 'welcome') {
        this.clock.provisional(msg.serverTime);
        this.joined = true;
      }
      this.opts.onMessage(msg);
      if (msg.t === 'welcome') {
        const queued = this.livePending();
        this.pending = [];
        for (const p of queued) this.sendRaw(p.msg);
      }
    };

    sock.onclose = (e) => (e.code === CLOSE_EVICTED ? this.evicted(sock) : this.drop(sock));
  }

  /** 次に繋ぎ直すときに使う通行証に差し替える（有効期限が切れる前に取り直したもの） */
  setPass(pass: string) {
    this.opts.pass = pass;
  }

  /** 追い出された。タイマーでは繋ぎ直さない（画面に戻る・ネットワークが戻るなどの、利用者の動きがあれば繋ぐ） */
  private evicted(sock: WebSocket) {
    if (this.ws !== sock) return;
    sock.onclose = null;
    sock.onmessage = null;
    this.clearTimers();
    this.ws = null;
    this.joined = false;
    this.opts.onWaiting(this.livePending().length);
    this.opts.onEvicted?.();
  }

  /** 接続が切れた（または死んでいる）ので片付けて、少し待ってから繋ぎ直す */
  private drop(sock: WebSocket) {
    if (this.ws !== sock) return;
    sock.onclose = null;
    sock.onmessage = null;
    try {
      sock.close();
    } catch {
      // 既に閉じている
    }
    this.clearTimers();
    this.ws = null;
    this.joined = false;
    this.opts.onWaiting(this.livePending().length);
    // 全員が同時に再接続して集中しないよう、待ち時間に揺らぎを持たせる
    const delay = Math.min(RECONNECT_MAX_MS, 500 * 2 ** this.retry++) * (0.5 + Math.random() * 0.5);
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private reconnectNow() {
    clearTimeout(this.reconnectTimer);
    this.retry = 0;
    this.open();
  }

  private clearTimers() {
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.watchdogTimer);
    for (const t of this.pingTimers) clearTimeout(t);
    this.pingTimers = [];
  }
}
