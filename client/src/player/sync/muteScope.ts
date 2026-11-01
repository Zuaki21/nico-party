import type { NicoPlayer } from '../nicoPlayer';

/**
 * 一時的にプレイヤーをミュートし、終わったら元の状態に戻す（StartGate の先読みと CatchUp の位置合わせが共有する）。
 * 元の状態は、最初に on した人が覚える。使っている人が全員 off したときに戻す
 * （後から on した人が「ミュート済み」を元の状態と取り違えて、ミュートのまま戻らなくなるのを防ぐ）
 */
export class MuteScope {
  private before: boolean | null = null;
  private owners = new Set<string>();

  constructor(private player: NicoPlayer) {}

  on(owner: string) {
    if (this.owners.size === 0) this.before = this.player.isMuted();
    this.owners.add(owner);
    this.player.mute(true);
  }

  off(owner: string) {
    if (!this.owners.delete(owner) || this.owners.size > 0) return;
    this.player.mute(this.before ?? false);
    this.before = null;
  }
}
