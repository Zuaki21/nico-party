// 再生の状態遷移以外の、サーバーと shared の純粋なロジックの単体テスト。
//   メッセージの検証・通行証・読み込み失敗の記録・量の制限・追加の順番待ち・保存先・本文の読み取り上限・中継の経路・並べ替え
//   cd server && npm run check:misc
const assert = require('node:assert/strict');
const { loadTs } = require('./_load.cjs');

const load = loadTs([
  'server/src/room/validate.ts',
  'server/src/room/loadReport.ts',
  'server/src/room/sockets.ts',
  'server/src/room/enqueue.ts',
  'server/src/room/roomStore.ts',
  'server/src/room/state.ts',
  'server/src/pass.ts',
  'server/src/body.ts',
  'server/src/nico/nicoRoutes.ts',
  'server/src/nico/nicoRewrite.ts',
  'shared/playlist.ts',
  'shared/video.ts',
]);
const { parseClientMsg } = load('server/src/room/validate.ts');
const { reportLoad, everyoneFailed } = load('server/src/room/loadReport.ts');
const { MessageLimiter } = load('server/src/room/sockets.ts');
const { EnqueueQueue } = load('server/src/room/enqueue.ts');
const { RoomStore } = load('server/src/room/roomStore.ts');
const pass = load('server/src/pass.ts');
const { readLimited, BodyTooLargeError } = load('server/src/body.ts');
const { matchRoute } = load('server/src/nico/nicoRoutes.ts');
const { reorder, jumpTo } = load('shared/playlist.ts');
const { parseVideoId } = load('shared/video.ts');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const item = (id) => ({ id, videoId: 'sm' + id, title: id, addedBy: 'x' });
const ids = (list) => list.map((q) => q.id).join(',');

// ---- parseClientMsg
test('検証: 正しい join は通り、形式の合わない clientId だけ捨てる', () => {
  assert.deepEqual(parseClientMsg({ t: 'join', name: 'a', clientId: 'abcdefgh-1234' }), { t: 'join', name: 'a', clientId: 'abcdefgh-1234' });
  assert.deepEqual(parseClientMsg({ t: 'join', name: 'a', clientId: 'x y' }), { t: 'join', name: 'a' });
  assert.equal(parseClientMsg({ t: 'join', name: 'a'.repeat(201) }), null);
  assert.equal(parseClientMsg({ t: 'join' }), null);
});

test('検証: 数値は有限で範囲内だけ（NaN・Infinity・巨大な値は捨てる）', () => {
  const ok = { t: 'control', itemId: 'a', playing: true, position: 10 };
  assert.deepEqual(parseClientMsg(ok), ok);
  for (const position of [NaN, Infinity, 86_401, '10']) assert.equal(parseClientMsg({ ...ok, position }), null);
  assert.equal(parseClientMsg({ ...ok, playing: 'true' }), null);
  assert.equal(parseClientMsg({ t: 'move', id: 'a', index: NaN }), null);
  assert.equal(parseClientMsg({ t: 'move', id: 'a', index: 10_001 }), null);
  assert.deepEqual(parseClientMsg({ t: 'move', id: 'a', index: 3 }), { t: 'move', id: 'a', index: 3 });
});

test('検証: next は itemId が null でもよい。auto は true のときだけ残る', () => {
  assert.deepEqual(parseClientMsg({ t: 'next', itemId: null }), { t: 'next', itemId: null });
  assert.deepEqual(parseClientMsg({ t: 'next', itemId: 'a', auto: true }), { t: 'next', itemId: 'a', auto: true });
  assert.deepEqual(parseClientMsg({ t: 'next', itemId: 'a', auto: 'yes' }), { t: 'next', itemId: 'a' });
  assert.equal(parseClientMsg({ t: 'next', itemId: 5 }), null);
  assert.equal(parseClientMsg({ t: 'next' }), null);
});

test('検証: mode は指定された正しい項目だけ。空でも通る（何も変えない）', () => {
  assert.deepEqual(parseClientMsg({ t: 'mode' }), { t: 'mode' });
  assert.deepEqual(parseClientMsg({ t: 'mode', repeat: 'all', shuffle: true }), { t: 'mode', repeat: 'all', shuffle: true });
  assert.deepEqual(parseClientMsg({ t: 'mode', repeat: 'bogus', shuffle: 1 }), { t: 'mode' });
});

