/**
 * SPEC-CHAT の E2E（SPEC-CHAT-070〜076）。仕様は docs/design/CHAT.md。
 */
import { expect, test } from '@playwright/test';
import {
  E2E_PROJECT_ID,
  E2E_PROJECT_PATH,
  LONG_TURNS,
  SESSION_COMPACT,
  SESSION_LONG,
  SESSION_MAIN,
  SESSION_SAMPLE,
} from './support/env.js';

function sessionUrl(sessionId: string): string {
  return `/#/projects/${E2E_PROJECT_ID}/sessions/${sessionId}`;
}

test('SPEC-CHAT-070: Overview → プロジェクト → セッション分析へドリルダウンでき、パンくずで戻れる', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('project-table').getByText(E2E_PROJECT_PATH).click();

  // プロジェクト画面: セッション一覧から E2E 主対象セッションへ
  await expect(page.locator('.crumbs')).toContainText('Overview');
  await page.getByTestId('session-table').getByText(SESSION_MAIN).first().click();
  await expect(page).toHaveURL(new RegExp(`#/projects/.+/sessions/${SESSION_MAIN}`));

  // パンくずで プロジェクト → Overview と戻る
  await page.locator('.crumbs').getByText(E2E_PROJECT_PATH).click();
  await expect(page.getByTestId('session-table')).toBeVisible();
  await page.locator('.crumbs').getByText('← Overview').click();
  await expect(page.getByTestId('project-table')).toBeVisible();
});

test('SPEC-CHAT-071: セッションヘッダにモデル・総トークン・推定コスト・破損スキップ行数が表示される', async ({
  page,
}) => {
  // 破損行（壊れた JSON）はサンプルセッションに含まれる
  await page.goto(sessionUrl(SESSION_SAMPLE));
  const head = page.locator('.chathead');
  await expect(head).toContainText('claude-sonnet-5');
  await expect(head).toContainText('合計');
  await expect(head).toContainText('推定');
  await expect(head).toContainText('破損');
  await expect(head).toContainText('行スキップ');
});

test('SPEC-CHAT-072: ツール呼び出しは折りたたまれ、開くと入出力が読め、失敗（is_error）が明示される', async ({
  page,
}) => {
  await page.goto(sessionUrl(SESSION_MAIN));
  const tool = page.locator('details.tool', { hasText: 'Bash' }).first();
  await expect(tool).toContainText('失敗');
  // 折りたたみ状態では結果本文は見えない
  await expect(tool.locator('pre.result')).not.toBeVisible();
  await tool.locator('summary').click();
  await expect(tool.locator('pre.result')).toContainText('合成のビルド失敗ログ');
});

test('SPEC-CHAT-073: やりとり別コスト棒グラフの帯クリックで会話が絞り込まれ、解除できる', async ({
  page,
}) => {
  await page.goto(sessionUrl(SESSION_MAIN));
  await expect(page.getByText('E2E 用の依頼文。', { exact: false })).toBeVisible();

  await page.getByTestId('turn-band-0').click();
  await expect(page.getByText('のみ表示')).toBeVisible();

  await page.getByRole('button', { name: '✕' }).click();
  await expect(page.getByText('のみ表示')).not.toBeVisible();
});

test('SPEC-CHAT-076: compact 済み（グレー）の帯もクリックで会話が絞り込まれ、解除できる', async ({
  page,
}) => {
  await page.goto(sessionUrl(SESSION_COMPACT));
  await expect(page.getByText('圧縮後のやりとり。', { exact: false })).toBeVisible();

  // やりとり #1（圧縮前）は compact_boundary より前に開始 = compacted（グレー表示）
  await page.getByTestId('turn-band-0').click();
  await expect(page.getByText('のみ表示')).toBeVisible();

  // 絞り込み結果は compacted のやりとりだけになる
  await expect(page.getByText('圧縮前のやりとり。', { exact: false })).toBeVisible();
  await expect(page.getByText('圧縮後のやりとり。', { exact: false })).not.toBeVisible();

  await page.getByRole('button', { name: '✕' }).click();
  await expect(page.getByText('のみ表示')).not.toBeVisible();
  await expect(page.getByText('圧縮後のやりとり。', { exact: false })).toBeVisible();
});

test('SPEC-CHAT-074: 巨大行（50KB 超）を含むセッションの分析画面が表示される', async ({ page }) => {
  await page.goto(sessionUrl(SESSION_SAMPLE));
  await expect(page.getByText('サンプルの依頼文。')).toBeVisible();
  await expect(page.locator('.chathead')).toContainText('合計');
});

test('SPEC-CHAT-075: 画面に収まらない行数のセッションで、.appmain を末尾までスクロールすると最後の行が描画される', async ({
  page,
}) => {
  await page.goto(sessionUrl(SESSION_LONG));
  await expect(page.getByText('長いセッションの依頼 1', { exact: true })).toBeVisible();

  // 末尾の行は初期ビューポートの描画範囲外（仮想化されているため DOM に無い）
  const last = page.getByText(`長いセッションの応答 ${String(LONG_TURNS)}`, { exact: true });
  await expect(last).not.toBeVisible();

  // 行の実測（measureElement）で総高さが伸びるため、1 回の scrollTop 代入では
  // 末尾に届かないことがある。末尾行が見えるまでスクロールを繰り返す
  await expect(async () => {
    await page.locator('.appmain').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(last).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
});

test('SPEC-DASH-124: セッション一覧の回数と、分析画面の ⚡ マーカー・通し番号付き区切り線が一致する', async ({
  page,
}) => {
  // プロジェクト画面: compaction 列に回数が出る（claude セッションは 0 も表示）
  await page.goto(`/#/projects/${E2E_PROJECT_ID}`);
  const table = page.getByTestId('session-table');
  const compactRow = table.locator('tr', { hasText: SESSION_COMPACT });
  await expect(compactRow.getByTestId('compaction-count')).toHaveText('1');
  const mainRow = table.locator('tr', { hasText: SESSION_MAIN });
  await expect(mainRow.getByTestId('compaction-count')).toHaveText('0');

  // セッション分析画面: マーカー 1 本・通し番号付き区切り線 1 本
  await page.goto(sessionUrl(SESSION_COMPACT));
  await expect(page.getByTestId('compaction-marker')).toHaveCount(1);
  await expect(page.locator('.divider.compaction')).toContainText('compaction #1');
});
