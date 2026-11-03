// 確認スクリプトの共通部分: TypeScript のファイルを CommonJS に変換して、一時フォルダに置く
// （型は確かめない。型は npm run typecheck が確かめる）
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

/** 一時フォルダを作る。プロセスの終わりに消す */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** src の .ts を CommonJS に変換して out に書き、そのパスを返す */
function transpileTo(src, out) {
  const js = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  fs.writeFileSync(out, js);
  return out;
}

module.exports = { tempDir, transpileTo };