test('検証: 文字列の長さの上限、知らない種類、オブジェクトでないものは null', () => {
  assert.equal(parseClientMsg({ t: 'enqueue', url: 'x'.repeat(501) }), null);
  assert.deepEqual(parseClientMsg({ t: 'enqueue', url: 'sm9' }), { t: 'enqueue', url: 'sm9' });
  assert.equal(parseClientMsg({ t: 'remove', id: 'a'.repeat(65) }), null);
  assert.equal(parseClientMsg({ t: 'nope' }), null);
  for (const raw of [null, undefined, 5, 'x', []]) assert.equal(parseClientMsg(raw), null);
});

test('検証: ClientMsg のすべての種類が、正しい形なら通る', () => {
  const samples = [
    { t: 'join', name: 'n' },
    { t: 'control', itemId: 'a', playing: false, position: 0 },
    { t: 'enqueue', url: 'sm9' },
    { t: 'remove', id: 'a' },
    { t: 'jump', id: 'a' },
    { t: 'move', id: 'a', index: 0 },
    { t: 'next', itemId: 'a' },
    { t: 'prev', itemId: 'a' },
    { t: 'loadFailed', itemId: 'a' },
    { t: 'loadOk', itemId: 'a' },
    { t: 'mode', repeat: 'one' },
    { t: 'ping', clientTime: 1 },
  ];
  for (const m of samples) assert.deepEqual(parseClientMsg(m), m, m.t);
});

// ---- 通行証
test('通行証: 発行したものは確かめられ、中身が戻る', async () => {
  const p = await pass.issuePass('secret', 'ws', { u: 'u1', n: '太郎', r: 'room1' });
  assert.deepEqual(await pass.verifyPass('secret', 'ws', p), { u: 'u1', n: '太郎', r: 'room1' });
});

test('通行証: 別の scope・別の鍵・改ざん・壊れた形・無いものは null', async () => {
  const p = await pass.issuePass('secret', 'nico', { u: 'u1' });
  assert.equal(await pass.verifyPass('secret', 'ws', p), null);
  assert.equal(await pass.verifyPass('other', 'nico', p), null);
  const [payload, sig] = p.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'admin', s: 'nico', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal(await pass.verifyPass('secret', 'nico', `${forged}.${sig}`), null);
  assert.equal(await pass.verifyPass('secret', 'nico', `${payload}.${sig}.x`), null);
  assert.equal(await pass.verifyPass('secret', 'nico', `${payload}.`), null);
  for (const bad of [null, undefined, '', 'abc', '.', 'a.b']) assert.equal(await pass.verifyPass('secret', 'nico', bad), null);
});

test('通行証: 期限が切れたら null', async () => {
  const realNow = Date.now;
  try {
    const p = await pass.issuePass('secret', 'nico', { u: 'u1' });
    assert.ok(await pass.verifyPass('secret', 'nico', p));
    Date.now = () => realNow() + 24 * 60 * 60 * 1000 + 1000;
    assert.equal(await pass.verifyPass('secret', 'nico', p), null);
  } finally {
    Date.now = realNow;
  }
});

test('通行証: 鍵が未登録なら例外（鍵なしで署名しない）', () => {
  assert.throws(() => pass.passSecret({}), /PASS_SECRET/);
  assert.throws(() => pass.passSecret({ PASS_SECRET: '' }), /PASS_SECRET/);
  assert.equal(pass.passSecret({ PASS_SECRET: 'k' }), 'k');
});

test('回数の制限: 窓の中で上限まで。窓が過ぎたら数え直す', () => {
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    for (let i = 0; i < 3; i++) assert.equal(pass.withinRateLimit('k1', 3, 1000), true);
    assert.equal(pass.withinRateLimit('k1', 3, 1000), false);
    assert.equal(pass.withinRateLimit('k2', 3, 1000), true);
    t += 1000;
    assert.equal(pass.withinRateLimit('k1', 3, 1000), true);
  } finally {
    Date.now = realNow;
  }
});

// ---- 読み込み失敗の記録
test('読み込み失敗: 報告を足す・取り消す。別の動画の記録は引き継がない', () => {
  const a = reportLoad(undefined, 'i1', 'm1', true);
  assert.deepEqual(a, { itemId: 'i1', ids: ['m1'] });
  const b = reportLoad(a, 'i1', 'm2', true);
  assert.deepEqual(b.ids.sort(), ['m1', 'm2']);
  assert.deepEqual(reportLoad(b, 'i1', 'm1', false).ids, ['m2']);
  assert.deepEqual(reportLoad(b, 'i2', 'm3', true), { itemId: 'i2', ids: ['m3'] });
});

