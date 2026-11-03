// 部屋の置き場（node/roomHost.ts）と、停止時の保存（node/persist.ts）のテスト。
//   接続して入室・生存確認・退出後の破棄・全部屋の書き出しと、別のプロセスでの読み込み
//   cd server && npm run check:host
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./_load.cjs');

const load = loadTs(['server/src/node/roomHost.ts', 'server/src/node/persist.ts']);
const { RoomHost } = load('server/src/node/roomHost.ts');
const { saveRooms, savedRooms } = load('server/src/node/persist.ts');

/** ws の WebSocket の代用品 */
function fakeRaw() {
  const raw = new EventEmitter();
  raw.readyState = 1;
  raw.sent = [];
  raw.closed = null;
  raw.send = (d) => raw.sent.push(d);
  raw.close = (code, reason) => {
    // 本物と同じく、閉じるのは最初の 1 回だけ
    if (raw.closed) return;
    raw.readyState = 3;
    raw.closed = { code, reason };
    raw.emit('close');
  };
  return raw;
}
const msgs = (raw) => raw.sent.filter((d) => d !== 'hb').map((d) => JSON.parse(d));
const message = (raw, m) => raw.emit('message', Buffer.from(typeof m === 'string' ? m : JSON.stringify(m)), false);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const who = (uid) => ({ uid, name: '名前' + uid });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('接続: 入室すると welcome が届く。生存確認 hb には、部屋を通さずに hb で返す', async () => {
  const host = new RoomHost();
  const raw = fakeRaw();
  assert.equal(await host.join('r1', raw, who('u1')), true);
  message(raw, { t: 'join', name: 'x', clientId: 'client-abcdefgh-1' });
  await tick();
  assert.ok(msgs(raw).some((m) => m.t === 'welcome'));
  message(raw, 'hb');
  assert.deepEqual(raw.sent.at(-1), 'hb');
  assert.deepEqual(await host.stats(), { rooms: 1, connections: 1 });
});

test('接続: 部屋の準備を待っている間に届いた join も取りこぼさない。待っている間に切れた接続は、部屋に残らない', async () => {
  const host = new RoomHost();
  const raw = fakeRaw();
  const joining = host.join('r1', raw, who('u1'));
  message(raw, { t: 'join', name: 'x', clientId: 'client-abcdefgh-1' });
  assert.equal(await joining, true);
  await tick();
  assert.ok(msgs(raw).some((m) => m.t === 'welcome'));

  const gone = fakeRaw();
  const p = host.join('r1', gone, who('u2'));
  gone.close(1000, 'bye');
  await p;
  await tick();
  assert.deepEqual(await host.stats(), { rooms: 1, connections: 1 });

  // 新しい部屋への最初の接続が、部屋の準備中に切れたら、その部屋は残さない
  const first = fakeRaw();
  const q = host.join('r-new', first, who('u3'));
  first.close(1000, 'bye');
  assert.equal(await q, true);
  await tick();
  assert.deepEqual(await host.stats(), { rooms: 1, connections: 1 });
});

