// クライアントとサーバーで共有するメッセージ定義。
// position は動画の再生位置 (秒)。

export interface QueueItem {
  /** キュー内で一意な ID（同じ動画を2回積んでも区別できるように） */
  id: string;
  videoId: string;
  title: string;
  addedBy: string;
  /** 追加した人のアイコン（Discord の CDN の URL。サーバーが付ける。無い場合は名前だけ表示する） */
  addedByAvatar?: string;
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
  /** アイコンの URL（Discord の CDN。ログインできなかった人には無い） */
  avatar?: string;
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

/**
 * invalid_url: 動画 ID が読み取れない / queue_full: 再生リストが上限 / not_found: 動画が無い (id) /
 * unplayable: 埋め込みで再生できない (title, reason=埋め込みページのエラーコード) / not_embeddable: 埋め込み禁止 (title)
 */
export type ErrorCode =
  | 'invalid_url'
  | 'queue_full'
  | 'not_found'
  | 'unplayable'
  | 'not_embeddable'
  | 'too_fast'
  /** ニコニコに問い合わせられなかった（動画の有無は分からない） */
  | 'upstream_error';

/** 部屋の誰かの操作の通知。文言は各自の画面で組み立てる（client/src/core/i18n/ の noticeSeek など） */
export type NoticeEvent =
  | { k: 'seek'; position: number }
  | { k: 'switch'; title: string }
  | { k: 'add'; title: string }
  | { k: 'remove'; title: string };

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
  /** 操作した人 (by) への通知。操作した本人の画面では出さない */
  | { t: 'notice'; by: Member; ev: NoticeEvent }
  /** 文言は各自の画面で、選んでいる言語で組み立てる（client/src/core/i18n/ の err_*） */
  | { t: 'error'; code: ErrorCode; params?: Record<string, string> }
  | { t: 'pong'; clientTime: number; serverTime: number };

/**
 * 接続の生存確認用のメッセージ。サーバーは部屋を通さずに、同じ文字列をすぐ返す（server/src/node/roomHost.ts）
 */
export const HEARTBEAT = 'hb';

/**
 * サーバーが、同じユーザーの古い接続を切るときの閉じコード（1 人がつなげる接続の数を超えたとき）。
 * クライアントは、これで切られたら自動では繋ぎ直さない（繋ぎ直すと、今度は別の自分の接続を追い出して、延々と続く）
 */
export const CLOSE_EVICTED = 4001;
