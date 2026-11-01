// 再生の状態遷移 (src/room/playback.ts) の単体テスト。保存や配信を含まない関数だけなので、時刻・ID・乱数を固定して確かめられる。
//   cd server && npm run check:playback
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

// TypeScript を CommonJS に変換して、同じフォルダ構成のまま一時フォルダに置く
const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playback-'));
for (const rel of ['server/src/room/playback.ts', 'shared/playlist.ts']) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const out = path.join(tmp, rel.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, js);
}
const pb = require(path.join(tmp, 'server/src/room/playback.js'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = 1_000_000;
let n = 0;
const deps = (over = {}) => ({ now: NOW, newId: () => `n${++n}`, random: () => 0, ...over });
const by = { id: 'u1', name: '太郎' };
const item = (id, videoId = 'sm' + id) => ({ id, videoId, title: id, addedBy: 'x' });
const state = (over = {}) => ({ current: null, playing: false, position: 0, updatedAt: 0, version: 0, by: null, byName: null, ...over });
const snap = (over = {}) => ({ state: state(), queue: [], history: [], ...over });
const ids = (list) => list.map((q) => q.id).join(',');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('失敗:', name); throw e; }
}

test('何も再生していないときの追加は、すぐ再生を始める（開始は 3 秒先）', () => {
  const c = pb.addItem(snap(), item('a'), by, deps());
  assert.equal(c.state.current.id, 'a');
  assert.equal(c.state.playing, true);
  assert.equal(c.state.position, 0);
  assert.equal(c.state.updatedAt, NOW + pb.START_DELAY_MS);
  assert.equal(c.state.startedAt, NOW);
  assert.equal(c.state.by, 'u1');
  assert.equal(c.queue.length, 0);
});

test('再生中の追加は、キューの最後に足すだけ（状態は変えない）', () => {
  const c = pb.addItem(snap({ state: state({ current: item('a') }), queue: [item('b')] }), item('c'), by, deps());
  assert.equal(c.state, undefined);
  assert.equal(ids(c.queue), 'b,c');
});

test('シャッフルのときは、乱数で次の動画を選ぶ', () => {
  const s = snap({ state: state({ current: item('a'), shuffle: true }), queue: [item('b'), item('c'), item('d')] });
  const c = pb.nextItem(s, { itemId: 'a' }, by, deps({ random: () => 0.7 }));
  assert.equal(c.state.current.id, 'd'); // floor(0.7 * 3) = 2
  assert.equal(ids(c.history), 'a');
  assert.equal(ids(c.queue), 'b,c');
});

test('次へ: 今の動画は視聴済みに回り、キューの先頭が再生される', () => {
  const c = pb.nextItem(snap({ state: state({ current: item('a') }), queue: [item('b'), item('c')] }), { itemId: 'a' }, by, deps());
  assert.equal(c.state.current.id, 'b');
  assert.equal(ids(c.history), 'a');
  assert.equal(ids(c.queue), 'c');
});

test('次へ: 動画の ID が合わなければ無視（複数人から同時に届いても 1 回だけ進む）', () => {
  assert.equal(pb.nextItem(snap({ state: state({ current: item('b') }) }), { itemId: 'a' }, by, deps()), null);
});

test('自動送りは、動画の開始から 3 秒以内なら捨てる（遅れて届いた前の動画の終了通知）', () => {
  const s = snap({ state: state({ current: item('a'), startedAt: NOW - 2000 }), queue: [item('b')] });
  assert.equal(pb.nextItem(s, { itemId: 'a', auto: true }, by, deps()), null);
  assert.ok(pb.nextItem(s, { itemId: 'a' }, by, deps()), '手動の次へは受け付ける');
  const later = snap({ state: state({ current: item('a'), startedAt: NOW - 4000 }), queue: [item('b')] });
  assert.equal(pb.nextItem(later, { itemId: 'a', auto: true }, by, deps()).state.current.id, 'b');
});

test('1 曲リピート: 自動送りでは、同じ動画を新しい ID でもう一度', () => {
  const s = snap({ state: state({ current: item('a'), startedAt: 0, repeat: 'one' }), queue: [item('b')] });
  const c = pb.nextItem(s, { itemId: 'a', auto: true }, by, deps());
  assert.equal(c.state.current.videoId, 'sma');
  assert.notEqual(c.state.current.id, 'a');
  assert.equal(c.queue, undefined);
  assert.equal(pb.nextItem(s, { itemId: 'a' }, by, deps()).state.current.id, 'b', '手動の次へは先へ進む');
});

test('全曲リピート: 最後まで来たら、視聴済みを全部もう一度（新しい ID で）', () => {
  const s = snap({ state: state({ current: item('c'), repeat: 'all' }), history: [item('a'), item('b')] });
  const c = pb.nextItem(s, { itemId: 'c' }, by, deps());
  assert.equal(c.state.current.videoId, 'sma');
  assert.equal(c.queue.map((q) => q.videoId).join(','), 'smb,smc');
  assert.equal(c.history.length, 0);
});

