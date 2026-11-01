// ニコニコの中継の書き換えルール (src/nico/nico.ts の rewriter) の単体テスト。
// 書き換えで作る中継の URL に、必ず通行証が入っていること（無いと 401 になって再生できなくなる）と、
// 元の URL の形ごとの書き換え結果を確かめる。   cd server && npm run check:nico
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nico-'));
for (const rel of ['server/src/nico/nico.ts', 'server/src/nico/nicoApi.ts', 'server/src/pass.ts', 'shared/search.ts']) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const out = path.join(tmp, rel.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, js);
}
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const { rewriter } = require(path.join(tmp, 'server/src/nico/nico.js'));

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

console.log(`OK: ${passed} 件`);
