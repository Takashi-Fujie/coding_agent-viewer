/**
 * SPEC-CODEX-080〜092: Codex usage 会計。仕様は docs/design/CODEX.md（Issue #30）。
 *
 * token_count はセッション累積値の繰り返し記録なので、行ごとの合算ではなく
 * 「累積値の増分」を会計する。減少（reset / compaction / resume 巻き戻り）は
 * 実ログ未観測のため、オーナー裁定（案 B）どおり計上せず基準だけ更新する。
 * 累積減少は確定契約（単調増加）と矛盾するため常設フィクスチャに置かず、
 * このファイル内で行列を生成して検証する。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenTotals } from '../../../server/aggregate.js';
import { estimateRecordsCost } from '../../../server/cost.js';
import type { PriceTable } from '../../../server/cost.js';
import { buildIndex, INDEX_SCHEMA_VERSION } from '../../../server/core/indexer.js';
import { addToSummary, createSummary } from '../../../server/core/summary.js';
import type { IndexRecord } from '../../../server/core/types.js';
import { createCodexNormalizer } from '../../../server/sources/codex-normalize.js';
import { createCodexSource } from '../../../server/sources/codex.js';
import { appendJsonl, pick, withTempDir, writeJsonl } from '../../helpers/fixtures.js';

const at = (sec: number): string => `2026-08-08T00:00:${String(sec).padStart(2, '0')}.000Z`;

const sessionMeta = {
  timestamp: at(0),
  type: 'session_meta',
  payload: {
    id: '00000000-0000-7000-8000-000000000001',
    cwd: '/home/user/synthetic-project',
    cli_version: '0.147.0',
  },
};

const turnContext = (sec: number, model: string) => ({
  timestamp: at(sec),
  type: 'turn_context',
  payload: { turn_id: `turn-${sec}`, cwd: '/home/user/synthetic-project', model },
});

interface Cumulative {
  input: number;
  cached: number;
  output: number;
  reasoning?: number;
}

/** 累積値の token_count 行（フィクスチャと同じ形。rate_limits は会計対象外の雑音として付ける）。 */
const tokenCount = (sec: number, c: Cumulative) => ({
  timestamp: at(sec),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: c.input,
        cached_input_tokens: c.cached,
        output_tokens: c.output,
        reasoning_output_tokens: c.reasoning ?? 0,
        total_tokens: c.input + c.output,
      },
      last_token_usage: {
        input_tokens: 999_999,
        cached_input_tokens: 999_999,
        output_tokens: 999_999,
        reasoning_output_tokens: 999_999,
        total_tokens: 999_999,
      },
      model_context_window: 258400,
    },
    rate_limits: { limit_id: 'codex', primary: { used_percent: 1 } },
  },
});

/** 行列を順に流し、生成されたレコードだけを返す。 */
function normalizeAll(lines: unknown[]): IndexRecord[] {
  const normalizer = createCodexNormalizer();
  const records: IndexRecord[] = [];
  lines.forEach((line, i) => {
    const record = normalizer.normalize(line, { offset: i * 100, length: 80 });
    if (record) records.push(record);
  });
  return records;
}

const usageRecords = (records: IndexRecord[]): IndexRecord[] =>
  records.filter((r) => r.usage !== undefined);

