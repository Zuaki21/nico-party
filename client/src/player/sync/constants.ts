/** 自分が操作した直後に発火するイベントを「ユーザー操作」と誤認しない時間 */
export const SUPPRESS_MS = 800;
/**
 * 読み込み直後に、自分のプレイヤーを途中の位置へシークさせた直後は、読み込みが終わって位置の通知が追いつくまで時間がかかる。
 * その間に出る再生・シーク完了のイベントや 0 秒付近の位置通知を、ユーザー操作として全員に送ってしまわないための時間
 * （途中参加したときに、全員の動画が最初に戻されるのを防ぐ）
 */
export const SEEK_SUPPRESS_MS = 4000;
/** 誰かの操作を受けたとき、これ以上ずれていたらシーク */
export const APPLY_THRESHOLD = 1.0;
/** 定期チェックでのシーク閾値（シーク連発でカクつかないよう大きめ） */
export const DRIFT_THRESHOLD = 1.5;
/** プレイヤーをクリックした（フォーカスが移った）あと、ユーザー操作とみなす時間 */
export const INTERACT_MS = 5000;
/**
 * ユーザーが操作してから、その操作が部屋に届いて返ってくるまで、部屋の状態で上書きしない時間。
 * これが無いと、操作の直後に届いた他の状態更新や定期補正で、操作が無かったことにされてシークが戻る
 */
export const LOCAL_HOLD_MS = 1500;
/** ローカル操作をまとめる時間（シークバーのドラッグ等） */
export const LOCAL_DEBOUNCE_MS = 150;
/** 位置が合うのを待つ上限。これを過ぎたら、合っていなくても通常の同期に任せる */
export const CATCHUP_MAX_MS = 8000;
/** 位置が合うまで、この間隔でシークを送り直す */
export const CATCHUP_RESEEK_MS = 1500;
export const CATCHUP_POLL_MS = 200;
/** 動画の終端とみなす余裕（秒） */
export const END_MARGIN = 0.5;
/**
 * これだけ待ってもプレイヤーの読み込みが終わらなければ、読み込めなかったとサーバーに伝える（全員そろったら次へ進む）。
 * 再生できない動画は追加時にサーバーが弾くが、見つけられなかった種類のエラーへの保険
 */
export const LOAD_TIMEOUT_MS = 20000;
/** 開始時刻を待つ間、一時停止を送り直す間隔 */
export const HOLD_INTERVAL_MS = 300;
/** 先読みのための再生を、再生開始の通知が無くても止めるまでの時間 */
export const PRELOAD_PLAY_MS = 400;
/** 全員の動画が終わっているはずなのに次へ進んでいないとき、自分から進めるまでの猶予（秒） */
export const STUCK_MARGIN = 3;
/** 自動送りの要求を送り直す間隔 */
export const NEXT_RESEND_MS = 4000;
