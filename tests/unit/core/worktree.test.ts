/**
 * SPEC-CORE-080〜084: cwd から git の正式な仕組みで本体リポジトリを解決する。
 * 仕様は docs/design/CORE.md「worktree セッションの本体統合（Issue #41）」。
 *
 * worktree の実構造（.git ファイル + gitdir 行、管理 dir の commondir）を
 * 一時ディレクトリに手組みして検証する（実 git worktree コマンドに依存しない）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRepo } from '../../../server/core/worktree.js';
import { createClaudeSource } from '../../../server/sources/claude.js';
import { createCodexSource } from '../../../server/sources/codex.js';
import { loadSnapshot } from '../../../server/store.js';
import { projectPath } from '../../../server/routes/overview.js';
import { withTempDir, writeJsonl } from '../../helpers/fixtures.js';

/**
 * 本体リポジトリ + worktree の実配置を組み立てる。
 * <root>/main/.git/（ディレクトリ・worktrees/<name>/commondir 入り）
 * <root>/main/.claude/worktrees/<name>/.git（gitdir: 行のファイル）
 */
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

describe('resolveRepo', () => {
  it('SPEC-CORE-080: .git ファイルの gitdir と commondir を解決して本体ルートと worktree 名を得る', async () => {
    await withTempDir(async (root) => {
      const { mainRoot, worktreeRoot } = await buildWorktreeTree(root);
      expect(await resolveRepo(worktreeRoot)).toEqual({ root: mainRoot, worktree: 'wt-sample' });

      // worktree 内のサブディレクトリ起動でも上へ辿って同じ結果になる
      const sub = join(worktreeRoot, 'src', 'deep');
      await mkdir(sub, { recursive: true });
      expect(await resolveRepo(sub)).toEqual({ root: mainRoot, worktree: 'wt-sample' });
    });
  });

  it('SPEC-CORE-081: commondir の相対パスは管理ディレクトリ基準で解決する', async () => {
    await withTempDir(async (root) => {
      // commondir を既定の ../.. ではなく、管理 dir 基準の別表現で書いても同じ本体に解決される
      const { mainRoot, worktreeRoot } = await buildWorktreeTree(root, 'wt-rel');
      const adminDir = join(mainRoot, '.git', 'worktrees', 'wt-rel');
      await writeFile(join(adminDir, 'commondir'), '../../../.git\n', 'utf8');
      expect(await resolveRepo(worktreeRoot)).toEqual({ root: mainRoot, worktree: 'wt-rel' });
    });
  });

  it('SPEC-CORE-082: cwd が実在しないとき実在する祖先から .git を探して本体ルートを得る', async () => {
    await withTempDir(async (root) => {
      const { mainRoot } = await buildWorktreeTree(root, 'wt-alive');
      // 削除済み worktree: ディレクトリを作らない（.claude/worktrees までは実在する）
      const gone = join(mainRoot, '.claude', 'worktrees', 'wt-gone');
      expect(await resolveRepo(gone)).toEqual({ root: mainRoot, worktree: 'wt-gone' });

      // 深い階層ごと消えていても同様に本体へ到達する
      const goneDeep = join(mainRoot, '.claude', 'worktrees', 'wt-gone2', 'src');
      expect(await resolveRepo(goneDeep)).toEqual({ root: mainRoot, worktree: 'src' });
    });
  });

  it('SPEC-CORE-083: .git がディレクトリ（通常リポジトリ）の cwd は統合対象にしない', async () => {
    await withTempDir(async (root) => {
      const { mainRoot } = await buildWorktreeTree(root);
      expect(await resolveRepo(mainRoot)).toEqual({ root: mainRoot, worktree: null });

      // リポジトリ内サブディレクトリ起動も worktree ではないため統合しない
      const sub = join(mainRoot, 'packages', 'sub');
      await mkdir(sub, { recursive: true });
      expect(await resolveRepo(sub)).toEqual({ root: mainRoot, worktree: null });
    });
  });

  it('SPEC-CORE-084: どの祖先にも .git が無い cwd は解決不能として null を返す', async () => {
    await withTempDir(async (root) => {
      const plain = join(root, 'plain-project');
      await mkdir(plain, { recursive: true });
      expect(await resolveRepo(plain)).toBeNull();

      // 実在しない cwd でも祖先に .git が無ければ null
      expect(await resolveRepo(join(root, 'no-such-dir'))).toBeNull();
    });
  });
});

const SESSION_MAIN = 's0000000-0000-4000-8000-000000000011';
const SESSION_WT = 's0000000-0000-4000-8000-000000000012';
const SESSION_PLAIN = 's0000000-0000-4000-8000-000000000013';

function userLine(uuid: string, cwd: string, timestamp: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    cwd,
    timestamp,
    message: { role: 'user', content: '<synthetic> 依頼文' },
  };
}

/**
 * worktree 実配置 + Claude ログディレクトリを組み立てる。
 * proj-main（cwd = 本体）/ proj-wt（cwd = worktree）/ proj-plain（cwd = .git なし）。
 * worktree セッションの方が最終更新が新しい（SPEC-CORE-088 の表示パス揺れの再現条件）。
 */
