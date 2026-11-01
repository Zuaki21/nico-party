/** プレイヤーをクリックした（フォーカスが移った）あと、ユーザー操作とみなす時間 */
const INTERACT_MS = 5000;
/**
 * ユーザーが操作してから、その操作が部屋に届いて返ってくるまで、部屋の状態で上書きしない時間。
 * これが無いと、操作の直後に届いた他の状態更新や定期補正で、操作が無かったことにされてシークが戻る
 */
const LOCAL_HOLD_MS = 1500;

/**
 * ユーザーがプレイヤーを操作しているか、の判定と、操作の直後の保護。
 *
 * プレイヤーは別オリジンの iframe で、中の操作は見えない。
 * ポインターが上にある・フォーカスがプレイヤーにある・クリックでフォーカスが移った直後、のどれかのときだけ、
 * 変化をユーザー操作とみなす（同期のための自分の操作や読み込みの副作用を、誤って全員に送らないため）
 */
export class InteractionTracker {
  /** マウス・タッチがプレイヤーの上にある */
  private pointerInside = false;
  /** プレイヤーをクリック・キー操作した直後（この時刻まで）はユーザー操作とみなす */
  private interactUntil = 0;
  /** この時刻までは、ユーザーの操作を優先して部屋の状態を反映しない */
  private holdUntil = 0;

  constructor(private iframe: HTMLIFrameElement) {
    iframe.addEventListener('pointerenter', () => (this.pointerInside = true));
    iframe.addEventListener('pointerleave', () => (this.pointerInside = false));
    window.addEventListener('blur', () => {
      if (document.activeElement === iframe) this.interactUntil = Date.now() + INTERACT_MS;
    });
  }

  /**
   * プレイヤーを触れる状態か。ポインターが上にある・フォーカスがプレイヤーにある（キーボード操作）・クリック直後。
   * フォーカスがあるあいだは、クリックしなくても矢印キーなどでシークできるので、ユーザー操作とみなす
   */
  engaged() {
    return this.pointerInside || document.activeElement === this.iframe || Date.now() < this.interactUntil;
  }

  /** 操作を検知した（送信を待つ間も）。しばらく部屋の状態で巻き戻されないようにする */
  hold() {
    this.holdUntil = Date.now() + LOCAL_HOLD_MS;
  }

  isHolding() {
    return Date.now() < this.holdUntil;
  }

  /** 保護が終わるまでの残り (ms) */
  holdRemainingMs() {
    return this.holdUntil - Date.now();
  }

  releaseHold() {
    this.holdUntil = 0;
  }
}
