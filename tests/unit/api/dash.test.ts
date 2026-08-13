/**
 * SPEC-DASH のサーバ側受け入れテスト。仕様は docs/design/DASH.md。
 *
 * app.test.ts と同じく supertest + 合成フィクスチャのみ。期待値は core 層の
 * 同じ関数で計算し、ハードコードしない。
 */
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../../server/app.js';
import { buildIndex } from '../../../server/core/indexer.js';
import { estimateRecordsCost, loadPriceTable, normalizeModelId } from '../../../server/cost.js';
import type { IndexRecord } from '../../../server/core/types.js';
import { SAMPLE_FIXTURE, assistantLine, writeJsonl } from '../../helpers/fixtures.js';

const SESSION_D1 = 's0000000-0000-4000-8000-0000000000d1';
const SESSION_D2 = 's0000000-0000-4000-8000-0000000000d2';
const SESSION_D3 = 's0000000-0000-4000-8000-0000000000d3';
const PROJECT_A = '-home-dev-project-a';
const PROJECT_B = '-home-dev-project-b';

let root: string;
let logDir: string;
let cacheDir: string;
let claudeDir: string;
let app: Express;

/** UTC 深夜（JST では翌日）に活動した、ツール失敗・MCP・hook 入りのセッション。 */
function sessionD2Lines(): unknown[] {
  return [
    {
      type: 'user',
      uuid: 'u-d2-1',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-01-01T20:00:00.000Z',
      sessionId: SESSION_D2,
      cwd: '/home/dev/project-a',
      message: { role: 'user', content: 'ツールをいろいろ使う依頼。' },
    },
    {
      type: 'attachment',
      uuid: 'at-d2-1',
      parentUuid: 'u-d2-1',
      isSidechain: false,
      timestamp: '2026-01-01T20:00:01.000Z',
      sessionId: SESSION_D2,
      attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', stdout: '' },
    },
    assistantLine({
      uuid: 'a-d2-1',
      model: 'claude-opus-5',
      timestamp: '2026-01-01T20:00:05.000Z',
      content: [
        { type: 'text', text: 'ツールを使います。' },
        { type: 'tool_use', id: 'toolu_d2_bash', name: 'Bash', input: { command: 'false' } },
        { type: 'tool_use', id: 'toolu_d2_mcp', name: 'mcp__github__create_pr', input: {} },
        { type: 'tool_use', id: 'toolu_d2_agent', name: 'Agent', input: { subagent_type: 'sample-reviewer' } },
        { type: 'tool_use', id: 'toolu_d2_skill', name: 'Skill', input: { skill: 'sample-skill' } },
      ],
    }),
    {
      type: 'user',
      uuid: 'u-d2-2',
      parentUuid: 'a-d2-1',
      isSidechain: false,
      timestamp: '2026-01-01T20:00:10.000Z',
      sessionId: SESSION_D2,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_d2_bash', content: 'Error: exit 1', is_error: true },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u-d2-3',
      parentUuid: 'a-d2-1',
      isSidechain: false,
      timestamp: '2026-01-01T20:00:12.000Z',
      sessionId: SESSION_D2,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_d2_mcp', content: 'PR created' }],
      },
    },
    // compaction 境界（SPEC-DASH-122 の集計対象）
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'sys-d2-1',
      parentUuid: 'u-d2-3',
      isSidechain: false,
      timestamp: '2026-01-01T20:00:20.000Z',
      sessionId: SESSION_D2,
    },
  ];
}

/** 別プロジェクト・別日のセッション（ツール成功のみ・hook 1 件）。 */
function sessionD3Lines(): unknown[] {
  return [
    {
      type: 'attachment',
      uuid: 'at-d3-1',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-01-03T12:00:00.000Z',
      sessionId: SESSION_D3,
      attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', stdout: '' },
    },
    assistantLine({
      uuid: 'a-d3-1',
      model: 'claude-sonnet-5',
      timestamp: '2026-01-03T12:00:05.000Z',
      content: [
        { type: 'text', text: 'B の応答。' },
        { type: 'tool_use', id: 'toolu_d3_bash', name: 'Bash', input: { command: 'true' } },
      ],
    }),
    {
      type: 'user',
      uuid: 'u-d3-1',
      parentUuid: 'a-d3-1',
      isSidechain: false,
      timestamp: '2026-01-03T12:00:06.000Z',
      sessionId: SESSION_D3,
      cwd: '/home/dev/project-b',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_d3_bash', content: 'ok' }],
      },
    },
  ];
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ccv-dash-test-'));
  logDir = join(root, 'projects');
  cacheDir = join(root, 'cache');
  claudeDir = join(root, 'claude');

  await mkdir(join(logDir, PROJECT_A), { recursive: true });
  await mkdir(join(logDir, PROJECT_B), { recursive: true });
  await mkdir(claudeDir, { recursive: true });

  // 規約: 巨大行・壊れ行・未知モデル・<synthetic> はサンプルフィクスチャで担保する
  await cp(SAMPLE_FIXTURE, join(logDir, PROJECT_A, `${SESSION_D1}.jsonl`));
  await writeJsonl(join(logDir, PROJECT_A, `${SESSION_D2}.jsonl`), sessionD2Lines());
  await writeJsonl(join(logDir, PROJECT_B, `${SESSION_D3}.jsonl`), sessionD3Lines());

  app = createApp({ logDir, cacheDir, claudeDir });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** テストと同じ core 関数で全レコードを得る。 */
