// ニコニコの中継の書き換えルール (src/nico/nicoRewrite.ts の rewriter) の単体テスト。
// 書き換えで作る中継の URL に、必ず通行証が入っていること（無いと 401 になって再生できなくなる）と、
// 元の URL の形ごとの書き換え結果を確かめる。   cd server && npm run check:nico
const assert = require('node:assert/strict');
const { loadTs } = require('./_load.cjs');

const load = loadTs(['server/src/nico/nico.ts']);
const { rewriter } = load('server/src/nico/nicoRewrite.ts');
const { handleNico } = load('server/src/nico/nico.ts');
const { issuePass, ConfigError } = load('server/src/pass.ts');

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
    `${HOST}/.proxy/srv/nico/${PASS}/delivery-domand-nicovideo-jp/hlsext/abc/master.m3u8`,
  );
});

test('プレイヤーの JS の URL は、通行証つきの中継を通す', () => {
  assert.equal(
    replace('https://assets.embed.res.nimg.jp/js/watch_ja_abc123.js'),
    `/.proxy/srv/nico/${PASS}/watch/watch_ja_abc123`,
  );
  // `.js` の . は文字どおりの . だけ（任意の 1 文字ではない）
  assert.ok(!replace('https://assets.embed.res.nimg.jp/js/xjs').includes('/watch/'));
});

test('stella・users・v1/v4 の watch は、通行証つきの中継を通す', () => {
  // stella の /v1/watch/ は、stella の規則のあとに /v1/watch/ の規則も当たって、パスが崩れる（今までの挙動。
  // stella は視聴の記録を送るだけの呼び出しで、届かなくても再生には影響しない。変えるときは、この期待値も直す）
  assert.equal(replace('https://stella.nicovideo.jp/v1/watch/sm9'), `/.proxy/srv/nico/${PASS}/stella/../../srv/nico/${PASS}/v1-watch/sm9`);
  assert.equal(replace('https://stella.nicovideo.jp/v1/other'), `/.proxy/srv/nico/${PASS}/stella/v1/other`);
  assert.equal(replace('/users/123'), `/../../srv/nico/${PASS}/users/123`);
  assert.equal(replace('/v1/watch/sm9/access-rights/hls'), `/../../srv/nico/${PASS}/v1-watch/sm9/access-rights/hls`);
  assert.equal(replace('/v4/watch/sm9'), `/../../srv/nico/${PASS}/v4-watch/sm9`);
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
  assert.equal(replaceJs('fetch("/api/watch/sm9")'), `fetch("/.proxy/srv/nico/${PASS}/api-watch/sm9")`);
  assert.equal(replaceJs('"/v1/recommend?x=1"'), `"/../../srv/nico/${PASS}/nvapi-recommend?x=1"`);
});

