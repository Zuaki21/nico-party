import type { ClientMsg, PlaybackState } from '../../shared/protocol';
import type { NicoPlayer } from './nicoPlayer';

/** 自分が操作した直後に発火するイベントを「ユーザー操作」と誤認しない時間 */
const SUPPRESS_MS = 800;
/** 誰かの操作を受けたとき、これ以上ずれていたらシーク */
const APPLY_THRESHOLD = 1.0;
/** 定期チェックでのシーク閾値（シーク連発でカクつかないよう大きめ） */
const DRIFT_THRESHOLD = 1.5;
/** 動画の終端とみなす余裕（秒） */
const END_MARGIN = 0.5;
/** 全員の動画が終わっているはずなのに次へ進んでいないとき、自分から進めるまでの猶予（秒） */
const STUCK_MARGIN = 3;
/** ローカル操作をまとめる時間（シークバーのドラッグ等） */
const LOCAL_DEBOUNCE_MS = 150;
/** 開始待ちの間に先読みしておく長さ（秒） */
const PRELOAD_SEC = 3;

/**
 * 部屋の再生状態と自分のプレイヤーを一致させる。
 * syncparty の SyncEngine を、ニコニコ埋め込みプレイヤー専用に簡略化したもの。
 */
export class SyncEngine {
  private state: PlaybackState | null = null;
  /** サーバー時刻 − ローカル時刻 (ms) */
  private clockOffset = 0;
  /** プレイヤーに読み込んでいるキュー項目 */
  private loadedItemId: string | null = null;
  private suppressUntil = 0;
  private localTimer: number | undefined;
  /** 再生開始時刻ちょうどに再生を始めるためのタイマー */
  private startTimer: number | undefined;
  /** 開始待ちの間、ミュートで裏再生して動画データを先読みしている */
  private preloading = false;
  /** 先読みが済んだキュー項目 */
  private preloadedFor: string | null = null;
  /** 先読みのためにミュートする前の状態（終わったら戻す） */
  private mutedBefore = false;
  private ticks = 0;

  constructor(
    private player: NicoPlayer,
    private send: (msg: ClientMsg) => void,
  ) {
    const onLocal = () => {
      clearTimeout(this.localTimer);
      this.localTimer = window.setTimeout(() => this.onLocalChange(), LOCAL_DEBOUNCE_MS);
    };
    player.on('play', onLocal);
    player.on('pause', onLocal);
    player.on('seeked', onLocal);
    player.on('load', () => this.apply(APPLY_THRESHOLD));
    player.on('ended', () => this.requestNext());
    window.setInterval(() => this.onTick(), 1000);
  }

  setClockOffset(offset: number) {
    this.clockOffset = offset;
  }

  update(state: PlaybackState) {
    this.state = state;
    const item = state.current;
    if ((item?.id ?? null) !== this.loadedItemId) {
      // 先読みの途中で動画が変わったら、ミュートを元に戻してから切り替える
      if (this.preloading) this.player.mute(this.mutedBefore);
      this.preloading = false;
      this.preloadedFor = null;
      this.loadedItemId = item?.id ?? null;
      if (item) this.player.load(item.videoId);
      else this.player.unload();
      return; // 読み込み完了 (load) 後に apply する
    }
    this.apply(APPLY_THRESHOLD);
  }

  private serverNow() {
    return Date.now() + this.clockOffset;
  }

  /** 今この瞬間の部屋の再生位置 */
  private expected(s: PlaybackState) {
    if (s.playing) return s.position + (this.serverNow() - s.updatedAt) / 1000;
    return s.position;
  }

  private suppress() {
    this.suppressUntil = Date.now() + SUPPRESS_MS;
  }