test('読み込み失敗: 全員が報告したときだけ true。誰もいなければ false', () => {
  const f = { itemId: 'i1', ids: ['m1', 'm2'] };
  assert.equal(everyoneFailed(f, 'i1', ['m1', 'm2']), true);
  assert.equal(everyoneFailed(f, 'i1', ['m1', 'm2', 'm3']), false);
  assert.equal(everyoneFailed(f, 'i1', ['m1']), true);
  assert.equal(everyoneFailed(f, 'i1', []), false);
  assert.equal(everyoneFailed(f, 'other', ['m1']), false);
  assert.equal(everyoneFailed(undefined, 'i1', ['m1']), false);
  assert.equal(everyoneFailed(f, undefined, ['m1']), false);
});

// ---- 量の制限
test('メッセージの量の制限: 溜められる数まで受け付け、尽きたら断り、時間で回復する。人ごとに別', () => {
  const l = new MessageLimiter(2, 3);
  for (let i = 0; i < 3; i++) assert.equal(l.take('a', 0), true);
  assert.equal(l.take('a', 0), false);
  assert.equal(l.take('b', 0), true);
  assert.equal(l.take('a', 500), true);
  assert.equal(l.take('a', 500), false);
  for (let i = 0; i < 3; i++) assert.equal(l.take('a', 60_000), true);
  assert.equal(l.take('a', 60_000), false);
});

test('メッセージの量の制限: 使っていない記録は溜まり続けない', () => {
  const l = new MessageLimiter(10, 10);
  for (let i = 0; i < 600; i++) l.take('k' + i, 0);
  l.take('new', 60_000);
  assert.ok(l.buckets.size < 100, String(l.buckets.size));
});

// ---- 追加の順番待ち
test('追加の順番待ち: 受け取った順に 1 件ずつ処理する。失敗しても列は進む', async () => {
  const q = new EnqueueQueue();
  const order = [];
  const job = (name, ms, fail) => () =>
    new Promise((resolve, reject) => setTimeout(() => { order.push(name); fail ? reject(new Error('x')) : resolve(); }, ms));
  const jobs = [q.submit('m', job('slow', 20)), q.submit('m', job('fail', 1, true)), q.submit('m', job('fast', 1))];
  await Promise.all(jobs);
  assert.deepEqual(order, ['slow', 'fail', 'fast']);
});

test('追加の順番待ち: 1 人 8 件・全体 20 件を超えて溜まったら断る。終わると枠が戻る', async () => {
  const q = new EnqueueQueue();
  let release;
  const gate = new Promise((r) => (release = r));
  const jobs = [];
  for (let i = 0; i < 8; i++) jobs.push(q.submit('m1', () => gate));
  assert.equal(q.submit('m1', async () => {}), null);
  for (let i = 0; i < 8; i++) jobs.push(q.submit('m2', () => gate));
  for (let i = 0; i < 4; i++) jobs.push(q.submit('m3', () => gate));
  assert.equal(q.submit('m4', async () => {}), null);
  release();
  await Promise.all(jobs);
  assert.ok(q.submit('m1', async () => {}));
});

// ---- 保存先
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const puts = [];
  return {
    data,
    puts,
    async get(keys) { return new Map(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])); },
    async put(entries) { puts.push(Object.keys(entries)); for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v)); },
    async delete(keys) { for (const k of [].concat(keys)) data.delete(k); },
    async deleteAll() { data.clear(); },
  };
}
const stateOf = (over = {}) => ({ current: null, playing: false, position: 0, updatedAt: 0, version: 0, by: null, byName: null, ...over });

test('保存先: 何もなければ初期状態で始まる', async () => {
  const store = await RoomStore.load(fakeStorage());
  assert.equal(store.getState().current, null);
  assert.deepEqual(store.getQueue(), []);
  assert.equal(store.getLoadFailed(), undefined);
});

test('保存先: commit は版を進めるが、渡した state は書き換えない。保存したものが戻る', async () => {
  const storage = fakeStorage();
  const store = await RoomStore.load(storage);
  const input = stateOf({ version: 4 });
  const { state, written } = store.commit({ state: input });
  await written;
  assert.equal(input.version, 4);
  assert.equal(state.version, 5);
  assert.equal(store.getState().version, 5);
  assert.equal(storage.data.get('state').version, 5);
});

