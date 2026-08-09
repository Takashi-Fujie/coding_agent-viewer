/**
 * SPEC-CORE-070〜079: ログソース抽象とセッション発見。仕様は docs/design/CORE.md。
 *
 * 発見のテストは一時ディレクトリに実命名規約どおりのツリーを組み立てて行う
 * （tests/fixtures/codex/ は中身の契約用フィクスチャであり、ここでは使わない）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../server/app.js';
import { createClaudeSource } from '../../../server/sources/claude.js';
import { createCodexSource } from '../../../server/sources/codex.js';
import { loadSnapshot } from '../../../server/store.js';
import type { LogSource } from '../../../server/sources/types.js';
import { withTempDir, writeJsonl } from '../../helpers/fixtures.js';

const SESSION_A = 's0000000-0000-4000-8000-000000000001';
const SESSION_B = 's0000000-0000-4000-8000-000000000002';
const ROLLOUT_1 = 'rollout-2026-08-08T10-00-00-00000000-0000-7000-8000-000000000001.jsonl';
const ROLLOUT_2 = 'rollout-2026-08-09T09-30-00-00000000-0000-7000-8000-000000000002.jsonl';

/** Claude 形式の最小ログディレクトリ（プロジェクト 2 つ・subagent・空プロジェクト入り）を組み立てる。 */
async function buildClaudeTree(root: string): Promise<string> {
  const logDir = join(root, 'projects');
  await mkdir(join(logDir, '-home-user-project-a', 'subagents'), { recursive: true });
  await mkdir(join(logDir, '-home-user-project-b'), { recursive: true });
  await mkdir(join(logDir, '-home-user-project-empty', 'memory'), { recursive: true });
  await writeJsonl(join(logDir, '-home-user-project-a', `${SESSION_A}.jsonl`), [
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: '<synthetic> 依頼文' } },
  ]);
  await writeJsonl(join(logDir, '-home-user-project-a', 'subagents', 'agent-x.jsonl'), [
    { type: 'user', uuid: 'u-2', message: { role: 'user', content: '<synthetic> サブエージェント' } },
  ]);
  await writeJsonl(join(logDir, '-home-user-project-b', `${SESSION_B}.jsonl`), [
    { type: 'user', uuid: 'u-3', message: { role: 'user', content: '<synthetic> 依頼文' } },
  ]);
  return logDir;
}

/** Codex 形式の日付階層(2 日分)を組み立てる。 */
async function buildCodexTree(root: string): Promise<string> {
  const sessionsDir = join(root, 'sessions');
  await mkdir(join(sessionsDir, '2026', '08', '08'), { recursive: true });
  await mkdir(join(sessionsDir, '2026', '08', '09'), { recursive: true });
  await writeJsonl(join(sessionsDir, '2026', '08', '08', ROLLOUT_1), [
    { timestamp: '2026-08-08T10:00:00.000Z', type: 'session_meta', payload: { id: '<synthetic>' } },
  ]);
  await writeJsonl(join(sessionsDir, '2026', '08', '09', ROLLOUT_2), [
    { timestamp: '2026-08-09T09:30:00.000Z', type: 'session_meta', payload: { id: '<synthetic>' } },
  ]);
  return sessionsDir;
}

describe('claude ソースの発見', () => {
  it('SPEC-CORE-071: logDir 直下のディレクトリをグループ、配下再帰の *.jsonl をセッションとして返す', async () => {
    await withTempDir(async (root) => {
      const logDir = await buildClaudeTree(root);
      const groups = await createClaudeSource({ logDir }).discoverGroups();
      expect(
        groups.map((g) => ({ groupId: g.groupId, sessionIds: g.sessions.map((s) => s.sessionId) })),
      ).toEqual([
        { groupId: '-home-user-project-a', sessionIds: [SESSION_A, 'agent-x'] },
        { groupId: '-home-user-project-b', sessionIds: [SESSION_B] },
        { groupId: '-home-user-project-empty', sessionIds: [] },
      ]);
    });
  });

  it('SPEC-CORE-072: 公開セッション ID は接頭辞なしの basename のまま変わらない', async () => {
    await withTempDir(async (root) => {
      const logDir = await buildClaudeTree(root);
      const groups = await createClaudeSource({ logDir }).discoverGroups();
      for (const session of groups.flatMap((g) => g.sessions)) {
        expect(session.sessionId).not.toContain(':');
        expect(session.filePath.endsWith(`/${session.sessionId}.jsonl`)).toBe(true);
      }
    });
  });

  it('SPEC-CORE-079: .jsonl を含まないプロジェクトディレクトリも空グループとして返す', async () => {
    await withTempDir(async (root) => {
      const logDir = await buildClaudeTree(root);
      const groups = await createClaudeSource({ logDir }).discoverGroups();
      const empty = groups.find((g) => g.groupId === '-home-user-project-empty');
      expect(empty).toBeDefined();
      expect(empty?.sessions).toEqual([]);
    });
  });

  it('SPEC-CORE-077: logDir が存在しなければ空一覧を返しエラーにしない', async () => {
    await withTempDir(async (root) => {
      const source = createClaudeSource({ logDir: join(root, 'no-such-dir') });
      await expect(source.discoverGroups()).resolves.toEqual([]);
    });
  });
});

