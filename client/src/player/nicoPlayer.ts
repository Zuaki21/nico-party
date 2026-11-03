/**
 * ニコニコ埋め込みプレイヤー (embed.nicovideo.jp) の postMessage ラッパー。
 * 公式ドキュメントのない API なので、仕様は実際のメッセージを観察して合わせている。
 *   受信: loadComplete / playerStatusChange / seekStatusChange / playerMetadataChange
 *   送信: play / pause / seek (data.time はミリ秒) / mute (data.mute)
 */

export const enum PlayerStatus {
  Loading = 1,
  Playing = 2,
  Paused = 3,
  Ended = 4,
}

/** 知っている再生状態（1〜4）なら、その値。それ以外は null */
function toStatus(v: unknown): PlayerStatus | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= PlayerStatus.Loading && n <= PlayerStatus.Ended ? (n as PlayerStatus) : null;
}

/**
 * 埋め込みプレイヤーから postMessage で届く通知（非公式の API）。
 * 中身はプレイヤーの版で変わりうるので、どの項目も、使う前に型を確かめる
 */
interface PlayerMessage {
  eventName?: unknown;
  data?: PlayerEventData;
}
interface PlayerEventData {
  playerStatus?: unknown;
  seekStatus?: unknown;
  /** ミリ秒 */
  currentTime?: unknown;
  /** ミリ秒 */
  duration?: unknown;
  muted?: unknown;
  videoInfo?: { lengthInSeconds?: unknown } | null;
}

/**
 * load: 動画の読み込みが終わり操作できるようになった /
 * progress: 再生位置の通知（約 0.25 秒ごと）で位置が進んだ。再生開始の通知が来ないときでも分かる /
 * error: プレイヤーが「エラーが発生しました」の画面になった（この間は操作も位置の通知も信用しない）
 */
type PlayerEvent = 'load' | 'play' | 'pause' | 'ended' | 'seeked' | 'progress' | 'error';

type Handler = () => void;

const PLAYER_ID = 'nico-party';
/** エラー画面の間に、位置の通知がこれだけ続けて進んだら、直ったとみなす */
const RECOVER_ADVANCES = 4;

export class NicoPlayer {
  readonly iframe: HTMLIFrameElement;
  private status: PlayerStatus = PlayerStatus.Loading;
  private loaded = false;
  private errored = false;
  /** エラー画面の間に、位置が進み続けた回数（iframe 内の「プレーヤーを更新」で直ったことを見分ける） */
  private errorAdvance = { time: -1, count: 0 };
  private duration = 0;
  /** 最後に通知された再生位置 (秒) と、その受信時刻 */
  private time = 0;
  private timeAt = 0;
  /** プレイヤーが実際に通知してきた再生位置 (秒) と、その受信時刻（seek() で見かけ上動かした値とは別） */
  private reported = { time: 0, at: 0 };
  private muted = false;
  private handlers: Partial<Record<PlayerEvent, Handler[]>> = {};

  /** @param src 動画 ID から iframe の URL を作る関数 */
  constructor(
    container: HTMLElement,
    private src: (videoId: string, playerId: string) => string,
  ) {
    this.iframe = document.createElement('iframe');
    this.iframe.allow = 'autoplay; fullscreen';
    this.iframe.allowFullscreen = true;
    container.appendChild(this.iframe);
    window.addEventListener('message', this.onMessage);
  }

  /** 読み込み前の状態に戻す（ミュートは別。load では保つ） */
  private resetPlayback() {
    this.loaded = false;
    this.errored = false;
    this.errorAdvance = { time: -1, count: 0 };
    this.status = PlayerStatus.Loading;
    this.time = 0;
    this.timeAt = 0;
    this.duration = 0;
    this.reported = { time: 0, at: 0 };
  }

  load(videoId: string) {
    this.resetPlayback();
    this.iframe.src = this.src(videoId, PLAYER_ID);
  }

  unload() {
    this.resetPlayback();
    // src 属性を消すだけでは、中のページが残って再生され続ける。空のページに移して止める
    this.iframe.src = 'about:blank';
    this.muted = false;
  }

  ready() {
    return this.loaded && !this.errored;
  }

  play() {
    this.post('play');
  }

  pause() {
    this.post('pause');
  }

  mute(mute: boolean) {
    this.post('mute', { mute });
    this.muted = mute;
  }

  isMuted() {
    return this.muted;
  }

  /** @param sec 秒 */
  seek(sec: number) {
    sec = Math.max(0, sec);
    this.post('seek', { time: sec * 1000 });
    this.time = sec;
    this.timeAt = performance.now();
  }