test('書き換えた結果に、通行証のない中継の URL が残らない', () => {
  const sample = [
    'https://delivery.domand.nicovideo.jp/hlsext/a.m3u8', 'https://assets.embed.res.nimg.jp/js/w.js',
    'https://stella.nicovideo.jp/v1/watch/sm9', '/users/1', '/v1/watch/sm9/x', '/v4/watch/sm9', '/api/watch/sm9',
  ].join('\n');
  const out = replaceJs(sample);
  for (const line of out.split('\n')) {
    if (/nico\//.test(line)) assert.ok(line.includes(`srv/nico/${PASS}/`), `通行証が無い: ${line}`);
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

  await run('キャッシュ: プレイヤーの JS は、人が違っても取得は 1 回。通行証は、その人のものが入る', async () => {
    const js = () => ok('fetch("https://stella.nicovideo.jp/v1")');
    const a = await relayWith(js, { path: '/watch/watch_ja_cache1', pass: await issuePass('secret', 'nico', { u: 'cache-a' }) });
    const passA = a.calls.length;
    assert.equal(passA, 1);
    const userB = await issuePass('secret', 'nico', { u: 'cache-b' });
    const b = await relayWith(js, { path: '/watch/watch_ja_cache1', pass: userB });
    assert.equal(b.calls.length, 0, '2 人目は、ニコニコに問い合わせない');
    const text = await b.res.text();
    assert.ok(text.includes(`/.proxy/srv/nico/${userB}/stella/v1`), '2 人目の通行証が入る');
    assert.ok(!text.includes('cachedpass'), '目印が残らない');
    assert.ok(!(await (await relayWith(js, { path: '/watch/watch_ja_cache1' })).res.text()).includes(userB), '他の人の通行証は入らない');
  });

  await run('キャッシュ: 同時に取りに来ても、取得は 1 回', async () => {
    let n = 0;
    const slow = async () => { n++; await new Promise((r) => setTimeout(r, 30)); return ok('x'); };
    const results = await Promise.all(Array.from({ length: 5 }, () => relayWith(slow, { path: '/watch/watch_ja_cache2' })));
    assert.equal(n, 1);
    for (const r of results) assert.equal(r.res.status, 200);
  });

  await run('キャッシュ: 404 や失敗は覚えない。次の人は、もう一度取りに行く', async () => {
    const notFound = () => new Response('missing', { status: 404 });
    const a = await relayWith(notFound, { path: '/watch/watch_ja_cache3' });
    assert.equal(a.res.status, 404);
    const b = await relayWith(() => ok('fixed'), { path: '/watch/watch_ja_cache3' });
    assert.equal(b.calls.length, 1);
    assert.equal(b.res.status, 200);
    const down = await relayWith(() => { throw new Error('network'); }, { path: '/watch/watch_ja_cache4' });
    assert.equal(down.res.status, 502);
    const retry = await relayWith(() => ok('up'), { path: '/watch/watch_ja_cache4' });
    assert.equal(retry.res.status, 200);
  });

  await run('キャッシュ: 埋め込みの HTML など、覚えない経路は毎回取りに行く', async () => {
    const a = await relayWith(() => ok('<html></html>'), { path: '/nico-embed/sm9' });
    const b = await relayWith(() => ok('<html></html>'), { path: '/nico-embed/sm9' });
    assert.equal(a.calls.length + b.calls.length, 2);
  });

  await run('中継: 通行証がなければ 401。問い合わせは出さない', async () => {
    const { res, calls } = await relayWith(() => ok('x'), { pass: 'bad.pass' });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  });

  await run('中継: 上流の応答が大きすぎれば、content-length が無くても読み切らずに 502', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const huge = () => new Response(new ReadableStream({
      pull(c) { pulled++; c.enqueue(chunk); if (pulled > 100) c.close(); },
    }));
    const { res } = await relayWith(huge);
    assert.equal(res.status, 502);
    assert.ok(pulled <= 12, `読んだのは ${pulled} MB`);
  });

  await run('中継: 知らない経路・パスをたどる入力は 404', async () => {
    assert.equal((await relayWith(() => ok('x'), { path: '/nope' })).res.status, 404);
    assert.equal((await relayWith(() => ok('x'), { path: '/nico-embed/../x' })).res.status, 404);
  });

  await run('中継: 上流のステータスはそのまま伝える。本文は書き換える', async () => {
    const { res } = await relayWith(() => new Response('https://stella.nicovideo.jp/x', { status: 404 }));
    assert.equal(res.status, 404);
    assert.match(await res.text(), /\/\.proxy\/srv\/nico\//);
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

  await run('中継: リダイレクトは自分で辿る（redirect: manual）。307 は POST と本文を保ち、302 は GET に切り替える', async () => {
    const hops = (status) => (url, init, n) =>
      n === 1 ? new Response(null, { status, headers: { location: '/moved' } }) : ok('done');
    const r307 = await relayWith(hops(307), { method: 'POST', path: '/v4-watch/sm9', body: '{"a":1}' });
    assert.ok(r307.calls.every((c) => c.init.redirect === 'manual'), 'すべての問い合わせが manual');
    assert.equal(r307.calls[1].url, 'https://nvapi.nicovideo.jp/moved', '相対 Location は元の URL から解決する');
    assert.equal(r307.calls[1].init.method, 'POST');
    assert.equal(r307.calls[1].init.body, '{"a":1}');
    const r302 = await relayWith(hops(302), { method: 'POST', path: '/v4-watch/sm9', body: '{"a":1}' });
    assert.equal(r302.calls[1].init.method, 'GET');
    assert.equal(r302.calls[1].init.body, undefined);
    assert.ok(r302.calls[1].init.headers['user-agent'], 'リダイレクト先にも User-Agent を付ける');
  });

  await run('中継: 待つ時間は、リダイレクトを含めた全体で 1 本（ホップごとに取り直さない）', async () => {
    const { calls } = await relayWith((url, init, n) =>
      n < 3 ? new Response(null, { status: 302, headers: { location: 'https://www.nicovideo.jp/next' + n } }) : ok('done'));
    assert.equal(calls.length, 3);
    assert.ok(calls[0].init.signal && calls.every((c) => c.init.signal === calls[0].init.signal));
  });

  await run('中継: 本物のタイムアウトの中断は 504 になる', async () => {
    const realError = console.error;
    console.error = () => {};
    try {
      const signal = AbortSignal.timeout(1);
      await new Promise((r) => setTimeout(r, 20));
      const { res } = await relayWith(() => { throw signal.reason; });
      assert.equal(res.status, 504);
    } finally {
      console.error = realError;
    }
  });

  await run('中継: 秘密の未登録は、502 にせず例外にする（外側が 500 にする）', async () => {
    const req = new Request('http://x/nico/p.q/nico-embed/sm9');
    await assert.rejects(
      () => handleNico(req, { DISCORD_CLIENT_ID: 'a' }, '/p.q/nico-embed/sm9'),
      (e) => e instanceof ConfigError && /PASS_SECRET is not set/.test(e.message),
    );
  });

  await run('中継: 経路の動画 ID に、パスをたどる文字を入れられない', async () => {
    const { matchRoute } = load('server/src/nico/nicoRoutes.ts');
    assert.ok(matchRoute('POST', '/v1-watch/sm9/x'));
    assert.equal(matchRoute('POST', '/v1-watch/./x'), null);
    assert.equal(matchRoute('POST', '/v1-watch/../x'), null);
  });

  await run('中継: 許可外へのリダイレクトを断ったとき、警告を残す', async () => {
    const warns = [];
    const realWarn = console.warn;
    console.warn = (m) => warns.push(m);
    try {
      await relayWith(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }));
    } finally {
      console.warn = realWarn;
    }
    assert.equal(warns.length, 1);
    assert.match(warns[0], /evil\.example/);
    // 辿りすぎのときも残る
    const warns2 = [];
    console.warn = (m) => warns2.push(m);
    try {
      await relayWith(() => new Response(null, { status: 302, headers: { location: 'https://www.nicovideo.jp/loop' } }));
    } finally {
      console.warn = realWarn;
    }
    assert.match(warns2.at(-1), /too many redirects/);
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
