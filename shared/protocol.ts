// クライアントとサーバーで共有するメッセージ定義。
// position は動画の再生位置 (秒)。

export interface QueueItem {
  /** キュー内で一意な ID（同じ動画を2回積んでも区別できるように） */
  id: string;
  videoId: string;
  title: string;
  addedBy: string;
  // 以下はキューに追加した時点の動画情報（取得できなかった場合は無い）
  thumbnail?: string;
  author?: string;
  views?: number;
  comments?: number;
  /** 秒 */
  length?: number;
}

export interface Member {
  id: string;
  name: string;
}

export interface PlaybackState {
  /** 再生中の動画。null なら何も再生していない */
  current: QueueItem | null;
  playing: boolean;
  position: number;
  /** position を記録したサーバー時刻 (ms) */
  updatedAt: number;
  version: number;
  /** 最後に操作したメンバー */
  by: string | null;
  byName: string | null;
}

export type ClientMsg =
  | { t: 'join'; name: string }
  | { t: 'control'; itemId: string; playing: boolean; position: number }
  | { t: 'enqueue'; url: string }
  | { t: 'remove'; id: string }
  /** id の動画を、視聴済み + 再生中 + キューを並べたリストの index 番目に移動する */
  | { t: 'move'; id: string; index: number }
  /** itemId の動画を終えて次へ進む。既に進んでいたら無視される */
  | { t: 'next'; itemId: string | null }
  /** itemId の動画をやめて、直前に視聴した動画に戻る */
  | { t: 'prev'; itemId: string }
  | { t: 'ping'; clientTime: number };

export type ServerMsg =
  | {
      t: 'welcome';
      id: string;
      state: PlaybackState;
      queue: QueueItem[];
      history: QueueItem[];
      members: Member[];
      serverTime: number;
    }
  | { t: 'state'; state: PlaybackState }
  /** queue: これから再生する動画 / history: 再生し終えた動画（古い順） */
  | { t: 'queue'; queue: QueueItem[]; history: QueueItem[] }
  | { t: 'members'; members: Member[] }
  | { t: 'error'; message: string }
  | { t: 'pong'; clientTime: number; serverTime: number };

/**
 * 接続の生存確認用のメッセージ。サーバーは Durable Object の自動応答で同じ文字列を返す
 * （部屋を起こさないので稼働時間がかからない）
 */
export const HEARTBEAT = 'hb';

export function initialState(): PlaybackState {
  return {
    current: null,
    playing: false,
    position: 0,
    updatedAt: Date.now(),
    version: 0,
    by: null,
    byName: null,
  };
}

/** URL や文字列から sm9 / so123 / nm456 形式の動画 ID を取り出す */
export function parseVideoId(input: string): string | null {
  return input.match(/\b(?:sm|so|nm)\d+/)?.[0] ?? null;
}

/**
 * 視聴済み・再生中・キューを1本のリストとみなして id の動画を index 番目（自分を抜いた後の位置）に移す。
 * 再生中の動画は動かしても再生中のまま。それより前に置いた動画は視聴済み、後ろはキューになる。
 * 何も変わらないときは null。
 */
export function reorder(
  history: QueueItem[],
  current: QueueItem | null,
  queue: QueueItem[],
  id: string,
  index: number,
): { history: QueueItem[]; queue: QueueItem[] } | null {
  const all = [...history, ...(current ? [current] : []), ...queue];
  const from = all.findIndex((q) => q.id === id);
  if (from < 0) return null;
  const [item] = all.splice(from, 1);
  const to = Math.max(0, Math.min(all.length, Math.trunc(index)));
  if (to === from) return null;
  all.splice(to, 0, item);

  if (current) {
    const ci = all.findIndex((q) => q.id === current.id);
    return { history: all.slice(0, ci), queue: all.slice(ci + 1) };
  }
  // 再生中が無いときは、元の視聴済みとキューの境目を基準に振り分ける
  const fromHistory = from < history.length;
  const boundary = history.length - (fromHistory ? 1 : 0);
  const toHistory = to < boundary || (to === boundary && fromHistory);
  const historyLen = boundary + (toHistory ? 1 : 0);
  return { history: all.slice(0, historyLen), queue: all.slice(historyLen) };
}
