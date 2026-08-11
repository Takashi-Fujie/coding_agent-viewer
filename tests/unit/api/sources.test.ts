/**
 * SPEC-DASH-080〜084: ソース情報と絞り込み（Issue #31）。仕様は docs/design/DASH.md。
 *
 * Claude と Codex の合成ログを同居させたアプリで、/api/sources と source クエリ、
 * DTO の source / records を検証する。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../server/app.js';
import { assistantLine, writeJsonl } from '../../helpers/fixtures.js';

const PROJECT_CLAUDE = '-home-dev-sample-project';
const SESSION_CLAUDE = 's0000000-0000-4000-8000-0000000000s1';
// cwd グルーピング（#45）後のグループ id: codex: + cwd の非英数字 - 置換
const CODEX_GROUP = 'codex:-home-user-synthetic-project';
const CODEX_ROLLOUT = 'rollout-2026-02-02T00-00-00-00000000-0000-7000-8000-0000000000c1';
const SESSION_CODEX = `codex:${CODEX_ROLLOUT}`;

let root: string;
let app: Express;

/** Claude 側: usage 付き assistant を 1 件持つ通常セッション（2026-01-01）。 */
function claudeLines(): unknown[] {
  return [
    {
      type: 'user',
      uuid: 'u-s1-1',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: SESSION_CLAUDE,
      cwd: '/home/dev/sample-project',
      message: { role: 'user', content: '<synthetic> 検索対象アルパカ依頼' },
    },
    assistantLine({ uuid: 'a-s1-1', timestamp: '2026-01-01T00:00:01.000Z' }),
  ];
}

/** Codex 側: usage を持たない（#30 まで未集計）rollout（2026-02-02）。 */
function codexLines(): unknown[] {
  return [
    {
      timestamp: '2026-02-02T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '00000000-0000-7000-8000-0000000000c1', cwd: '/home/user/synthetic-project', cli_version: '0.147.0' },
    },
    { timestamp: '2026-02-02T00:00:01.000Z', type: 'turn_context', payload: { turn_id: 'turn-001', model: 'gpt-5.5' } },
    {
      timestamp: '2026-02-02T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<synthetic> 検索対象カピバラ依頼' }] },
    },
    {
      timestamp: '2026-02-02T00:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<synthetic> 応答' }] },
    },
  ];
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ccv-sources-'));
  const logDir = join(root, 'projects');
  const codexDir = join(root, 'codex-sessions');
  await mkdir(join(logDir, PROJECT_CLAUDE), { recursive: true });
  await writeJsonl(join(logDir, PROJECT_CLAUDE, `${SESSION_CLAUDE}.jsonl`), claudeLines());
  await mkdir(join(codexDir, '2026', '02', '02'), { recursive: true });
  await writeJsonl(join(codexDir, '2026', '02', '02', `${CODEX_ROLLOUT}.jsonl`), codexLines());

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

describe('GET /api/sources', () => {
  it('SPEC-DASH-080: 登録済みソースの id と発見済みセッション数を返す', async () => {
    const res = await request(app).get('/api/sources');

    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([
      { id: 'claude', sessions: 1 },
      { id: 'codex', sessions: 1 },
    ]);
  });

  it('SPEC-DASH-080: ルートが存在しないソースは 0 件として返す', async () => {
    const empty = createApp({
      logDir: join(root, 'projects'),
      cacheDir: join(root, '.cache-empty'),
      claudeDir: join(root, 'claude-home'),
      codexSessionsDir: join(root, 'no-such-dir'),
    });

    const res = await request(empty).get('/api/sources');
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([
      { id: 'claude', sessions: 1 },
      { id: 'codex', sessions: 0 },
    ]);
  });
});

