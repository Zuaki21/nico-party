import type { ClientMsg, PlaybackState } from '../../../../shared/protocol';
import type { NicoPlayer } from '../nicoPlayer';
import { CatchUp } from './catchUp';
import {
  APPLY_THRESHOLD,
  DRIFT_THRESHOLD,
  END_MARGIN,
  LOAD_TIMEOUT_MS,
  LOCAL_DEBOUNCE_MS,
  NEXT_RESEND_MS,
  SEEK_SUPPRESS_MS,
  STUCK_MARGIN,
  SUPPRESS_MS,
} from './constants';
import type { LoadedState, SyncContext } from './context';
import { InteractionTracker } from './interaction';
import { StartGate } from './startGate';
import { SuppressWindow } from './suppress';

/**
 * 部屋の再生状態と自分のプレイヤーを一致させる。
 * syncparty の SyncEngine を、ニコニコ埋め込みプレイヤー専用に簡略化したもの。
 *
 * ここには「どの動画を読み込んでいるか」「部屋の状態に合わせる判断（apply）」「ユーザー操作を部屋に送る」を置き、
 * 次の 3 つの部品に分けている。
 * - InteractionTracker: ユーザーがプレイヤーを操作しているかの判定と、操作の直後の保護
 * - StartGate: 動画の切り替え直後、再生開始の時刻まで先読みして待つ
 * - CatchUp: 途中参加のとき、位置が合うまでミュートして画面を隠す
 * これらと共有する「自分の命令の直後の無視時間」は SuppressWindow
 */
export class SyncEngine {
  private state: PlaybackState | null = null;
  /** プレイヤーに読み込んでいるキュー項目 */
  private loadedItemId: string | null = null;
  /** プレイヤーに読み込んでいる動画 ID（1曲リピートなどで同じ動画なら読み込み直さない） */
  private loadedVideoId: string | null = null;
  private localTimer: number | undefined;
  /** 読み込みが終わらない動画を飛ばすためのタイマー */
  private loadTimer: number | undefined;
  /** 読み込めなかったとサーバーに伝えたキュー項目（再接続したら送り直し、遅れて読み込めたら取り消す） */
  private reportedFailFor: string | null = null;
  private ticks = 0;
  private tickTimer: number | undefined;
  /** 読み込み完了の直後で、最初の同期をしている */
  private justLoaded = false;
  /** この時刻までは、自動送りの要求を送り直さない */
  private nextSentUntil = 0;
  /** ユーザーの操作の保護が終わったら、保留した同期をやり直すためのタイマー */
  private holdRetryTimer: number | undefined;

  private suppress = new SuppressWindow();
  private local: InteractionTracker;
  private gate: StartGate;
  private catchUp: CatchUp;

  constructor(
    private player: NicoPlayer,
    private send: (msg: ClientMsg) => void,
    /** 自分のプレイヤーで動画を読み込めなかった */
    private onLoadFailed: () => void,
    /** 途中参加で位置が合うまでの間、プレイヤーを隠す・隠すのをやめる */
    onCatchUp: (on: boolean) => void,
    /** 今のサーバー時刻 (ms)。ローカルの時計に、ping/pong で測ったずれを足したもの */
    private serverNow: () => number,
  ) {
    const ctx: SyncContext = {
      player,
      loadedState: () => this.loadedState(),
      expected: (s) => this.expected(s),
      suppress: this.suppress,
      apply: () => this.apply(APPLY_THRESHOLD),
      applyAfterLoad: () => this.applyAfterLoad(),
    };
    this.local = new InteractionTracker(player.iframe);
    this.gate = new StartGate(ctx);
    this.catchUp = new CatchUp(ctx, onCatchUp);

    const onLocal = () => {
      // 操作を検知した時点（送信を待つ間も）から、部屋の状態で巻き戻されないようにする
      if (this.isUserInput()) this.local.hold();
      clearTimeout(this.localTimer);
      this.localTimer = window.setTimeout(() => this.onLocalChange(), LOCAL_DEBOUNCE_MS);
    };
    player.on('play', onLocal);
    // 先読みのための再生が始まったら、すぐ 0 秒に戻して止める（音が出続けないように）
    player.on('play', () => {
      if (this.gate.active) this.apply(APPLY_THRESHOLD);
    });
    // 再生開始の通知が来ないことや、止める命令が無視されることがあるので、
    // 開始時刻より前に再生位置が進んでいたら、その都度 0 秒に戻して止める
    player.on('progress', () => this.gate.holdBeforeStart());
    player.on('pause', onLocal);
    player.on('seeked', onLocal);
    player.on('load', () => {
      clearTimeout(this.loadTimer);
      // 読み込めなかったと伝えた後で読み込めたら取り消す
      if (this.reportedFailFor === this.loadedItemId) this.resendLoadReport();
      this.applyAfterLoad();
    });
    player.on('ended', () => this.requestNext(true));
    this.tickTimer = window.setInterval(() => this.onTick(), 1000);
  }

