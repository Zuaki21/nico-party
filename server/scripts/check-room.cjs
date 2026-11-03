// Room クラスの単体テスト。保存先・WebSocket を代用品にして動かす。
//   接続数の上限と追い出し・入室しない接続の掃除・アラーム・入室・退出・配信の順序・メッセージ量の制限
//   cd server && npm run check:room
const assert = require('node:assert/strict');
const { loadTs } = require('./_load.cjs');

const load = loadTs(['server/src/node/routes.ts', 'server/src/room/room.ts', 'server/src/nico/nicoApi.ts']);

// ---- 代用品
const realDateNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
const advance = (ms) => (now += ms);

function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    closed: null,
    send(data) { this.sent.push(JSON.parse(data)); },
    close(code, reason) { this.readyState = 2; this.closed = { code, reason }; },
  };
}

/** put を遅らせられる保存先 */
function fakeStorage() {
  const data = new Map();
  const s = {
    data,
    putGate: null,
    alarm: null,
    async get(keys) { return new Map(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])); },
    put(entries) {
      for (const [k, v] of Object.entries(entries)) data.set(k, structuredClone(v));
      return s.putGate ?? Promise.resolve();
    },
    async delete(keys) { for (const k of [].concat(keys)) data.delete(k); },
    async deleteAll() { data.clear(); },
    async getAlarm() { return s.alarm; },
    async setAlarm(t) { s.alarm = t; },
  };
  return s;
}

async function makeRoom(preset = {}) {
  const storage = fakeStorage();
  for (const [k, v] of Object.entries(preset)) storage.data.set(k, v);
  const sockets = [];
  const ctx = {
    storage,
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
  };
  const { Room } = load('server/src/room/room.ts');
  const room = await Room.create(ctx);
  return { room, storage, sockets };
}

/** 接続を 1 本受ける（uid があればログイン済みの接続）。受け入れられたら接続、断られたら { status: 503 } */
async function connect(room, uid, avatar) {
  const ws = fakeWs();
  const ok = await room.connect(ws, uid ? { uid, name: '名前' + uid, avatar } : { uid: null, name: null });
  return ok ? ws : { status: 503 };
}
const send = (room, ws, msg) => room.webSocketMessage(ws, JSON.stringify(msg));
const join = async (room, ws, clientId = 'client-abcdefgh-1') => { await send(room, ws, { t: 'join', name: 'x', clientId }); };
const openCount = (list) => list.filter((w) => w.readyState === 1).length;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('接続: ログイン済みの接続は、1 人 5 本まで。超えたら古いものから、追い出しの閉じコードで切る', async () => {
  const { room, sockets } = await makeRoom();
  const made = [];
  for (let i = 0; i < 7; i++) { made.push(await connect(room, 'u1')); advance(10); }
  assert.equal(openCount(sockets), 5);
  assert.equal(made[0].closed.code, 4001);
  assert.equal(made[1].closed.code, 4001);
  assert.equal(made[6].readyState, 1);
  const other = await connect(room, 'u2');
  assert.equal(other.readyState, 1, '別のユーザーには影響しない');
});

test('接続: 追い出すときは、入室待ちの接続を、入室済みの接続より先に切る', async () => {
  const { room } = await makeRoom();
  const first = await connect(room, 'u1');
  await join(room, first);
  advance(10);
  const rest = [];
  for (let i = 0; i < 4; i++) { rest.push(await connect(room, 'u1')); advance(10); }
  const sixth = await connect(room, 'u1');
  assert.equal(first.readyState, 1, '入室済みの最古の接続は残る');
  assert.equal(rest[0].closed?.code, 4001, '入室していない最古の接続が切られる');
  assert.equal(sixth.readyState, 1);
});

test('接続: 部屋の接続数が上限(150)なら 503', async () => {
  const { room } = await makeRoom();
  for (let i = 0; i < 150; i++) await connect(room, 'u' + i);
  const res = await connect(room, 'extra');
  assert.equal(res.status, 503);
});

test('接続: 入室しない接続は、15 秒を過ぎたら次の接続のときに切られる', async () => {
  const { room } = await makeRoom();
  const idle = await connect(room, 'u1');
  advance(16_000);
  await connect(room, 'u2');
  assert.equal(idle.closed.code, 1008);
});

