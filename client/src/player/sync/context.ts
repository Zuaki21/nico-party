import type { PlaybackState, QueueItem } from '../../../../shared/protocol';
import type { NicoPlayer } from '../nicoPlayer';
import type { MuteScope } from './muteScope';
import type { SuppressWindow } from './suppress';

/** 部屋の再生状態のうち、いま自分のプレイヤーに読み込んでいる動画のもの（current が確かにある） */
export type LoadedState = PlaybackState & { current: QueueItem };

/** 同期エンジンが、開始待ち（StartGate）や途中参加の位置合わせ（CatchUp）に貸す道具 */
export interface SyncContext {
  player: NicoPlayer;
  /** 部屋の状態。いまのキュー項目が、プレイヤーに読み込み済みのものでなければ null */
  loadedState(): LoadedState | null;
  /** 今この瞬間の部屋の再生位置 (秒) */
  expected(s: PlaybackState): number;
  suppress: SuppressWindow;
  /** 一時的なミュート（先読みと位置合わせで共有する） */
  mute: MuteScope;
  /** 部屋の状態に自分のプレイヤーを合わせ直す（通常のしきい値） */
  apply(): void;
  /** 位置合わせが終わった（タイムアウトを含む）あとの同期。長めに操作を無視するが、位置合わせは繰り返さない */
  applyAfterCatchUp(): void;
}

/** 各部品が使う分だけに絞った型 */
export type StartGateContext = Pick<SyncContext, 'player' | 'loadedState' | 'expected' | 'suppress' | 'mute' | 'apply'>;
export type CatchUpContext = Pick<
  SyncContext,
  'player' | 'loadedState' | 'expected' | 'suppress' | 'mute' | 'apply' | 'applyAfterCatchUp'
>;
