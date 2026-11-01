// 使い方: node run.cjs <SyncEngine を export しているモジュール> > log.json（check.cjs から呼ばれる）
// 偽の時計・偽のプレイヤーで、いくつかの場面を流し、プレイヤーとサーバーへの呼び出しを時刻つきで記録する。
// 各場面の最後に、動画が終わったあとの状態（ミュート・覆い・残っているタイマー）も記録する。
// 記録 (expected.json) と比べて、挙動が変わっていないことを確かめる
const path = require('path');
const { SyncEngine } = require(path.resolve(process.argv[2]));

class Clock {
  constructor() { this.now = 1_000_000; this.base = this.now; this.timers = []; this.seq = 0; }
  setTimeout(fn, ms, internal = false) { const id = ++this.seq; this.timers.push({ id, at: this.now + Math.max(0, ms || 0), fn, every: 0, internal }); return id; }
  setInterval(fn, ms) { const id = ++this.seq; this.timers.push({ id, at: this.now + ms, fn, every: ms }); return id; }
  clear(id) { this.timers = this.timers.filter((t) => t.id !== id); }
  advance(ms) {
    const target = this.now + ms;
    for (;;) {
      let next = null;
      for (const t of this.timers) if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      if (!next) break;
      this.now = next.at;
      if (next.every) next.at += next.every; else this.timers = this.timers.filter((t) => t !== next);
      next.fn();
    }
    this.now = target;
  }
}

