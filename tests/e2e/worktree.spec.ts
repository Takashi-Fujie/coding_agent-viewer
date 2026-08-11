/**
 * worktree 統合とグルーピング表示の E2E（SPEC-DASH-105〜106・Issue #41）。
 * 仕様は docs/design/DASH.md「worktree グルーピング表示」。
 *
 * seed（tests/e2e/support/seed.ts の seedWorktree）が実在する worktree 構造と
 * 本体 / worktree それぞれのセッションを敷いてある。
 */
import { expect, test } from '@playwright/test';
import { E2E_WT_MAIN_PROJECT_ID, E2E_WT_NAME, E2E_WT_REPO_ROOT } from './support/env.js';

test('SPEC-DASH-105: Overview のプロジェクト一覧に worktree の行が現れず本体プロジェクトへ統合される', async ({
  page,
}) => {
  await page.goto('/');
  const table = page.getByTestId('project-table');
  // 本体プロジェクトの行（実パス表示）はある
  await expect(table).toContainText(E2E_WT_REPO_ROOT);
  // worktree のプロジェクト行（worktree 名を含むパス）は統合されて存在しない
  await expect(table).not.toContainText(E2E_WT_NAME);
});

test('SPEC-DASH-106: 統合されたプロジェクトの詳細で「本体」と worktree 名のグループが描画される', async ({
  page,
}) => {
  await page.goto(`/#/projects/${E2E_WT_MAIN_PROJECT_ID}`);
  const groups = page.getByTestId('wt-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText('本体');
  await expect(groups.nth(1)).toContainText(E2E_WT_NAME);
  // 各グループの件数表示
  await expect(groups.nth(0)).toContainText('1 セッション');
  await expect(groups.nth(1)).toContainText('1 セッション');
});