async function allRecords(): Promise<IndexRecord[]> {
  const files = [
    join(logDir, PROJECT_A, `${SESSION_D1}.jsonl`),
    join(logDir, PROJECT_A, `${SESSION_D2}.jsonl`),
    join(logDir, PROJECT_B, `${SESSION_D3}.jsonl`),
  ];
  const records: IndexRecord[] = [];
  for (const file of files) {
    const { index } = await buildIndex(file, { cacheDir });
    records.push(...index.records);
  }
  return records;
}

describe('ローカル日付集計（API）', () => {
  it('SPEC-DASH-010: tzOffset を渡すと日次系列がローカル日付で丸められる', async () => {
    // UTC 2026-01-01T20:00 の活動は JST（540 分）では 01-02 に入る
    const utc = await request(app).get('/api/overview?from=2026-01-02&to=2026-01-02');
    expect(utc.status).toBe(200);
    expect(utc.body.daily).toEqual([]);

    const jst = await request(app).get('/api/overview?from=2026-01-02&to=2026-01-02&tzOffset=540');
    expect(jst.status).toBe(200);
    expect(jst.body.daily.map((d: { date: string }) => d.date)).toEqual(['2026-01-02']);
  });

  it('SPEC-DASH-011: tzOffset が整数でない・絶対値 840 超のとき 400 を返す', async () => {
    for (const bad of ['abc', '1.5', '900', '-900']) {
      const res = await request(app).get(`/api/overview?tzOffset=${bad}`);
      expect(res.status, `tzOffset=${bad}`).toBe(400);
      expect(typeof res.body.error).toBe('string');
    }
    const projects = await request(app).get(`/api/projects/${PROJECT_A}?tzOffset=abc`);
    expect(projects.status).toBe(400);
  });

  it('SPEC-DASH-012: /api/overview の byModel は messages・5m/1h 内訳を含み cost.byModel とキーが揃う', async () => {
    const records = await allRecords();
    const billable = records.filter((r) => r.kind === 'assistant' && r.usage !== undefined);
    const opus = billable.filter((r) => normalizeModelId(r.model ?? '') === 'claude-opus-5');

    const res = await request(app).get('/api/overview');
    expect(res.status).toBe(200);
    const byModel = res.body.byModel['claude-opus-5'];
    expect(byModel.messages).toBe(opus.length);
    expect(byModel.cacheCreation5m).toBe(opus.reduce((s, r) => s + r.usage!.cacheCreation5m, 0));
    expect(byModel.cacheCreation1h).toBe(opus.reduce((s, r) => s + r.usage!.cacheCreation1h, 0));
    // コストは cost.byModel（同じ正規化キー）で突き合わせる
    expect(Object.keys(res.body.cost.byModel)).toEqual(
      expect.arrayContaining(Object.keys(res.body.byModel)),
    );
  });

  it('SPEC-DASH-013: /api/projects/:id の日次モデル別系列は日次推定コストを含む', async () => {
    const table = await loadPriceTable();
    const { index } = await buildIndex(join(logDir, PROJECT_B, `${SESSION_D3}.jsonl`), { cacheDir });
    const expected = estimateRecordsCost(index.records, table).total;

    const res = await request(app).get(`/api/projects/${PROJECT_B}`);
    expect(res.status).toBe(200);
    const daily: { date: string; byModel: Record<string, number>; cost: number }[] = res.body.daily;
    expect(daily.length).toBeGreaterThan(0);
    const sum = daily.reduce((s, d) => s + d.cost, 0);
    expect(sum).toBeCloseTo(expected, 10);
  });

  it('SPEC-DASH-122: /api/projects/:id の sessions 要素は compactionCount を含む', async () => {
    const res = await request(app).get(`/api/projects/${PROJECT_A}`);
    expect(res.status).toBe(200);
    const sessions: { id: string; compactionCount: number }[] = res.body.sessions;

    const d2 = sessions.find((s) => s.id === SESSION_D2);
    expect(d2?.compactionCount).toBe(1);
    // 境界の無いセッションは 0（undefined ではなく数値で返す）
    const d1 = sessions.find((s) => s.id === SESSION_D1);
    expect(d1?.compactionCount).toBe(0);
  });
});

