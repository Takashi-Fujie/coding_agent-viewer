/**
 * SPEC-DASH-115〜116: 同一プロジェクトの Claude / Codex 表示統合の E2E（Issue #49）。
 * 仕様は docs/design/DASH.md。
 *
 * webServer（support/server.ts）の seed には、Claude プロジェクト（/home/dev/sample-project）と
 * 同一 cwd の Codex rollout が含まれる（support/seed.ts の codexSharedSessionLines）。
 */
import { expect, test } from '@playwright/test';
import { E2E_PROJECT_ID } from './support/env.js';

const nav = '[data-testid="source-switch"]';
const table = '[data-testid="project-table"]';

test('SPEC-DASH-115: 同一 cwd の claude / codex seed でプロジェクト一覧が 1 行になり、両ソースバッジと合算値が描画される', async ({
  page,
}) => {
  await page.goto('/');
  const rows = page.locator(`${table} tbody tr`, { hasText: 'sample-project' });
  await expect(rows).toHaveCount(1);

  // 両ソースバッジ + 合算値（Claude 分のトークンがあるため未集計表示にならない）
  const row = rows.first();
  await expect(row.locator('.badge.src-claude')).toHaveText('Claude');
  await expect(row.locator('.badge.src-codex')).toHaveText('Codex');
  await expect(row).not.toContainText('未集計');
});

test('SPEC-DASH-116: ソース切替で統合行が残って値が選択ソース分になり、codex: 付き旧プロジェクト URL は 404 になる', async ({
  page,
}) => {
  await page.goto('/');
  const row = page.locator(`${table} tbody tr`, { hasText: 'sample-project' }).first();
  await expect(row.locator('.badge.src-claude')).toBeVisible();

  // Codex 選択: 行は残り、バッジ・値が Codex 分だけになる（usage 未集計 → 未集計表示）
  await page.locator(nav).getByRole('button', { name: 'Codex' }).click();
  await expect(row.locator('.badge.src-codex')).toBeVisible();
  await expect(row.locator('.badge.src-claude')).toHaveCount(0);
  await expect(row).toContainText('未集計');

  // codex: 付き旧 URL は 404（統合 id の URL は 200）
  const gone = await page.request.get(`/api/projects/${encodeURIComponent(`codex:${E2E_PROJECT_ID}`)}`);
  expect(gone.status()).toBe(404);
  const alive = await page.request.get(`/api/projects/${E2E_PROJECT_ID}`);
  expect(alive.status()).toBe(200);
});
