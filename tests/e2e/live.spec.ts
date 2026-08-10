/**
 * SPEC-LIVE の E2E（SPEC-LIVE-030〜032）。仕様は docs/design/LIVE.md。
 *
 * テストプロセスから合成 JSONL へ直接追記し、SSE 経由の画面反映を検証する。
 * chokidar の検知に遅延があるため、時間ではなく「現れる / 現れない」を
 * web-first assertion（自動リトライ）で待つ。
 */
import { appendFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  E2E_PROJECT_ID,
  SESSION_CODEX,
  SESSION_LIVE,
  SESSION_MAIN,
  codexDayId,
  codexFilePath,
  sessionFilePath,
} from './support/env.js';
import { codexAppendLine, liveAppendLine } from './support/seed.js';

function sessionUrl(sessionId: string): string {
  return `/#/projects/${E2E_PROJECT_ID}/sessions/${sessionId}`;
}

async function appendLive(n: number): Promise<void> {
  await appendFile(sessionFilePath(SESSION_LIVE), JSON.stringify(liveAppendLine(n)) + '\n', 'utf8');
}

test('SPEC-LIVE-030: セッション分析画面を開いた状態で JSONL に追記すると、リロードなしで新しいメッセージが会話の末尾に現れる', async ({
  page,
}) => {
  await page.goto(sessionUrl(SESSION_LIVE));
  await expect(page.getByText('初期状態の応答。')).toBeVisible();

  await appendLive(1);
  await expect(page.getByText('ライブ追記メッセージ 1')).toBeVisible({ timeout: 15_000 });
});

test('SPEC-LIVE-031: 追記に合わせてヘッダの総トークンが増える', async ({ page }) => {
  await page.goto(sessionUrl(SESSION_LIVE));
  const head = page.locator('.chathead');
  await expect(head).toContainText('合計');
  const before = await head.textContent();

  await appendLive(2);
  await expect(page.getByText('ライブ追記メッセージ 2')).toBeVisible({ timeout: 15_000 });
  const after = await head.textContent();
  expect(after).not.toBe(before);
});

test('SPEC-LIVE-032: 別セッションを開いた状態では、他セッションへの追記で表示中の会話が変わらない', async ({
  page,
}) => {
  await page.goto(sessionUrl(SESSION_MAIN));
  await expect(page.getByText('E2E 用の依頼文。', { exact: false })).toBeVisible();

  await appendLive(3);
  // 反映されないことの検証: SSE が届く猶予を置いてから不在を確認する
  await page.waitForTimeout(3_000);
  await expect(page.getByText('ライブ追記メッセージ 3')).toHaveCount(0);
  await expect(page.getByText('E2E 用の依頼文。', { exact: false })).toBeVisible();
});

/* ---- Codex ライブ更新（Issue #31・SPEC-LIVE-050〜051） ---- */

async function appendCodex(n: number): Promise<void> {
  await appendFile(codexFilePath(), JSON.stringify(codexAppendLine(n)) + '\n', 'utf8');
}

function codexSessionUrl(): string {
  return `/#/projects/${codexDayId()}/sessions/${encodeURIComponent(SESSION_CODEX)}`;
}

test('SPEC-LIVE-050: Codex 合成 rollout のセッション分析画面を開いた状態で追記すると、リロードなしで新しいメッセージが末尾に現れる', async ({
  page,
}) => {
  await page.goto(codexSessionUrl());
  await expect(page.getByText('Codex 初期応答。')).toBeVisible();

  await appendCodex(1);
  await expect(page.getByText('Codex ライブ追記 1')).toBeVisible({ timeout: 15_000 });
});

test('SPEC-LIVE-051: 別セッションを開いた状態では、Codex rollout への追記で表示中の会話が変わらない', async ({
  page,
}) => {
  await page.goto(sessionUrl(SESSION_MAIN));
  await expect(page.getByText('E2E 用の依頼文。', { exact: false })).toBeVisible();

  await appendCodex(2);
  await page.waitForTimeout(3_000);
  await expect(page.getByText('Codex ライブ追記 2')).toHaveCount(0);
  await expect(page.getByText('E2E 用の依頼文。', { exact: false })).toBeVisible();
});
