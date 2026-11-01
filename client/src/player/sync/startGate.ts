import type { StartGateContext, LoadedState } from './context';

/** 開始時刻を待つ間、一時停止を送り直す間隔 */
const HOLD_INTERVAL_MS = 300;
/** 先読みのための再生を、再生開始の通知が無くても止めるまでの時間 */
const PRELOAD_PLAY_MS = 400;

/**
 * 動画の切り替え直後、再生開始の時刻（サーバーが少し先に決める）まで待つ間の動き。
 * 動画データを先読みしてから 0 秒で止めて待ち、開始時刻ちょうどに再生する。
 *
 * ニコニコのプレイヤーは再生するまで動画データを読み込まないので、一度だけ再生して読み込みを始めさせ、
 * 再生が始まったらすぐ 0 秒に戻して止める（開始時刻に再生した瞬間に読み込みが始まって遅れるのを防ぐ）。
 * 念のためミュートもするが、環境によっては効かないので、再生している時間を最小にしている
 */
export class StartGate {
  /** 開始待ちの間、ミュートで裏再生して動画データを先読みしている */
  private preloading = false;
  /** 先読みが済んだキュー項目 */
  private preloadedFor: string | null = null;
  /** 先読みのためにミュートする前の状態（終わったら戻す） */
  private mutedBefore = false;
  private preloadStartedAt = 0;
  /** 開始時刻まで 0 秒で止めておくためのタイマー */
  private holdTimer: number | undefined;
  /** 再生開始時刻ちょうどに再生を始めるためのタイマー */
  private startTimer: number | undefined;

  constructor(private ctx: StartGateContext) {}

  /** 先読みのための再生中か（このあいだの再生・停止はユーザーの操作ではない） */
  get active() {
    return this.preloading;
  }

  /**
   * 開始時刻より前なら、先読みして待つ（開始時刻に合わせて、同期をやり直すタイマーも張る）。
   * @returns 待つことにしたなら true（呼び出し側は、これ以上同期しない）
   */
  waitIfBeforeStart(s: LoadedState, target: number): boolean {
    clearTimeout(this.startTimer);
    if (s.playing && target < 0) {
      this.preload(s.current.id);
      this.startTimer = window.setTimeout(() => this.ctx.apply(), -target * 1000);
      return true;
    }
    this.stopHold();
    // 先読みが終わる前に開始時刻になった。そのまま再生を続け、位置だけ呼び出し側で合わせる
    if (this.preloading) this.endPreload(false);
    return false;
  }

  /** 動画が切り替わった。先読みの途中なら、ミュートを元に戻して、待っていた状態を捨てる */
  reset() {
    if (this.preloading) this.ctx.player.mute(this.mutedBefore);
    this.stopHold();
    clearTimeout(this.startTimer);
    this.preloading = false;
    this.preloadedFor = null;
  }

  /**
   * 開始時刻より前ならプレイヤーを止めておく（progress・定期的な確認のたびに呼ばれる）。
   * ニコニコのプレイヤーは再生開始の通知を送らないことがあり、再生位置の通知も再生中は 2 秒おき程度なので、
   * 通知を待たずに HOLD_INTERVAL_MS ごとに一時停止を送り続ける（止まっていれば何も起きない）
   */
  holdBeforeStart() {
    const s = this.ctx.loadedState();
    const p = this.ctx.player;
    if (!s || !s.playing || this.ctx.expected(s) >= 0) {
      this.stopHold();
      return;
    }
    if (this.preloading) {
      // 再生が始まった兆候があるか、少し待ったら先読みを終えて止める（読み込みは止めた後も続く）
      const started = !p.isPaused() || p.getTime() > 0;
      if (!started && Date.now() - this.preloadStartedAt < PRELOAD_PLAY_MS) return;
      this.endPreload(true);
      this.preloadedFor = s.current.id;
      return;
    }
    // 状態の通知が当てにならないので、止まっているつもりでも一時停止を送る
    this.ctx.suppress.extend();
    p.pause();
    if (p.getTime() > 0.05) p.seek(0);
  }

  private preload(itemId: string) {
    const p = this.ctx.player;
    if (this.preloadedFor === itemId || this.preloading) {
      this.startHold();
      this.holdBeforeStart();
      return;
    }
    // 一度だけ再生して読み込みを始めさせる。止めるのは holdBeforeStart（すぐ・または少し後）
    this.preloading = true;
    this.preloadStartedAt = Date.now();
    this.mutedBefore = p.isMuted();
    this.ctx.suppress.extend();
    p.mute(true);
    p.play();
    this.startHold();
  }

  private startHold() {
    if (this.holdTimer !== undefined) return;
    this.holdTimer = window.setInterval(() => this.holdBeforeStart(), HOLD_INTERVAL_MS);
  }

  private stopHold() {
    clearInterval(this.holdTimer);
    this.holdTimer = undefined;
  }

  /** @param hold true なら 0 秒に戻して止める（開始時刻を待つ） */
  private endPreload(hold: boolean) {
    const p = this.ctx.player;
    this.preloading = false;
    this.ctx.suppress.extend();
    if (hold) {
      p.pause();
      p.seek(0);
    }
    p.mute(this.mutedBefore);
  }
}
