/**
 * SPEC-CORE-091〜096 / SPEC-DASH-110〜112: 同一プロジェクトの Claude / Codex 表示統合（Issue #49）。
 * 仕様は docs/design/CORE.md「同一プロジェクトの Claude / Codex 表示統合」と docs/design/DASH.md の同名セクション。
 *
 * グループ id をソース中立（接頭辞なしのパス縮約）にし、同一 id の Claude / Codex グループを
 * API 層で 1 プロジェクトに束ねる。内部データはソース別グループのまま（1 グループ 1 ソース維持）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../server/app.js';
import { createClaudeSource } from '../../../server/sources/claude.js';
import { createCodexSource } from '../../../server/sources/codex.js';
import { loadSnapshot } from '../../../server/store.js';
import { assistantLine, withTempDir, writeJsonl } from '../../helpers/fixtures.js';

/** ソース中立のグループ id（cwd の非英数字 `-` 置換。claude の実ディレクトリ名と同値）。 */
const groupIdOf = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** 両ソースで共用する合成 cwd。claude 側のプロジェクトディレクトリ名は縮約形と同値にする。 */
const SHARED_CWD = '/home/dev/shared-project';
const SHARED_ID = groupIdOf(SHARED_CWD);
const CODEX_ONLY_CWD = '/home/user/codex-only-project';
const CODEX_ONLY_ID = groupIdOf(CODEX_ONLY_CWD);
const EMPTY_CLAUDE_ID = '-home-dev-empty-project';

const SESSION_CLAUDE = 's0000000-0000-4000-8000-0000000000d1';
const ROLLOUT_SHARED = 'rollout-2026-02-02T00-00-00-00000000-0000-7000-8000-0000000000e1';
const ROLLOUT_ONLY = 'rollout-2026-02-03T00-00-00-00000000-0000-7000-8000-0000000000e2';
const ROLLOUT_NO_CWD = 'rollout-2026-02-04T00-00-00-00000000-0000-7000-8000-0000000000e3';
const SESSION_CODEX_SHARED = `codex:${ROLLOUT_SHARED}`;

function claudeLines(cwd: string): unknown[] {
  return [
    {
      type: 'user',
      uuid: 'u-x1',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: SESSION_CLAUDE,
      cwd,
      message: { role: 'user', content: '<synthetic> 依頼文' },
    },
    assistantLine({ uuid: 'a-x1', timestamp: '2026-01-01T00:00:01.000Z' }),
  ];
}

/** session_meta（cwd 付き / 無し）+ 実ユーザー入力の最小 rollout（usage 無し = 未集計）。 */
function codexLines(cwd: string | null, day: string): unknown[] {
  const lines: unknown[] = [];
  if (cwd !== null) {
    lines.push({
      timestamp: `${day}T00:00:00.000Z`,
      type: 'session_meta',
      payload: { id: '<synthetic>', cwd, cli_version: '0.147.0' },
    });
  }
  lines.push({
    timestamp: `${day}T00:00:01.000Z`,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<synthetic> 依頼文' }] },
  });
  return lines;
}

