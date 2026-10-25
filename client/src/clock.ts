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

  reset() {
    this.samples = [];
    this.offset = 0;
  }
}
