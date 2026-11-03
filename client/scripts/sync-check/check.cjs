// 同期エンジン (src/player/sync) の挙動が、記録 (expected.json) と変わっていないかを確かめる。
//   npm run check:sync           ... 比べる
//   npm run check:sync -- --update ... 意図して挙動を変えたとき、記録を作り直す
// 偽の時計・偽のプレイヤーで、いくつかの場面（途中参加・開始待ち・ユーザー操作・動画の切り替えなど）を流し、
// プレイヤーとサーバーへの呼び出しを、時刻つきで比べる（run.cjs に場面がある）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadTs } = require('../loadTs.cjs');

// 同期エンジンのフォルダの全ファイルを変換して、別のプロセス（run.cjs）で読み込む
const SYNC_DIR = 'client/src/player/sync';
const load = loadTs(fs.readdirSync(path.resolve(__dirname, '../../src/player/sync')).filter((f) => f.endsWith('.ts')).map((f) => `${SYNC_DIR}/${f}`));
const engine = path.join(load.dir, SYNC_DIR, 'engine.js');
const actual = JSON.parse(
  execFileSync(process.execPath, [path.join(__dirname, 'run.cjs'), engine], { encoding: 'utf8', maxBuffer: 1 << 26 }),
);

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
  // 崩れた挙動を、そのまま記録にしない
  if (broken > 0) {
    console.log('終了後の状態が崩れている場面があるので、記録は作り直しません');
    process.exit(1);
  }
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
