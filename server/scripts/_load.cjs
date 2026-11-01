// 確認スクリプトの共通部分: TypeScript のファイルを CommonJS に変換して一時フォルダに置き、require できるようにする。
// 同じフォルダ構成（server/src/..., shared/...）のまま置くので、ファイル同士の import もそのまま通る。
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

/** @param rels リポジトリのルートからの .ts のパス @returns 変換後のファイルを読み込む関数 */
function loadTs(rels) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-'));
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  for (const rel of rels) {
    const js = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const out = path.join(tmp, rel.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, js);
  }
  return (rel) => require(path.join(tmp, rel.replace(/\.ts$/, '.js')));
}

/** テストを 1 件ずつ流す。失敗したら名前を出して止める */
function makeRunner() {
  let passed = 0;
  return {
    test(name, fn) {
      try {
        const r = fn();
        if (r && typeof r.then === 'function') return r.then(() => passed++, (e) => { console.error('失敗:', name); throw e; });
        passed++;
      } catch (e) {
        console.error('失敗:', name);
        throw e;
      }
    },
    get passed() { return passed; },
  };
}

module.exports = { loadTs, makeRunner };
