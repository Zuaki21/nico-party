import type { ClientMsg, PlaybackState } from '../../shared/protocol';
import type { NicoPlayer } from './nicoPlayer';

/** 自分が操作した直後に発火するイベントを「ユーザー操作」と誤認しない時間 */
const SUPPRESS_MS = 800;
/**
 * 自分のプレイヤーを途中の位置へシークさせた直後は、読み込みが終わって位置の通知が追いつくまで時間がかかる。
 * その間に出る再生・シーク完了のイベントや 0 秒付近の位置通知を、ユーザー操作として全員に送ってしまわないための時間
 * （途中参加したときに、全員の動画が最初に戻されるのを防ぐ）
 */
const SEEK_SUPPRESS_MS = 4000;
/** 誰かの操作を受けたとき、これ以上ずれていたらシーク */
const APPLY_THRESHOLD = 1.0;
/** 定期チェックでのシーク閾値（シーク連発でカクつかないよう大きめ） */
const DRIFT_THRESHOLD = 1.5;
/** プレイヤーをクリックした（フォーカスが移った）あと、ユーザー操作とみなす時間 */
const INTERACT_MS = 5000;
/**
 * ユーザーが操作してから、その操作が部屋に届いて返ってくるまで、部屋の状態で上書きしない時間。
 * これが無いと、操作の直後に届いた他の状態更新や定期補正で、操作が無かったことにされてシークが戻る
 */
const LOCAL_HOLD_MS = 1500;
/** 動画の終端とみなす余裕（秒） */
const END_MARGIN = 0.5;
/**
 * これだけ待ってもプレイヤーの読み込みが終わらなければ、読み込めなかったとサーバーに伝える（全員そろったら次へ進む）。
 * 再生できない動画は追加時にサーバーが弾くが、見つけられなかった種類のエラーへの保険
 */