function makeEnv(scenarioName, run) {
  const clock = new Clock();
  const log = [];
  const t = () => clock.now - clock.base;
  const L = (...a) => log.push(`${String(t()).padStart(6)} ${a.join(' ')}`);

  const iframe = {
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); },
    fire(type) { for (const fn of this.listeners[type] ?? []) fn({ type }); },
  };
  const winListeners = {};
  globalThis.window = {
    setTimeout: (f, ms) => clock.setTimeout(f, ms),
    setInterval: (f, ms) => clock.setInterval(f, ms),
    addEventListener: (type, fn) => { (winListeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { winListeners[type] = (winListeners[type] ?? []).filter((f) => f !== fn); },
  };
  globalThis.document = { activeElement: null };
  globalThis.setTimeout = (f, ms) => clock.setTimeout(f, ms);
  globalThis.setInterval = (f, ms) => clock.setInterval(f, ms);
  globalThis.clearTimeout = (id) => clock.clear(id);
  globalThis.clearInterval = (id) => clock.clear(id);
  Date.now = () => clock.now;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => clock.now - clock.base + 5000 }, configurable: true });

  // ---- 偽のプレイヤー（NicoPlayer と同じ公開メソッド）
  /** 偽のプレイヤー自身のタイマー（エンジンのタイマー漏れの検査から除く） */
  const internalTimeout = (fn, ms) => clock.setTimeout(fn, ms, true);
  const player = {
    iframe,
    handlers: {},
    failLoad: false,
    /** 再生開始の通知（play イベント）を出さない（実際のプレイヤーに、そういうことがある） */
    noPlayEvent: false,
    /** seek の命令を無視する */
    ignoreSeek: false,
    /** play / pause の命令を無視する（自動再生のブロックなど） */
    ignorePlay: false,
    ignorePause: false,
    loaded: false, status: 'loading', pos: 0, playingSince: 0, dataReady: false,
    time: 0, timeAt: 0, reported: { time: 0, at: 0 }, muted: false, duration: 0,
    /** 読み込み完了の通知（load）を、もう一度出す */
    reload() { this.emit('load'); },
    on(type, fn) { (this.handlers[type] ??= []).push(fn); },
    emit(type) { for (const fn of this.handlers[type] ?? []) fn(); },
    truePos() { return this.pos + (this.status === 'playing' ? (clock.now - this.playingSince) / 1000 : 0); },
    perf() { return clock.now - clock.base + 5000; },
    load(id) {
      L('player.load', id);
      this.loaded = false; this.status = 'loading'; this.time = 0; this.timeAt = 0; this.duration = 0; this.reported = { time: 0, at: 0 };
      this.pos = 0; this.dataReady = false;
      if (!this.failLoad) internalTimeout(() => { this.loaded = true; this.duration = 120; this.emit('load'); }, 300);
    },
    unload() { L('player.unload'); this.loaded = false; },
    ready() { return this.loaded; },
    play() {
      L('player.play');
      if (this.ignorePlay) return;
      internalTimeout(() => {
        if (this.status === 'playing') return;
        this.pos = this.truePos(); this.time = this.pos; this.timeAt = this.perf();
        this.status = 'playing'; this.playingSince = clock.now;
        internalTimeout(() => (this.dataReady = true), 200);
        if (!this.noPlayEvent) this.emit('play');
      }, 80);
    },
    pause() {
      L('player.pause');
      if (this.ignorePause) return;
      internalTimeout(() => {
        if (this.status !== 'playing') return;
        this.pos = this.truePos(); this.time = this.pos; this.timeAt = this.perf();
        this.status = 'paused'; this.emit('pause');
      }, 50);
    },
    seek(sec) {
      sec = Math.max(0, sec);
      L('player.seek', sec.toFixed(2));
      this.time = sec; this.timeAt = this.perf(); // 本物の NicoPlayer と同じ、見かけ上の位置
      internalTimeout(() => {
        if (!this.dataReady || this.ignoreSeek) return; // データを読み込む前のシークは効かない
        this.pos = sec; if (this.status === 'playing') this.playingSince = clock.now;
        this.emit('seeked');
      }, 100);
    },
    mute(m) { L('player.mute', m); this.muted = m; },
    isMuted() { return this.muted; },
    getTime() { if (this.status !== 'playing' || !this.timeAt) return this.time; return this.time + (this.perf() - this.timeAt) / 1000; },
    getDuration() { return this.duration; },
    isPaused() { return this.status !== 'playing'; },
    isEnded() { return this.status === 'ended'; },
    getReported() { return this.reported; },
    // ---- ユーザー操作（偽）
    userSeek(sec) { this.pos = sec; this.time = sec; this.timeAt = this.perf(); if (this.status === 'playing') this.playingSince = clock.now; L('USER seek', sec); this.emit('seeked'); },
    userPause() { this.pos = this.truePos(); this.status = 'paused'; this.time = this.pos; this.timeAt = this.perf(); L('USER pause'); this.emit('pause'); },
    completeLoad() { this.loaded = true; this.duration = 120; this.emit('load'); },
    userPlay() { this.pos = this.truePos(); this.status = 'playing'; this.playingSince = clock.now; this.time = this.pos; this.timeAt = this.perf(); L('USER play'); this.emit('play'); },
    drift(sec) { this.pos += sec; this.time += sec; },
    finish() { this.pos = this.duration; this.status = 'ended'; this.emit('ended'); },
  };
  // プレイヤーが約 0.25 秒ごとに位置を通知する
  clock.setInterval(() => {
    if (player.status !== 'playing') return;
    const prev = player.time;
    player.time = player.truePos(); player.timeAt = player.perf();
    player.reported = { time: player.time, at: player.timeAt };
    if (player.time > prev) player.emit('progress');
  }, 250);

  /** サーバーの時計が、ローカルの時計より進んでいる量 (ms)。場面から変えられる */
  const offset = { v: 0 };
  let cover = false;
  const engine = new SyncEngine(
    player,
    (msg) => L('send', JSON.stringify(msg)),
    () => L('onLoadFailed'),
    (on) => { cover = on; L('cover', on); },
    () => clock.now + offset.v,
  );
  const item = (id, videoId) => ({ id, videoId, title: 't', addedBy: 'a' });
  // updatedAt は、サーバーの時刻で書く
  const state = (over) => ({ current: item('i1', 'sm1'), playing: true, position: 0, updatedAt: clock.now + offset.v, version: 1, by: null, byName: null, ...over });
  let initialMuted = false;
  const startPlayerMuted = (muted) => { player.muted = muted; initialMuted = muted; };
  try {
    run({ clock, player, engine, state, item, L, iframe, winListeners, offset, startPlayerMuted });
  } catch (e) {
    log.push('EXCEPTION ' + (e && e.stack));
  }
  // ---- 場面のあとの状態の確認（動画の同期が終わったら、ミュート・覆い・タイマーが元に戻っていること）
  const mutedRestored = player.muted === initialMuted;
  engine.dispose();
  const leftover = clock.timers.filter((t) => !t.internal && t.every !== 250).length; // 250ms は偽のプレイヤーの位置通知
  const listenersLeft = Object.values(winListeners).flat().length + Object.values(iframe.listeners).flat().length;
  log.push(`END mutedRestored=${mutedRestored} cover=${cover} timersAfterDispose=${leftover} listenersAfterDispose=${listenersLeft}`);
  return log;
}

