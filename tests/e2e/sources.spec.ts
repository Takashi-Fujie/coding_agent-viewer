/**
 * SPEC-DASH-090〜093: ソース切替と Codex 統合の E2E（Issue #31）。仕様は docs/design/DASH.md。
 *
 * webServer（support/server.ts）は Claude + Codex の合成ログを seed 済み。
 * SPEC-DASH-093 だけは「Codex セッションが無い環境」が必要なため、
 * テスト内で空の Codex ルートを持つサーバを別ポートに立てて検証する。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { createApp } from '../../server/app.js';
import { E2E_CLAUDE_DIR, E2E_LOG_DIR, codexDayId } from './support/env.js';

const nav = '[data-testid="source-switch"]';
const table = '[data-testid="project-table"]';

test('SPEC-DASH-090: 切替で codex-only グループが消え、統合グループは選択ソースの値で残る（#49 改定。旧: Codex グループが消える）', async ({
  page,
}) => {
  await page.goto('/');
  // 全ソース: Claude プロジェクト（Codex と統合済み）と codex-only グループが並ぶ
  await expect(page.locator(table)).toContainText('sample-project');
  await expect(page.locator(table)).toContainText('sample-codex');
  const allCost = await page.getByTestId('tile-cost').textContent();

  // Codex 選択: codex-only は残り、統合プロジェクトの行も部分表示で残る（#49 改定）
  await page.locator(nav).getByRole('button', { name: 'Codex' }).click();
  await expect(page.locator(table)).toContainText('sample-codex');
  await expect(page.locator(table)).toContainText('sample-project');

  // Claude 選択: codex-only グループは消え、統合プロジェクトは Claude のみの値で残る
  await page.locator(nav).getByRole('button', { name: 'Claude' }).click();
  await expect(page.locator(table)).toContainText('sample-project');
  await expect(page.locator(table)).not.toContainText('sample-codex');
  // Codex は usage 未集計（0）なので、Claude のみの総コストは全ソースと一致する
  await expect(page.getByTestId('tile-cost')).toHaveText(allCost ?? '');
});

test('SPEC-DASH-091: Codex グループの行にソースバッジと cwd 末尾ラベルが描画される', async ({ page }) => {
  await page.goto('/');
  const day = codexDayId();

  const row = page.locator(`${table} tbody tr`, { hasText: 'sample-codex' });
  await expect(row.locator('b', { hasText: 'sample-codex' })).toBeVisible();
  await expect(row.locator('.badge.src')).toHaveText('Codex');
  // 日付を主ラベルにしない（#45 改定。旧: 日付ラベル）
  await expect(row.locator('b', { hasText: day })).toHaveCount(0);
});

test('SPEC-DASH-092: 日付クリック絞り込みで usage 0 の Codex セッションが一覧に残る', async ({
  page,
}) => {
  await page.goto('/');
  const day = codexDayId();
  await expect(page.locator(table)).toContainText('sample-codex');

  await page.getByTestId(`band-${day}`).click();
  await expect(page.getByTestId('day-chip')).toBeVisible();

  // usage 0 の Codex グループが「その日に活動した」一覧に残る
  await expect(page.locator(table)).toContainText('sample-codex');
  await expect(
    page.locator(`${table} tbody tr`, { hasText: 'sample-codex' }).locator('.badge.src'),
  ).toHaveText('Codex');
});

test('SPEC-DASH-093: Codex セッションが無い seed では「Codex」選択肢が disabled 表示になる', async ({
  page,
}) => {
  // Codex ルートが空（存在しない）のサーバを別ポートに立てる
  const emptyRoot = await mkdtemp(join(tmpdir(), 'e2e-no-codex-'));
  const app = createApp({
    logDir: E2E_LOG_DIR,
    cacheDir: join(emptyRoot, 'cache'),
    claudeDir: E2E_CLAUDE_DIR,
    codexSessionsDir: join(emptyRoot, 'codex-sessions'),
  });
  const server: Server = app.listen(4520, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    await page.goto('http://127.0.0.1:4520/');
    const codexButton = page.locator(nav).getByRole('button', { name: 'Codex' });
    await expect(codexButton).toBeVisible();
    await expect(codexButton).toBeDisabled();
    await expect(page.locator(nav).getByRole('button', { name: 'Claude' })).toBeEnabled();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(emptyRoot, { recursive: true, force: true });
  }
});