describe('GET /api/stats/tools', () => {
  it('SPEC-DASH-020: ツール別の呼出数と失敗数を返し、失敗数は tool_use と tool_result の id 突き合わせで数える', async () => {
    const res = await request(app).get('/api/stats/tools');
    expect(res.status).toBe(200);

    const tools: { name: string; count: number; failures: number }[] = res.body.tools;
    const bash = tools.find((t) => t.name === 'Bash');
    // D2（失敗）+ D3（成功）の 2 回。失敗は is_error: true の D2 の 1 回だけ
    expect(bash).toMatchObject({ count: 2, failures: 1 });
    const read = tools.find((t) => t.name === 'Read');
    expect(read).toMatchObject({ count: 1, failures: 0 });
    // count 降順
    const counts = tools.map((t) => t.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('SPEC-DASH-021: from / to / tzOffset / project で絞り込める', async () => {
    // プロジェクト B のみ: D3 の Bash 1 回（成功）だけ
    const byProject = await request(app).get(`/api/stats/tools?project=${PROJECT_B}`);
    expect(byProject.status).toBe(200);
    expect(byProject.body.tools).toEqual([{ name: 'Bash', count: 1, failures: 0 }]);

    // JST の 01-02 = UTC 01-01 深夜の D2 だけが該当する
    const jstDay = await request(app).get(
      '/api/stats/tools?from=2026-01-02&to=2026-01-02&tzOffset=540',
    );
    expect(jstDay.status).toBe(200);
    const names = jstDay.body.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['Agent', 'Bash', 'Skill', 'mcp__github__create_pr']);
    expect(jstDay.body.tools.find((t: { name: string }) => t.name === 'Bash').failures).toBe(1);

    // 同じ範囲を UTC で見ると D2 は 01-01 側なので空になる
    const utcDay = await request(app).get('/api/stats/tools?from=2026-01-02&to=2026-01-02');
    expect(utcDay.body.tools).toEqual([]);

    const bad = await request(app).get('/api/stats/tools?tzOffset=abc');
    expect(bad.status).toBe(400);
  });

  it('SPEC-DASH-022: mcp__server__tool 形式をサーバ別に分解した内訳を返す', async () => {
    const res = await request(app).get('/api/stats/tools');
    expect(res.body.mcp).toEqual([
      { server: 'github', count: 1, failures: 0, tools: ['create_pr'] },
    ]);
  });

  it('SPEC-DASH-023: プロジェクト別のツール別呼出数・合計・失敗数を返す', async () => {
    const res = await request(app).get('/api/stats/tools');
    const rows: { project: string; total: number; failures: number; byTool: Record<string, number> }[] =
      res.body.byProject;

    const a = rows.find((r) => r.project === PROJECT_A);
    // サンプル（Agent / Read / Skill）+ D2（Bash / MCP / Agent / Skill）= 7 回・失敗 1
    expect(a).toBeDefined();
    expect(a!.total).toBe(7);
    expect(a!.failures).toBe(1);
    expect(a!.byTool['Bash']).toBe(1);

    const b = rows.find((r) => r.project === PROJECT_B);
    expect(b).toMatchObject({ total: 1, failures: 0, byTool: { Bash: 1 } });
  });
});

describe('GET /api/stats/agents', () => {
  it('SPEC-DASH-024: subagent / skill 別の起動回数と最終使用日時を返す', async () => {
    const res = await request(app).get('/api/stats/agents');
    expect(res.status).toBe(200);

    // sample-reviewer はサンプル（01-01 午前）と D2（01-01T20:00:05Z）の 2 回
    const reviewer = res.body.subagents.find(
      (s: { name: string }) => s.name === 'sample-reviewer',
    );
    expect(reviewer).toMatchObject({ count: 2, lastTimestamp: '2026-01-01T20:00:05.000Z' });

    const skill = res.body.skills.find((s: { name: string }) => s.name === 'sample-skill');
    expect(skill).toMatchObject({ count: 2, lastTimestamp: '2026-01-01T20:00:05.000Z' });

    // project 絞り込み: B には subagent / skill 起動が無い
    const byProject = await request(app).get(`/api/stats/agents?project=${PROJECT_B}`);
    expect(byProject.body.subagents).toEqual([]);
    expect(byProject.body.skills).toEqual([]);
  });
});

describe('GET /api/stats/hooks', () => {
  it('SPEC-DASH-025: hook 発火履歴を新しい順に返し、limit 超過分は truncated: true で打ち切る', async () => {
    const res = await request(app).get('/api/stats/hooks');
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.hooks).toEqual([
      {
        timestamp: '2026-01-03T12:00:00.000Z',
        hookName: 'SessionStart:startup',
        hookEvent: 'SessionStart',
        project: PROJECT_B,
        sessionId: SESSION_D3,
      },
      {
        timestamp: '2026-01-01T20:00:01.000Z',
        hookName: 'PreToolUse:Bash',
        hookEvent: 'PreToolUse',
        project: PROJECT_A,
        sessionId: SESSION_D2,
      },
    ]);

    const limited = await request(app).get('/api/stats/hooks?limit=1');
    expect(limited.body.hooks).toHaveLength(1);
    expect(limited.body.hooks[0].hookEvent).toBe('SessionStart');
    expect(limited.body.truncated).toBe(true);

    // project 絞り込み
    const byProject = await request(app).get(`/api/stats/hooks?project=${PROJECT_A}`);
    expect(byProject.body.hooks).toHaveLength(1);
    expect(byProject.body.hooks[0].hookEvent).toBe('PreToolUse');
  });
});