test('保存先: 状態・キュー・視聴済みは、1 回の書き込みで保存する', async () => {
  const storage = fakeStorage();
  const store = await RoomStore.load(storage);
  await store.commit({ state: stateOf(), queue: [item('a')], history: [item('h')] }).written;
  assert.equal(storage.puts.length, 1);
  assert.deepEqual(storage.puts[0].sort(), ['history', 'queue', 'state']);
});

test('保存先: 動画が切り替わったときだけ、読み込み失敗の記録を同じ書き込みで消す', async () => {
  const storage = fakeStorage();
  const store = await RoomStore.load(storage);
  await store.commit({ state: stateOf({ current: item('a') }) }).written;
  await store.setLoadFailed({ itemId: 'a', ids: ['m1'] });
  assert.deepEqual(storage.data.get('loadFailed'), { itemId: 'a', ids: ['m1'] });
  await store.commit({ state: stateOf({ current: item('a'), position: 5 }) }).written;
  assert.ok(store.getLoadFailed(), '同じ動画のままなら残る');
  await store.commit({ state: stateOf({ current: item('b') }) }).written;
  assert.equal(store.getLoadFailed(), undefined);
  assert.equal(storage.data.has('loadFailed'), false);
});

test('保存先: 同じ内容の読み込み失敗は書き込まない。起こし直しても復元される', async () => {
  const storage = fakeStorage();
  const store = await RoomStore.load(storage);
  await store.commit({ state: stateOf({ current: item('a') }), queue: [item('q')], history: [] }).written;
  await store.setLoadFailed({ itemId: 'a', ids: ['m1'] });
  const writes = storage.puts.length;
  await store.setLoadFailed({ itemId: 'a', ids: ['m1'] });
  assert.equal(storage.puts.length, writes);
  const again = await RoomStore.load(storage);
  assert.equal(again.getState().current.id, 'a');
  assert.equal(ids(again.getQueue()), 'q');
  assert.deepEqual(again.getLoadFailed(), { itemId: 'a', ids: ['m1'] });
});

test('保存先: 返したものを書き換えても、保存先の中身は変わらない。deleteAll で初期状態に戻る', async () => {
  const storage = fakeStorage();
  const store = await RoomStore.load(storage);
  await store.commit({ state: stateOf(), queue: [item('a')], history: [] }).written;
  store.getQueue().push(item('zzz'));
  assert.equal(ids(store.getQueue()), 'a');
  await store.deleteAll();
  assert.deepEqual(store.getQueue(), []);
  assert.equal(storage.data.size, 0);
});

// ---- 本文の読み取り上限
const streamBody = (chunks) =>
  new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
const post = (body) => new Request('http://x/', { method: 'POST', body, duplex: 'half' });

test('本文の上限: 上限以内なら全部読める（複数のチャンク・日本語も）', async () => {
  assert.equal(await readLimited(post(streamBody(['{"a":', '"あ"}'])), 100), '{"a":"あ"}');
  assert.equal(await readLimited(new Request('http://x/', { method: 'POST' }), 10), '');
});

test('本文の上限: content-length が無いチャンク転送でも、読んだ量で止める', async () => {
  const req = post(streamBody(['x'.repeat(60), 'x'.repeat(60)]));
  assert.equal(req.headers.get('content-length'), null);
  await assert.rejects(() => readLimited(req, 100), BodyTooLargeError);
});

test('本文の上限: content-length が上限を超えていれば、読まずに断る', async () => {
  const req = new Request('http://x/', { method: 'POST', body: 'x'.repeat(50) });
  await assert.rejects(() => readLimited(req, 10), BodyTooLargeError);
});

// ---- 中継の経路
test('中継の経路: メソッドとパスが合うものだけ。知らない経路は null', () => {
  assert.ok(matchRoute('GET', '/nico-embed/sm9'));
  assert.equal(matchRoute('POST', '/nico-embed/sm9'), null);
  assert.equal(matchRoute('GET', '/nico-embed/xx'), null);
  assert.ok(matchRoute('POST', '/v4-watch/sm9'));
  assert.ok(matchRoute('POST', '/v1-watch/sm9/x'));
  assert.equal(matchRoute('POST', '/v1-watch/sm9'), null);
  assert.ok(matchRoute('GET', '/nvapi-recommend'));
  assert.equal(matchRoute('GET', '/nope'), null);
  assert.equal(matchRoute('GET', ''), null);
});

