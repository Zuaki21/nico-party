import type { PlaybackState, QueueItem } from '../../../shared/protocol';
import { initialState } from './state';

export type LoadFailed = { itemId: string; ids: string[] };

const STATE_KEY = 'state';
const QUEUE_KEY = 'queue';
const HISTORY_KEY = 'history';
/** 読み込めなかったと報告してきたメンバー（全員そろったら次へ進める） */
const LOAD_FAILED_KEY = 'loadFailed';

/**
 * 部屋の再生状態・再生リスト・読み込み失敗の報告の保存先。
 * 読み込みは、起こされてから最初の1回だけ storage に行き、あとはメモリのものを使う。
 * 書き込みは storage に成功してからメモリを更新する（失敗したときに、メモリだけ新しくならないように）。
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

  /** 版を進めて保存する */
  async putState(s: PlaybackState) {
    s.version++;
    await this.storage.put(STATE_KEY, s);
    this.cache.state = { ...s };
  }

  /** 渡されたリストだけを保存する（片方だけでもよい） */
  async putLists(lists: { queue?: QueueItem[]; history?: QueueItem[] }) {
    const entries: Record<string, QueueItem[]> = {};
    if (lists.queue) entries[QUEUE_KEY] = [...lists.queue];
    if (lists.history) entries[HISTORY_KEY] = [...lists.history];
    if (Object.keys(entries).length > 0) await this.storage.put(entries);
    if (lists.queue) this.cache.queue = entries[QUEUE_KEY];
    if (lists.history) this.cache.history = entries[HISTORY_KEY];
  }

  async putLoadFailed(failed: LoadFailed | undefined) {
    if (failed) await this.storage.put(LOAD_FAILED_KEY, failed);
    else await this.storage.delete(LOAD_FAILED_KEY);
    this.cache.failed = failed;
    this.cache.failedLoaded = true;
  }

  async deleteAll() {
    await this.storage.deleteAll();
    this.cache = { failedLoaded: false };
  }
}