test('アラーム: 接続すると掃除のアラームが張られ、時間がたつと入室しない接続を切って、部屋を破棄する', async () => {
  const { room, storage } = await makeRoom();
  const idle = await connect(room, 'u1');
  assert.ok(storage.alarm > now, '入室待ちの接続があるので、アラームが張られる');
  storage.data.set('state', { current: null });
  advance(16_000);
  await room.alarm();
  assert.equal(idle.closed.code, 1008);
  assert.equal(storage.data.size, 0, '誰もいなくなったので部屋を破棄する');
});

test('アラーム: 入室待ちの接続が新しければ、切らずにもう一度掃除する。入室済みの人がいれば部屋は残る', async () => {
  const { room, storage } = await makeRoom();
  const member = await connect(room, 'u1');
  await join(room, member);
  const fresh = await connect(room, 'u2');
  storage.alarm = null;
  advance(1000);
  await room.alarm();
  assert.equal(fresh.readyState, 1);
  assert.ok(storage.alarm > now, '再び掃除する');
  advance(16_000);
  await room.alarm();
  assert.equal(fresh.closed.code, 1008);
  assert.equal(member.readyState, 1);
});

test('入室: welcome が届き、メンバーに入る。2 度目の join は無視する', async () => {
  const { room } = await makeRoom();
  const ws = await connect(room, 'u1');
  await join(room, ws);
  const welcome = ws.sent.find((m) => m.t === 'welcome');
  assert.ok(welcome);
  assert.equal(welcome.members.length, 1);
  assert.equal(welcome.members[0].name, '名前u1');
  await join(room, ws, 'client-zzzzzzzz-2');
  assert.equal(ws.sent.filter((m) => m.t === 'welcome').length, 1);
});

test('入室: 入室前の操作は受け付けない。入室前の接続には配信しない', async () => {
  const { room } = await makeRoom();
  const member = await connect(room, 'u1');
  await join(room, member);
  const idle = await connect(room, 'u2');
  await send(room, idle, { t: 'mode', shuffle: true });
  assert.equal(member.sent.filter((m) => m.t === 'state').length, 0, '入室前の操作は無視');
  await send(room, member, { t: 'mode', shuffle: true });
  assert.equal(member.sent.filter((m) => m.t === 'state').length, 1);
  assert.equal(idle.sent.length, 0, '入室待ちの接続には配信しない');
});

test('配信: 保存の完了を待たずに送る（送った内容は保存された状態で、版が進んでいる）', async () => {
  const { room, storage } = await makeRoom();
  const a = await connect(room, 'u1');
  const b = await connect(room, 'u2');
  await join(room, a, 'client-aaaaaaaa-1');
  await join(room, b, 'client-bbbbbbbb-1');
  let release;
  storage.putGate = new Promise((r) => (release = r));
  const pending = send(room, a, { t: 'mode', repeat: 'all' });
  await new Promise((r) => setTimeout(r, 10));
  const got = b.sent.filter((m) => m.t === 'state');
  assert.equal(got.length, 1, '書き込みが終わる前に配信している');
  assert.equal(got[0].state.repeat, 'all');
  assert.equal(got[0].state.version, 1);
  release();
  await pending;
  assert.equal(storage.data.get('state').version, 1);
});

test('配信: 同じモードの再送は、保存も配信もしない', async () => {
  const { room, storage } = await makeRoom();
  const a = await connect(room, 'u1');
  await join(room, a);
  await send(room, a, { t: 'mode', shuffle: true });
  const before = a.sent.filter((m) => m.t === 'state').length;
  await send(room, a, { t: 'mode', shuffle: true });
  await send(room, a, { t: 'mode' });
  assert.equal(a.sent.filter((m) => m.t === 'state').length, before);
  assert.equal(storage.data.get('state').version, 1);
});

test('退出: 最後の入室済みの人が退出したら、60 秒後の破棄を予約する。入室待ちの接続の退出では何もしない', async () => {
  const { room, storage } = await makeRoom();
  const a = await connect(room, 'u1');
  await join(room, a);
  const idle = await connect(room, 'u2');
  storage.alarm = null;
  const membersBefore = a.sent.filter((m) => m.t === 'members').length;
  idle.readyState = 3;
  await room.webSocketClose(idle);
  assert.equal(storage.alarm, null, '入室待ちの接続が切れても、部屋は何も変わらない');
  assert.equal(a.sent.filter((m) => m.t === 'members').length, membersBefore);
  a.readyState = 3;
  await room.webSocketClose(a);
  assert.equal(storage.alarm, now + 60_000);
});

