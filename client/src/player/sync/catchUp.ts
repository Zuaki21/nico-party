import { APPLY_THRESHOLD } from './constants';
import type { CatchUpContext } from './context';

/** 位置が合うのを待つ上限。これを過ぎたら、合っていなくても通常の同期に任せる */
const CATCHUP_MAX_MS = 8000;
/** 位置が合うまで、この間隔でシークを送り直す */
const CATCHUP_RESEEK_MS = 1500;
const CATCHUP_POLL_MS = 200;

/**
 * 途中参加のとき、位置が合うまでの間、ミュートして画面を隠して待つ。
 *
 * 読み込んだばかりの動画を途中の位置から始めると、位置が合うまでの間、最初から再生されてしまう。
 * ニコニコのプレイヤーは再生するまで動画データを読み込まないので、先にシークしても効かない。
 * そこで、ミュートして一度再生し（動画データを読み込ませる）、再生が始まったら目的の位置へシークして、
 * プレイヤー自身が通知してきた位置が合ったら、ミュートと画面を元に戻す
 */
export class CatchUp {
  private catchingUp = false;
  private startedAt = 0;
  private seekAt = 0;
  private mutedBefore = false;
  private timer: number | undefined;

  constructor(
    private ctx: CatchUpContext,
    /** 位置が合うまでの間、プレイヤーを隠す・隠すのをやめる */
    private onCatchUp: (on: boolean) => void,
  ) {}

  get active() {
    return this.catchingUp;
  }

  begin() {
    if (this.catchingUp) return;
    const p = this.ctx.player;
    this.catchingUp = true;
    this.startedAt = Date.now();
    this.seekAt = 0;
    this.mutedBefore = p.isMuted();
    this.onCatchUp(true);
    this.ctx.suppress.extend(CATCHUP_MAX_MS + 2000);
    p.mute(true);
    p.play();
    this.timer = window.setInterval(() => this.step(), CATCHUP_POLL_MS);
  }

  /** 待っている途中でやめる（動画が切り替わったとき） */
  cancel() {
    if (this.catchingUp) this.end();
  }

  private step() {
    const s = this.ctx.loadedState();
    const p = this.ctx.player;
    if (!this.catchingUp) return;
    // 動画が変わった・止まった・読み込み直しなど、待つ前提が崩れたときは、やめて通常の同期に任せる
    if (!s || !s.playing || !p.ready()) {
      this.end();
      this.ctx.apply();
      return;
    }
    const timedOut = Date.now() - this.startedAt > CATCHUP_MAX_MS;
    const target = this.ctx.expected(s);
    const reported = p.getReported();
    const started = !p.isPaused() || reported.time > 0;
    if (!timedOut && started) {
      // プレイヤー自身が通知してきた位置で、位置が合っているかを見る（seek() 直後の見かけの値は使わない）
      const reportedAfterSeek = this.seekAt > 0 && reported.at > this.seekAt;
      if (reportedAfterSeek && Math.abs(reported.time - target) <= APPLY_THRESHOLD) {
        // 位置が合った
      } else {
        if (performance.now() - this.seekAt > CATCHUP_RESEEK_MS) {
          this.seekAt = performance.now();
          p.seek(target);
        }
        return;
      }
    } else if (!timedOut) {
      return;
    }
    this.end();
    // タイムアウトで位置が合っていないままのときは、ここでシークが入る。読み込み直後と同じく長めに無視する
    this.ctx.applyAfterLoad();
  }

  private end() {
    clearInterval(this.timer);
    this.catchingUp = false;
    // 位置が合ったので、始めるときに長く取った無視の時間を通常に戻す（残すと、合流してしばらくシークバーの操作が部屋に送られない）
    this.ctx.suppress.reset();
    this.ctx.player.mute(this.mutedBefore);
    this.onCatchUp(false);
  }
}
