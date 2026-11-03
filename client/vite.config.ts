import { appendFileSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** /__log で受け取る 1 回分の上限（画面は 1 行ずつ送る） */
const REMOTE_LOG_MAX = 16 * 1024;

/**
 * 開発用: Activity 内のログを POST /__log で受けて dev.log に追記する（Discord の中では開発者ツールを開きにくいため）。
 * トンネル越しに外から届くこともあるので、大きすぎる本文は書かない
 */
function remoteLog(): Plugin {
  return {
    name: 'remote-log',
    configureServer(server) {
      server.middlewares.use('/__log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        let tooLarge = false;
        req.on('data', (c: Buffer) => {
          if (tooLarge) return;
          body += c;
          if (body.length > REMOTE_LOG_MAX) tooLarge = true;
        });
        req.on('end', () => {
          if (!tooLarge) appendFileSync('dev.log', body + '\n');
          res.statusCode = tooLarge ? 413 : 200;
          res.end();
        });
      });
    },
  };
}

/** 画面に出すバージョン。リリースのたびに package.json の version を進める */
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string };

export default defineConfig({
  envDir: '..',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [remoteLog()],
  build: {
    rollupOptions: {
      // index.html: Activity 本体 / landing.html: Discord の外から開いたときの案内（index.html の中のスクリプトが、Discord の外から開かれたら /landing に移す）
      input: { index: 'index.html', landing: 'landing.html' },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // cloudflared 経由のホスト名を許可
    allowedHosts: true,
    // Discord のプロキシ越しでも HMR を使えるように
    hmr: { clientPort: 443 },
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '^/nico/': 'http://127.0.0.1:8787',
    },
  },
});
