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

/** off: リピートしない / all: 再生リストの最後まで行ったら最初に戻る / one: 同じ動画を繰り返す */
export type RepeatMode = 'off' | 'all' | 'one';

export interface PlaybackState {
  /** 再生中の動画。null なら何も再生していない */
  current: QueueItem | null;
  playing: boolean;
  position: number;
  /** position を記録したサーバー時刻 (ms)。動画の切り替え直後は少し先の時刻（その時刻に再生開始） */
  updatedAt: number;
  version: number;
  /** 今の動画の再生を始めた（start した）サーバー時刻 (ms)。シークや一時停止では変わらない */
  startedAt?: number;
  /** 最後に操作したメンバー */
  by: string | null;
  byName: string | null;
  /** 部屋全員で共通の再生モード（古いデータには無いので未定義は off / false 扱い） */
  repeat?: RepeatMode;
  shuffle?: boolean;
}

export type ClientMsg =
  /** clientId: ページを開いている間は変わらない ID（再接続しても同じメンバーとして扱う） */
  | { t: 'join'; name: string; clientId?: string }
  | { t: 'control'; itemId: string; playing: boolean; position: number }
  | { t: 'enqueue'; url: string }
  | { t: 'remove'; id: string }
  /** id の動画を、視聴済み + 再生中 + キューを並べたリストの index 番目に移動する */
  | { t: 'move'; id: string; index: number }
  /**
   * itemId の動画を終えて次へ進む。既に進んでいたら無視される。
   * auto は動画が最後まで再生されて自動で進むとき（1曲リピートではこのときだけ同じ動画を繰り返す）
   */
  | { t: 'next'; itemId: string | null; auto?: boolean }
  /** リピート・シャッフルの切り替え */
  | { t: 'mode'; repeat?: RepeatMode; shuffle?: boolean }
  /** itemId の動画をやめて、直前に視聴した動画に戻る */
  | { t: 'prev'; itemId: string }
  /** 視聴済み・キューの中から id の動画を選んで、そこから再生する（並び順は変えない） */
  | { t: 'jump'; id: string }
  /** itemId の動画を読み込めなかった。部屋の全員から届いたら、その動画を再生リストから外して次へ進む */
  | { t: 'loadFailed'; itemId: string }
  /** loadFailed を送った後で、遅れて読み込めた（報告を取り消す） */
  | { t: 'loadOk'; itemId: string }
  | { t: 'ping'; clientTime: number };

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const num = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;

/**
 * 届いたメッセージを検証して ClientMsg にする。形や範囲が合わないものは null（握りつぶす）。
 * 型だけを信じて処理すると、細工したクライアントの想定外の値でサーバーが壊れる
 */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'join':
      if (!str(m.name, 200)) return null;
      return { t: 'join', name: m.name, ...(str(m.clientId, 64) ? { clientId: m.clientId } : {}) };
    case 'control':
      if (!str(m.itemId, 64) || typeof m.playing !== 'boolean' || !num(m.position, 86_400)) return null;
      return { t: 'control', itemId: m.itemId, playing: m.playing, position: m.position };
    case 'enqueue':
      return str(m.url, 500) ? { t: 'enqueue', url: m.url } : null;
    case 'remove':
    case 'jump':
      return str(m.id, 64) ? { t: m.t, id: m.id } : null;
    case 'move':
      return str(m.id, 64) && num(m.index, 10_000) ? { t: 'move', id: m.id, index: m.index } : null;
    case 'next':
      if (m.itemId !== null && !str(m.itemId, 64)) return null;
      return { t: 'next', itemId: m.itemId, ...(m.auto === true ? { auto: true } : {}) };
    case 'mode': {
      const repeat = m.repeat === 'off' || m.repeat === 'all' || m.repeat === 'one' ? m.repeat : undefined;
      const shuffle = typeof m.shuffle === 'boolean' ? m.shuffle : undefined;
      return {
        t: 'mode',
        ...(repeat !== undefined ? { repeat } : {}),
        ...(shuffle !== undefined ? { shuffle } : {}),
      };
    }
    case 'prev':
    case 'loadFailed':
    case 'loadOk':
      return str(m.itemId, 64) ? { t: m.t, itemId: m.itemId } : null;
    case 'ping':
      return num(m.clientTime, 1e15) ? { t: 'ping', clientTime: m.clientTime } : null;
    default:
      return null;
  }
}

/**
 * invalid_url: 動画 ID が読み取れない / queue_full: 再生リストが上限 / not_found: 動画が無い (id) /
 * unplayable: 埋め込みで再生できない (title, reason=埋め込みページのエラーコード) / not_embeddable: 埋め込み禁止 (title)
 */
export type ErrorCode = 'invalid_url' | 'queue_full' | 'not_found' | 'unplayable' | 'not_embeddable' | 'too_fast';

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
  /** 文言は各自の画面で、選んでいる言語で組み立てる（client/src/i18n.ts の err_*） */
  | { t: 'error'; code: ErrorCode; params?: Record<string, string> }
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

/** 視聴済み → 再生中 → キューの順に並べた1本のリスト（画面の再生リストと同じ並び） */
function flatten(history: QueueItem[], current: QueueItem | null, queue: QueueItem[]) {
  return [...history, ...(current ? [current] : []), ...queue];
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
  const all = flatten(history, current, queue);
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

/**
 * 視聴済み・再生中・キューを1本のリストとみなして、id の動画を再生中にする。
 * リスト上でそれより前はすべて視聴済み、後ろはすべてキューになる（並び順は変えない）。見つからなければ null。
 */
export function jumpTo(
  history: QueueItem[],
  current: QueueItem | null,
  queue: QueueItem[],
  id: string,
): { history: QueueItem[]; current: QueueItem; queue: QueueItem[] } | null {
  const all = flatten(history, current, queue);
  const i = all.findIndex((q) => q.id === id);
  if (i < 0) return null;
  return { history: all.slice(0, i), current: all[i], queue: all.slice(i + 1) };
}

/** /api/search の結果（ニコニコのスナップショット検索 API を整形したもの） */
export interface SearchResult {
  total: number;
  items: SearchItem[];
}

export interface SearchItem {
  videoId: string;
  title: string;
  thumbnail?: string;
  views?: number;
  comments?: number;
  /** 秒 */
  length?: number;
  /** 投稿日時 (ISO 8601) */
  startTime?: string;
  /** 埋め込みプレイヤーで再生できない理由（埋め込みページのエラーコード）。再生できるなら無い */
  unplayable?: string;
}

/** popular: 再生数 / new: 新着 / likes: 人気（ニコニコの検索 API に人気順は無いので、いいね数で並べる） */
export type SearchSort = 'popular' | 'new' | 'likes';
export const SEARCH_PAGE_SIZE = 20;
/** 検索で指定できる開始位置の上限（これより先の結果は取得できない） */
export const SEARCH_MAX_OFFSET = 1000;
