// 部屋の負荷テスト: 多数の部屋に、多数の接続をつないで、入室・状態の配信・生存確認を行う。
//   node scripts/load/loadtest.cjs ws://127.0.0.1:8787 <部屋の数> <1 部屋の人数> <秒数>
// 通行証を使わないので、接続先のサーバーが ALLOW_ANON_WS=true で、接続元がローカルのときだけ動く（本番には使えない）。
// ニコニコへの問い合わせはしない（動画の追加や中継は含まない）。
const WebSocket = require('ws');

const [url = 'ws://127.0.0.1:8787', roomsArg = '5', usersArg = '50', secsArg = '30'] = process.argv.slice(2);
const ROOMS = Number(roomsArg);
const USERS = Number(usersArg);
const SECS = Number(secsArg);
const TOGGLE_MS = 2000;

const stats = {
  connected: 0,
  connectFailed: 0,
  welcomed: 0,
  closedEarly: 0,
  joinMs: [],
  stateMs: [],
  stateReceived: 0,
  errors: 0,
};
const percentile = (xs, p) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] : NaN);
const fmt = (xs) => `n=${xs.length} p50=${percentile(xs, 50).toFixed(0)}ms p95=${percentile(xs, 95).toFixed(0)}ms max=${xs.length ? Math.max(...xs).toFixed(0) : 'NaN'}ms`;

/** 部屋ごとに、最後に状態を変えた時刻（ms）を覚えて、配信までの時間を測る */
const lastToggleAt = new Map();
const timers = [];

function user(room, index) {
  return new Promise((resolve) => {
    const started = performance.now();
    const ws = new WebSocket(`${url}/ws/${room}`);
    let welcomed = false;
    ws.on('open', () => {
      stats.connected++;
      for (let i = 0; i < 4; i++) setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ping', clientTime: Date.now() })), i * 300);
      ws.send(JSON.stringify({ t: 'join', name: 'ゲスト', clientId: `load-${room}-${index}-xxxxxxxx` }));
      timers.push(setInterval(() => ws.readyState === 1 && ws.send('hb'), 30_000));
    });
    ws.on('message', (data) => {
      const text = String(data);
      if (text === 'hb') return;
      const msg = JSON.parse(text);
      if (msg.t === 'welcome' && !welcomed) {
        welcomed = true;
        stats.welcomed++;
        stats.joinMs.push(performance.now() - started);
        resolve({ ws, index, room });
      } else if (msg.t === 'state') {
        stats.stateReceived++;
        const at = lastToggleAt.get(room);
        if (at !== undefined) stats.stateMs.push(performance.now() - at);
      } else if (msg.t === 'error') stats.errors++;
    });
    ws.on('error', () => { stats.connectFailed++; resolve(null); });
    ws.on('close', () => { if (!welcomed) { stats.closedEarly++; resolve(null); } });
  });
}

(async () => {
  const t0 = performance.now();
  console.log(`接続: ${ROOMS} 部屋 × ${USERS} 人 = ${ROOMS * USERS} 接続を、一斉につなぐ`);
  const all = await Promise.all(Array.from({ length: ROOMS * USERS }, (_, i) => user(`load-room-${Math.floor(i / USERS)}`, i % USERS)));
  const users = all.filter(Boolean);
  console.log(`入室まで ${(performance.now() - t0).toFixed(0)}ms。入室できた: ${stats.welcomed}/${ROOMS * USERS}、失敗 ${stats.connectFailed}、入室前に切られた ${stats.closedEarly}`);
  console.log(`入室にかかった時間: ${fmt(stats.joinMs)}`);
  stats.stateMs.length = 0;
  stats.stateReceived = 0;

  // 各部屋の 1 人が、2 秒ごとに状態を変える（全員に配信される）
  const owners = users.filter((u) => u.index === 0);
  for (const o of owners) {
    let shuffle = false;
    timers.push(setInterval(() => {
      shuffle = !shuffle;
      lastToggleAt.set(o.room, performance.now());
      if (o.ws.readyState === 1) o.ws.send(JSON.stringify({ t: 'mode', shuffle }));
    }, TOGGLE_MS));
  }
  await new Promise((r) => setTimeout(r, SECS * 1000));
  timers.forEach(clearInterval);
  const stillOpen = users.filter((u) => u.ws.readyState === 1).length;
  console.log(`${SECS} 秒の状態の配信: 受信 ${stats.stateReceived} 件、配信までの時間 ${fmt(stats.stateMs)}`);
  console.log(`終了時に開いている接続: ${stillOpen}/${users.length}、エラー通知: ${stats.errors}`);
  users.forEach((u) => u.ws.close());
  setTimeout(() => process.exit(0), 500);
})();
