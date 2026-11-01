// 確認スクリプトの共通部分: TypeScript のファイルを CommonJS に変換して一時フォルダに置き、require できるようにする。
// 同じフォルダ構成（server/src/..., shared/...）のまま置くので、ファイル同士の import もそのまま通る。
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

/**
 * @param rels 入口にする .ts のパス（リポジトリのルートから）。そこから相対 import でたどれるものは、自動で一緒に変換する
 * @returns 変換後のファイルを読み込む関数
 */
function loadTs(rels) {
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
      const dep = path.posix.join(path.posix.dirname(rel), m[1]) + '.ts';
      if (fs.existsSync(path.join(root, dep))) convert(dep);
    }
  };
  rels.forEach(convert);
  return (rel) => require(path.join(tmp, rel.replace(/\.ts$/, '.js')));
}

/** 'cloudflare:workers'（Workers の中でしか読み込めない）を、最小の代用品に差し替える。Room クラスを手元で動かすため */
function stubCloudflareWorkers() {
  const Module = require('module');
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'cloudflare:workers') {
      return {
        DurableObject: class {
          constructor(ctx, env) {
            this.ctx = ctx;
            this.env = env;
          }
        },
      };
    }
    return original.call(this, request, ...rest);
  };
}

module.exports = { loadTs, stubCloudflareWorkers };
