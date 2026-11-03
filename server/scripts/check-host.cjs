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

test('停止: 書き出すものが無ければ、前のファイルを残さない', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-'));
  const file = path.join(dir, 'rooms.json');
  try {
    fs.writeFileSync(file, '{"r1":{"state":{}}}');
    saveRooms(file, {});
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('退出: 全員が抜けて待ち時間が過ぎたら、部屋は破棄される（アラーム）', async () => {
  const realNow = Date.now;
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
    Date.now = realNow;
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
