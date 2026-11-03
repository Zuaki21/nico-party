import { existsSync } from 'node:fs';
import type { Env } from '../env';

/** ローカル開発では、server/.dev.vars と server/.env（KEY=VALUE の形式）から読む。本番は環境変数をそのまま使う */
function loadEnvFiles() {
  for (const file of ['.dev.vars', '.env']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/** 環境変数から、サーバーの環境を作る */
export function loadEnv(): Env {
  loadEnvFiles();
  const e = process.env;
  return {
    DISCORD_CLIENT_ID: e.DISCORD_CLIENT_ID ?? '',
    DISCORD_CLIENT_SECRET: e.DISCORD_CLIENT_SECRET ?? '',
    PASS_SECRET: e.PASS_SECRET ?? '',
    ...(e.DISCORD_BOT_TOKEN ? { DISCORD_BOT_TOKEN: e.DISCORD_BOT_TOKEN } : {}),
    ...(e.ALLOW_ANON_WS ? { ALLOW_ANON_WS: e.ALLOW_ANON_WS } : {}),
  };
}