const scenarios = {
  '途中参加（再生中の部屋に入る）': ({ clock, engine, state }) => {
    engine.update(state({ position: 30 })); clock.advance(15000);
  },
  '途中参加 + 途中で状態の再送': ({ clock, engine, state }) => {
    const s = state({ position: 30 }); engine.update(s); clock.advance(3000); engine.update({ ...s, version: 2 }); clock.advance(6000);
  },
  '開始待ち（切り替え直後）': ({ clock, engine, state }) => {
    engine.update(state({ position: 0, updatedAt: clock.now + 3000 })); clock.advance(10000);
  },
  '参加直後は先頭（ずれが小さい）': ({ clock, engine, state }) => {
    engine.update(state({ position: 0.4 })); clock.advance(8000);
  },
  '参加後に、ユーザーがシーク': ({ clock, engine, state, player, iframe }) => {
    engine.update(state({ position: 30 })); clock.advance(10000);
    iframe.fire('pointerenter'); player.userSeek(70); clock.advance(2500);
  },
  '参加直後（位置合わせ中）に、ユーザーがシーク': ({ clock, engine, state, player, iframe }) => {
    engine.update(state({ position: 30 })); clock.advance(1200);
    iframe.fire('pointerenter'); player.userSeek(70); clock.advance(5000);
  },
  'ユーザーが一時停止': ({ clock, engine, state, player, iframe }) => {
    engine.update(state({ position: 30 })); clock.advance(10000);
    iframe.fire('pointerenter'); player.userPause(); clock.advance(3000);
  },
  'プレイヤーの外では、同期の変化を送らない': ({ clock, engine, state, player }) => {
    engine.update(state({ position: 30 })); clock.advance(10000);
    player.userSeek(70); clock.advance(3000);
  },
  'フォーカスがあるときのキーボード操作': ({ clock, engine, state, player, iframe, winListeners }) => {
    engine.update(state({ position: 30 })); clock.advance(10000);
    globalThis.document.activeElement = iframe; for (const fn of winListeners.blur ?? []) fn();
    player.userSeek(55); clock.advance(8000); player.userSeek(80); clock.advance(3000);
  },
  '他の人が一時停止': ({ clock, engine, state }) => {
    const s = state({ position: 30 }); engine.update(s); clock.advance(10000);
    engine.update({ ...s, playing: false, position: 41, updatedAt: clock.now, version: 2 }); clock.advance(5000);
  },
  '他の人がシーク': ({ clock, engine, state }) => {
    const s = state({ position: 30 }); engine.update(s); clock.advance(10000);
    engine.update({ ...s, position: 90, updatedAt: clock.now, version: 2 }); clock.advance(5000);
  },
  '操作の保護中に、他の人の状態が届く': ({ clock, engine, state, player, iframe }) => {
    const s = state({ position: 30 }); engine.update(s); clock.advance(10000);
    iframe.fire('pointerenter'); player.userSeek(70); clock.advance(200);
    engine.update({ ...s, position: 20, updatedAt: clock.now, version: 2 }); clock.advance(6000);
  },
  '位置合わせ中に動画が切り替わる': ({ clock, engine, state, item }) => {
    engine.update(state({ position: 30 })); clock.advance(900);
    engine.update(state({ current: item('i2', 'sm2'), position: 0, updatedAt: clock.now + 3000 })); clock.advance(10000);
  },
  '開始待ち中に動画が切り替わる': ({ clock, engine, state, item }) => {
    engine.update(state({ position: 0, updatedAt: clock.now + 3000 })); clock.advance(1500);
    engine.update(state({ current: item('i2', 'sm2'), position: 0, updatedAt: clock.now + 3000 })); clock.advance(10000);
  },
  '同じ動画をもう一度（リピート）': ({ clock, engine, state, item }) => {
    engine.update(state({ position: 0, updatedAt: clock.now })); clock.advance(6000);
    engine.update(state({ current: item('i3', 'sm1'), position: 0, updatedAt: clock.now + 3000 })); clock.advance(8000);
  },
  '動画の終了で次へ': ({ clock, engine, state, player }) => {
    engine.update(state({ position: 100 })); clock.advance(10000); player.finish(); clock.advance(5000);
  },
  '終端を過ぎた状態で参加（終了通知が来ない）': ({ clock, engine, state }) => {
    engine.update(state({ position: 130 })); clock.advance(15000);
  },
  '読み込めない動画': ({ clock, engine, state, player }) => {
    player.failLoad = true; engine.update(state({ position: 0 })); clock.advance(25000); engine.resendLoadReport();
  },
  '開始待ち中に他の人が一時停止': ({ clock, engine, state }) => {
    const s = state({ position: 0, updatedAt: clock.now + 3000 }); engine.update(s); clock.advance(1500);
    engine.update({ ...s, playing: false, position: 0, updatedAt: clock.now, version: 2 }); clock.advance(6000);
  },
  '参加時に一時停止中の部屋': ({ clock, engine, state }) => {
    engine.update(state({ playing: false, position: 45 })); clock.advance(8000);
  },
  '何も再生していない状態へ': ({ clock, engine, state }) => {
    engine.update(state({ position: 30 })); clock.advance(8000);
    engine.update({ ...state({ position: 0 }), current: null, playing: false, version: 3 }); clock.advance(3000);
  },
};

