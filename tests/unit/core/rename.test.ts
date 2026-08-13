/**
 * SPEC-CORE-100〜109: プロジェクトディレクトリのリネーム追跡（Issue #50）。
 * 仕様は docs/design/CORE.md「プロジェクトディレクトリのリネーム追跡」。
 *
 * 実在する「作業ディレクトリ」を一時ディレクトリに作り、loadSnapshot を 2 回呼んで
 * 検証する（1 回目で台帳記録 → rename → 2 回目で併合）。inode はリネームで不変である
 * ことを利用するため、作業ディレクトリは実 fs 上に作る（合成パス文字列だけでは足りない）。
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../server/app.js';
import { createClaudeSource } from '../../../server/sources/claude.js';
import { createCodexSource } from '../../../server/sources/codex.js';
import { loadSnapshot } from '../../../server/store.js';
import type { Snapshot } from '../../../server/store.js';
import { assistantLine, withTempDir, writeJsonl } from '../../helpers/fixtures.js';

const pathGroupId = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

const S_OLD = 's0000000-0000-4000-8000-000000000021';
const S_NEW = 's0000000-0000-4000-8000-000000000022';
const S_MAIN = 's0000000-0000-4000-8000-000000000023';
const S_WT = 's0000000-0000-4000-8000-000000000024';

function userLine(uuid: string, cwd: string, timestamp: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    cwd,
    timestamp,
    message: { role: 'user', content: '<synthetic> 依頼文' },
  };
}

interface Tree {
  workOld: string;
  workNew: string;
  logDir: string;
  cacheDir: string;
  localDir: string;
}

/** 実在する作業ディレクトリ + 旧 cwd の claude ログを組み立てる。 */
async function buildBaseTree(root: string): Promise<Tree> {
  const workOld = join(root, 'work', 'proj-old');
  await mkdir(workOld, { recursive: true });
  const logDir = join(root, 'projects');
  await mkdir(join(logDir, 'proj-old'), { recursive: true });
  await writeJsonl(join(logDir, 'proj-old', `${S_OLD}.jsonl`), [
    userLine('u-o1', workOld, '2026-01-01T00:00:00.000Z'),
    assistantLine({ uuid: 'a-o1', timestamp: '2026-01-01T00:00:01.000Z' }),
  ]);
  return {
    workOld,
    workNew: join(root, 'work', 'proj-new'),
    logDir,
    cacheDir: join(root, 'cache'),
    localDir: join(root, 'local'),
  };
}

/** 作業ディレクトリをリネームし、新 cwd のログ（別グループ）を追加する。 */
async function renameAndAddNew(t: Tree): Promise<void> {
  await rename(t.workOld, t.workNew);
  await mkdir(join(t.logDir, 'proj-new'), { recursive: true });
  await writeJsonl(join(t.logDir, 'proj-new', `${S_NEW}.jsonl`), [
    userLine('u-n1', t.workNew, '2026-01-02T00:00:00.000Z'),
  ]);
}

function load(t: Tree): Promise<Snapshot> {
  return loadSnapshot({
    sources: [createClaudeSource({ logDir: t.logDir })],
    cacheDir: t.cacheDir,
    localDir: t.localDir,
  });
}

async function readLedger(t: Tree): Promise<{ entries: Record<string, { dev: number; ino: number; cwd: string }> }> {
  return JSON.parse(await readFile(join(t.localDir, 'dir-identity.json'), 'utf8'));
}

