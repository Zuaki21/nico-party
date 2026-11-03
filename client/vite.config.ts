import { appendFileSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** 開発用: Activity 内のログを POST /__log で受けて dev.log に追記する */
function remoteLog(): Plugin {
  return {
    name: 'remote-log',
    configureServer(server) {
      server.middlewares.use('/__log', (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          appendFileSync('dev.log', body + '\n');
          res.end('ok');
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
