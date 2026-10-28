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

/** load: 動画の読み込みが終わり操作できるようになった */
/** progress: 再生位置の通知（約 0.25 秒ごと）で位置が進んだ。再生開始の通知が来ないときでも分かる */
type PlayerEvent = 'load' | 'play' | 'pause' | 'ended' | 'seeked' | 'progress';

type Handler = () => void;

const PLAYER_ID = 'nico-party';

export class NicoPlayer {
  readonly iframe: HTMLIFrameElement;
  private status: PlayerStatus = PlayerStatus.Loading;
  private loaded = false;
  private duration = 0;
  /** 最後に通知された再生位置 (秒) と、その受信時刻 */
  private time = 0;
  private timeAt = 0;
  /** どこまで読み込み済みか (秒) */
  private buffered = 0;
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

  load(videoId: string) {
    this.loaded = false;
    this.status = PlayerStatus.Loading;
    this.time = 0;
    this.timeAt = 0;
    this.duration = 0;
    this.buffered = 0;
    this.iframe.src = this.src(videoId, PLAYER_ID);
  }

  unload() {
    this.loaded = false;
    this.iframe.removeAttribute('src');
  }

  ready() {
    return this.loaded;
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

  /** どこまで読み込み済みか (秒) */
  getBuffered() {
    return this.buffered;
  }

  /** @param sec 秒 */
  seek(sec: number) {
    sec = Math.max(0, sec);
    this.post('seek', { time: sec * 1000 });
    this.time = sec;
    this.timeAt = performance.now();
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

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.iframe.contentWindow) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    const data = msg.data ?? {};

    switch (msg.eventName) {
      case 'loadComplete':
        this.loaded = true;
        this.duration = Number(data.videoInfo?.lengthInSeconds) || 0;
        this.emit('load');
        return;

      case 'playerStatusChange': {
        const s = Number(data.playerStatus) as PlayerStatus;
        if (s === this.status) return;
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
          if (this.time > prev) this.emit('progress');
        }
        if (typeof data.duration === 'number' && data.duration > 0) {
          this.duration = data.duration / 1000;
        }
        if (typeof data.maximumBuffered === 'number') this.buffered = data.maximumBuffered / 1000;
        if (typeof data.muted === 'boolean') this.muted = data.muted;
        return;
    }
  };
}
