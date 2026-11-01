// 同期エンジン (src/player/sync) の挙動が、記録 (expected.json) と変わっていないかを確かめる。
//   npm run check:sync           ... 比べる
//   npm run check:sync -- --update ... 意図して挙動を変えたとき、記録を作り直す
// 偽の時計・偽のプレイヤーで、いくつかの場面（途中参加・開始待ち・ユーザー操作・動画の切り替えなど）を流し、
// プレイヤーとサーバーへの呼び出しを、時刻つきで比べる（run.cjs に場面がある）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript');

const src = path.resolve(__dirname, '../../src/player/sync');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-check-'));
for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.ts'))) {
  const js = ts.transpileModule(fs.readFileSync(path.join(src, f), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  fs.writeFileSync(path.join(out, f.replace(/\.ts$/, '.js')), js);
}
// 時計のずれの推定 (src/net/clock.ts) の単体テスト
const clockJs = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../src/net/clock.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
fs.writeFileSync(path.join(out, 'clock.js'), clockJs);
{
  const assert = require('node:assert/strict');
  const { ClockSync } = require(path.join(out, 'clock.js'));
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
  const fresh = new ClockSync();
  fresh.reset();
  fresh.provisional(7000, 1000);
  assert.equal(fresh.offset, 6000, '一度も測れていなければ、仮の値を使う');
}
const actual = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'run.cjs'), path.join(out, 'engine.js')], { encoding: 'utf8', maxBuffer: 1 << 26 }));
fs.rmSync(out, { recursive: true, force: true });

// 記録との比較とは別に、どの場面も、終わったあとに元の状態へ戻っていること（ミュートが元に戻る・覆いが外れる・
// エンジンのタイマーとイベントの購読が残らない）を確かめる。これが崩れると、音が出続ける・画面が隠れたまま・タイマーの漏れになる
let broken = 0;
for (const [name, lines] of Object.entries(actual)) {
  const end = lines[lines.length - 1];
  if (end !== 'END mutedRestored=true cover=false timersAfterDispose=0 listenersAfterDispose=0' || lines.some((l) => l.startsWith('EXCEPTION'))) {
    broken++;
    console.log('終了後の状態が崩れている:', name, '=>', end);
  }
}
const expectedPath = path.join(__dirname, 'expected.json');
if (process.argv.includes('--update')) {
  fs.writeFileSync(expectedPath, JSON.stringify(actual, null, 1) + '\n');
  console.log('記録を作り直しました:', Object.keys(actual).length, '場面');
  process.exit(0);
}
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
let bad = 0;
for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
  const a = expected[name] ?? [], b = actual[name] ?? [];
  if (JSON.stringify(a) === JSON.stringify(b)) continue;
  bad++;
  console.log('差異:', name);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) { console.log('  記録:', a[i]); console.log('  今  :', b[i]); break; }
  }
}
console.log(bad === 0 && broken === 0 ? `OK: ${Object.keys(expected).length} 場面すべて一致（終了後の状態も元どおり）` : `${bad} 場面で差異、${broken} 場面で終了後の状態が崩れている`);
process.exit(bad === 0 && broken === 0 ? 0 : 1);
