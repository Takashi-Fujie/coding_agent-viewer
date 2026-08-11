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

/* ---- 差分追記描画（Issue #33・SPEC-LIVE-066〜068） ---- */

test('SPEC-LIVE-066: 追記前に目印を付けた表示済みメッセージの DOM 要素が追記後も同一で、新着分だけが末尾に現れる', async ({
  page,
}) => {
  await page.goto(sessionUrl(SESSION_LIVE));
  // 本文の遅延取得が完了した要素を対象にする（プレビュー → 本文の置き換えは正規の挙動）
  const shown = page.locator('.msg .text:not(.preview)', { hasText: '初期状態の応答。' });
  await expect(shown).toBeVisible();
  // DOM ノードに目印を付ける。要素が作り直されると（新しいノードになると）消える
  await shown.evaluate((el) => {
    (el as HTMLElement & { __e2eMark?: boolean }).__e2eMark = true;
  });

  await appendLive(4);
  await expect(page.getByText('ライブ追記メッセージ 4')).toBeVisible({ timeout: 15_000 });

  await expect(shown).toBeVisible();
  expect(
    await shown.evaluate((el) => (el as HTMLElement & { __e2eMark?: boolean }).__e2eMark === true),
  ).toBe(true);
});

test('SPEC-LIVE-067: 追記の前後で、取得済み本文範囲への再リクエストが発生しない', async ({
  page,
}) => {
  const bodyRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/messages?')) bodyRequests.push(new URL(req.url()).search);
  });

  await page.goto(sessionUrl(SESSION_LIVE));
  await expect(page.getByText('初期状態の応答。')).toBeVisible();
  const beforeCount = bodyRequests.length;
  const fetchedStarts = new Set(bodyRequests.map((s) => new URLSearchParams(s).get('start')));

  await appendLive(5);
  await expect(page.getByText('ライブ追記メッセージ 5')).toBeVisible({ timeout: 15_000 });

  // 追記後の本文リクエストは新着分（未取得の start）だけで、取得済み範囲を再要求しない
  const afterAppend = bodyRequests.slice(beforeCount);
  expect(afterAppend.length).toBeGreaterThan(0);
  for (const search of afterAppend) {
    expect(fetchedStarts.has(new URLSearchParams(search).get('start'))).toBe(false);
  }
});

test('SPEC-LIVE-068: 会話の途中へスクロールした状態で追記が来ても、スクロール位置が変わらない', async ({
  page,
}) => {
  // メッセージ 2 件でも縦スクロールが発生するようビューポートを低くする
  await page.setViewportSize({ width: 1280, height: 360 });
  await page.goto(sessionUrl(SESSION_LIVE));
  await expect(page.getByText('初期状態の応答。')).toBeVisible();

  // このアプリのスクローラは window ではなく .appmain（.app が 100vh 固定）
  const scroller = page.locator('main.appmain');
  await scroller.evaluate((el) => el.scrollTo(0, 200));
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(200);

  await appendLive(6);
  await expect(page.getByText('ライブ追記メッセージ 6')).toBeVisible({ timeout: 15_000 });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(200);
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
