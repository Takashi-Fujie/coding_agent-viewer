/**
 * SPEC-CODEX-100〜105 / 107: Codex セッションのプロジェクト（cwd）グルーピング（Issue #45）。
 * 仕様は docs/design/CODEX.md「セッションのプロジェクト（cwd）グルーピング」。
 *
 * 発見層（日付グループ）は変更せず、store 層が summary.cwd で再グルーピングする。
 * worktree 併合（SPEC-CORE-090 改定）の codex 適用もここで検証する。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../server/app.js';
import { createClaudeSource } from '../../../server/sources/claude.js';
import { createCodexSource } from '../../../server/sources/codex.js';
import { loadSnapshot } from '../../../server/store.js';
import { withTempDir, writeJsonl } from '../../helpers/fixtures.js';

/** cwd 縮約 + `codex:` 接頭辞のグループ id（claude の縮約形式と衝突しないための規約）。 */
const codexGroupId = (cwd: string): string => `codex:${cwd.replace(/[^A-Za-z0-9]/g, '-')}`;

let seq = 0;

/** session_meta（cwd 付き / 無し）+ 実ユーザー入力 1 行の最小 rollout。 */
function rolloutLines(cwd: string | null): unknown[] {
  const lines: unknown[] = [];
  if (cwd !== null) {
    lines.push({
      timestamp: '2026-08-08T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '<synthetic>', cwd, cli_version: '0.147.0' },
    });
  }
  lines.push({
    timestamp: '2026-08-08T00:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<synthetic> 依頼文' }] },
  });
  return lines;
}