const LOAD_TIMEOUT_MS = 20000;
/** 開始時刻を待つ間、一時停止を送り直す間隔 */
const HOLD_INTERVAL_MS = 300;
/** 先読みのための再生を、再生開始の通知が無くても止めるまでの時間 */
const PRELOAD_PLAY_MS = 400;
/** 全員の動画が終わっているはずなのに次へ進んでいないとき、自分から進めるまでの猶予（秒） */
const STUCK_MARGIN = 3;
/** ローカル操作をまとめる時間（シークバーのドラッグ等） */
const LOCAL_DEBOUNCE_MS = 150;

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
  /** プレイヤーに読み込んでいる動画 ID（1曲リピートなどで同じ動画なら読み込み直さない） */
  private loadedVideoId: string | null = null;
  private suppressUntil = 0;
  private localTimer: number | undefined;
  /** 再生開始時刻ちょうどに再生を始めるためのタイマー */
  private startTimer: number | undefined;
  /** 読み込みが終わらない動画を飛ばすためのタイマー */
  private loadTimer: number | undefined;
  /** 開始待ちの間、ミュートで裏再生して動画データを先読みしている */
  private preloading = false;
  /** 先読みが済んだキュー項目 */
  private preloadedFor: string | null = null;
  /** 先読みのためにミュートする前の状態（終わったら戻す） */
  private mutedBefore = false;
  private preloadStartedAt = 0;
  /** 開始時刻まで 0 秒で止めておくためのタイマー */
  private holdTimer: number | undefined;
  /** 読み込めなかったとサーバーに伝えたキュー項目（再接続したら送り直し、遅れて読み込めたら取り消す） */
  private reportedFailFor: string | null = null;
  private ticks = 0;
  /** マウス・タッチがプレイヤーの上にある */
  private pointerInside = false;
  /** この時刻までは、ユーザーの操作を優先して部屋の状態を反映しない */
  private localHoldUntil = 0;
  /** プレイヤーをクリック・キー操作した直後（この時刻まで）はユーザー操作とみなす */
  private interactUntil = 0;

  constructor(
    private player: NicoPlayer,
    private send: (msg: ClientMsg) => void,
    /** 自分のプレイヤーで動画を読み込めなかった */
    private onLoadFailed: () => void,
  ) {
    // プレイヤーは別オリジンの iframe で、中の操作は見えない。
    // ポインターが上にある・クリックでフォーカスが移った、のどちらかのときだけ、変化をユーザー操作とみなす
    // （同期のための自分の操作や読み込みの副作用を、誤って全員に送らないため）
    const iframe = player.iframe;
    iframe.addEventListener('pointerenter', () => (this.pointerInside = true));
    iframe.addEventListener('pointerleave', () => (this.pointerInside = false));
    window.addEventListener('blur', () => {
      if (document.activeElement === iframe) this.interactUntil = Date.now() + INTERACT_MS;
    });
    const onLocal = () => {
      // 操作を検知した時点（送信を待つ間も）から、部屋の状態で巻き戻されないようにする
      if (this.isUserInput()) this.localHoldUntil = Date.now() + LOCAL_HOLD_MS;
      clearTimeout(this.localTimer);
      this.localTimer = window.setTimeout(() => this.onLocalChange(), LOCAL_DEBOUNCE_MS);
    };
    player.on('play', onLocal);
    // 先読みのための再生が始まったら、すぐ 0 秒に戻して止める（音が出続けないように）
    player.on('play', () => {
      if (this.preloading) this.apply(APPLY_THRESHOLD);
    });
    // 再生開始の通知が来ないことや、止める命令が無視されることがあるので、
    // 開始時刻より前に再生位置が進んでいたら、その都度 0 秒に戻して止める
    player.on('progress', () => this.holdBeforeStart());
    player.on('pause', onLocal);
    player.on('seeked', onLocal);
    player.on('load', () => {
      clearTimeout(this.loadTimer);
      // 読み込めなかったと伝えた後で読み込めたら取り消す
      if (this.reportedFailFor === this.loadedItemId) this.resendLoadReport();
      this.apply(APPLY_THRESHOLD);
    });
    player.on('ended', () => this.requestNext(true));
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
      this.stopHold();
      clearTimeout(this.startTimer);
      this.preloading = false;
      this.preloadedFor = null;
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

  private serverNow() {
    return Date.now() + this.clockOffset;
  }

  /** 今この瞬間の部屋の再生位置 */
  private expected(s: PlaybackState) {
    if (s.playing) return s.position + (this.serverNow() - s.updatedAt) / 1000;
    return s.position;
  }

  private suppress(ms = SUPPRESS_MS) {
    this.suppressUntil = Math.max(this.suppressUntil, Date.now() + ms);
  }

  /** 今起きた変化が、プレイヤーへのユーザー操作によるものと考えられるか */
  private isUserInput() {
    if (Date.now() < this.suppressUntil || this.preloading) return false;
    return this.pointerInside || Date.now() < this.interactUntil;
  }

  /** 部屋の状態に自分のプレイヤーを合わせる */
  private apply(threshold: number) {
    const s = this.state;
    const p = this.player;
    // ユーザーが操作した直後。その操作が部屋に反映されるまで巻き戻さない（this.state は更新済みなので、後の定期補正で合う）
    if (Date.now() < this.localHoldUntil) return;
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
    this.stopHold();
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
      this.suppress(target > 1 ? SEEK_SUPPRESS_MS : SUPPRESS_MS);
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
   * ニコニコのプレイヤーは再生するまで動画データを読み込まないので、一度だけ再生して読み込みを始めさせ、
   * 再生が始まったらすぐ 0 秒に戻して止める（開始時刻に再生した瞬間に読み込みが始まって遅れるのを防ぐ）。
   * 念のためミュートもするが、環境によっては効かないので、再生している時間を最小にしている
   */
  private preload(itemId: string) {
    const p = this.player;
    if (this.preloadedFor === itemId || this.preloading) {
      this.startHold();
      this.holdBeforeStart();
      return;
    }
    // 一度だけ再生して読み込みを始めさせる。止めるのは holdBeforeStart（すぐ・または少し後）
    this.preloading = true;
    this.preloadStartedAt = Date.now();
    this.mutedBefore = p.isMuted();
    this.suppress();
    p.mute(true);
    p.play();
    this.startHold();
  }

  /**
   * 開始時刻を待つ間、プレイヤーを 0 秒で止めておく。
   * ニコニコのプレイヤーは再生開始の通知を送らないことがあり、再生位置の通知も再生中は 2 秒おき程度なので、
   * 通知を待たずに HOLD_INTERVAL_MS ごとに一時停止を送り続ける（止まっていれば何も起きない）
   */
  private startHold() {
    if (this.holdTimer !== undefined) return;
    this.holdTimer = window.setInterval(() => this.holdBeforeStart(), HOLD_INTERVAL_MS);
  }

  private stopHold() {
    clearInterval(this.holdTimer);
    this.holdTimer = undefined;
  }

  /** 開始時刻より前ならプレイヤーを止めておく（progress・定期的な確認のたびに呼ばれる） */
  private holdBeforeStart() {
    const s = this.state;
    const p = this.player;
    if (!s?.current || s.current.id !== this.loadedItemId || !s.playing || this.expected(s) >= 0) {
      this.stopHold();
      return;
    }
    if (this.preloading) {
      // 再生が始まった兆候があるか、少し待ったら先読みを終えて止める（読み込みは止めた後も続く）
      const started = !p.isPaused() || p.getTime() > 0;
      if (!started && Date.now() - this.preloadStartedAt < PRELOAD_PLAY_MS) return;
      this.endPreload(true);
      this.preloadedFor = s.current.id;
      return;
    }
    // 状態の通知が当てにならないので、止まっているつもりでも一時停止を送る
    this.suppress();
    p.pause();
    if (p.getTime() > 0.05) p.seek(0);
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
    // プレイヤーを触っていないのに起きた変化は、同期や読み込みの副作用
    if (!this.pointerInside && Date.now() >= this.interactUntil) {
      this.localHoldUntil = 0;
      return;
    }
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
    this.localHoldUntil = Date.now() + LOCAL_HOLD_MS;
    this.send({ t: 'control', itemId: s.current.id, playing, position });
  }

  /** 動画が最後まで再生されたので次へ進める（1曲リピートならサーバーが同じ動画を繰り返す） */
  private requestNext(auto: boolean) {
    // 動画を読み込み直している最中に、前の動画の終了通知が遅れて届いても、次の動画の終了と取り違えない
    if (auto && !this.player.ready()) return;
    if (this.state?.current && this.state.current.id === this.loadedItemId) {
      this.send({ t: 'next', itemId: this.loadedItemId, auto });
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
      this.requestNext(true);
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
