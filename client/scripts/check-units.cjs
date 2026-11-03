// 画面の、DOM に頼らない小さな処理の単体テスト
//   時計のずれの推定・リンクを本当の URL に戻す処理・通行証を伏せる処理・再生リストの状態・数と時間の書式
//   npm run check:units
const assert = require('node:assert/strict');
const { loadTs } = require('./loadTs.cjs');

// i18n は、読み込んだときに言語を決めて <html lang> を書く。ブラウザの代わりを置き、英語で始める
globalThis.document = { documentElement: {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });

const load = loadTs([
  'client/src/net/clock.ts',
  'client/src/core/urls.ts',
  'client/src/core/scrub.ts',
  'client/src/ui/playlistStore.ts',
  'client/src/core/i18n/index.ts',
]);

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

const { ClockSync } = load('client/src/net/clock.ts');
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

const { realUrl } = load('client/src/core/urls.ts');
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

const { scrubSecrets } = load('client/src/core/scrub.ts');
test('通行証を伏せる: 通行証の形と ?pass= の値は伏せ、それ以外は残す', () => {
  const pass = 'eyJ1IjoiMTIzNDU2Nzg5MCJ9abc.QWxhZGRpbjpvcGVuIHNlc2FtZQ';
  assert.equal(scrubSecrets(`GET /.proxy/srv/nico/${pass}/nico-embed/sm9`), 'GET /.proxy/srv/nico/[pass]/nico-embed/sm9');
  assert.equal(scrubSecrets('wss://x/ws/room?pass=abc.def&x=1'), 'wss://x/ws/room?pass=[pass]&x=1');
  assert.equal(scrubSecrets('state v3 sm9 playing pos=1.0'), 'state v3 sm9 playing pos=1.0');
});

const store = load('client/src/ui/playlistStore.ts');
const item = (id, videoId = 'sm' + id) => ({ id, videoId, title: id, addedBy: 'x' });
const ids = (list) => list.map((q) => q.id).join(',');
const state = (current, over = {}) => ({ current, playing: true, position: 0, updatedAt: 0, version: 1, by: null, byName: null, ...over });

test('再生リスト: 前へ・次への移動先（シャッフル・全曲リピートを含む）', () => {
  store.setLists([item('q1'), item('q2')], [item('h1')]);
  store.setPlaybackState(state(item('c')));
  assert.equal(store.navTarget('prev').item.id, 'h1');
  assert.equal(store.navTarget('next').item.id, 'q1');
  store.setPlaybackState(state(item('c'), { shuffle: true }));
  assert.deepEqual(store.navTarget('next'), { random: true });
  store.setLists([], [item('h1')]);
  store.setPlaybackState(state(item('c'), { repeat: 'all' }));
  assert.equal(store.navTarget('next').item.id, 'h1', '全曲リピートで最後なら、最初に戻る');
  store.setPlaybackState(state(item('c')));
  assert.equal(store.navTarget('next'), null);
  store.setLists([], []);
  assert.equal(store.navTarget('prev'), null);
});

test('再生リスト: 追加済みの判定と、取り消す対象（あとから追加したものを優先）', () => {
  store.setLists([item('q1', 'sm1'), item('q2', 'sm1')], [item('h1', 'sm2')]);
  store.setPlaybackState(state(item('c', 'sm3')));
  assert.equal(store.isInPlaylist('sm1'), true);
  assert.equal(store.isInPlaylist('sm3'), true, '再生中も含む');
  assert.equal(store.isInPlaylist('sm2'), false, '視聴済みは含めない');
  assert.deepEqual(store.findAddedItem('sm1'), { id: 'q2' });
  assert.deepEqual(store.findAddedItem('sm2'), { id: 'h1' });
  assert.equal(store.findAddedItem('sm9'), null);
});

test('再生リスト: 並べ替えはサーバーと同じ規則で画面に反映し、変わったことを知らせる', () => {
  let changed = 0;
  store.onPlaylistChange(() => changed++);
  store.setLists([item('q1'), item('q2')], [item('h1')]);
  store.setPlaybackState(state(item('c')));
  changed = 0;
  assert.equal(store.applyReorder('q2', 0), true);
  assert.equal(ids(store.lists.history), 'q2,h1');
  assert.equal(ids(store.lists.queue), 'q1');
  assert.equal(changed, 1);
  assert.equal(store.applyReorder('q2', 0), false, '並びが変わらなければ false');
});

const i18n = load('client/src/core/i18n/index.ts');
test('書式: 時間・数（言語ごとの短い表し方）', () => {
  assert.equal(i18n.formatTime(0), '0:00');
  assert.equal(i18n.formatTime(65.9), '1:05');
  assert.equal(i18n.formatTime(3725), '1:02:05');
  assert.equal(i18n.formatTime(-3), '0:00');
  assert.equal(i18n.getLang(), 'en');
  assert.equal(i18n.formatCount(999), '999');
  assert.equal(i18n.formatCount(12_345), '12.3K');
  assert.equal(i18n.formatCount(2_000_000), '2M');
  assert.equal(i18n.formatNumber(12_345), '12,345');
});

console.log(`OK: ${passed} 件`);