Object.assign(scenarios, {
  'サーバーの時計が進んでいる（+5 秒）': ({ clock, engine, state, offset }) => {
    offset.v = 5000; engine.update(state({ position: 30 })); clock.advance(12000);
  },
  'サーバーの時計が遅れている（-3 秒）': ({ clock, engine, state, offset }) => {
    offset.v = -3000; engine.update(state({ position: 30 })); clock.advance(12000);
  },
  '途中で時計のずれが補正される': ({ clock, engine, state, offset }) => {
    engine.update(state({ position: 30 })); clock.advance(5000); offset.v = 2500; clock.advance(9000);
  },
  '音を消していた人の途中参加（ミュートが元に戻る）': ({ clock, engine, state, startPlayerMuted }) => {
    startPlayerMuted(true); engine.update(state({ position: 30 })); clock.advance(12000);
  },
  '音を消していた人の開始待ち（ミュートが元に戻る）': ({ clock, engine, state, startPlayerMuted }) => {
    startPlayerMuted(true); engine.update(state({ position: 0, updatedAt: clock.now + 3000 })); clock.advance(10000);
  },
  '位置合わせがタイムアウトする（シークが効かない）': ({ clock, engine, state, player }) => {
    player.ignoreSeek = true; engine.update(state({ position: 30 })); clock.advance(20000);
  },
  '再生開始の通知が来ない（開始待ち）': ({ clock, engine, state, player }) => {
    player.noPlayEvent = true; engine.update(state({ position: 0, updatedAt: clock.now + 3000 })); clock.advance(10000);
  },
  '再生開始の通知が来ない（途中参加）': ({ clock, engine, state, player }) => {
    player.noPlayEvent = true; engine.update(state({ position: 30 })); clock.advance(12000);
  },
  '終了通知の送り直し（次へ進まないとき）': ({ clock, engine, state, player }) => {
    engine.update(state({ position: 100 })); clock.advance(10000); player.finish(); clock.advance(9000);
  },
  '遅れて読み込めた（loadOk で取り消す）': ({ clock, engine, state, player }) => {
    player.failLoad = true; engine.update(state({ position: 0 })); clock.advance(21000); player.completeLoad(); clock.advance(5000);
  },
  'ポインターが外れたら、保護が解ける': ({ clock, engine, state, player, iframe }) => {
    engine.update(state({ position: 30 })); clock.advance(10000);
    iframe.fire('pointerenter'); player.userSeek(70); clock.advance(300); iframe.fire('pointerleave'); clock.advance(3000);
  },
  'ユーザーが再生ボタンで再生（一時停止中の部屋）': ({ clock, engine, state, player, iframe }) => {
    engine.update(state({ playing: false, position: 45 })); clock.advance(8000);
    iframe.fire('pointerenter'); player.userPlay(); clock.advance(3000);
  },
  '再生中にずれが広がる（定期補正）': ({ clock, engine, state, player }) => {
    engine.update(state({ position: 30 })); clock.advance(10000); player.drift(4); clock.advance(6000);
  },
  '開始待ち中のユーザー操作は送らない': ({ clock, engine, state, player, iframe }) => {
    engine.update(state({ position: 0, updatedAt: clock.now + 3000 })); clock.advance(1200);
    iframe.fire('pointerenter'); player.userPause(); player.userSeek(10); clock.advance(4000);
  },
  '読み込み中に前の動画の終了通知が届く': ({ clock, engine, state, player, item }) => {
    engine.update(state({ position: 0, updatedAt: clock.now })); clock.advance(5000);
    engine.update(state({ current: item('i2', 'sm2'), position: 0, updatedAt: clock.now + 3000 })); player.finish(); clock.advance(8000);
  },
  '再生の命令が無視される（自動再生ブロック。位置合わせを繰り返さない）': ({ clock, engine, state, player }) => {
    player.ignorePlay = true; engine.update(state({ position: 30 })); clock.advance(30000);
  },
  '一時停止の命令が無視される（開始待ち）': ({ clock, engine, state, player }) => {
    player.ignorePause = true; engine.update(state({ position: 0, updatedAt: clock.now + 3000 })); clock.advance(10000);
  },
  '読み込み完了の直前にユーザーがシーク（保護中に読み込みが終わる）': ({ clock, engine, state, player, iframe }) => {
    engine.update(state({ position: 30 })); clock.advance(100);
    iframe.fire('pointerenter'); player.userSeek(5); clock.advance(10000);
  },
  '読み込み完了の通知が二度来る': ({ clock, engine, state, player }) => {
    engine.update(state({ position: 30 })); clock.advance(5000); player.reload(); clock.advance(8000);
  },
});

const out = {};
for (const [name, run] of Object.entries(scenarios)) out[name] = makeEnv(name, run);
console.log(JSON.stringify(out, null, 1));