describe('source クエリによる絞り込み', () => {
  it('SPEC-DASH-081: /api/overview は source=codex で Codex グループだけの集計になる', async () => {
    const res = await request(app).get('/api/overview').query({ source: 'codex' });

    expect(res.status).toBe(200);
    expect(res.body.projects.map((p: { id: string }) => p.id)).toEqual([CODEX_GROUP]);
    expect(res.body.totals.sessions).toBe(1);
    // Codex は usage 未集計（#30）なのでトークンは 0 だがレコードは数えられる
    expect(res.body.totals.records).toBeGreaterThan(0);
    expect(res.body.totals.tokens.input).toBe(0);
  });

  it('SPEC-DASH-081: /api/overview は source=claude で Codex グループが消え、未指定なら全ソース合算になる', async () => {
    const claudeOnly = await request(app).get('/api/overview').query({ source: 'claude' });
    const all = await request(app).get('/api/overview');

    expect(claudeOnly.body.projects.map((p: { id: string }) => p.id)).toEqual([PROJECT_CLAUDE]);
    expect(all.body.projects.map((p: { id: string }) => p.id).sort()).toEqual(
      [PROJECT_CLAUDE, CODEX_GROUP].sort(),
    );
    // 全ソースの合計 = Claude のみの合計 + Codex 分（トークンは Codex が 0 なので一致する）
    expect(all.body.totals.tokens).toEqual(claudeOnly.body.totals.tokens);
    expect(all.body.totals.records).toBeGreaterThan(claudeOnly.body.totals.records);
  });

  it('SPEC-DASH-082: /api/projects と /api/search と /api/stats/tokens も source で絞り込める', async () => {
    const projects = await request(app).get('/api/projects').query({ source: 'codex' });
    expect(projects.body.map((p: { id: string }) => p.id)).toEqual([CODEX_GROUP]);

    const search = await request(app).get('/api/search').query({ q: 'カピバラ', source: 'claude' });
    expect(search.body.hits).toEqual([]);
    const searchCodex = await request(app).get('/api/search').query({ q: 'カピバラ', source: 'codex' });
    expect(searchCodex.body.hits.length).toBeGreaterThan(0);

    const stats = await request(app).get('/api/stats/tokens').query({ source: 'claude' });
    expect(stats.status).toBe(200);
  });

  it('SPEC-DASH-082: 未登録のソース id には 400 を返す', async () => {
    for (const path of ['/api/overview', '/api/projects', '/api/search?q=x', '/api/stats/tools']) {
      const res = await request(app).get(path).query({ source: 'gemini' });
      expect(res.status, path).toBe(400);
      expect(res.body.error).toContain('gemini');
    }
  });
});

describe('DTO の source / records', () => {
  it('SPEC-DASH-083: プロジェクト一覧・セッション一覧・検索ヒット・セッション要約に source が含まれる', async () => {
    const overview = await request(app).get('/api/overview');
    const bySource = new Map(
      overview.body.projects.map((p: { id: string; source: string }) => [p.id, p.source]),
    );
    expect(bySource.get(PROJECT_CLAUDE)).toBe('claude');
    expect(bySource.get(CODEX_GROUP)).toBe('codex');

    const project = await request(app).get(`/api/projects/${CODEX_GROUP}`);
    expect(project.body.source).toBe('codex');
    expect(project.body.sessions[0].source).toBe('codex');

    const session = await request(app).get(`/api/sessions/${encodeURIComponent(SESSION_CODEX)}`);
    expect(session.body.source).toBe('codex');

    const search = await request(app).get('/api/search').query({ q: 'カピバラ' });
    expect(search.body.hits[0].source).toBe('codex');
  });

  it('SPEC-DASH-084: 一覧の各行は範囲フィルタ後のレコード件数 records を含む', async () => {
    // Codex の活動日（2026-02-02）に絞ると、Claude 行は records 0・Codex 行は records > 0 になる
    const codexDay = '2026-02-02';
    const overview = await request(app).get('/api/overview').query({ from: codexDay, to: codexDay });
    const rows = new Map(
      overview.body.projects.map((p: { id: string; records: number }) => [p.id, p.records]),
    );
    expect(rows.get(PROJECT_CLAUDE)).toBe(0);
    expect(rows.get(CODEX_GROUP)).toBeGreaterThan(0);

    const project = await request(app)
      .get(`/api/projects/${CODEX_GROUP}`)
      .query({ from: codexDay, to: codexDay });
    expect(project.body.sessions[0].records).toBeGreaterThan(0);
    // usage 未集計でもレコード件数で「その日の活動」が判定できる（日別絞り込みの基準）
    expect(project.body.sessions[0].totalTokens).toBe(0);
  });
});
