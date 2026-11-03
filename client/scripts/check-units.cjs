// 画面の、DOM に頼らない小さな処理の単体テスト
//   時計のずれの推定 (src/net/clock.ts)・プレイヤーの中のリンクを本当の URL に戻す処理 (src/core/urls.ts)
//   npm run check:units
const assert = require('node:assert/strict');
const path = require('path');
const { tempDir, transpileTo } = require('./transpile.cjs');

const out = tempDir('check-units-');
const load = (rel) => require(transpileTo(path.resolve(__dirname, '..', rel), path.join(out, path.basename(rel, '.ts') + '.js')));

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('失敗:', name);
    throw e;
  }
};

const { ClockSync } = load('src/net/clock.ts');
test('時計: 往復の短い測定を採り、再接続しても直前の値を保つ', () => {
  const c = new ClockSync();
  c.provisional(1_000_500, 1_000_000);
  assert.equal(c.offset, 500, '往復を測れる前は、welcome の時刻から仮の値を作る');
  c.sample(1_000_000, 1_000_550, 1_000_100); // rtt 100 → offset = 1_000_550 + 50 - 1_000_100 = 500
  c.sample(2_000_000, 2_000_540, 2_000_020); // rtt 20 → offset = 2_000_540 + 10 - 2_000_020 = 530（往復が短いほうを採る）
  assert.equal(c.offset, 530);
  c.reset();
  assert.equal(c.offset, 530, '再接続の直後も、直前の値を保つ（端末の時計に跳ばない）');
  c.provisional(3_000_900, 3_000_000);
  assert.equal(c.offset, 530, '一度測れた値は、往復を測れない仮の値で上書きしない');
  c.sample(4_000_000, 4_000_520, 4_000_040);
  assert.equal(c.offset, 4_000_520 + 20 - 4_000_040, '再接続後に測り直した値に置き換わる');
});

test('時計: 一度も測れていなければ、仮の値を使う', () => {
  const fresh = new ClockSync();
  fresh.reset();
  fresh.provisional(7000, 1000);
  assert.equal(fresh.offset, 6000);
});

const { realUrl } = load('src/core/urls.ts');
test('リンク: 中継の URL は元に戻し、それ以外は戻さない。開けないものは null', () => {
  const own = 'https://app.discordsays.com';
  const base = `${own}/.proxy/nico/x/watch`;
  assert.equal(realUrl(`${own}/.proxy/external/www--nicovideo--jp/watch/sm9?a=1#t`, base, own), 'https://www.nicovideo.jp/watch/sm9?a=1#t', '中継の URL は元に戻す');
  assert.equal(realUrl(`${own}/external/www--nicovideo--jp`, base, own), 'https://www.nicovideo.jp/', '.proxy が付かない形も戻す。パスが無ければ /');
  assert.equal(realUrl('https://example.com/a', base, own), 'https://example.com/a', '外のサイトはそのまま');
  assert.equal(realUrl('https://other.example/external/www--nicovideo--jp/x', base, own), 'https://other.example/external/www--nicovideo--jp/x', '自分のオリジンでなければ戻さない');
  assert.equal(realUrl('javascript:alert(1)', base, own), null, 'http(s) 以外は開かない');
  assert.equal(realUrl('http://[', base, own), null, '壊れた URL は開かない');
  assert.equal(realUrl(`${own}/.proxy/external/a%00b/x`, base, own), null, 'ホストにできない文字があっても例外にしない');
});

console.log(`OK: ${passed} 件`);