  /** プレイヤーが最後に通知してきた再生位置と、その受信時刻 (performance.now)。まだ通知が無ければ at は 0 */
  getReported() {
    return this.reported;
  }

  /** 現在の再生位置 (秒)。通知の間隔を補間する */
  getTime() {
    if (this.status !== PlayerStatus.Playing || !this.timeAt) return this.time;
    return this.time + (performance.now() - this.timeAt) / 1000;
  }

  getDuration() {
    return this.duration;
  }

  isPaused() {
    return this.status !== PlayerStatus.Playing;
  }

  isEnded() {
    return this.status === PlayerStatus.Ended;
  }

  on(type: PlayerEvent, fn: Handler) {
    (this.handlers[type] ??= []).push(fn);
  }

  private emit(type: PlayerEvent) {
    for (const fn of this.handlers[type] ?? []) fn();
  }

  private post(eventName: string, data?: unknown) {
    this.iframe.contentWindow?.postMessage(
      { eventName, data, playerId: PLAYER_ID, sourceConnectorType: 1 },
      '*',
    );
  }

  /** エラー画面の間は、操作や再生位置を部屋に送らない（ready() が false になる） */
  private enterError() {
    this.errored = true;
    this.errorAdvance = { time: -1, count: 0 };
    this.status = PlayerStatus.Loading;
    this.emit('error');
  }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.iframe.contentWindow) return;
    const msg = e.data as PlayerMessage | null;
    if (!msg || typeof msg !== 'object') return;
    const data: PlayerEventData = msg.data && typeof msg.data === 'object' ? msg.data : {};
    // エラー画面の間に届く再生状態・位置の通知は捨てる（0 秒などの値で他の人の位置を巻き戻さないため）。
    // ただし、位置が進み続けるなら直ったとみなす（「プレーヤーを更新」で loadComplete が来ない場合に備える）
    if (this.errored && msg.eventName !== 'loadComplete' && msg.eventName !== 'error') {
      // 復帰したときに状態がずれないよう、通知は通知せずに覚えておく
      const status = toStatus(data.playerStatus);
      if (msg.eventName === 'playerStatusChange' && status !== null) this.status = status;
      if (msg.eventName === 'playerMetadataChange' && typeof data.duration === 'number' && data.duration > 0) {
        this.duration = data.duration / 1000;
      }
      if (msg.eventName === 'playerMetadataChange' && typeof data.currentTime === 'number') {
        const a = this.errorAdvance;
        a.count = data.currentTime > a.time && a.time >= 0 ? a.count + 1 : 0;
        a.time = data.currentTime;
        if (a.count >= RECOVER_ADVANCES) {
          this.errored = false;
          this.loaded = true;
          // 位置の補間の基準も、復帰した時点のものにする
          this.time = data.currentTime / 1000;
          this.timeAt = performance.now();
          this.emit('load');
        }
      }
      return;
    }

    switch (msg.eventName) {
      case 'error':
        this.enterError();
        return;

      case 'loadComplete':
        this.errored = false;
        this.loaded = true;
        this.duration = Number(data.videoInfo?.lengthInSeconds) || 0;
        this.emit('load');
        return;

      case 'playerStatusChange': {
        const s = toStatus(data.playerStatus);
        if (s === null || s === this.status) return;
        // 補間の基準を切り替え時点に更新しておく
        this.time = this.getTime();
        this.timeAt = performance.now();
        this.status = s;
        if (s === PlayerStatus.Playing) this.emit('play');
        else if (s === PlayerStatus.Paused) this.emit('pause');
        else if (s === PlayerStatus.Ended) this.emit('ended');
        return;
      }

      case 'seekStatusChange':
        // 2: シーク中 → 0: 完了
        if (Number(data.seekStatus) === 0) this.emit('seeked');
        return;

      case 'playerMetadataChange':
        // currentTime / duration はミリ秒
        if (typeof data.currentTime === 'number') {
          const prev = this.time;
          this.time = data.currentTime / 1000;
          this.timeAt = performance.now();
          this.reported = { time: this.time, at: this.timeAt };
          if (this.time > prev) this.emit('progress');
        }
        if (typeof data.duration === 'number' && data.duration > 0) {
          this.duration = data.duration / 1000;
        }
        if (typeof data.muted === 'boolean') this.muted = data.muted;
        return;

      default:
        // 名前の分からないエラー通知に備える（エラー画面で実際に届く名前を、コンソールから確認できる）
        console.debug('[nico-party] 未知のプレイヤー通知', msg.eventName, data);
        if (/error/i.test(String(msg.eventName))) this.enterError();
    }
  };
}