let root: string;
let app: Express;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ccv-cross-'));
  const logDir = join(root, 'projects');
  const codexDir = join(root, 'codex-sessions');

  // claude: 共有 cwd のセッション + セッション 0 件の空プロジェクト
  await mkdir(join(logDir, SHARED_ID), { recursive: true });
  await writeJsonl(join(logDir, SHARED_ID, `${SESSION_CLAUDE}.jsonl`), claudeLines(SHARED_CWD));
  await mkdir(join(logDir, EMPTY_CLAUDE_ID), { recursive: true });

  // codex: 共有 cwd / codex 単独 cwd / cwd 無し（日付フォールバック）
  await mkdir(join(codexDir, '2026', '02', '02'), { recursive: true });
  await writeJsonl(join(codexDir, '2026', '02', '02', `${ROLLOUT_SHARED}.jsonl`), codexLines(SHARED_CWD, '2026-02-02'));
  await mkdir(join(codexDir, '2026', '02', '03'), { recursive: true });
  await writeJsonl(join(codexDir, '2026', '02', '03', `${ROLLOUT_ONLY}.jsonl`), codexLines(CODEX_ONLY_CWD, '2026-02-03'));
  await mkdir(join(codexDir, '2026', '02', '04'), { recursive: true });
  await writeJsonl(join(codexDir, '2026', '02', '04', `${ROLLOUT_NO_CWD}.jsonl`), codexLines(null, '2026-02-04'));

  app = createApp({
    logDir,
    cacheDir: join(root, '.cache'),
    claudeDir: join(root, 'claude-home'),
    codexSessionsDir: codexDir,
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

type ProjectRow = { id: string; sources: string[]; sessionCount: number; records: number };

describe('グループ id のソース中立化（store 層）', () => {
  it('SPEC-CORE-091: codex の cwd グループ id は接頭辞なしのパス縮約になり、codex: 付き旧 id は 404 になる', async () => {
    const overview = await request(app).get('/api/overview');
    const ids = overview.body.projects.map((p: ProjectRow) => p.id);
    expect(ids).toContain(CODEX_ONLY_ID);
    expect(ids.some((id: string) => id.startsWith('codex:'))).toBe(false);

    const gone = await request(app).get(`/api/projects/${encodeURIComponent(`codex:${CODEX_ONLY_ID}`)}`);
    expect(gone.status).toBe(404);
    const alive = await request(app).get(`/api/projects/${CODEX_ONLY_ID}`);
    expect(alive.status).toBe(200);
  });

  it('SPEC-CORE-092: 同一 id の claude / codex グループは表示上 1 プロジェクトに束ねられ、内部はソース別グループのまま維持される', async () => {
    // 内部（snapshot）: 同一 id・別 sourceId の 2 グループ
    const snapshot = await loadSnapshot({
      sources: [
        createClaudeSource({ logDir: join(root, 'projects') }),
        createCodexSource({ sessionsDir: join(root, 'codex-sessions') }),
      ],
      cacheDir: join(root, '.cache-snap'),
    });
    const shared = snapshot.projects.filter((p) => p.id === SHARED_ID);
    expect(shared.map((p) => p.sourceId).sort()).toEqual(['claude', 'codex']);

    // 表示（API）: 1 行に統合され、行数は id 重複分だけ減る
    const overview = await request(app).get('/api/overview');
    const rows = overview.body.projects.filter((p: ProjectRow) => p.id === SHARED_ID);
    expect(rows).toHaveLength(1);
  });

  it('SPEC-CORE-093: source 指定時は選択ソースのグループを持つプロジェクトだけが残り、値は選択ソース分になる', async () => {
    const claude = await request(app).get('/api/overview').query({ source: 'claude' });
    const claudeIds = claude.body.projects.map((p: ProjectRow) => p.id);
    // 統合プロジェクトは行が残る（値は claude 分）。codex-only は消える。空 claude グループは残る
    expect(claudeIds).toContain(SHARED_ID);
    expect(claudeIds).not.toContain(CODEX_ONLY_ID);
    expect(claudeIds).toContain(EMPTY_CLAUDE_ID);
    const sharedClaude = claude.body.projects.find((p: ProjectRow) => p.id === SHARED_ID);
    expect(sharedClaude.sessionCount).toBe(1);

    const codex = await request(app).get('/api/overview').query({ source: 'codex' });
    const codexIds = codex.body.projects.map((p: ProjectRow) => p.id);
    expect(codexIds).toContain(SHARED_ID);
    expect(codexIds).toContain(CODEX_ONLY_ID);
    expect(codexIds).not.toContain(EMPTY_CLAUDE_ID);
    const sharedCodex = codex.body.projects.find((p: ProjectRow) => p.id === SHARED_ID);
    expect(sharedCodex.sessionCount).toBe(1);
    expect(sharedCodex.sources).toEqual(['codex']);
  });

  it('SPEC-CORE-094: cwd を持たない日付フォールバックグループは統合されず従来どおり単独で表示される', async () => {
    const overview = await request(app).get('/api/overview');
    const fallback = overview.body.projects.find((p: ProjectRow) => p.id === '2026-02-04');
    expect(fallback).toBeDefined();
    expect(fallback.sources).toEqual(['codex']);
    expect(fallback.sessionCount).toBe(1);
  });

  it('SPEC-CORE-095: worktree 併合の合成 id も接頭辞なしになり、ソースをまたぐ併合はされず表示層で束ねられる', async () => {
    await withTempDir(async (dir) => {
      // 本体リポジトリ + worktree の実配置（tests/unit/core/worktree.test.ts と同じ手組み）
      const mainRoot = join(dir, 'main');
      const adminDir = join(mainRoot, '.git', 'worktrees', 'wt-x');
      const worktreeRoot = join(mainRoot, '.claude', 'worktrees', 'wt-x');
      await mkdir(adminDir, { recursive: true });
      await mkdir(worktreeRoot, { recursive: true });
      await writeFile(join(worktreeRoot, '.git'), `gitdir: ${adminDir}\n`, 'utf8');
      await writeFile(join(adminDir, 'commondir'), '../..\n', 'utf8');

      // claude は本体 cwd のセッション、codex は worktree cwd のセッション（本体 codex グループ無し）
      const logDir = join(dir, 'projects');
      await mkdir(join(logDir, groupIdOf(mainRoot)), { recursive: true });
      await writeJsonl(join(logDir, groupIdOf(mainRoot), `${SESSION_CLAUDE}.jsonl`), claudeLines(mainRoot));
      const codexDir = join(dir, 'codex-sessions');
      await mkdir(join(codexDir, '2026', '02', '05'), { recursive: true });
      await writeJsonl(
        join(codexDir, '2026', '02', '05', `${ROLLOUT_ONLY}.jsonl`),
        codexLines(worktreeRoot, '2026-02-05'),
      );

      const snapshot = await loadSnapshot({
        sources: [createClaudeSource({ logDir }), createCodexSource({ sessionsDir: codexDir })],
        cacheDir: join(dir, '.cache'),
      });
      // 内部: 合成された codex グループは接頭辞なしの本体ルート縮約 id で、claude グループとは別エントリ
      const entries = snapshot.projects.filter((p) => p.id === groupIdOf(mainRoot));
      expect(entries.map((p) => p.sourceId).sort()).toEqual(['claude', 'codex']);
      const codexEntry = entries.find((p) => p.sourceId === 'codex');
      expect(codexEntry?.sessions[0]?.worktree).toBe('wt-x');

      // 表示: 1 行に統合される
      const wtApp = createApp({
        logDir,
        cacheDir: join(dir, '.cache-api'),
        claudeDir: join(dir, 'claude-home'),
        codexSessionsDir: codexDir,
      });
      const overview = await request(wtApp).get('/api/overview');
      const rows = overview.body.projects.filter((p: ProjectRow) => p.id === groupIdOf(mainRoot));
      expect(rows).toHaveLength(1);
      expect(rows[0].sources).toEqual(['claude', 'codex']);
    });
  });

  it('SPEC-CORE-096: claude ソース単独の環境では一覧・詳細・集計の id・値・並びが従来と一致する', async () => {
    await withTempDir(async (dir) => {
      const logDir = join(dir, 'projects');
      await mkdir(join(logDir, SHARED_ID), { recursive: true });
      await writeJsonl(join(logDir, SHARED_ID, `${SESSION_CLAUDE}.jsonl`), claudeLines(SHARED_CWD));
      const claudeApp = createApp({
        logDir,
        cacheDir: join(dir, '.cache'),
        claudeDir: join(dir, 'claude-home'),
      });

      const overview = await request(claudeApp).get('/api/overview');
      expect(overview.body.projects.map((p: ProjectRow) => p.id)).toEqual([SHARED_ID]);
      expect(overview.body.projects[0].sources).toEqual(['claude']);
      expect(overview.body.totals.sessions).toBe(1);
      // トークン合計は従来と同じ（assistantLine の usage: 10+20+30+40）
      expect(overview.body.projects[0].totalTokens).toBe(100);

      const detail = await request(claudeApp).get(`/api/projects/${SHARED_ID}`);
      expect(detail.status).toBe(200);
      expect(detail.body.sessions.map((s: { id: string }) => s.id)).toEqual([SESSION_CLAUDE]);
    });
  });
});

describe('統合プロジェクトの API（SPEC-DASH-110〜112）', () => {
  it('SPEC-DASH-110: 統合行は sources に両ソースを含み、セッション数・トークン・records・lastTimestamp が合算になる', async () => {
    const overview = await request(app).get('/api/overview');
    const row = overview.body.projects.find((p: ProjectRow) => p.id === SHARED_ID);
    expect(row.sources).toEqual(['claude', 'codex']);
    expect(row.sessionCount).toBe(2);
    // claude 分のトークン（codex は未集計 0）+ 両ソースのレコード
    expect(row.totalTokens).toBe(100);
    const claudeOnly = await request(app).get('/api/overview').query({ source: 'claude' });
    const claudeRow = claudeOnly.body.projects.find((p: ProjectRow) => p.id === SHARED_ID);
    expect(row.records).toBeGreaterThan(claudeRow.records);
    // lastTimestamp は両ソースの最大（codex 側 2026-02-02 が claude 側 2026-01-01 より新しい）
    expect(row.lastTimestamp?.startsWith('2026-02-02')).toBe(true);
  });

  it('SPEC-DASH-111: /api/projects/:id は統合 id で両ソースのセッションと範囲フィルタ後の bySource 内訳を返す', async () => {
    const detail = await request(app).get(`/api/projects/${SHARED_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sources).toEqual(['claude', 'codex']);
    expect(detail.body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(
      [SESSION_CLAUDE, SESSION_CODEX_SHARED].sort(),
    );
    // セッション行の source は単数のまま（行単位のソース識別）
    const rowSources = new Map(
      detail.body.sessions.map((s: { id: string; source: string }) => [s.id, s.source]),
    );
    expect(rowSources.get(SESSION_CLAUDE)).toBe('claude');
    expect(rowSources.get(SESSION_CODEX_SHARED)).toBe('codex');

    const bySource = new Map(
      detail.body.bySource.map((b: { source: string }) => [b.source, b]),
    );
    expect((bySource.get('claude') as { sessions: number }).sessions).toBe(1);
    expect((bySource.get('claude') as { totalTokens: number }).totalTokens).toBe(100);
    expect((bySource.get('codex') as { sessions: number }).sessions).toBe(1);
    expect((bySource.get('codex') as { totalTokens: number }).totalTokens).toBe(0);

    // 範囲フィルタ後の内訳: codex の活動日に絞ると claude 側の records は 0 になる
    const day = await request(app).get(`/api/projects/${SHARED_ID}`).query({ from: '2026-02-02', to: '2026-02-02' });
    const dayBySource = new Map(
      day.body.bySource.map((b: { source: string }) => [b.source, b]),
    );
    expect((dayBySource.get('claude') as { records: number }).records).toBe(0);
    expect((dayBySource.get('codex') as { records: number }).records).toBeGreaterThan(0);
  });

  it('SPEC-DASH-112: source クエリ指定時、統合プロジェクトの詳細は選択ソースのセッション・集計だけになり id は変わらない', async () => {
    const codexView = await request(app).get(`/api/projects/${SHARED_ID}`).query({ source: 'codex' });
    expect(codexView.status).toBe(200);
    expect(codexView.body.id).toBe(SHARED_ID);
    expect(codexView.body.sources).toEqual(['codex']);
    expect(codexView.body.sessions.map((s: { id: string }) => s.id)).toEqual([SESSION_CODEX_SHARED]);

    const claudeView = await request(app).get(`/api/projects/${SHARED_ID}`).query({ source: 'claude' });
    expect(claudeView.body.sessions.map((s: { id: string }) => s.id)).toEqual([SESSION_CLAUDE]);
  });
});