test('再生中の動画を消すと、視聴済みには残さず、次の動画へ進む', () => {
  const s = snap({ state: state({ current: item('a') }), queue: [item('b')], history: [item('z')] });
  const c = pb.removeItem(s, 'a', by, deps());
  assert.equal(c.state.current.id, 'b');
  assert.equal(ids(c.history), 'z');
  assert.equal(c.queue.length, 0);
});

test('最後の 1 本を消すと、停止する', () => {
  const c = pb.removeItem(snap({ state: state({ current: item('a') }) }), 'a', by, deps());
  assert.equal(c.state.current, null);
  assert.equal(c.state.playing, false);
});

test('キューや視聴済みの動画を消す。無ければ何も変えない', () => {
  const s = snap({ state: state({ current: item('a') }), queue: [item('b'), item('c')], history: [item('z')] });
  assert.equal(ids(pb.removeItem(s, 'b', by, deps()).queue), 'c');
  assert.equal(ids(pb.removeItem(s, 'z', by, deps()).history), '');
  assert.equal(pb.removeItem(s, 'nothing', by, deps()), null);
});

test('前へ: 直前の動画に戻り、今の動画はキューの先頭に戻る', () => {
  const s = snap({ state: state({ current: item('b') }), queue: [item('c')], history: [item('z'), item('a')] });
  const c = pb.prevItem(s, 'b', by, deps());
  assert.equal(c.state.current.id, 'a');
  assert.equal(ids(c.queue), 'b,c');
  assert.equal(ids(c.history), 'z');
});

test('前へ: 戻る先が無ければ、今の動画を新しい ID で最初から', () => {
  const c = pb.prevItem(snap({ state: state({ current: item('a'), position: 50 }) }), 'a', by, deps());
  assert.equal(c.state.current.videoId, 'sma');
  assert.notEqual(c.state.current.id, 'a');
  assert.equal(c.state.position, 0);
  assert.equal(pb.prevItem(snap({ state: state({ current: item('a') }) }), 'other', by, deps()), null);
});

test('ジャンプ: 選んだ動画から再生し、それより前は視聴済み・後ろはキュー', () => {
  const s = snap({ state: state({ current: item('b') }), queue: [item('c'), item('d')], history: [item('a')] });
  const c = pb.jumpItem(s, 'd', by, deps());
  assert.equal(c.state.current.id, 'd');
  assert.equal(ids(c.history), 'a,b,c');
  assert.equal(c.queue.length, 0);
  assert.equal(pb.jumpItem(s, 'b', by, deps()), null, '今の動画へのジャンプは何もしない');
});

test('並べ替え', () => {
  const s = snap({ state: state({ current: item('a') }), queue: [item('b'), item('c')] });
  assert.equal(ids(pb.moveItem(s, 'c', 1).queue), 'c,b');
  assert.equal(pb.moveItem(s, 'nothing', 0), null);
});

test('操作: 古い動画への操作は捨て、位置は 0 以上にそろえる', () => {
  const s = state({ current: item('a') });
  assert.equal(pb.control(s, { itemId: 'zzz', playing: true, position: 5 }, by, deps()), null);
  const c = pb.control(s, { itemId: 'a', playing: false, position: -3 }, by, deps());
  assert.equal(c.playing, false);
  assert.equal(c.position, 0);
  assert.equal(c.updatedAt, NOW);
});

test('モード: 指定したものだけ変える。再生位置の基準は変えない', () => {
  const s = state({ updatedAt: 42, repeat: 'off', shuffle: false });
  const c = pb.setMode(s, { shuffle: true });
  assert.equal(c.shuffle, true);
  assert.equal(c.repeat, 'off');
  assert.equal(c.updatedAt, 42);
});

test('全員が読み込めなかった動画は、視聴済みに残さず飛ばす', () => {
  const s = snap({ state: state({ current: item('a') }), queue: [item('b')], history: [item('z')] });
  const c = pb.skipUnloadable(s, by, deps());
  assert.equal(c.state.current.id, 'b');
  assert.equal(ids(c.history), 'z');
});

test('再生リストの上限: 古い視聴済みから消える（再生中とキューは消えない）', () => {
  const history = Array.from({ length: 149 }, (_, i) => item('h' + i));
  const s = snap({ state: state({ current: item('a') }), queue: [item('q1')], history });
  assert.equal(pb.hasRoom(s), true);
  const c = pb.addItem(s, item('q2'), by, deps());
  assert.equal(c.history.length, 150 - 1 - 2); // 上限 150 − 再生中 1 − キュー 2
  assert.equal(c.history[0].id, 'h' + (149 - c.history.length));
  assert.equal(pb.hasRoom(snap({ state: state({ current: item('a') }), queue: Array.from({ length: 149 }, (_, i) => item('q' + i)) })), false);
});

console.log(`OK: ${passed} 件`);
