import type { PlaybackState, QueueItem } from '../../../shared/protocol';
import type { Change } from './playback';
import { initialState } from './state';

export type LoadFailed = { itemId: string; ids: string[] };

const STATE_KEY = 'state';
const QUEUE_KEY = 'queue';
const HISTORY_KEY = 'history';
/** 読み込めなかったと報告してきたメンバー（全員そろったら次へ進める） */
const LOAD_FAILED_KEY = 'loadFailed';

/**
 * 部屋の再生状態・再生リスト・読み込み失敗の報告の保存先。
 *
 * 部屋が起こされたときに、全部を storage から読み込んでメモリに置く（load。Durable Object の
 * blockConcurrencyWhile の中で呼ぶので、読み込みが終わるまで他のイベントは処理されない）。
 * その後の読み出しは同期で、メモリのものを返す。そのため、状態を読んでから書くまでの間に
 * 他のメッセージの処理が割り込むことはない（await を挟まない限り）。
 * 書き込みは commit に集めて、1 回の storage.put にまとめる（途中で退避されても、半端な状態が残らない）。
 * メモリは書き込みと同時に更新する（storage への書き込みはメモリ上で即座に反映され、失敗したら部屋ごと作り直される）。
 * 呼び出し側が受け取ったものを書き換えても、メモリの中身が勝手に変わらないよう、コピーを返す
 * （state は浅いコピー。current など中のオブジェクトは共有しているので、状態遷移の関数は中身を書き換えず、新しく作ること）。
 *
 * 前提: Durable Object の出力ゲートが、storage への書き込みが終わるまで、送ったメッセージを相手に届けない。
 * そのため commit のあと、written を待たずに配信してよい。storage.put に allowUnconfirmed を付けないこと
 */
export class RoomStore {
  private constructor(
    private storage: DurableObjectStorage,
    private data: { state: PlaybackState; queue: QueueItem[]; history: QueueItem[]; failed: LoadFailed | undefined },
  ) {}

  static async load(storage: DurableObjectStorage): Promise<RoomStore> {
    const got = await storage.get([STATE_KEY, QUEUE_KEY, HISTORY_KEY, LOAD_FAILED_KEY]);
    return new RoomStore(storage, {
      state: (got.get(STATE_KEY) as PlaybackState | undefined) ?? initialState(),
      queue: (got.get(QUEUE_KEY) as QueueItem[] | undefined) ?? [],
      history: (got.get(HISTORY_KEY) as QueueItem[] | undefined) ?? [],
      failed: got.get(LOAD_FAILED_KEY) as LoadFailed | undefined,
    });
  }

  getState(): PlaybackState {
    return { ...this.data.state };
  }

  getQueue(): QueueItem[] {
    return [...this.data.queue];
  }

  getHistory(): QueueItem[] {
    return [...this.data.history];
  }

  getLoadFailed(): LoadFailed | undefined {
    return this.data.failed;
  }

  /**
   * 渡されたものを、1 回の書き込みで保存する。state は版を進める（渡されたものは書き換えず、保存した state を返す）。
   * 動画が切り替わるときは、前の動画の読み込み失敗の記録も、同じ書き込みで消す。
   * メモリへの反映は呼んだ時点で済む。written は storage への書き込みの完了
   * （WebSocket で送ったメッセージは、書き込みが終わるまで相手に届かないので、written を待たずに配信してよい）
   */
  commit(c: Change): { state?: PlaybackState; written: Promise<void> } {
    const entries: Record<string, unknown> = {};
    const d = this.data;
    let state: PlaybackState | undefined;
    if (c.state) {
      state = { ...c.state, version: c.state.version + 1 };
      if (d.failed && state.current?.id !== d.state.current?.id) this.setFailed(undefined, entries);
      d.state = state;
      entries[STATE_KEY] = state;
    }
    if (c.queue) {
      d.queue = [...c.queue];
      entries[QUEUE_KEY] = d.queue;
    }
    if (c.history) {
      d.history = [...c.history];
      entries[HISTORY_KEY] = d.history;
    }
    return { state, written: this.write(entries) };
  }

  /** 読み込み失敗の報告を保存する（undefined なら記録を消す）。同じ内容なら何もしない */
  async setLoadFailed(failed: LoadFailed | undefined) {
    if (JSON.stringify(failed) === JSON.stringify(this.data.failed)) return;
    const entries: Record<string, unknown> = {};
    this.setFailed(failed, entries);
    await this.write(entries);
  }

  /** メモリを更新し、storage への書き込み内容に加える（undefined は削除の印） */
  private setFailed(failed: LoadFailed | undefined, entries: Record<string, unknown>) {
    this.data.failed = failed;
    entries[LOAD_FAILED_KEY] = failed;
  }

  /** undefined の項目は削除、それ以外は put。await を挟まずに出すので、1 回の書き込みとしてまとめて保存される */
  private async write(entries: Record<string, unknown>) {
    const put: Record<string, unknown> = {};
    const del: string[] = [];
    for (const [k, v] of Object.entries(entries)) {
      if (v === undefined) del.push(k);
      else put[k] = v;
    }
    const writes: Promise<unknown>[] = [];
    if (Object.keys(put).length > 0) writes.push(this.storage.put(put));
    if (del.length > 0) writes.push(this.storage.delete(del));
    await Promise.all(writes);
  }

  async deleteAll() {
    await this.storage.deleteAll();
    this.data = { state: initialState(), queue: [], history: [], failed: undefined };
  }
}
