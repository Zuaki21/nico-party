/**
 * メッセージの受け付け残り（連投で保存と配信が増えないようにする）。
 * 数える単位は呼び出し側が決める（ログインした人はユーザーごと。接続を何本つないでも、量は増やせない）
 */
export class MessageLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  /**
   * @param refillPerSec 1 秒あたりに補充される数
   * @param burst 溜められる最大数（短い間に続けて送れる数）
   */
  constructor(
    private refillPerSec: number,
    private burst: number,
  ) {}

  /** メッセージを 1 件受け付けられるか（連投されたら false） */
  take(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (!this.buckets.has(key) && this.buckets.size > 500) this.sweep(now);
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens--;
    return true;
  }

  /** 受け付けたあとで、別の制限に断られたとき、数えた分を戻す */
  refund(key: string) {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(this.burst, b.tokens + 1);
  }

  /** 満タンまで回復した（つまり使っていない）記録を捨てる */
  private sweep(now: number) {
    const idleMs = (this.burst / this.refillPerSec) * 1000;
    for (const [k, b] of this.buckets) if (now - b.at >= idleMs) this.buckets.delete(k);
  }
}
