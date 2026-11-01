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