async function buildMergeTree(root: string, options?: { withMainProject?: boolean }) {
  const { mainRoot, worktreeRoot } = await buildWorktreeTree(root);
  const plainDir = join(root, 'plain-project');
  await mkdir(plainDir, { recursive: true });

  const logDir = join(root, 'projects');
  if (options?.withMainProject !== false) {
    await mkdir(join(logDir, 'proj-main'), { recursive: true });
    await writeJsonl(join(logDir, 'proj-main', `${SESSION_MAIN}.jsonl`), [
      userLine('u-m1', mainRoot, '2026-01-02T00:00:00.000Z'),
    ]);
  }
  await mkdir(join(logDir, 'proj-wt'), { recursive: true });
  await writeJsonl(join(logDir, 'proj-wt', `${SESSION_WT}.jsonl`), [
    userLine('u-w1', worktreeRoot, '2026-01-03T00:00:00.000Z'),
  ]);
  await mkdir(join(logDir, 'proj-plain'), { recursive: true });
  await writeJsonl(join(logDir, 'proj-plain', `${SESSION_PLAIN}.jsonl`), [
    userLine('u-p1', plainDir, '2026-01-01T00:00:00.000Z'),
  ]);
  return { mainRoot, worktreeRoot, logDir, cacheDir: join(root, 'cache') };
}

describe('loadSnapshot の worktree 併合', () => {
  it('SPEC-CORE-085: 本体ルートが同じ claude プロジェクトは本体の従来 id に併合される', async () => {
    await withTempDir(async (root) => {
      const { logDir, cacheDir } = await buildMergeTree(root);
      const snapshot = await loadSnapshot({ sources: [createClaudeSource({ logDir })], cacheDir });

      const merged = snapshot.projects.find((p) => p.id === 'proj-main');
      expect(merged?.sessions.map((s) => s.id).sort()).toEqual([SESSION_MAIN, SESSION_WT]);
      expect(snapshot.sessionsById.get(SESSION_WT)?.projectId).toBe('proj-main');
      // 統合対象でないプロジェクトは従来のまま
      expect(snapshot.projects.find((p) => p.id === 'proj-plain')?.sessions).toHaveLength(1);
    });
  });

  it('SPEC-CORE-086: 本体プロジェクトが無ければ本体ルートから同形式の id を合成して併合する', async () => {
    await withTempDir(async (root) => {
      const { mainRoot, logDir, cacheDir } = await buildMergeTree(root, {
        withMainProject: false,
      });
      const snapshot = await loadSnapshot({ sources: [createClaudeSource({ logDir })], cacheDir });

      const synthesized = mainRoot.replace(/[^A-Za-z0-9]/g, '-');
      const merged = snapshot.projects.find((p) => p.id === synthesized);
      expect(merged?.sessions.map((s) => s.id)).toEqual([SESSION_WT]);
      expect(snapshot.projects.some((p) => p.id === 'proj-wt')).toBe(false);
    });
  });

  it('SPEC-CORE-087: 併合後のセッションは worktree ラベルを持ち、本体セッションは null を持つ', async () => {
    await withTempDir(async (root) => {
      const { logDir, cacheDir } = await buildMergeTree(root);
      const snapshot = await loadSnapshot({ sources: [createClaudeSource({ logDir })], cacheDir });

      expect(snapshot.sessionsById.get(SESSION_WT)?.worktree).toBe('wt-sample');
      expect(snapshot.sessionsById.get(SESSION_MAIN)?.worktree).toBeNull();
      expect(snapshot.sessionsById.get(SESSION_PLAIN)?.worktree).toBeNull();
    });
  });

  it('SPEC-CORE-088: 併合後の表示パスは worktree セッションが最新でも本体ルートになる', async () => {
    await withTempDir(async (root) => {
      const { mainRoot, logDir, cacheDir } = await buildMergeTree(root);
      const snapshot = await loadSnapshot({ sources: [createClaudeSource({ logDir })], cacheDir });

      const merged = snapshot.projects.find((p) => p.id === 'proj-main');
      expect(merged).toBeDefined();
      expect(merged && projectPath(merged)).toBe(mainRoot);
    });
  });

  it('SPEC-CORE-089: 旧 worktree グループの id は projects 一覧に現れない', async () => {
    await withTempDir(async (root) => {
      const { logDir, cacheDir } = await buildMergeTree(root);
      const snapshot = await loadSnapshot({ sources: [createClaudeSource({ logDir })], cacheDir });
      expect(snapshot.projects.some((p) => p.id === 'proj-wt')).toBe(false);
    });
  });

  it('SPEC-CORE-090: Codex ソースのグループは併合対象にしない', async () => {
    await withTempDir(async (root) => {
      const { worktreeRoot } = await buildWorktreeTree(root);
      const sessionsDir = join(root, 'sessions');
      const rollout = 'rollout-2026-08-08T10-00-00-00000000-0000-7000-8000-000000000001.jsonl';
      await mkdir(join(sessionsDir, '2026', '08', '08'), { recursive: true });
      // cwd が worktree を指していても、日付グループのまま併合されない
      await writeJsonl(join(sessionsDir, '2026', '08', '08', rollout), [
        {
          timestamp: '2026-08-08T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: '<synthetic>', cwd: worktreeRoot },
        },
      ]);
      const snapshot = await loadSnapshot({
        sources: [createCodexSource({ sessionsDir })],
        cacheDir: join(root, 'cache'),
      });
      expect(snapshot.projects.map((p) => p.id)).toEqual(['2026-08-08']);
    });
  });
});