test('退出: ほかの人が残っていれば、メンバー一覧を配信する', async () => {
  const { room } = await makeRoom();
  const a = await connect(room, 'u1');
  const b = await connect(room, 'u2');
  await join(room, a, 'client-aaaaaaaa-1');
  await join(room, b, 'client-bbbbbbbb-1');
  b.readyState = 3;
  await room.webSocketClose(b);
  const last = a.sent.filter((m) => m.t === 'members').pop();
  assert.equal(last.members.length, 1);
});

test('量の制限: 接続を何本つないでも、同じユーザーの量は増えない', async () => {
  const { room } = await makeRoom();
  const socks = [];
  for (let i = 0; i < 3; i++) socks.push(await connect(room, 'spam'));
  for (const s of socks) await join(room, s, 'client-' + 'abcdefgh' + socks.indexOf(s) + '-1');
  const watcher = await connect(room, 'watcher');
  await join(room, watcher, 'client-watcher1-1');
  for (let i = 0; i < 50; i++) for (const s of socks) await send(room, s, { t: 'mode', shuffle: i % 2 === 0, repeat: ['off', 'all', 'one'][i % 3] });
  const states = watcher.sent.filter((m) => m.t === 'state').length;
  assert.ok(states > 0 && states <= 45, `反映された数=${states}`);
});

test('量の制限: 部屋全体の制限に断られても、そのユーザーの枠は減らない', async () => {
  const { room } = await makeRoom();
  const a = await connect(room, 'u1');
  await join(room, a);
  // 部屋全体の枠を使い切る
  for (let i = 0; i < 500; i++) room.roomLimiter.take('room');
  const before = room.limiter.buckets.get('u1').tokens;
  await send(room, a, { t: 'mode', shuffle: true });
  assert.equal(a.sent.filter((m) => m.t === 'state').length, 0);
  assert.ok(room.limiter.buckets.get('u1').tokens >= before - 0.01, '断られた分は戻っている');
});

test('量の制限: 壊れたメッセージを大量に送ると、解析する前に数えられ、正しい操作も受け付けなくなる', async () => {
  const { room } = await makeRoom();
  const a = await connect(room, 'u1');
  await join(room, a);
  for (let i = 0; i < 200; i++) await room.webSocketMessage(a, '{broken');
  await send(room, a, { t: 'mode', shuffle: true });
  assert.equal(a.sent.filter((m) => m.t === 'state').length, 0);
  advance(5000);
  await send(room, a, { t: 'mode', shuffle: true });
  assert.equal(a.sent.filter((m) => m.t === 'state').length, 1, '時間がたてば、また受け付ける');
});

test('追加: 待っている間に全員が退出して部屋が破棄されたら、残るデータの破棄を予約し直す', async () => {
  const { room, storage } = await makeRoom();
  const a = await connect(room, 'u1');
  await join(room, a);
  let release;
  const gate = new Promise((r) => (release = r));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    await gate;
    if (String(url).includes('getthumbinfo')) {
      return new Response('<nicovideo_thumb_response status="ok"><thumb><title>t</title><length>1:00</length><embeddable>1</embeddable></thumb></nicovideo_thumb_response>');
    }
    return new Response('<html></html>');
  };
  try {
    const pending = send(room, a, { t: 'enqueue', url: 'sm9' });
    await new Promise((r) => setTimeout(r, 10));
    a.readyState = 3;
    await room.webSocketClose(a);
    storage.alarm = null; // 破棄のアラームが発火して、すでに消えている想定
    release();
    await pending;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(storage.data.has('queue') || storage.data.has('state'), '追加は書き込まれる');
  assert.equal(storage.alarm, now + 60_000);
});

// ---- HTTP の入口（node/routes.ts）
test('入口: 秘密が未登録なら、原因をログに残して 500。ログイン前の呼び出しも同じ', async () => {
  const { route } = load('server/src/node/routes.ts');
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a);
  try {
    for (const url of ['http://x/api/search?q=a', 'http://x/nico/p.q/nico-embed/sm9']) {
      const res = await route(new Request(url), {});
      assert.equal(res.status, 500, url);
    }
    assert.ok(logged.length >= 2);
  } finally {
    console.error = realError;
  }
});

