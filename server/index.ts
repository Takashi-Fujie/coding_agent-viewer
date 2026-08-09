/**
 * サーバのエントリポイント。仕様は docs/design/API.md（SPEC-API-001）。
 *
 * 個人の全作業ログを扱うため、127.0.0.1 以外には決して bind しない。
 * 認証を設けない前提はこの制約とセットである。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4517;

/** PORT 環境変数からポートを決める。不正値は既定値へ倒す。 */
export function resolvePort(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env['PORT'] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const claudeDir = join(homedir(), '.claude');
  const app = createApp({
    logDir: join(claudeDir, 'projects'),
    cacheDir: '.cache',
    claudeDir,
    codexSessionsDir: join(homedir(), '.codex', 'sessions'),
  });

  const port = resolvePort(process.env);
  app.listen(port, HOST, () => {
    console.log(`coding_agent-viewer API: http://${HOST}:${String(port)}/api/overview`);
  });
}
