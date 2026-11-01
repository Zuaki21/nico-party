import { SUPPRESS_MS } from './constants';

/**
 * 自分のプレイヤーに命令を送った直後の時間。この間に出るプレイヤーのイベントは、
 * 自分の命令の結果であって、ユーザーの操作ではないので、部屋に送らない
 */
export class SuppressWindow {
  private until = 0;

  /** 少なくとも ms のあいだ（すでに長く取っていれば、そのまま）無視する */
  extend(ms = SUPPRESS_MS) {
    this.until = Math.max(this.until, Date.now() + ms);
  }

  /** 無視する時間を、今から ms に取り直す（長く取っていたものも縮める） */
  reset(ms = SUPPRESS_MS) {
    this.until = Date.now() + ms;
  }

  active() {
    return Date.now() < this.until;
  }
}
