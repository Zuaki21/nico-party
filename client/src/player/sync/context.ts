import type { PlaybackState } from '../../../../shared/protocol';
import type { NicoPlayer } from '../nicoPlayer';
import type { SuppressWindow } from './suppress';

/** 同期エンジンが、開始待ち（StartGate）や途中参加の位置合わせ（CatchUp）に貸す、共通の道具 */
export interface SyncContext {
  player: NicoPlayer;
  /** 部屋の今の再生状態 */
  state(): PlaybackState | null;
  /** プレイヤーに読み込んでいるキュー項目 */
  loadedItemId(): string | null;
  /** 今この瞬間の部屋の再生位置 (秒) */
  expected(s: PlaybackState): number;
  suppress: SuppressWindow;
  /** 部屋の状態に自分のプレイヤーを合わせ直す（通常のしきい値） */
  apply(): void;
  /** 読み込み直後と同じ扱い（長めに操作を無視する）で、合わせ直す */
  applyAfterLoad(): void;
}