describe('codex ソースの発見', () => {
  it('SPEC-CORE-074: YYYY/MM/DD の日付階層を再帰探索し、日付グループでセッションを発見する', async () => {
    await withTempDir(async (root) => {
      const sessionsDir = await buildCodexTree(root);
      const groups = await createCodexSource({ sessionsDir }).discoverGroups();
      expect(
        groups.map((g) => ({ groupId: g.groupId, sessionIds: g.sessions.map((s) => s.sessionId) })),
      ).toEqual([
        { groupId: '2026-08-08', sessionIds: [`codex:${ROLLOUT_1.replace('.jsonl', '')}`] },
        { groupId: '2026-08-09', sessionIds: [`codex:${ROLLOUT_2.replace('.jsonl', '')}`] },
      ]);
    });
  });

  it('SPEC-CORE-075: session_index.jsonl を読まず rollout ファイル単独で発見する', async () => {
    await withTempDir(async (root) => {
      const sessionsDir = await buildCodexTree(root);
      // session_index.jsonl が壊れた JSON でも発見に影響しない（= 読んでいない）
      await writeFile(join(root, 'session_index.jsonl'), '{ broken', 'utf8');
      const groups = await createCodexSource({ sessionsDir }).discoverGroups();
      expect(groups.flatMap((g) => g.sessions)).toHaveLength(2);
    });
  });

  it('SPEC-CORE-076: rollout 命名に一致しないファイルと .jsonl 以外は発見対象にしない', async () => {
    await withTempDir(async (root) => {
      const sessionsDir = await buildCodexTree(root);
      const dateDir = join(sessionsDir, '2026', '08', '08');
      await writeFile(join(dateDir, 'notes.jsonl'), '{}\n', 'utf8');
      await writeFile(join(dateDir, 'rollout-memo.txt'), 'memo', 'utf8');
      await writeFile(join(dateDir, 'session_index.jsonl'), '{}\n', 'utf8');
      const groups = await createCodexSource({ sessionsDir }).discoverGroups();
      expect(groups.flatMap((g) => g.sessions.map((s) => s.sessionId))).toEqual([
        `codex:${ROLLOUT_1.replace('.jsonl', '')}`,
        `codex:${ROLLOUT_2.replace('.jsonl', '')}`,
      ]);
    });
  });

  it('SPEC-CORE-077: sessionsDir が存在しなければ空一覧を返しエラーにしない', async () => {
    await withTempDir(async (root) => {
      const source = createCodexSource({ sessionsDir: join(root, 'no-such-dir') });
      await expect(source.discoverGroups()).resolves.toEqual([]);
    });
  });
});

describe('loadSnapshot とソースの合成', () => {
  it('SPEC-CORE-070: ソースが発見したセッションだけをインデックス化し、配置規約を直接見ない', async () => {
    await withTempDir(async (root) => {
      // 発見結果を固定した偽ソース。store が勝手にディレクトリを走査すれば余分な entry が現れる
      const filePath = join(root, 'anywhere.jsonl');
      await writeJsonl(filePath, [{ type: 'user', uuid: 'u-1', message: { role: 'user', content: '<synthetic>' } }]);
      await writeJsonl(join(root, 'not-discovered.jsonl'), [{ type: 'user', uuid: 'u-9' }]);
      const fake: LogSource = {
        id: 'fake',
        discoverGroups: async () => [
          { groupId: 'g1', sessions: [{ sessionId: 'fake:anywhere', filePath }] },
        ],
      };
      const snapshot = await loadSnapshot({ sources: [fake], cacheDir: join(root, 'cache') });
      expect([...snapshot.sessionsById.keys()]).toEqual(['fake:anywhere']);
      expect(snapshot.projects.map((p) => p.id)).toEqual(['g1']);
      expect(snapshot.sessionsById.get('fake:anywhere')?.index.records).toHaveLength(1);
    });
  });

  it('SPEC-CORE-073: 同名ファイルがあってもソース間で公開 ID が衝突しない', async () => {
    await withTempDir(async (root) => {
      // claude 側にあえて rollout と同名の basename を置く（衝突の最悪ケース）
      const logDir = join(root, 'projects');
      await mkdir(join(logDir, '-home-user-project-a'), { recursive: true });
      await writeJsonl(join(logDir, '-home-user-project-a', ROLLOUT_1), [
        { type: 'user', uuid: 'u-1', message: { role: 'user', content: '<synthetic>' } },
      ]);
      const sessionsDir = await buildCodexTree(root);
      const snapshot = await loadSnapshot({
        sources: [createClaudeSource({ logDir }), createCodexSource({ sessionsDir })],
        cacheDir: join(root, 'cache'),
      });
      const base = ROLLOUT_1.replace('.jsonl', '');
      expect(snapshot.sessionsById.has(base)).toBe(true);
      expect(snapshot.sessionsById.has(`codex:${base}`)).toBe(true);
      expect(snapshot.sessionsById.get(base)?.filePath).not.toBe(snapshot.sessionsById.get(`codex:${base}`)?.filePath);
    });
  });

  it('SPEC-CORE-078: アプリ構成には Claude ソースのみ登録され、公開 ID は従来の basename のまま返る', async () => {
    await withTempDir(async (root) => {
      const logDir = await buildClaudeTree(root);
      await buildCodexTree(root); // 同じ root に codex ツリーがあってもアプリには現れない
      const app = createApp({ logDir, cacheDir: join(root, 'cache'), claudeDir: join(root, 'claude') });
      const list = await request(app).get('/api/projects');
      expect(list.status).toBe(200);
      // 空プロジェクトも旧実装どおり 0 セッションの行として現れる
      expect((list.body as { id: string }[]).map((p) => p.id)).toEqual([
        '-home-user-project-a',
        '-home-user-project-b',
        '-home-user-project-empty',
      ]);
      const detail = await request(app).get('/api/projects/-home-user-project-a');
      expect(detail.status).toBe(200);
      expect((detail.body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toEqual([
        SESSION_A,
        'agent-x',
      ]);
    });
  });
});