/** 日付ディレクトリ `YYYY/MM/DD` に rollout を 1 本置き、セッション id を返す。 */
async function writeRollout(sessionsDir: string, day: string, cwd: string | null): Promise<string> {
  seq += 1;
  const name = `rollout-2026-08-08T00-00-00-00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
  const dir = join(sessionsDir, ...day.split('/'));
  await mkdir(dir, { recursive: true });
  await writeJsonl(join(dir, `${name}.jsonl`), rolloutLines(cwd));
  return `codex:${name}`;
}

/** 本体リポジトリ + worktree の実配置（tests/unit/core/worktree.test.ts と同じ手組み）。 */
async function buildWorktreeTree(
  root: string,
  name = 'wt-sample',
): Promise<{ mainRoot: string; worktreeRoot: string }> {
  const mainRoot = join(root, 'main');
  const adminDir = join(mainRoot, '.git', 'worktrees', name);
  const worktreeRoot = join(mainRoot, '.claude', 'worktrees', name);
  await mkdir(adminDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(worktreeRoot, '.git'), `gitdir: ${adminDir}\n`, 'utf8');
  await writeFile(join(adminDir, 'commondir'), '../..\n', 'utf8');
  return { mainRoot, worktreeRoot };
}

async function snapshotOf(root: string, sessionsDir: string) {
  return loadSnapshot({
    sources: [createCodexSource({ sessionsDir })],
    cacheDir: join(root, 'cache'),
  });
}

describe('Codex セッションの cwd グルーピング', () => {
  it('SPEC-CODEX-100: codex セッションは summary.cwd 単位のグループに再編され、グループ id は codex: + cwd の非英数字 - 置換になる', async () => {
    await withTempDir(async (root) => {
      const sessionsDir = join(root, 'sessions');
      const cwdA = join(root, 'proj-a');
      const cwdB = join(root, 'proj-b');
      const sessionA = await writeRollout(sessionsDir, '2026/08/08', cwdA);
      const sessionB = await writeRollout(sessionsDir, '2026/08/08', cwdB);

      const snapshot = await snapshotOf(root, sessionsDir);
      const groupA = snapshot.projects.find((p) => p.id === codexGroupId(cwdA));
      const groupB = snapshot.projects.find((p) => p.id === codexGroupId(cwdB));
      expect(groupA?.sessions.map((s) => s.id)).toEqual([sessionA]);
      expect(groupB?.sessions.map((s) => s.id)).toEqual([sessionB]);
      expect(groupA?.sourceId).toBe('codex');
      expect(snapshot.sessionsById.get(sessionA)?.projectId).toBe(codexGroupId(cwdA));
    });
  });

  it('SPEC-CODEX-101: 別の日付ディレクトリにある同一 cwd のセッションが 1 グループにまとまり、codex グループの並びは id 昇順になる', async () => {
    await withTempDir(async (root) => {
      const sessionsDir = join(root, 'sessions');
      const cwdB = join(root, 'proj-b');
      const cwdA = join(root, 'proj-a');
      // 発見順（日付順）では B が先。再グルーピング後は id 昇順で A が先になる
      const day1 = await writeRollout(sessionsDir, '2026/08/07', cwdB);
      const day2 = await writeRollout(sessionsDir, '2026/08/08', cwdA);
      const day3 = await writeRollout(sessionsDir, '2026/08/09', cwdB);

      const snapshot = await snapshotOf(root, sessionsDir);
      const merged = snapshot.projects.find((p) => p.id === codexGroupId(cwdB));
      expect(merged?.sessions.map((s) => s.id).sort()).toEqual([day1, day3].sort());
      expect(snapshot.projects.map((p) => p.id)).toEqual([codexGroupId(cwdA), codexGroupId(cwdB)]);
      expect(snapshot.projects.find((p) => p.id === codexGroupId(cwdA))?.sessions.map((s) => s.id)).toEqual([day2]);
    });
  });

  it('SPEC-CODEX-102: summary.cwd の無いセッションは元の日付グループに残って表示され続ける', async () => {
    await withTempDir(async (root) => {
      const sessionsDir = join(root, 'sessions');
      const cwdA = join(root, 'proj-a');
      await writeRollout(sessionsDir, '2026/08/08', cwdA);
      const noCwd = await writeRollout(sessionsDir, '2026/08/08', null);

      const snapshot = await snapshotOf(root, sessionsDir);
      const dateGroup = snapshot.projects.find((p) => p.id === '2026-08-08');
      expect(dateGroup?.sessions.map((s) => s.id)).toEqual([noCwd]);
      expect(snapshot.sessionsById.get(noCwd)?.projectId).toBe('2026-08-08');
    });
  });

  it('SPEC-CODEX-103: cwd を持つセッションが抜けた旧日付グループの id は一覧に現れず、/api/projects/:id は 404 になる', async () => {
    await withTempDir(async (root) => {
      const sessionsDir = join(root, 'sessions');
      const cwdA = join(root, 'proj-a');
      await writeRollout(sessionsDir, '2026/08/08', cwdA);

      const snapshot = await snapshotOf(root, sessionsDir);
      expect(snapshot.projects.some((p) => p.id === '2026-08-08')).toBe(false);

      const logDir = join(root, 'projects');
      await mkdir(logDir, { recursive: true });
      const app = createApp({
        logDir,
        cacheDir: join(root, 'cache-api'),
        claudeDir: join(root, 'claude-home'),
        codexSessionsDir: sessionsDir,
      });
      const gone = await request(app).get('/api/projects/2026-08-08');
      expect(gone.status).toBe(404);
      const alive = await request(app).get(`/api/projects/${encodeURIComponent(codexGroupId(cwdA))}`);
      expect(alive.status).toBe(200);
    });
  });
});

describe('worktree 併合の codex 適用（SPEC-CORE-090 改定）', () => {
  it('SPEC-CODEX-104: cwd が worktree のセッションは本体ルートの codex グループへ併合され、worktree ラベルが付く', async () => {
    await withTempDir(async (root) => {
      const { mainRoot, worktreeRoot } = await buildWorktreeTree(root);
      const sessionsDir = join(root, 'sessions');
      const mainSession = await writeRollout(sessionsDir, '2026/08/08', mainRoot);
      const wtSession = await writeRollout(sessionsDir, '2026/08/09', worktreeRoot);

      const snapshot = await snapshotOf(root, sessionsDir);
      const merged = snapshot.projects.find((p) => p.id === codexGroupId(mainRoot));
      expect(merged?.sessions.map((s) => s.id).sort()).toEqual([mainSession, wtSession].sort());
      expect(snapshot.sessionsById.get(wtSession)?.worktree).toBe('wt-sample');
      expect(snapshot.sessionsById.get(mainSession)?.worktree).toBeNull();
      expect(snapshot.projects.some((p) => p.id === codexGroupId(worktreeRoot))).toBe(false);
    });
  });

  it('SPEC-CODEX-105: worktree 併合で本体グループが無い場合は codex: 接頭辞付きの合成 id になり、同じ本体ルートの claude グループとは併合されない', async () => {
    await withTempDir(async (root) => {
      const { mainRoot, worktreeRoot } = await buildWorktreeTree(root);
      const sessionsDir = join(root, 'sessions');
      const wtSession = await writeRollout(sessionsDir, '2026/08/08', worktreeRoot);

      // 同じ本体ルートで claude セッションも存在する（本体 cwd）
      const logDir = join(root, 'projects');
      await mkdir(join(logDir, 'proj-main'), { recursive: true });
      await writeJsonl(join(logDir, 'proj-main', 's0000000-0000-4000-8000-000000000045.jsonl'), [
        {
          type: 'user',
          uuid: 'u-m1',
          cwd: mainRoot,
          timestamp: '2026-01-02T00:00:00.000Z',
          message: { role: 'user', content: '<synthetic> 依頼文' },
        },
      ]);

      const snapshot = await loadSnapshot({
        sources: [createClaudeSource({ logDir }), createCodexSource({ sessionsDir })],
        cacheDir: join(root, 'cache'),
      });

      // codex は codex: 接頭辞の合成 id に併合される（claude の proj-main へは行かない）
      const synthesized = snapshot.projects.find((p) => p.id === codexGroupId(mainRoot));
      expect(synthesized?.sourceId).toBe('codex');
      expect(synthesized?.sessions.map((s) => s.id)).toEqual([wtSession]);
      expect(snapshot.sessionsById.get(wtSession)?.worktree).toBe('wt-sample');
      const claudeMain = snapshot.projects.find((p) => p.id === 'proj-main');
      expect(claudeMain?.sessions.map((s) => s.id)).toEqual(['s0000000-0000-4000-8000-000000000045']);
    });
  });
});

describe('Claude 既存挙動の維持', () => {
  it('SPEC-CODEX-107: claude ソースの一覧・グルーピング・集計は従来と一致する（既存テスト不変）', async () => {
    await withTempDir(async (root) => {
      const logDir = join(root, 'projects');
      await mkdir(join(logDir, 'proj-plain'), { recursive: true });
      await writeJsonl(join(logDir, 'proj-plain', 's0000000-0000-4000-8000-000000000046.jsonl'), [
        {
          type: 'user',
          uuid: 'u-p1',
          cwd: join(root, 'plain-project'),
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: '<synthetic> 依頼文' },
        },
      ]);
      const sessionsDir = join(root, 'sessions');
      await writeRollout(sessionsDir, '2026/08/08', join(root, 'proj-a'));

      const claudeOnly = await loadSnapshot({
        sources: [createClaudeSource({ logDir })],
        cacheDir: join(root, 'cache-claude'),
      });
      const mixed = await loadSnapshot({
        sources: [createClaudeSource({ logDir }), createCodexSource({ sessionsDir })],
        cacheDir: join(root, 'cache-mixed'),
      });

      // codex ソースを足しても claude グループの id・構成・順序は変わらない
      const claudeGroups = (p: { sourceId: string }): boolean => p.sourceId === 'claude';
      expect(mixed.projects.filter(claudeGroups).map((p) => p.id)).toEqual(
        claudeOnly.projects.map((p) => p.id),
      );
      expect(mixed.projects.filter(claudeGroups).flatMap((p) => p.sessions.map((s) => s.id))).toEqual(
        claudeOnly.projects.flatMap((p) => p.sessions.map((s) => s.id)),
      );
    });
  });
});
