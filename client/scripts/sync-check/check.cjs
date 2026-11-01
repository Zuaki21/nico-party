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
const actual = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'run.cjs'), path.join(out, 'engine.js')], { encoding: 'utf8', maxBuffer: 1 << 26 }));
fs.rmSync(out, { recursive: true, force: true });

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
console.log(bad === 0 ? `OK: ${Object.keys(expected).length} 場面すべて一致` : `${bad} 場面で差異`);
process.exit(bad === 0 ? 0 : 1);
