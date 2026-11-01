/** 動画の追加の順番待ちが、部屋全体・1 人あたりでこれだけ溜まっていたら、新しい追加は断る */
const WAITING_LIMIT = 20;
const WAITING_PER_MEMBER = 8;

/**
 * 動画の追加を、受け取った順に 1 件ずつ処理するための列。
 * 続けて追加しても弾かず、順番どおりに並ぶ。溜まりすぎている（自動化など）ときだけ断る
 */
export class EnqueueQueue {
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;
  private waitingBy = new Map<string, number>();

  /** @returns 列に入れたら、その処理が終わるまでの Promise。溜まりすぎで断ったら null */
  submit(memberId: string, job: () => Promise<void>): Promise<void> | null {
    const mine = this.waitingBy.get(memberId) ?? 0;
    if (this.waiting >= WAITING_LIMIT || mine >= WAITING_PER_MEMBER) return null;
    this.waiting++;
    this.waitingBy.set(memberId, mine + 1);
    this.chain = this.chain
      .then(job)
      .catch((e) => console.error('enqueue job failed', e))
      .finally(() => {
        this.waiting--;
        const left = (this.waitingBy.get(memberId) ?? 1) - 1;
        if (left > 0) this.waitingBy.set(memberId, left);
        else this.waitingBy.delete(memberId);
      });
    return this.chain;
  }
}
