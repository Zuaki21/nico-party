// サーバーの確認スクリプトから、TypeScript のファイルを読み込む（中身はリポジトリの scripts/loadTs.cjs）
const ts = require('typescript');
const { loadTs } = require('../../scripts/loadTs.cjs');

module.exports = { loadTs: (rels) => loadTs(ts, rels) };