  /** タイマーを止める（使い終わったとき。テストで、タイマーが残らないことを確かめるのにも使う） */
  dispose() {
    clearInterval(this.tickTimer);
    clearTimeout(this.localTimer);
    clearTimeout(this.loadTimer);
    clearTimeout(this.holdRetryTimer);
    this.gate.reset();
    this.catchUp.cancel();
  }

  update(state: PlaybackState) {
    this.state = state;
    const item = state.current;
    if ((item?.id ?? null) !== this.loadedItemId) {
      // 先読みの途中で動画が変わったら、ミュートを元に戻してから切り替える
      this.gate.reset();
      // 前の動画への操作の保護や送信待ちは、新しい動画に持ち越さない（最初の同期が遅れるため）
      clearTimeout(this.localTimer);
      clearTimeout(this.holdRetryTimer);
      this.local.releaseHold();
      this.nextSentUntil = 0;
      this.catchUp.cancel();
      this.reportedFailFor = null;
      const sameVideo = !!item && item.videoId === this.loadedVideoId && this.player.ready();
      this.loadedItemId = item?.id ?? null;
      this.loadedVideoId = item?.videoId ?? null;
      if (sameVideo) {
        // 同じ動画をもう一度（1曲リピートなど）。読み込み直さずに先頭から合わせる
        this.apply(APPLY_THRESHOLD);
        return;
      }
      clearTimeout(this.loadTimer);
      if (item) {
        this.player.load(item.videoId);
        this.loadTimer = window.setTimeout(() => {
          if (this.loadedItemId === item.id && !this.player.ready()) {
            this.onLoadFailed();
            this.reportedFailFor = item.id;
            this.resendLoadReport();
          }
        }, LOAD_TIMEOUT_MS);
      } else {
        this.player.unload();
      }
      return; // 読み込み完了 (load) 後に apply する
    }
    this.apply(APPLY_THRESHOLD);
  }

  /**
   * 読み込めなかった・遅れて読み込めた、の報告を（もう一度）送る。
   * 切断中に送った報告は届かないので、部屋に入り直したときにも呼ぶ
   */
  resendLoadReport() {
    const itemId = this.reportedFailFor;
    if (!itemId || itemId !== this.loadedItemId) return;
    this.send({ t: this.player.ready() ? 'loadOk' : 'loadFailed', itemId });
  }

  /** 部屋の状態。いまのキュー項目が、プレイヤーに読み込み済みのものでなければ null */
  private loadedState(): LoadedState | null {
    const s = this.state;
    return s?.current && s.current.id === this.loadedItemId ? (s as LoadedState) : null;
  }

  /** 今この瞬間の部屋の再生位置 */
  private expected(s: PlaybackState) {
    if (s.playing) return s.position + (this.serverNow() - s.updatedAt) / 1000;
    return s.position;
  }

  /**
   * 読み込み直後の同期。ここでの途中シークだけ、長めに無視する
   * （それ以外では、ユーザーの次の操作を長く受け付けなくなってしまう）
   */
  private applyAfterLoad() {
    this.justLoaded = true;
    this.apply(APPLY_THRESHOLD);
    this.justLoaded = false;
  }

  /** 今起きた変化が、プレイヤーへのユーザー操作によるものと考えられるか */
  private isUserInput() {
    if (this.suppress.active() || this.gate.active) return false;
    return this.local.engaged();
  }

