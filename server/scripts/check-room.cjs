// Room クラス（Durable Object）の単体テスト。Workers の外でも動くよう、'cloudflare:workers'・保存先・WebSocket を代用品にして動かす。
//   接続数の上限と追い出し・入室しない接続の掃除・アラーム・入室・退出・配信の順序・メッセージ量の制限
//   cd server && npm run check:room
const assert = require('node:assert/strict');
const { loadTs, stubCloudflareWorkers } = require('./_load.cjs');

stubCloudflareWorkers();
const load = loadTs([
  'server/src/room/room.ts',
  'server/src/room/limiter.ts',
  'server/src/room/loadReport.ts',
  'server/src/room/sockets.ts',
  'server/src/room/enqueue.ts',
  'server/src/room/validate.ts',
  'server/src/room/playback.ts',
  'server/src/room/roomStore.ts',
  'server/src/room/state.ts',
  'server/src/env.ts',
  'server/src/pass.ts',
  'server/src/nico/nicoApi.ts',
  'shared/playlist.ts',
  'shared/protocol.ts',
  'shared/search.ts',
  'shared/video.ts',
]);

// ---- 代用品
const realDateNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
const advance = (ms) => (now += ms);

globalThis.WebSocketRequestResponsePair = class {};
function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    closed: null,
    att: null,
    send(data) { this.sent.push(JSON.parse(data)); },
    close(code, reason) { this.readyState = 2; this.closed = { code, reason }; },
    serializeAttachment(a) { this.att = structuredClone(a); },
    deserializeAttachment() { return structuredClone(this.att); },
  };
}
globalThis.WebSocketPair = class {
  constructor() { this[0] = fakeWs(); this[1] = fakeWs(); }
};
// Node の Response は status 101 を作れないので、Room.fetch が返すものだけ差し替える
const RealResponse = globalThis.Response;
class FakeResponse {
  constructor(body, init = {}) { this.body = body; this.status = init.status; this.webSocket = init.webSocket; }
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

async function makeRoom() {
  const storage = fakeStorage();
  const sockets = [];
  let ready;
  const ctx = {
    storage,
    getWebSockets: () => sockets,
    // 本物は、accept の時点で接続の情報（attachment）が設定済みでなければ、部屋が壊れる
    acceptWebSocket: (ws) => {
      if (ws.att === null) throw new Error('accepted a socket without its attachment');
      sockets.push(ws);
    },
    blockConcurrencyWhile: (fn) => { ready = fn(); },
    setWebSocketAutoResponse: () => {},
  };
  const { Room } = load('server/src/room/room.ts');
  const room = new Room(ctx, {});
  await ready;
  return { room, storage, sockets };
}

/** 接続を 1 本受ける（uid があればログイン済みの接続） */
async function connect(room, uid) {
  const headers = { upgrade: 'websocket', ...(uid ? { 'x-nico-party-verified-name': encodeURIComponent('名前' + uid), 'x-nico-party-verified-uid': uid } : {}) };
  globalThis.Response = FakeResponse;
  try {
    const res = await room.fetch(new Request('http://x/ws/r', { headers }));
    // 部屋が持っている側（サーバー側）の接続を返す
    return res.status === 101 ? room.ctx.getWebSockets().at(-1) : res;
  } finally {
    globalThis.Response = RealResponse;
  }
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

test('接続: 部屋の接続数が上限(60)なら 503', async () => {
  const { room } = await makeRoom();
  for (let i = 0; i < 60; i++) await connect(room, 'u' + i);
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
  for (let i = 0; i < 300; i++) room.roomLimiter.take('room');
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
