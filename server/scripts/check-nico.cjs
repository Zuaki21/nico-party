// ニコニコの中継の書き換えルール (src/nico/nico.ts の rewriter) の単体テスト。
// 書き換えで作る中継の URL に、必ず通行証が入っていること（無いと 401 になって再生できなくなる）と、
// 元の URL の形ごとの書き換え結果を確かめる。   cd server && npm run check:nico
const assert = require('node:assert/strict');
const { loadTs } = require('./_load.cjs');

const load = loadTs([
  'server/src/nico/nico.ts',
  'server/src/nico/nicoRewrite.ts',
  'server/src/nico/nicoRoutes.ts',
  'server/src/nico/nicoApi.ts',
  'server/src/body.ts',
  'server/src/env.ts',
  'server/src/pass.ts',
  'shared/search.ts',
]);
const { rewriter } = load('server/src/nico/nicoRewrite.ts');
const { handleNico } = load('server/src/nico/nico.ts');
const { issuePass } = load('server/src/pass.ts');

const HOST = 'https://app123.discordsays.com';
const PASS = 'PAYLOAD.SIGNATURE';
const { replace, replaceJs } = rewriter(HOST, PASS);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('失敗:', name); throw e; }
}

test('HLS のプレイリストの URL は、通行証つきの中継を通す', () => {
  assert.equal(
    replace('https://delivery.domand.nicovideo.jp/hlsext/abc/master.m3u8'),
    `${HOST}/.proxy/nico/${PASS}/delivery-domand-nicovideo-jp/hlsext/abc/master.m3u8`,
  );
});

test('プレイヤーの JS の URL は、通行証つきの中継を通す', () => {
  assert.equal(
    replace('https://assets.embed.res.nimg.jp/js/watch_ja_abc123.js'),
    `/nico/${PASS}/watch/watch_ja_abc123`,
  );
});

test('stella・users・v1/v4 の watch は、通行証つきの中継を通す', () => {
  // stella の /v1/watch/ は、stella の規則のあとに /v1/watch/ の規則も当たって、パスが崩れる（今までの挙動。
  // stella は視聴の記録を送るだけの呼び出しで、届かなくても再生には影響しない。変えるときは、この期待値も直す）
  assert.equal(replace('https://stella.nicovideo.jp/v1/watch/sm9'), `/.proxy/nico/${PASS}/stella/../../nico/${PASS}/v1-watch/sm9`);
  assert.equal(replace('https://stella.nicovideo.jp/v1/other'), `/.proxy/nico/${PASS}/stella/v1/other`);
  assert.equal(replace('/users/123'), `/../../nico/${PASS}/users/123`);
  assert.equal(replace('/v1/watch/sm9/access-rights/hls'), `/../../nico/${PASS}/v1-watch/sm9/access-rights/hls`);
  assert.equal(replace('/v4/watch/sm9'), `/../../nico/${PASS}/v4-watch/sm9`);
});

test('nonce のつく /v1/watch/non… は書き換えない', () => {
  assert.equal(replace('/v1/watch/nonce'), '/v1/watch/nonce');
});

test('ニコニコの画像・API などのドメインは、Discord の URL Mapping（/external/）を通す', () => {
  assert.equal(replace('https://img.cdn.nimg.jp/a.jpg'), `${HOST}/.proxy/external/img--cdn--nimg--jp/a.jpg`);
  assert.equal(replace('https://nvapi.nicovideo.jp/v1/x'), `${HOST}/.proxy/external/nvapi--nicovideo--jp/v1/x`);
  assert.equal(replace('"https:\/\/www.nicovideo.jp\/watch"'), `"${HOST}/.proxy/external/www--nicovideo--jp\/watch"`);
});

test('ニコニコ以外のドメインは書き換えない', () => {
  assert.equal(replace('https://example.com/x'), 'https://example.com/x');
});

test('プレイヤーの JS だけにある書き換え: api-watch と recommend も通行証つき', () => {
  assert.equal(replaceJs('fetch("/api/watch/sm9")'), `fetch("/.proxy/nico/${PASS}/api-watch/sm9")`);
  assert.equal(replaceJs('"/v1/recommend?x=1"'), `"/../../nico/${PASS}/nvapi-recommend?x=1"`);
});