describe('リネーム追跡（inode 台帳）', () => {
  it('SPEC-CORE-100: 識別パスが実在するグループの (dev, ino, cwd) を台帳へグループ id キーで記録する', async () => {
    await withTempDir(async (root) => {
      const t = await buildBaseTree(root);
      await load(t);

      const info = await stat(t.workOld);
      const ledger = await readLedger(t);
      expect(ledger.entries['proj-old']).toMatchObject({
        dev: info.dev,
        ino: info.ino,
        cwd: t.workOld,
      });
    });
  });

  it('SPEC-CORE-101: 消失グループは台帳の識別子が一致する現存グループの id へ改名・併合される', async () => {
    await withTempDir(async (root) => {
      const t = await buildBaseTree(root);
      await load(t);
      await renameAndAddNew(t);
      const snapshot = await load(t);

      const merged = snapshot.projects.find((p) => p.id === 'proj-new');
      expect(merged?.sessions.map((s) => s.id).sort()).toEqual([S_OLD, S_NEW]);
      expect(snapshot.projects.some((p) => p.id === 'proj-old')).toBe(false);
    });
  });

  it('SPEC-CORE-102: 併合後は projectId が併合先になり (id, sourceId) の一意性を保つ', async () => {
    await withTempDir(async (root) => {
      const t = await buildBaseTree(root);
      await load(t);
      await renameAndAddNew(t);
      const snapshot = await load(t);

      expect(snapshot.sessionsById.get(S_OLD)?.projectId).toBe('proj-new');
      const claudeNew = snapshot.projects.filter(
        (p) => p.id === 'proj-new' && p.sourceId === 'claude',
      );
      expect(claudeNew).toHaveLength(1);
    });
  });

  it('SPEC-CORE-103: 台帳に記録が無い・識別子が一致しない消失グループは単独のまま残る', async () => {
    // 台帳が無い（初回走査の前にリネーム済み）
    await withTempDir(async (root) => {
      const t = await buildBaseTree(root);
      await renameAndAddNew(t);
      const snapshot = await load(t);
      expect(snapshot.projects.some((p) => p.id === 'proj-old')).toBe(true);
      expect(snapshot.projects.some((p) => p.id === 'proj-new')).toBe(true);
    });

    // dev 不一致（別ボリュームへの移動を台帳の書き換えで再現）
    await withTempDir(async (root) => {
      const t = await buildBaseTree(root);
      await load(t);
      const ledger = await readLedger(t);
      const entry = ledger.entries['proj-old'];
      expect(entry).toBeDefined();
      if (entry) entry.dev += 1;
      await writeFile(join(t.localDir, 'dir-identity.json'), JSON.stringify(ledger), 'utf8');
      await renameAndAddNew(t);
      const snapshot = await load(t);
      expect(snapshot.projects.some((p) => p.id === 'proj-old')).toBe(true);
    });
  });

  it('SPEC-CORE-104: 台帳・エイリアスが無い・壊れた JSON でも空扱いで続行しエラーにならない', async () => {
    await withTempDir(async (root) => {
      const t = await buildBaseTree(root);
      await mkdir(t.localDir, { recursive: true });
      await writeFile(join(t.localDir, 'dir-identity.json'), '{壊れた json', 'utf8');
      await writeFile(join(t.localDir, 'project-aliases.json'), 'not json', 'utf8');
      await renameAndAddNew(t);

      const snapshot = await load(t);
      // 誤統合は起きず、分裂したままになるだけ
      expect(snapshot.projects.some((p) => p.id === 'proj-old')).toBe(true);
      expect(snapshot.projects.some((p) => p.id === 'proj-new')).toBe(true);
    });
  });

  it('SPEC-CORE-105: エイリアスの旧パスに一致するグループは新パス縮約の id へ改名され、適用は 1 ホップのみ', async () => {
    await withTempDir(async (root) => {
      const oldCwd = '/vanished/alias-old';
      const newCwd = '/vanished/alias-new';
      const logDir = join(root, 'projects');
      for (const [id, session, cwd] of [
        [pathGroupId(oldCwd), S_OLD, oldCwd],
        [pathGroupId(newCwd), S_NEW, newCwd],
      ] as const) {
        await mkdir(join(logDir, id), { recursive: true });
        await writeJsonl(join(logDir, id, `${session}.jsonl`), [
          userLine(`u-${session}`, cwd, '2026-01-01T00:00:00.000Z'),
        ]);
      }
      const localDir = join(root, 'local');
      await mkdir(localDir, { recursive: true });
      await writeFile(
        join(localDir, 'project-aliases.json'),
        JSON.stringify({ aliases: { [oldCwd]: newCwd } }),
        'utf8',
      );

      const t: Tree = { workOld: '', workNew: '', logDir, cacheDir: join(root, 'cache'), localDir };
      const snapshot = await load(t);
      const merged = snapshot.projects.find((p) => p.id === pathGroupId(newCwd));
      expect(merged?.sessions.map((s) => s.id).sort()).toEqual([S_NEW, S_OLD].sort());
      expect(snapshot.projects.some((p) => p.id === pathGroupId(oldCwd))).toBe(false);
    });

    // 1 ホップのみ: A→B, B→C の連鎖でも A のグループは B で止まる
    await withTempDir(async (root) => {
      const a = '/vanished/hop-a';
      const b = '/vanished/hop-b';
      const c = '/vanished/hop-c';
      const logDir = join(root, 'projects');
      await mkdir(join(logDir, pathGroupId(a)), { recursive: true });
      await writeJsonl(join(logDir, pathGroupId(a), `${S_OLD}.jsonl`), [
        userLine('u-hop', a, '2026-01-01T00:00:00.000Z'),
      ]);
      const localDir = join(root, 'local');
      await mkdir(localDir, { recursive: true });
      await writeFile(
        join(localDir, 'project-aliases.json'),
        JSON.stringify({ aliases: { [a]: b, [b]: c } }),
        'utf8',
      );

      const t: Tree = { workOld: '', workNew: '', logDir, cacheDir: join(root, 'cache'), localDir };
      const snapshot = await load(t);
      expect(snapshot.projects.some((p) => p.id === pathGroupId(b))).toBe(true);
      expect(snapshot.projects.some((p) => p.id === pathGroupId(c))).toBe(false);
    });
  });

  it('SPEC-CORE-106: 併合後の旧 id は一覧に現れず /api/projects/:id は 404 になる', async () => {
    await withTempDir(async (root) => {
      const t = await buildBaseTree(root);
      const app = createApp({
        logDir: t.logDir,
        cacheDir: t.cacheDir,
        claudeDir: root,
        localDir: t.localDir,
      });
      await request(app).get('/api/projects').expect(200); // 台帳記録
      await renameAndAddNew(t);

      const list = await request(app).get('/api/projects').expect(200);
      const ids = (list.body as { id: string }[]).map((p) => p.id);
      expect(ids).toContain('proj-new');
      expect(ids).not.toContain('proj-old');
      await request(app).get('/api/projects/proj-old').expect(404);
      await request(app).get('/api/projects/proj-new').expect(200);
    });
  });

  it('SPEC-CORE-107: rename 併合はソース不問で適用され、代表パスを持たないグループは対象外', async () => {
    await withTempDir(async (root) => {
      const workOld = join(root, 'work', 'codex-old');
      const workNew = join(root, 'work', 'codex-new');
      await mkdir(workOld, { recursive: true });
      const sessionsDir = join(root, 'sessions');
      const dayDir = join(sessionsDir, '2026', '03', '01');
      await mkdir(dayDir, { recursive: true });
      const rolloutOld = 'rollout-2026-03-01T00-00-00-00000000-0000-7000-8000-000000000031';
      const rolloutNew = 'rollout-2026-03-01T01-00-00-00000000-0000-7000-8000-000000000032';
      const rolloutNoCwd = 'rollout-2026-03-01T02-00-00-00000000-0000-7000-8000-000000000033';
      const codexLines = (cwd: string | null): unknown[] => [
        ...(cwd === null
          ? []
          : [
              {
                timestamp: '2026-03-01T00:00:00.000Z',
                type: 'session_meta',
                payload: { id: '<synthetic>', cwd },
              },
            ]),
        {
          timestamp: '2026-03-01T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<synthetic> 依頼文' }],
          },
        },
      ];
      await writeJsonl(join(dayDir, `${rolloutOld}.jsonl`), codexLines(workOld));
      await writeJsonl(join(dayDir, `${rolloutNoCwd}.jsonl`), codexLines(null));

      // claude 側にはセッション 0 件の空グループ（代表パスなし）だけを置く
      const logDir = join(root, 'projects');
      await mkdir(join(logDir, 'empty-proj'), { recursive: true });

      const localDir = join(root, 'local');
      const cacheDir = join(root, 'cache');
      const sources = [
        createClaudeSource({ logDir }),
        createCodexSource({ sessionsDir }),
      ];
      await loadSnapshot({ sources, cacheDir, localDir });

      // 代表パスを持たないグループ（codex 日付フォールバック・claude 空グループ）は台帳に載らない
      const ledger = JSON.parse(await readFile(join(localDir, 'dir-identity.json'), 'utf8')) as {
        entries: Record<string, unknown>;
      };
      expect(Object.keys(ledger.entries)).toEqual([pathGroupId(workOld)]);

      await rename(workOld, workNew);
      await writeJsonl(join(dayDir, `${rolloutNew}.jsonl`), codexLines(workNew));
      const snapshot = await loadSnapshot({ sources, cacheDir, localDir });

      const merged = snapshot.projects.find((p) => p.id === pathGroupId(workNew));
      expect(merged?.sourceId).toBe('codex');
      expect(merged?.sessions.map((s) => s.id).sort()).toEqual(
        [`codex:${rolloutOld}`, `codex:${rolloutNew}`].sort(),
      );
      expect(snapshot.projects.some((p) => p.id === pathGroupId(workOld))).toBe(false);
      // 日付フォールバックグループは従来どおり残る
      expect(snapshot.projects.some((p) => p.id === '2026-03-01')).toBe(true);
    });
  });

  it('SPEC-CORE-108: 本体リポジトリごとリネームされても worktree グループを含む全セッションが新 id へ統合される', async () => {
    await withTempDir(async (root) => {
      // 本体リポジトリ + worktree の実配置（worktree.test.ts と同じ手組み構造）
      const mainRoot = join(root, 'main');
      const adminDir = join(mainRoot, '.git', 'worktrees', 'wt-sample');
      const worktreeRoot = join(mainRoot, '.claude', 'worktrees', 'wt-sample');
      await mkdir(adminDir, { recursive: true });
      await mkdir(worktreeRoot, { recursive: true });
      await writeFile(join(worktreeRoot, '.git'), `gitdir: ${adminDir}\n`, 'utf8');
      await writeFile(join(adminDir, 'commondir'), '../..\n', 'utf8');

      const logDir = join(root, 'projects');
      await mkdir(join(logDir, 'proj-main'), { recursive: true });
      await writeJsonl(join(logDir, 'proj-main', `${S_MAIN}.jsonl`), [
        userLine('u-m1', mainRoot, '2026-01-01T00:00:00.000Z'),
      ]);
      await mkdir(join(logDir, 'proj-wt'), { recursive: true });
      await writeJsonl(join(logDir, 'proj-wt', `${S_WT}.jsonl`), [
        userLine('u-w1', worktreeRoot, '2026-01-02T00:00:00.000Z'),
      ]);

      const t: Tree = {
        workOld: '',
        workNew: '',
        logDir,
        cacheDir: join(root, 'cache'),
        localDir: join(root, 'local'),
      };
      await load(t); // 台帳記録（proj-main / proj-wt とも本体ルートの識別子を持つ）

      const mainRoot2 = join(root, 'main2');
      await rename(mainRoot, mainRoot2);
      await mkdir(join(logDir, 'proj-new2'), { recursive: true });
      await writeJsonl(join(logDir, 'proj-new2', `${S_NEW}.jsonl`), [
        userLine('u-n2', mainRoot2, '2026-01-03T00:00:00.000Z'),
      ]);

      const snapshot = await load(t);
      const merged = snapshot.projects.find((p) => p.id === 'proj-new2');
      expect(merged?.sessions.map((s) => s.id).sort()).toEqual([S_MAIN, S_WT, S_NEW].sort());
      expect(snapshot.projects.some((p) => p.id === 'proj-main')).toBe(false);
      expect(snapshot.projects.some((p) => p.id === 'proj-wt')).toBe(false);
    });
  });

  it('SPEC-CORE-109: 併合は集計値を変えない（/api/overview の合計が併合の前後で一致する）', async () => {
    await withTempDir(async (root) => {
      const t = await buildBaseTree(root);
      await load(t); // 台帳記録
      await renameAndAddNew(t);

      const appOptions = { logDir: t.logDir, cacheDir: t.cacheDir, claudeDir: root };
      // 併合あり（台帳記録済みの localDir）と併合なし（台帳の無い localDir）で合計を比較する
      const mergedApp = createApp({ ...appOptions, localDir: t.localDir });
      const splitApp = createApp({ ...appOptions, localDir: join(root, 'local-empty') });

      const merged = await request(mergedApp).get('/api/overview').expect(200);
      const split = await request(splitApp).get('/api/overview').expect(200);
      expect((merged.body as { totals: unknown }).totals).toEqual(
        (split.body as { totals: unknown }).totals,
      );

      // 併合の有無を裏取り（前提の検証）
      const mergedList = (merged.body as { projects: { id: string }[] }).projects.map((p) => p.id);
      const splitList = (split.body as { projects: { id: string }[] }).projects.map((p) => p.id);
      expect(mergedList).not.toContain('proj-old');
      expect(splitList).toContain('proj-old');
    });
  });
});
