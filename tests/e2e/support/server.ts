/**
 * E2E 用サーバの起動スクリプト（Playwright の webServer が実行する）。
 * 仕様は docs/design/FLOW.md（E2E 基盤）。
 *
 * 実 ~/.claude には決して触れない。合成フィクスチャを敷き直してから
 * createApp に注入し、build:web 済みの web/dist を静的配信する
 * （実運用と同じ Express 配信経路で検証するため）。
 */
import { createApp } from '../../../server/app.js';
import { E2E_CACHE_DIR, E2E_CLAUDE_DIR, E2E_CODEX_DIR, E2E_LOG_DIR, E2E_PORT } from './env.js';
import { seed } from './seed.js';

await seed();

const app = createApp({
  logDir: E2E_LOG_DIR,
  cacheDir: E2E_CACHE_DIR,
  claudeDir: E2E_CLAUDE_DIR,
  codexSessionsDir: E2E_CODEX_DIR,
});

app.listen(E2E_PORT, '127.0.0.1', () => {
  console.log(`E2E server: http://127.0.0.1:${String(E2E_PORT)}/`);
});