describe('Codex usage 会計（token_count の増分差分化）', () => {
  it('SPEC-CODEX-080: token_count の累積増分は usage 付き kind system（subtype token_count）レコードになり、増分 0 の行（同一累積値の重複記録）はレコードを生成しない', () => {
    const records = normalizeAll([
      sessionMeta,
      turnContext(1, 'gpt-5.5'),
      tokenCount(2, { input: 1000, cached: 600, output: 50 }),
      tokenCount(3, { input: 1000, cached: 600, output: 50 }), // 同一累積値の重複記録
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'system',
      subtype: 'token_count',
      model: 'gpt-5.5',
    });
    expect(records[0]?.usage).toBeDefined();
  });

  it('SPEC-CODEX-081: usage は input=Δinput−Δcached・cacheRead=Δcached・output=Δoutput となり、reasoning の別掲と cache write の計上をしない', () => {
    const records = normalizeAll([
      turnContext(1, 'gpt-5.5'),
      tokenCount(2, { input: 1000, cached: 600, output: 50, reasoning: 10 }),
      tokenCount(3, { input: 2500, cached: 1400, output: 250, reasoning: 60 }),
    ]);
    expect(usageRecords(records)).toHaveLength(2);
    expect(records[0]?.usage).toMatchObject({
      input: 400, // 1000 − 600
      cacheRead: 600,
      output: 50, // reasoning 10 は内数のまま（別掲しない）
      cacheCreation: 0,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
    });
    expect(records[1]?.usage).toMatchObject({
      input: 700, // Δ1500 − Δ800
      cacheRead: 800,
      output: 200,
    });
  });

  it('SPEC-CODEX-082: Δcached が Δinput を上回る行でも input は負にならない（0 へクランプ）', () => {
    const records = normalizeAll([
      turnContext(1, 'gpt-5.5'),
      tokenCount(2, { input: 1000, cached: 100, output: 10 }),
      // Δinput=200 < Δcached=500（累積では cached ⊆ input のまま）
      tokenCount(3, { input: 1200, cached: 600, output: 20 }),
    ]);
    expect(records[1]?.usage).toMatchObject({ input: 0, cacheRead: 500 });
  });

  it('SPEC-CODEX-083: 1 ターンに複数の token_count がある場合も、合計は累積最終値と一致する', () => {
    const records = normalizeAll([
      turnContext(1, 'gpt-5.5'),
      tokenCount(2, { input: 1000, cached: 600, output: 50 }),
      tokenCount(3, { input: 2000, cached: 1200, output: 100 }),
      tokenCount(4, { input: 2000, cached: 1200, output: 100 }), // 重複
      tokenCount(5, { input: 3500, cached: 2000, output: 250 }),
    ]);
    const totals = tokenTotals(records);
    expect(totals.input + totals.cacheRead).toBe(3500);
    expect(totals.cacheRead).toBe(2000);
    expect(totals.output).toBe(250);
  });

  it('SPEC-CODEX-084: resume（session_meta 再追記）後も基準が継続し、多重計上しない', () => {
    const records = normalizeAll([
      sessionMeta,
      turnContext(1, 'gpt-5.5'),
      tokenCount(2, { input: 1000, cached: 600, output: 50 }),
      sessionMeta, // resume
      tokenCount(4, { input: 1600, cached: 900, output: 150 }),
    ]);
    const totals = tokenTotals(records);
    expect(totals.input + totals.cacheRead).toBe(1600);
    expect(totals.output).toBe(150);
  });

  it('SPEC-CODEX-085: モデル切替後の増分は切替後の turn_context.model に帰属し、切替前の増分は前モデルに残る', () => {
    const records = normalizeAll([
      turnContext(1, 'gpt-5.5'),
      tokenCount(2, { input: 1000, cached: 600, output: 50 }),
      turnContext(3, 'gpt-5.4-mini'),
      tokenCount(4, { input: 1600, cached: 900, output: 150 }),
    ]);
    expect(records.filter((r) => r.usage)).toHaveLength(2);
    const before = pick(records, (r) => r.model === 'gpt-5.5', '切替前の増分');
    const after = pick(records, (r) => r.model === 'gpt-5.4-mini', '切替後の増分');
    expect((before.usage?.input ?? 0) + (before.usage?.cacheRead ?? 0)).toBe(1000);
    expect((after.usage?.input ?? 0) + (after.usage?.cacheRead ?? 0)).toBe(600);
  });

  it('SPEC-CODEX-086: 最初の turn_context より前の増分は model undefined で計上され、コスト側で未知モデル警告になる', () => {
    const records = normalizeAll([
      sessionMeta,
      tokenCount(1, { input: 500, cached: 0, output: 20 }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.model).toBeUndefined();
    expect(records[0]?.usage).toMatchObject({ input: 500, output: 20 });

    const table: PriceTable = {
      version: 1,
      currency: 'USD',
      unit: 'per_1m_tokens',
      source: 'SPEC-SAMPLE-001 テスト用',
      cacheMultipliers: { read: 0.1, write5m: 1.25, write1h: 2.0 },
      models: {},
    };
    const cost = estimateRecordsCost(records, table);
    expect(cost.unknownModels.length).toBeGreaterThan(0);
  });

  it('SPEC-CODEX-087: 累積値の減少を検知したら epoch を切り替え、その行は計上せず新しい基準から以後の増分を数える（案 B）', () => {
    const records = normalizeAll([
      turnContext(1, 'gpt-5.5'),
      tokenCount(2, { input: 1000, cached: 600, output: 50 }),
      // compaction / reset を想定した減少（未観測ケース・テスト内生成のみ）
      tokenCount(3, { input: 200, cached: 0, output: 10 }),
      tokenCount(4, { input: 700, cached: 300, output: 40 }),
    ]);
    const usages = usageRecords(records);
    expect(usages).toHaveLength(2); // 減少行は計上しない
    const totals = tokenTotals(records);
    // 初回 1000 + 減少後の増分 (700−200) = 1500。減少行の 200 は計上しない
    expect(totals.input + totals.cacheRead).toBe(1500);
    expect(totals.output).toBe(80); // 50 + (40−10)
  });

  it('SPEC-CODEX-088: info が null・オブジェクトでない token_count は状態を変えずスキップする', () => {
    const infoNull = {
      timestamp: at(3),
      type: 'event_msg',
      payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex' } },
    };
    const infoBroken = {
      timestamp: at(4),
      type: 'event_msg',
      payload: { type: 'token_count', info: 'broken' },
    };
    const records = normalizeAll([
      turnContext(1, 'gpt-5.5'),
      tokenCount(2, { input: 1000, cached: 600, output: 50 }),
      infoNull,
      infoBroken,
      tokenCount(5, { input: 1600, cached: 900, output: 150 }),
    ]);
    const usages = usageRecords(records);
    expect(usages).toHaveLength(2);
    const totals = tokenTotals(records);
    expect(totals.input + totals.cacheRead).toBe(1600);
  });
});

describe('増分・キャッシュ（usage 会計）', () => {
  const ROLLOUT = 'rollout-2026-08-08T00-00-00-00000000-0000-7000-8000-000000000001.jsonl';

  it('SPEC-CODEX-089: usage 会計を含む増分解析は全再構築と完全に同じ集計になる（prevUsage が scanState 経由で継続する）', async () => {
    await withTempDir(async (dir) => {
      const sessionsDir = join(dir, 'sessions');
      const dayDir = join(sessionsDir, '2026', '08', '08');
      await mkdir(dayDir, { recursive: true });
      const filePath = join(dayDir, ROLLOUT);
      await writeJsonl(filePath, [
        sessionMeta,
        turnContext(1, 'gpt-5.5'),
        tokenCount(2, { input: 1000, cached: 600, output: 50 }),
      ]);
      const source = createCodexSource({ sessionsDir });
      const cacheDir = join(dir, 'cache-a');

      const first = await buildIndex(filePath, { cacheDir, source });
      expect(first.strategy).toBe('rebuild');

      // 基準（prevUsage）が失われていれば、追記分の累積値 1600 を全額計上してしまう
      await appendJsonl(filePath, [tokenCount(3, { input: 1600, cached: 900, output: 150 })]);
      const second = await buildIndex(filePath, { cacheDir, source });
      expect(second.strategy).toBe('incremental');

      const rebuilt = await buildIndex(filePath, { cacheDir: join(dir, 'cache-b'), source });
      expect(second.index.records).toEqual(rebuilt.index.records);
      expect(second.index.summary).toEqual(rebuilt.index.summary);

      const totals = tokenTotals(second.index.records);
      expect(totals.input + totals.cacheRead).toBe(1600);
    });
  });

  it('SPEC-CODEX-090: INDEX_SCHEMA_VERSION の繰り上げ（5）により prevUsage の無い旧キャッシュは全再構築される', () => {
    // v4 の scanState には prevUsage が無く、増分再開で epoch 誤検知 → 多重計上になるため
    expect(INDEX_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });
});

describe('集計統合（usage を持つレコード・kind 不問）', () => {
  /** usage 付き token_count 増分レコード（正規化出力と同じ形）。 */
  const usageRecord: IndexRecord = {
    offset: 0,
    length: 80,
    type: 'token_count',
    kind: 'system',
    subtype: 'token_count',
    model: 'gpt-5.5',
    timestamp: at(2),
    usage: {
      input: 400,
      output: 50,
      cacheRead: 600,
      cacheCreation: 0,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
      webSearch: 0,
      webFetch: 0,
    },
  };

  it('SPEC-CODEX-091: summary / aggregate / cost は usage を持つ非 assistant レコードを合算し、messages・assistantCount のカウントは assistant のみのまま変わらない', () => {
    const summary = createSummary();
    addToSummary(summary, usageRecord);
    expect(summary.assistantCount).toBe(0);
    expect(summary.models['gpt-5.5']).toMatchObject({ messages: 0, input: 400, output: 50, cacheRead: 600 });

    const totals = tokenTotals([usageRecord]);
    expect(totals).toMatchObject({ input: 400, output: 50, cacheRead: 600 });

    const table: PriceTable = {
      version: 1,
      currency: 'USD',
      unit: 'per_1m_tokens',
      source: 'SPEC-SAMPLE-001 テスト用',
      cacheMultipliers: { read: 0.1, write5m: 1.25, write1h: 2.0 },
      models: { 'gpt-5.5': { input: 10, output: 50 } },
    };
    const cost = estimateRecordsCost([usageRecord], table);
    expect(cost.byModel['gpt-5.5']?.messages).toBe(0);
    expect(cost.byModel['gpt-5.5']?.total).toBeGreaterThan(0);
    expect(cost.total).toBeCloseTo((400 / 1e6) * 10 + (50 / 1e6) * 50 + (600 / 1e6) * 1, 10);
  });

  it('SPEC-CODEX-092: Claude ソースの集計値・コストは従来と一致する（既存テスト不変）', () => {
    // usage の無いレコードと usage 付き assistant レコードの従来挙動が変わらないことを確認する
    const assistant: IndexRecord = {
      ...usageRecord,
      kind: 'assistant',
      subtype: undefined,
      type: 'assistant',
      model: 'claude-fable-5',
    };
    const summary = createSummary();
    addToSummary(summary, assistant);
    expect(summary.assistantCount).toBe(1);
    expect(summary.models['claude-fable-5']).toMatchObject({ messages: 1, input: 400 });

    const noUsage: IndexRecord = { offset: 0, length: 10, type: 'user', kind: 'user' };
    expect(tokenTotals([noUsage])).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
  });
});