test('入口: /api/token は POST だけが交換に届く。GET は 404', async () => {
  const { route } = load('server/src/node/routes.ts');
  const realError = console.error;
  console.error = () => {};
  try {
    const env = { PASS_SECRET: 's', DISCORD_CLIENT_SECRET: 'x', DISCORD_CLIENT_ID: 'a' };
    const post = await route(new Request('http://x/api/token', { method: 'POST', body: '{}' }), env);
    assert.equal(post.status, 400, '交換まで届いて、入力の検証で断られる（Discord へは出ない）');
    assert.equal((await route(new Request('http://x/api/token'), env)).status, 404);
    assert.equal((await route(new Request('http://x/api/token', { method: 'PUT', body: '{}' }), env)).status, 404);
  } finally {
    console.error = realError;
  }
});

test('入室: メンバーの ID は 16 桁。同じユーザーと接続元なら再接続しても同じ', async () => {
  const { room } = await makeRoom();
  const a = await connect(room, 'u1');
  await join(room, a, 'client-same0001-1');
  const first = a.sent.find((m) => m.t === 'welcome').id;
  assert.match(first, /^[0-9a-f]{16}$/);
  const b = await connect(room, 'u1');
  await join(room, b, 'client-same0001-1');
  assert.equal(b.sent.find((m) => m.t === 'welcome').id, first);
  const c = await connect(room, 'u1');
  await join(room, c, 'client-other001-1');
  assert.notEqual(c.sent.find((m) => m.t === 'welcome').id, first);
});

test('入口: 通行証がなければ 401、知らない経路は 404、/healthz は 200', async () => {
  const { route } = load('server/src/node/routes.ts');
  const env = { PASS_SECRET: 'secret' };
  assert.equal((await route(new Request('http://x/api/search?q=a'), env)).status, 401);
  assert.equal((await route(new Request('http://x/nope'), env)).status, 404);
  assert.equal((await route(new Request('http://x/'), env)).status, 404);
  assert.equal((await route(new Request('http://x/healthz'), env)).status, 200);
});

test('通知: シーク・動画の切り替え・削除は、操作した人のアイコンつきで全員に届く。再生・一時停止や自動送りは届かない', async () => {
  const item = (id) => ({ id, videoId: 'sm' + id, title: 'T' + id, addedBy: 'x', length: 600 });
  const state = { current: item('a'), playing: true, position: 10, updatedAt: now, version: 1, startedAt: now - 60_000, by: null, byName: null };
  const { room } = await makeRoom({ state, queue: [item('b')], history: [] });
  const A = await connect(room, 'u1', 'https://cdn.discordapp.com/avatars/1/h.png?size=64');
  const B = await connect(room, 'u2');
  await join(room, A, 'client-aaaaaaaa-1');
  await join(room, B, 'client-bbbbbbbb-1');
  const notices = (ws) => ws.sent.filter((m) => m.t === 'notice');
  advance(5000); // 10 秒の位置から 5 秒進んでいるはずなので、15 秒は通常の再生
  await send(room, A, { t: 'control', itemId: 'a', playing: true, position: 15 });
  await send(room, A, { t: 'control', itemId: 'a', playing: false, position: 15 });
  assert.equal(notices(B).length, 0, '再生・一時停止はシークではない');
  await send(room, A, { t: 'control', itemId: 'a', playing: false, position: 300 });
  assert.deepEqual(notices(B).map((m) => m.ev), [{ k: 'seek', position: 300 }]);
  assert.equal(notices(B)[0].by.name, '名前u1');
  assert.equal(notices(B)[0].by.avatar, 'https://cdn.discordapp.com/avatars/1/h.png?size=64');
  advance(5000);
  await send(room, A, { t: 'next', itemId: 'a', auto: true });
  assert.equal(notices(B).length, 1, '自動送りは知らせない');
  await send(room, B, { t: 'jump', id: 'a' });
  const sw = notices(A).at(-1);
  assert.equal(sw.ev.k, 'switch');
  assert.equal(sw.by.name, '名前u2');
  await send(room, B, { t: 'remove', id: 'b' });
  assert.deepEqual(notices(A).at(-1).ev, { k: 'remove', title: 'Tb' });
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      now = 1_000_000;
      await fn();
      passed++;
    } catch (e) {
      console.error('失敗:', name);
      throw e;
    }
  }
  Date.now = realDateNow;
  console.log(`OK: ${passed} 件`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
