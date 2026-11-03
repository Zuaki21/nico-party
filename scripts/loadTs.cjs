// 確認スクリプトの共通部分（client/scripts と server/scripts から使う）:
// TypeScript のファイルを CommonJS に変換して一時フォルダに置き、require できるようにする。型は確かめない（npm run typecheck が確かめる）。
// 相対 import は、`from '...'` / `import '...'` の形（静的なもの）だけ自動でたどる（フォルダの import は index.ts）。
// リポジトリと同じフォルダ構成（client/src/..., server/src/..., shared/...）のまま置くので、ファイル同士の import もそのまま通る。
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

/**
 * @param ts 呼び出し側の typescript（client と server は、それぞれ自分の node_modules に持っている）
 * @param rels 入口にする .ts のパス（リポジトリのルートから）。そこから相対 import でたどれるものは、自動で一緒に変換する
 * @returns 変換後のファイルを読み込む関数と、変換したファイルを置いたフォルダ
 */
function loadTs(ts, rels) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-'));
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  const done = new Set();
  const convert = (rel) => {
    if (done.has(rel)) return;
    done.add(rel);
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const out = path.join(tmp, rel.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, js);
    for (const m of src.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      // './x' は x.ts か、フォルダなら x/index.ts（node の CommonJS も、同じ順で探す）
      const base = path.posix.join(path.posix.dirname(rel), m[1]);
      const dep = [`${base}.ts`, `${base}/index.ts`].find((f) => fs.existsSync(path.join(root, f)));
      if (dep) convert(dep);
    }
  };
  rels.forEach(convert);
  const load = (rel) => require(path.join(tmp, rel.replace(/\.ts$/, '.js')));
  load.dir = tmp;
  return load;
}

module.exports = { loadTs };