test('部屋: 保存済みの中身から作り直した部屋に誰も入らなければ、少しあとで消える', async () => {
  const realSetTimeout = global.setTimeout;
  // 作り直したときに張るアラーム（60 秒後）を、すぐ鳴らす
  global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 30_000 ? 0 : ms, ...rest);
  try {
    const host = new RoomHost((id) => (id === 'saved' ? { state: { current: null, playing: false, position: 0, updatedAt: 0, version: 3, by: null } } : undefined));
    const raw = fakeRaw();
    const p = host.join('saved', raw, who('u1'));
    raw.close(1000, 'bye');
    await p;
    await tick(100);
    assert.deepEqual(await host.stats(), { rooms: 0, connections: 0 });
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('部屋: 作れなかった部屋は残さず、次の接続で作り直す。停止のときの保存も止めない', async () => {
  let fail = true;
  const host = new RoomHost(() => {
    if (fail) throw new Error('disk');
    return undefined;
  });
  await assert.rejects(() => host.join('r1', fakeRaw(), who('u1')), /disk/);
  assert.deepEqual(await host.exportAll(), {});
  fail = false;
  assert.equal(await host.join('r1', fakeRaw(), who('u1')), true);
  assert.deepEqual(await host.stats(), { rooms: 1, connections: 1 });
});

test('部屋: 部屋の状態は、ほかの接続にも配信される（同じ ID の部屋は共有、違う部屋は別）', async () => {
  const host = new RoomHost();
  const a = fakeRaw();
  const b = fakeRaw();
  const other = fakeRaw();
  await host.join('r1', a, who('u1'));
  await host.join('r1', b, who('u2'));
  await host.join('r2', other, who('u3'));
  for (const [raw, id] of [[a, 'client-aaaaaaaa-1'], [b, 'client-bbbbbbbb-1'], [other, 'client-cccccccc-1']]) message(raw, { t: 'join', name: 'x', clientId: id });
  await tick();
  message(a, { t: 'mode', repeat: 'one' });
  await tick();
  assert.equal(msgs(b).findLast((m) => m.t === 'state').state.repeat, 'one');
  assert.equal(msgs(other).some((m) => m.t === 'state'), false);
});

test('停止: 全部屋を書き出して、別のプロセス（新しい RoomHost）が部屋に最初に接続されたときに読み込む', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-'));
  const file = path.join(dir, 'rooms.json');
  try {
    const old = new RoomHost();
    const a = fakeRaw();
    await old.join('r1', a, who('u1'));
    message(a, { t: 'join', name: 'x', clientId: 'client-aaaaaaaa-1' });
    await tick();
    message(a, { t: 'mode', repeat: 'all', shuffle: true });
    await tick();
    saveRooms(file, await old.exportAll());
    await old.closeAll(1012, 'server restarting');
    assert.equal(a.closed.code, 1012);

    const fresh = new RoomHost(savedRooms(file));
    const b = fakeRaw();
    await fresh.join('r1', b, who('u1'));
    message(b, { t: 'join', name: 'x', clientId: 'client-aaaaaaaa-1' });
    await tick();
    const welcome = msgs(b).find((m) => m.t === 'welcome');
    assert.equal(welcome.state.repeat, 'all');
    assert.equal(welcome.state.shuffle, true);
    // 取り出した部屋は、ファイルから消える
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('停止: 保存済みに無い部屋は空で始まる。壊れたファイルでも起動できる', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-'));
  const file = path.join(dir, 'rooms.json');
  const realError = console.error;
  console.error = () => {};
  try {
    fs.writeFileSync(file, '{broken');
    const host = new RoomHost(savedRooms(file));
    const raw = fakeRaw();
    await host.join('r9', raw, who('u1'));
    message(raw, { t: 'join', name: 'x', clientId: 'client-aaaaaaaa-1' });
    await tick();
    assert.equal(msgs(raw).find((m) => m.t === 'welcome').state.current, null);
  } finally {
    console.error = realError;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('停止: まだ取り出されていない前の部屋は残し、1 日たったものは捨てる。書くものが無くなればファイルを消す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-'));
  const file = path.join(dir, 'rooms.json');
  const realNow = Date.now;
  try {
    let now = 1_000_000_000;
    Date.now = () => now;
    // 時刻の無い古い形式の部屋も、今書いたものとして残す
    fs.writeFileSync(file, '{"old":{"state":{"version":1}}}');
    saveRooms(file, { mine: { state: { version: 2 } } });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['mine', 'old']);
    // 取り出すときは、書き出した時刻を外す
    assert.deepEqual(savedRooms(file)('mine'), { state: { version: 2 } });
    now += 24 * 60 * 60 * 1000;
    saveRooms(file, {});
    assert.equal(fs.existsSync(file), false);
  } finally {
    Date.now = realNow;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('退出: 全員が抜けて待ち時間が過ぎたら、部屋は破棄される（アラーム）', async () => {
  const host = new RoomHost();
  const raw = fakeRaw();
  await host.join('r1', raw, who('u1'));
  message(raw, { t: 'join', name: 'x', clientId: 'client-aaaaaaaa-1' });
  await tick();
  const realSetTimeout = global.setTimeout;
  // 退出の時点で予約されるアラーム（60 秒後）を、すぐ鳴らす
  global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 30_000 ? 0 : ms, ...rest);
  try {
    raw.emit('close');
    await tick(100);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepEqual(await host.stats(), { rooms: 0, connections: 0 });
});

(async () => {
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
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
