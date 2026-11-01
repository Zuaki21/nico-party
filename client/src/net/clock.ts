/**
 * ping/pong でサーバー時刻とのずれを推定する。
 * 往復時間が最も短かったサンプルが最も正確なので、直近のうち最良のものを使う。
 */
export class ClockSync {
  private samples: { rtt: number; offset: number }[] = [];

  /** サーバー時刻 − ローカル時刻 (ms) */
  offset = 0;

  sample(clientTime: number, serverTime: number, now = Date.now()) {
    const rtt = now - clientTime;
    if (rtt < 0) return;
    this.samples.push({ rtt, offset: serverTime + rtt / 2 - now });
    if (this.samples.length > 8) this.samples.shift();
    this.offset = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  /**
   * 往復時間を測れないサンプル（welcome の serverTime など）。ping/pong の結果が出るまでの仮の値にする。
   * 片道遅延を引けないので、samples には入れない（入れると rtt 0 として常に採用され、本物のサンプルが負ける）
   */
  provisional(serverTime: number, now = Date.now()) {
    if (this.samples.length === 0) this.offset = serverTime - now;
  }

  /**
   * 再接続したとき。古いサンプルは捨てるが、offset は直前の値を残す
   * （0 に戻すと、welcome が届くまでの間、同期エンジンの見る時刻が端末の時計に跳ぶ）
   */
  reset() {
    this.samples = [];
  }
}
