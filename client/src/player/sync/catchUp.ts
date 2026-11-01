import { APPLY_THRESHOLD } from './constants';
import type { CatchUpContext } from './context';

const MUTE_OWNER = 'catchUp';

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
  private timer: number | undefined;
  private pauseAtEnd = false;
  /** 位置が合ったので止めた。止まるのを待ってから、ミュートと覆いを元に戻す（再生したまま音が出ないように） */
  private finishing = false;
  private finishPolls = 0;

  constructor(
    private ctx: CatchUpContext,
    /** 位置が合うまでの間、プレイヤーを隠す・隠すのをやめる */
    private onCatchUp: (on: boolean) => void,
  ) {}

  get active() {
    return this.catchingUp;
  }

  /**
   * @param pauseAtEnd 一時停止中の部屋に途中参加したとき。位置が合ったら、再生をやめて止める
   *   （動画データを読み込ませるには一度再生が要る。再生しないまま seek しても効かず、位置が 0 秒のままになる）
   */
  begin(pauseAtEnd = false) {
    if (this.catchingUp) return;
    const p = this.ctx.player;
    this.pauseAtEnd = pauseAtEnd;
    this.finishing = false;
    this.finishPolls = 0;
    this.catchingUp = true;
    this.startedAt = Date.now();
    this.seekAt = 0;
    this.onCatchUp(true);
    this.ctx.suppress.extend(CATCHUP_MAX_MS + 2000);
    this.ctx.mute.on(MUTE_OWNER);
    p.play();
    this.timer = window.setInterval(() => this.step(), CATCHUP_POLL_MS);
  }

  /** 待っている途中でやめる（動画が切り替わったとき） */
  cancel() {
    // 動画が変わるので、無視する時間は新しい動画の同期に任せる（ここで取り直すと、直前に延ばした分を縮めてしまう）
    if (this.catchingUp) this.end(false);
  }

  private step() {
    if (!this.catchingUp) return;
    const s = this.ctx.loadedState();
    const p = this.ctx.player;
    // 動画が変わった・止まった・読み込み直しなど、待つ前提が崩れたときは、やめて通常の同期に任せる
    if (!s || (!s.playing && !this.pauseAtEnd) || !p.ready()) {
      this.end();
      this.ctx.apply();
      return;
    }
    // 位置合わせの途中で、部屋が再生に変わった（一時停止の部屋に入ったあと、誰かが再生した）なら、止めずに終える
    if (s.playing) this.pauseAtEnd = false;
    if (this.finishing) {
      // 止める命令を送り直しながら、止まったのを確かめてからミュートを戻す（再生通知が来ない環境でも、音を出さない）。
      // 命令が無視されても、いつまでも待たない
      this.finishPolls++;
      if ((this.finishPolls >= 2 && p.isPaused()) || this.finishPolls > 5) {
        this.end();
        this.ctx.applyAfterCatchUp();
      } else {
        p.pause();
      }
      return;
    }
    const timedOut = Date.now() - this.startedAt > CATCHUP_MAX_MS;
    const target = this.ctx.expected(s);
    const reported = p.getReported();
    const started = !p.isPaused() || reported.time > 0;
    if (!timedOut) {
      // 再生がまだ始まっていない（動画データを読み込み中）
      if (!started) return;
      // プレイヤー自身が通知してきた位置で、位置が合っているかを見る（seek() 直後の見かけの値は使わない）
      const reportedAfterSeek = this.seekAt > 0 && reported.at > this.seekAt;
      const aligned = reportedAfterSeek && Math.abs(reported.time - target) <= APPLY_THRESHOLD;
      if (!aligned) {
        if (performance.now() - this.seekAt > CATCHUP_RESEEK_MS) {
          this.seekAt = performance.now();
          p.seek(target);
        }
        return;
      }
    }
    if (this.pauseAtEnd) {
      p.pause();
      this.finishing = true;
      return;
    }
    this.end();
    // タイムアウトで位置が合っていないままのときは、ここでシークが入る。読み込み直後と同じく長めに無視する
    //（再生が始まらないままでも、位置合わせをやり直さない）
    this.ctx.applyAfterCatchUp();
  }

  /** @param resetSuppress true なら、始めるときに長く取った無視の時間を通常に戻す */
  private end(resetSuppress = true) {
    clearInterval(this.timer);
    this.catchingUp = false;
    // 位置が合ったので、始めるときに長く取った無視の時間を通常に戻す（残すと、合流してしばらくシークバーの操作が部屋に送られない）
    if (resetSuppress) this.ctx.suppress.reset();
    this.ctx.mute.off(MUTE_OWNER);
    this.onCatchUp(false);
  }
}
