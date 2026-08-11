/**
 * SPEC-DASH-100: プロジェクト詳細のセッション行に worktree を露出する（Issue #41）。
 * 仕様は docs/design/DASH.md「worktree グルーピング表示」。
 * 併合そのもののテストは tests/unit/core/worktree.test.ts 側。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../server/app.js';
import { writeJsonl } from '../../helpers/fixtures.js';

const SESSION_MAIN = 's0000000-0000-4000-8000-000000000021';
const SESSION_WT = 's0000000-0000-4000-8000-000000000022';

let root: string;
let app: Express;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ccv-wt-api-'));

  // worktree の実配置（本体 .git ディレクトリ + worktree の .git ファイル/commondir）
  const mainRoot = join(root, 'main');
  const adminDir = join(mainRoot, '.git', 'worktrees', 'wt-sample');
  const worktreeRoot = join(mainRoot, '.claude', 'worktrees', 'wt-sample');
  await mkdir(adminDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(worktreeRoot, '.git'), `gitdir: ${adminDir}\n`, 'utf8');
  await writeFile(join(adminDir, 'commondir'), '../..\n', 'utf8');

  const logDir = join(root, 'projects');
  await mkdir(join(logDir, 'proj-main'), { recursive: true });
  await mkdir(join(logDir, 'proj-wt'), { recursive: true });
  await writeJsonl(join(logDir, 'proj-main', `${SESSION_MAIN}.jsonl`), [
    {
      type: 'user',
      uuid: 'u-m1',
      cwd: mainRoot,
      timestamp: '2026-01-02T00:00:00.000Z',
      message: { role: 'user', content: '<synthetic> 本体の依頼文' },
    },
  ]);
  await writeJsonl(join(logDir, 'proj-wt', `${SESSION_WT}.jsonl`), [
    {
      type: 'user',
      uuid: 'u-w1',
      cwd: worktreeRoot,
      timestamp: '2026-01-03T00:00:00.000Z',
      message: { role: 'user', content: '<synthetic> worktree の依頼文' },
    },
  ]);

  app = createApp({
    logDir,
    cacheDir: join(root, '.cache'),
    claudeDir: join(root, 'claude-home'),
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/projects/:id の worktree 露出', () => {
  it('SPEC-DASH-100: セッション行に worktree（worktree 名・本体は null）が含まれる', async () => {
    const res = await request(app).get('/api/projects/proj-main');

    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.sessions as { id: string; worktree: string | null }[]).map((s) => [s.id, s]),
    );
    expect(byId.get(SESSION_WT)?.worktree).toBe('wt-sample');
    expect(byId.get(SESSION_MAIN)?.worktree).toBeNull();
  });
});
