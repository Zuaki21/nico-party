import type { NicoPlayer } from '../nicoPlayer';

/**
 * 一時的にプレイヤーをミュートし、終わったら元の状態に戻す（StartGate の先読みと CatchUp の位置合わせが使う）。
 * on() は二重に呼ばれても、最初の元の状態を覚えたままにする（覚え直すと、ミュートのまま戻らなくなる）
 */
export class MuteScope {
  private before: boolean | null = null;

  constructor(private player: NicoPlayer) {}

  on() {
    if (this.before === null) this.before = this.player.isMuted();
    this.player.mute(true);
  }

  off() {
    if (this.before === null) return;
    this.player.mute(this.before);
    this.before = null;
  }
}