  /** 部屋の状態に自分のプレイヤーを合わせる */
  private apply(threshold: number) {
    const s = this.state;
    const p = this.player;
    if (!s?.current || s.current.id !== this.loadedItemId || !p.ready()) return;

    const target = this.expected(s);
    // 動画の切り替え直後で、まだ開始時刻になっていない。
    // 先読みしてから 0 秒で止めて待ち、開始時刻ちょうどに再生する
    clearTimeout(this.startTimer);
    if (s.playing && target < 0) {
      this.preload(s.current.id);
      this.startTimer = window.setTimeout(() => this.apply(APPLY_THRESHOLD), -target * 1000);
      return;
    }
    // 先読みが終わる前に開始時刻になった。そのまま再生を続け、位置だけ下で合わせる
    if (this.preloading) this.endPreload(false);
    const duration = p.getDuration();
    // 部屋の位置が動画の終端を過ぎている。終了済みの動画に play() すると先頭から再生し直すので触らない
    if (duration > 0 && target >= duration - END_MARGIN) {
      if (!p.isEnded() && p.getTime() < duration - threshold) {
        this.suppress();
        p.seek(duration);
      }
      return;
    }

    if (Math.abs(p.getTime() - target) > threshold) {
      this.suppress();
      p.seek(target);
    }
    if (s.playing && p.isPaused()) {
      this.suppress();
      p.play();
    } else if (!s.playing && !p.isPaused()) {
      this.suppress();
      p.pause();
    }
  }

  /**
   * 開始待ちの間に動画データを読み込んでおく。
   * ニコニコのプレイヤーは再生するまで動画データを読み込まないので、ミュートで裏再生して先読みし、
   * 読み込めたら 0 秒に戻して止める（開始時刻に再生した瞬間に読み込みが始まって遅れるのを防ぐ）
   */
  private preload(itemId: string) {
    const p = this.player;
    if (this.preloadedFor === itemId) {
      // 先読み済み。0 秒で止めて開始時刻を待つ
      if (p.getTime() > 0.5) {
        this.suppress();
        p.seek(0);
      }
      if (!p.isPaused()) {
        this.suppress();
        p.pause();
      }
      return;
    }
    if (!this.preloading) {
      this.preloading = true;
      this.mutedBefore = p.isMuted();
      this.suppress();
      p.mute(true);
      p.play();
      return;
    }
    const enough = Math.min(PRELOAD_SEC, Math.max(0, p.getDuration() - END_MARGIN));
    if (p.getBuffered() >= enough) {
      this.endPreload(true);
      this.preloadedFor = itemId;
    }
  }

  /** @param hold true なら 0 秒に戻して止める（開始時刻を待つ） */
  private endPreload(hold: boolean) {
    const p = this.player;
    this.preloading = false;
    this.suppress();
    if (hold) {
      p.pause();
      p.seek(0);
    }
    p.mute(this.mutedBefore);
  }

  /** ユーザーがプレイヤーを操作した */
  private onLocalChange() {
    const s = this.state;
    const p = this.player;
    if (!s?.current || s.current.id !== this.loadedItemId) return;
    // 先読みのための再生・停止はユーザーの操作ではない
    if (this.preloading) return;
    if (Date.now() < this.suppressUntil || !p.ready()) return;
    // 再生終了による停止は ended で処理する
    if (p.isEnded()) return;

    const playing = !p.isPaused();
    const position = p.getTime();
    const expected = this.expected(s);
    // 開始待ちの間（expected < 0）に止まっているのは部屋の状態どおり
    if (expected < 0 && !playing) return;
    // 部屋の状態と一致しているなら送らない（同期による変化のエコー等）
    if (playing === s.playing && Math.abs(position - Math.max(0, expected)) < APPLY_THRESHOLD) return;
    this.send({ t: 'control', itemId: s.current.id, playing, position });
  }

  private requestNext() {
    if (this.state?.current && this.state.current.id === this.loadedItemId) {
      this.send({ t: 'next', itemId: this.loadedItemId });
    }
  }

  private onTick() {
    this.ticks++;
    const s = this.state;
    const p = this.player;
    if (!s?.current || !p.ready()) return;

    // 途中参加などで誰のプレイヤーも終了イベントを出さないまま終端を過ぎた
    const duration = p.getDuration();
    if (s.playing && duration > 0 && this.expected(s) > duration + STUCK_MARGIN) {
      this.requestNext();
      return;
    }

    // 先読み中は読み込みの進み具合を毎秒確認する
    if (this.preloading) {
      this.apply(APPLY_THRESHOLD);
      return;
    }

    // ずれの定期補正
    if (this.ticks % 2 === 0 && Date.now() >= this.suppressUntil) this.apply(DRIFT_THRESHOLD);
  }
}