test('中継の経路: 上流の URL はパスから組み立て、クエリは引き継ぐ。nvapi の POST は actionTrackId だけ', async () => {
  const rewrite = { replace: (b) => b, replaceJs: (b) => b };
  const get = matchRoute('GET', '/nico-embed/sm9');
  const up = await get.route.upstream(get.m, { req: new Request('http://x/'), query: '?playerId=1', rewrite });
  assert.equal(up.url, 'https://embed.nicovideo.jp/watch/sm9?playerId=1');
  const post4 = matchRoute('POST', '/v4-watch/sm9');
  const req = new Request('http://x/?actionTrackId=abc&evil=1', { method: 'POST', body: '{"a":1}' });
  const nv = await post4.route.upstream(post4.m, { req, query: '?actionTrackId=abc&evil=1', rewrite });
  assert.equal(nv.url, 'https://nvapi.nicovideo.jp/v4/watch/sm9?actionTrackId=abc');
  assert.equal(nv.init.body, '{"a":1}');
});

// ---- 共有の並べ替え・ジャンプ・動画 ID
test('並べ替え: 再生中より前に置いた動画は視聴済み、後ろに置いた動画はキューになる。再生中は動かない', () => {
  const r = reorder([item('a')], item('b'), [item('c'), item('d')], 'd', 0);
  assert.equal(ids(r.history), 'd,a');
  assert.equal(ids(r.queue), 'c');
  const r2 = reorder([item('a')], item('b'), [item('c')], 'a', 2);
  assert.equal(ids(r2.history), '');
  assert.equal(ids(r2.queue), 'c,a');
});

test('並べ替え: 変わらない・範囲外・知らない ID の扱い', () => {
  assert.equal(reorder([item('a')], item('b'), [], 'a', 0), null);
  assert.equal(reorder([item('a')], item('b'), [], 'zzz', 0), null);
  const end = reorder([item('a')], item('b'), [item('c')], 'a', 99);
  assert.equal(ids(end.queue), 'c,a');
  const start = reorder([item('a')], item('b'), [item('c')], 'c', -5);
  assert.equal(ids(start.history), 'c,a');
  assert.ok(reorder([item('a')], item('b'), [item('c')], 'c', NaN));
});

test('並べ替え: 再生中がないときは、元の視聴済みとキューの境目を基準に振り分ける', () => {
  const h = [item('h1'), item('h2')];
  const q = [item('q1'), item('q2')];
  const a = reorder(h, null, q, 'q2', 0);
  assert.equal(ids(a.history), 'q2,h1,h2');
  assert.equal(ids(a.queue), 'q1');
  const toQueue = reorder(h, null, q, 'h1', 3);
  assert.equal(ids(toQueue.history), 'h2');
  assert.equal(ids(toQueue.queue), 'q1,q2,h1');
  const stay = reorder(h, null, q, 'h1', 1);
  assert.equal(ids(stay.history), 'h2,h1');
  assert.equal(ids(stay.queue), 'q1,q2');
});

test('ジャンプ: 選んだ動画が再生中になり、前は視聴済み、後ろはキュー。見つからなければ null', () => {
  const r = jumpTo([item('a')], item('b'), [item('c'), item('d')], 'c');
  assert.equal(r.current.id, 'c');
  assert.equal(ids(r.history), 'a,b');
  assert.equal(ids(r.queue), 'd');
  assert.equal(jumpTo([], null, [item('x')], 'zzz'), null);
  assert.equal(jumpTo([], null, [item('x')], 'x').current.id, 'x');
});

test('動画 ID: URL・ID・余計な文字', () => {
  assert.equal(parseVideoId('sm9'), 'sm9');
  assert.equal(parseVideoId('https://www.nicovideo.jp/watch/sm9?ref=x'), 'sm9');
  assert.equal(parseVideoId('nm1234'), 'nm1234');
  assert.equal(parseVideoId('so12345678901'), null);
  assert.equal(parseVideoId('hello'), null);
  assert.equal(parseVideoId(''), null);
});

(async () => {
  // 通行証や時計を扱うテストが重ならないよう、1 件ずつ順に流す
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      console.error('失敗:', name);
      throw e;
    }
  }
  console.log(`OK: ${passed} 件`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