test('書き換えた結果に、通行証のない中継の URL が残らない', () => {
  const sample = [
    'https://delivery.domand.nicovideo.jp/hlsext/a.m3u8', 'https://assets.embed.res.nimg.jp/js/w.js',
    'https://stella.nicovideo.jp/v1/watch/sm9', '/users/1', '/v1/watch/sm9/x', '/v4/watch/sm9', '/api/watch/sm9',
  ].join('\n');
  const out = replaceJs(sample);
  for (const line of out.split('\n')) {
    if (/nico\//.test(line)) assert.ok(line.includes(`nico/${PASS}/`), `通行証が無い: ${line}`);
  }
});

// ---- 中継の入口（handleNico）。ニコニコへの問い合わせ (fetch) は代用品にする
const ENV = { DISCORD_CLIENT_ID: 'app1', PASS_SECRET: 'secret' };
async function relayWith(fetchImpl, { method = 'GET', path = '/nico-embed/sm9', body, pass } = {}) {
  const p = pass === undefined ? await issuePass('secret', 'nico', { u: 'relay-user-' + Math.random() }) : pass;
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return fetchImpl(String(url), init, calls.length); };
  try {
    const req = new Request('http://x/nico' + (p ? '/' + p : '') + path, { method, body, ...(body && typeof body !== 'string' ? { duplex: 'half' } : {}) });
    const res = await handleNico(req, ENV, '/' + (p ? p : 'none') + path);
    return { res, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const ok = (text, init = {}) => new Response(text, { status: 200, ...init });

(async () => {
  const run = async (name, fn) => {
    try { await fn(); passed++; } catch (e) { console.error('失敗:', name); throw e; }
  };

  await run('中継: 通行証がなければ 401。問い合わせは出さない', async () => {
    const { res, calls } = await relayWith(() => ok('x'), { pass: 'bad.pass' });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  await run('中継: 知らない経路・パスをたどる入力は 404', async () => {
    assert.equal((await relayWith(() => ok('x'), { path: '/nope' })).res.status, 404);
    assert.equal((await relayWith(() => ok('x'), { path: '/nico-embed/../x' })).res.status, 404);
  });

  await run('中継: 上流のステータスはそのまま伝える。本文は書き換える', async () => {
    const { res } = await relayWith(() => new Response('https://stella.nicovideo.jp/x', { status: 404 }));
    assert.equal(res.status, 404);
    assert.match(await res.text(), /\/\.proxy\/nico\//);
  });

  await run('中継: リダイレクトの先がニコニコ以外なら、問い合わせずに 502', async () => {
    const { res, calls } = await relayWith(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
    assert.equal(res.status, 502);
    assert.equal(calls.length, 1, '外部のホストには問い合わせない');
  });

  await run('中継: リダイレクトの先が http や、似たホスト名でも 502', async () => {
    for (const location of ['http://embed.nicovideo.jp/x', 'https://evilnicovideo.jp/x', 'https://nicovideo.jp.evil.example/x']) {
      const { res, calls } = await relayWith(() => new Response(null, { status: 301, headers: { location } }));
      assert.equal(res.status, 502, location);
      assert.equal(calls.length, 1);
    }
  });

  await run('中継: ニコニコ内のリダイレクトは辿る。辿りすぎは 502', async () => {
    const { res, calls } = await relayWith((url, init, n) =>
      n === 1 ? new Response(null, { status: 302, headers: { location: 'https://www.nicovideo.jp/moved' } }) : ok('done'));
    assert.equal(res.status, 200);
    assert.equal(calls[1].url, 'https://www.nicovideo.jp/moved');
    const loop = await relayWith(() => new Response(null, { status: 302, headers: { location: 'https://www.nicovideo.jp/again' } }));
    assert.equal(loop.res.status, 502);
    assert.equal(loop.calls.length, 4);
  });

  await run('中継: 大きすぎる応答は 502', async () => {
    const { res } = await relayWith(() => ok('x', { headers: { 'content-length': String(20 * 1024 * 1024) } }));
    assert.equal(res.status, 502);
  });

  await run('中継: POST の本文がチャンク転送で大きいときは 413。上流に送らない', async () => {
    const big = new ReadableStream({ start(c) { const chunk = new TextEncoder().encode('x'.repeat(1000)); for (let i = 0; i < 100; i++) c.enqueue(chunk); c.close(); } });
    const { res, calls } = await relayWith(() => ok('x'), { method: 'POST', path: '/v4-watch/sm9', body: big });
    assert.equal(res.status, 413);
    assert.equal(calls.length, 0);
  });

  await run('中継: 上流に繋がらなければ 502、時間切れなら 504', async () => {
    const realError = console.error;
    console.error = () => {};
    try {
      assert.equal((await relayWith(() => { throw new Error('down'); })).res.status, 502);
      const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
      assert.equal((await relayWith(() => { throw timeout; })).res.status, 504);
    } finally {
      console.error = realError;
    }
  });

  console.log(`OK: ${passed} 件`);
})().catch((e) => { console.error(e); process.exit(1); });