  /** 部屋の状態に自分のプレイヤーを合わせる */
  private apply(threshold: number) {
    const p = this.player;
    // 途中参加で位置が合うのを待っている間は、そちらで合わせる（CatchUp）
    if (this.catchUp.active) return;
    // ユーザーが操作した直後。その操作が部屋に反映されるまで巻き戻さない（this.state は更新済みなので、後の定期補正で合う）
    if (this.local.isHolding()) {
      // 保護が終わったら、保留した他の人の操作を反映する
      clearTimeout(this.holdRetryTimer);
      this.holdRetryTimer = window.setTimeout(() => this.apply(APPLY_THRESHOLD), this.local.holdRemainingMs() + 50);
      return;
    }
    const s = this.loadedState();
    if (!s || !p.ready()) return;

    const target = this.expected(s);
    // 動画の切り替え直後で、まだ開始時刻になっていない。先読みして待つ（StartGate）
    if (this.gate.waitIfBeforeStart(s, target)) return;
    const duration = p.getDuration();
    // 部屋の位置が動画の終端を過ぎている。終了済みの動画に play() すると先頭から再生し直すので触らない
    if (duration > 0 && target >= duration - END_MARGIN) {
      if (!p.isEnded() && p.getTime() < duration - threshold) {
        this.suppress.extend();
        p.seek(duration);
      }
      return;
    }

    // 途中参加: 読み込んだばかりの動画を途中の位置から始めると、位置が合うまでの間、最初から再生されてしまう。
    // 位置が合うまでミュートして画面を隠し、合ったら元に戻す。
    // 先頭からのずれが APPLY_THRESHOLD 以内なら、通常の同期でもシークしないので、この処理は要らない
    if (this.justLoaded && s.playing && target > APPLY_THRESHOLD && p.isPaused()) {
      this.catchUp.begin();
      return;
    }
    if (Math.abs(p.getTime() - target) > threshold) {
      this.suppress.extend(this.justLoaded && target > 1 ? SEEK_SUPPRESS_MS : SUPPRESS_MS);
      p.seek(target);
    }
    if (s.playing && p.isPaused()) {
      this.suppress.extend();
      p.play();
    } else if (!s.playing && !p.isPaused()) {
      this.suppress.extend();
      p.pause();
    }
  }

  /** ユーザーがプレイヤーを操作した */
  private onLocalChange() {
    const s = this.loadedState();
    const p = this.player;
    if (!s) return;
    // 先読みのための再生・停止や、途中参加の位置合わせは、ユーザーの操作ではない
    if (this.gate.active || this.catchUp.active) return;
    // プレイヤーを触っていないのに起きた変化は、同期や読み込みの副作用
    if (!this.local.engaged()) {
      this.local.releaseHold();
      return;
    }
    if (this.suppress.active() || !p.ready()) return;
    // 再生終了による停止は ended で処理する
    if (p.isEnded()) return;

    const playing = !p.isPaused();
    const position = p.getTime();
    const expected = this.expected(s);
    // 開始待ちの間（expected < 0）に止まっているのは部屋の状態どおり
    if (expected < 0 && !playing) return;
    // 部屋の状態と一致しているなら送らない（同期による変化のエコー等）
    if (playing === s.playing && Math.abs(position - Math.max(0, expected)) < APPLY_THRESHOLD) return;
    this.local.hold();
    this.send({ t: 'control', itemId: s.current.id, playing, position });
  }

  /** 動画が最後まで再生されたので次へ進める（1曲リピートならサーバーが同じ動画を繰り返す） */
  private requestNext(auto: boolean) {
    // 動画を読み込み直している最中に、前の動画の終了通知が遅れて届いても、次の動画の終了と取り違えない
    if (auto && !this.player.ready()) return;
    if (!this.loadedState()) return;
    // 終わっているのに進まない確認が毎秒呼ばれても、数秒に1回しか送らない
    if (auto) {
      if (Date.now() < this.nextSentUntil) return;
      this.nextSentUntil = Date.now() + NEXT_RESEND_MS;
    }
    this.send({ t: 'next', itemId: this.loadedItemId, auto });
  }

  private onTick() {
    this.ticks++;
    const s = this.state;
    const p = this.player;
    if (!s?.current || !p.ready()) return;

    // 途中参加などで誰のプレイヤーも終了イベントを出さないまま終端を過ぎた
    const duration = p.getDuration();
    if (s.playing && duration > 0 && this.expected(s) > duration + STUCK_MARGIN) {
      this.requestNext(true);
      return;
    }

    // 先読み中は読み込みの進み具合を毎秒確認する
    if (this.gate.active) {
      this.apply(APPLY_THRESHOLD);
      return;
    }

    // ずれの定期補正
    if (this.ticks % 2 === 0 && !this.suppress.active()) this.apply(DRIFT_THRESHOLD);
  }
}
