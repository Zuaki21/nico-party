import type { PlaybackState, QueueItem } from '../../../shared/protocol';
import { initialState } from './state';

export type LoadFailed = { itemId: string; ids: string[] };

/** 1 回の書き込みで保存する内容（指定したものだけ。failed は null で記録を消す） */
export interface Commit {
  state?: PlaybackState;
  queue?: QueueItem[];
  history?: QueueItem[];
  failed?: LoadFailed | null;
}

const STATE_KEY = 'state';
const QUEUE_KEY = 'queue';
const HISTORY_KEY = 'history';
/** 読み込めなかったと報告してきたメンバー（全員そろったら次へ進める） */
const LOAD_FAILED_KEY = 'loadFailed';

/**
 * 部屋の再生状態・再生リスト・読み込み失敗の報告の保存先。
 * 読み込みは、起こされてから最初の1回だけ storage に行き、あとはメモリのものを使う。
 * 書き込みは commit に集めて、1 回の書き込みにまとめる（途中で退避されても、半端な状態が残らない）。
 * storage に成功してからメモリを更新する（失敗したときに、メモリだけ新しくならないように）。
 * 呼び出し側が受け取ったものを書き換えても、メモリの中身が勝手に変わらないよう、コピーを返す
 */
export class RoomStore {
  private cache: {
    state?: PlaybackState;
    queue?: QueueItem[];
    history?: QueueItem[];
    failed?: LoadFailed;
    failedLoaded: boolean;
  } = { failedLoaded: false };

  constructor(private storage: DurableObjectStorage) {}

  async getState(): Promise<PlaybackState> {
    this.cache.state ??= (await this.storage.get<PlaybackState>(STATE_KEY)) ?? initialState();
    return { ...this.cache.state };
  }

  async getQueue(): Promise<QueueItem[]> {
    this.cache.queue ??= (await this.storage.get<QueueItem[]>(QUEUE_KEY)) ?? [];
    return [...this.cache.queue];
  }

  async getHistory(): Promise<QueueItem[]> {
    this.cache.history ??= (await this.storage.get<QueueItem[]>(HISTORY_KEY)) ?? [];
    return [...this.cache.history];
  }

  async getLoadFailed(): Promise<LoadFailed | undefined> {
    if (!this.cache.failedLoaded) {
      this.cache.failed = await this.storage.get<LoadFailed>(LOAD_FAILED_KEY);
      this.cache.failedLoaded = true;
    }
    return this.cache.failed;
  }

  /** 渡されたものを、1 回の書き込みで保存する。state は版を進める */
  async commit(c: Commit) {
    const entries: Record<string, unknown> = {};
    if (c.state) {
      c.state.version++;
      entries[STATE_KEY] = c.state;
    }
    if (c.queue) entries[QUEUE_KEY] = [...c.queue];
    if (c.history) entries[HISTORY_KEY] = [...c.history];
    if (c.failed) entries[LOAD_FAILED_KEY] = c.failed;
    // 同じ瞬間に出した書き込みは、まとめて 1 回で保存される
    const writes: Promise<unknown>[] = [];
    if (Object.keys(entries).length > 0) writes.push(this.storage.put(entries));
    if (c.failed === null) writes.push(this.storage.delete(LOAD_FAILED_KEY));
    await Promise.all(writes);
    if (c.state) this.cache.state = { ...c.state };
    if (c.queue) this.cache.queue = [...c.queue];
    if (c.history) this.cache.history = [...c.history];
    if (c.failed !== undefined) {
      this.cache.failed = c.failed ?? undefined;
      this.cache.failedLoaded = true;
    }
  }

  async deleteAll() {
    await this.storage.deleteAll();
    this.cache = { failedLoaded: false };
  }
}
