/**
 * コスト計算のテスト。仕様は docs/spec/SPEC-COST.md。
 *
 * 金額は浮動小数になるので toBeCloseTo で比較する。丸めは表示層の責務とし、
 * ここでは丸めない（丸めてから合計すると誤差が積み上がるため）。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRICE_TABLE_PATH,
  estimateCost,
  estimateRecordsCost,
  loadPriceTable,
  normalizeModelId,
} from '../../server/cost.js';
import type { PriceTable } from '../../server/cost.js';
import type { IndexRecord, NormalizedUsage } from '../../server/core/types.js';

/** テスト用の決定的な価格表（実ファイルの変動に引きずられないため）。 */
const table: PriceTable = {
  version: 1,
  currency: 'USD',
  unit: 'per_1m_tokens',
  source: 'テスト用ダミー',
  cacheMultipliers: { read: 0.1, write5m: 1.25, write1h: 2.0 },
  models: {
    'sample-basic': { input: 10, output: 50 },
    'sample-fast': { input: 5, output: 25, fast: { input: 10, output: 50 } },
    'sample-intro': { input: 3, output: 15, intro: { input: 2, output: 10, until: '2026-08-31' } },
    'claude-haiku-4-5': { input: 1, output: 5 },
  },
};

const usage = (over: Partial<NormalizedUsage> = {}): NormalizedUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  webSearch: 0,
  webFetch: 0,
  ...over,
});

describe('価格表', () => {
  it('SPEC-COST-001: 単価を server/pricing.json から読み込む', async () => {
    const loaded = await loadPriceTable(DEFAULT_PRICE_TABLE_PATH);

    expect(DEFAULT_PRICE_TABLE_PATH).toMatch(/server[/\\]pricing\.json$/);
    expect(loaded.cacheMultipliers).toEqual({ read: 0.1, write5m: 1.25, write1h: 2.0 });
    expect(loaded.models['claude-opus-5']).toMatchObject({ input: 5, output: 25 });
    expect(loaded.models['claude-sonnet-5']?.intro).toMatchObject({ input: 2, output: 10, until: '2026-08-31' });
    // 出典が不明な旧世代モデルを推測で埋めていないこと
    expect(loaded.models['claude-opus-4-1']).toBeUndefined();
    expect(loaded.source).toContain('claude-api');
  });

  it('SPEC-COST-002: $/1M tokens として input / output を計算する', () => {
    const cost = estimateCost({ model: 'sample-basic', usage: usage({ input: 1_000_000, output: 200_000 }) }, table);

    expect(cost.input).toBeCloseTo(10, 10);
    expect(cost.output).toBeCloseTo(10, 10);
    expect(cost.total).toBeCloseTo(20, 10);
  });

  it('SPEC-COST-003: モデル ID 末尾の日付サフィックスを除去して突き合わせる', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelId('claude-sonnet-5')).toBe('claude-sonnet-5');
    // 8 桁でない数字サフィックスは除去しない（バージョン番号を壊さないため）
    expect(normalizeModelId('claude-opus-4-5')).toBe('claude-opus-4-5');

    const cost = estimateCost(
      { model: 'claude-haiku-4-5-20251001', usage: usage({ input: 1_000_000 }) },
      table,
    );

    expect(cost.unknownModel).toBe(false);
    expect(cost.model).toBe('claude-haiku-4-5');
    expect(cost.input).toBeCloseTo(1, 10);
  });
});

describe('キャッシュ単価', () => {
  it('SPEC-COST-010: cache read を input 単価 x0.1 で計算する', () => {
    const cost = estimateCost({ model: 'sample-basic', usage: usage({ cacheRead: 1_000_000 }) }, table);

    expect(cost.cacheRead).toBeCloseTo(1, 10);
    expect(cost.total).toBeCloseTo(1, 10);
  });

  it('SPEC-COST-011: cache write 5m を input 単価 x1.25 で計算する', () => {
    const cost = estimateCost(
      { model: 'sample-basic', usage: usage({ cacheCreation: 1_000_000, cacheCreation5m: 1_000_000 }) },
      table,
    );

    expect(cost.cacheWrite5m).toBeCloseTo(12.5, 10);
    expect(cost.cacheWrite1h).toBe(0);
    expect(cost.cacheSplitAssumed).toBe(false);
  });

  it('SPEC-COST-012: cache write 1h を input 単価 x2.0 で計算する', () => {
    const cost = estimateCost(
      { model: 'sample-basic', usage: usage({ cacheCreation: 1_000_000, cacheCreation1h: 1_000_000 }) },
      table,
    );

    expect(cost.cacheWrite1h).toBeCloseTo(20, 10);
    expect(cost.cacheWrite5m).toBe(0);
  });

  it('SPEC-COST-013: 5m / 1h の内訳が欠けて合計だけある場合は 5m 単価で計算し cacheSplitAssumed を立てる', () => {
    const cost = estimateCost({ model: 'sample-basic', usage: usage({ cacheCreation: 1_000_000 }) }, table);

    expect(cost.cacheSplitAssumed).toBe(true);
    expect(cost.cacheWrite5m).toBeCloseTo(12.5, 10);
    expect(cost.cacheWrite1h).toBe(0);
  });
});

describe('導入価格', () => {
  it('SPEC-COST-020: timestamp が introUntil 以前なら導入価格を適用する', () => {
    const cost = estimateCost(
      { model: 'sample-intro', timestamp: '2026-08-02T00:00:00.000Z', usage: usage({ input: 1_000_000, output: 1_000_000 }) },
      table,
    );

    expect(cost.introApplied).toBe(true);
    expect(cost.input).toBeCloseTo(2, 10);
    expect(cost.output).toBeCloseTo(10, 10);
  });

  it('SPEC-COST-020: introUntil 当日は導入価格を適用する（境界を含む）', () => {
    const cost = estimateCost(
      { model: 'sample-intro', timestamp: '2026-08-31T23:59:59.999Z', usage: usage({ input: 1_000_000 }) },
      table,
    );

    expect(cost.introApplied).toBe(true);
    expect(cost.input).toBeCloseTo(2, 10);
  });

  it('SPEC-COST-021: introUntil を過ぎたら通常価格を適用する', () => {
    const cost = estimateCost(
      { model: 'sample-intro', timestamp: '2026-09-01T00:00:00.000Z', usage: usage({ input: 1_000_000 }) },
      table,
    );

    expect(cost.introApplied).toBe(false);
    expect(cost.input).toBeCloseTo(3, 10);
  });

  it('SPEC-COST-022: timestamp が無ければ導入価格を適用しない', () => {
    const cost = estimateCost({ model: 'sample-intro', usage: usage({ input: 1_000_000 }) }, table);

    expect(cost.introApplied).toBe(false);
    expect(cost.input).toBeCloseTo(3, 10);
  });
});

describe('未知モデルと fast mode', () => {
  it('SPEC-COST-030: 価格表に無いモデルは cost 0 とし unknownModel を立てる', () => {
    const cost = estimateCost(
      { model: 'claude-imaginary-9', usage: usage({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }) },
      table,
    );

    expect(cost.unknownModel).toBe(true);
    expect(cost.total).toBe(0);
    expect(cost.input).toBe(0);
    expect(cost.cacheRead).toBe(0);
  });

  it('SPEC-COST-030: モデルが未指定の場合も unknownModel として扱う', () => {
    const cost = estimateCost({ usage: usage({ input: 1_000_000 }) }, table);

    expect(cost.unknownModel).toBe(true);
    expect(cost.total).toBe(0);
  });

  it('SPEC-COST-031: <synthetic> は未知モデルとして扱う', () => {
    const cost = estimateCost({ model: '<synthetic>', usage: usage({ input: 1_000_000 }) }, table);

    expect(cost.unknownModel).toBe(true);
    expect(cost.total).toBe(0);
  });

  it('SPEC-COST-032: speed が fast のときは fast 単価を適用する', () => {
    const standard = estimateCost({ model: 'sample-fast', usage: usage({ input: 1_000_000 }) }, table);
    const fast = estimateCost({ model: 'sample-fast', speed: 'fast', usage: usage({ input: 1_000_000 }) }, table);

    expect(standard.fastApplied).toBe(false);
    expect(standard.input).toBeCloseTo(5, 10);
    expect(fast.fastApplied).toBe(true);
    expect(fast.input).toBeCloseTo(10, 10);
    expect(fast.unknownRate).toBe(false);
  });

  it('SPEC-COST-033: fast 単価が未定義のモデルで fast のときは unknownRate を立てる', () => {
    const cost = estimateCost({ model: 'sample-basic', speed: 'fast', usage: usage({ input: 1_000_000 }) }, table);

    expect(cost.unknownRate).toBe(true);
    expect(cost.fastApplied).toBe(false);
    // 0 円にはせず通常単価で暫定計算する（警告つきの推定値）
    expect(cost.input).toBeCloseTo(10, 10);
  });
});

describe('集計', () => {
  const record = (over: Partial<IndexRecord>): IndexRecord => ({
    offset: 0,
    length: 1,
    type: 'assistant',
    kind: 'assistant',
    usage: usage({ input: 1_000_000 }),
    ...over,
  });

  it('SPEC-COST-040: レコード群からモデル別コストと合計を集計する', () => {
    const summary = estimateRecordsCost(
      [
        record({ model: 'sample-basic' }),
        record({ model: 'sample-basic' }),
        record({ model: 'claude-haiku-4-5' }),
        // assistant 以外・usage の無いレコードは集計対象外
        record({ kind: 'user', type: 'user', usage: undefined, model: undefined }),
      ],
      table,
    );

    expect(summary.byModel['sample-basic']).toMatchObject({ messages: 2 });
    expect(summary.byModel['sample-basic']?.total).toBeCloseTo(20, 10);
    expect(summary.byModel['claude-haiku-4-5']?.total).toBeCloseTo(1, 10);
    expect(summary.total).toBeCloseTo(21, 10);
  });

  it('SPEC-COST-041: 未知モデル名の一覧を含める', () => {
    const summary = estimateRecordsCost(
      [
        record({ model: 'sample-basic' }),
        record({ model: '<synthetic>' }),
        record({ model: 'claude-imaginary-9' }),
        record({ model: 'claude-imaginary-9' }),
      ],
      table,
    );

    expect(summary.unknownModels).toEqual(['<synthetic>', 'claude-imaginary-9']);
    expect(summary.total).toBeCloseTo(10, 10);
  });

  it('SPEC-COST-042: 推定である旨のフラグと単価の出典を含める', () => {
    const summary = estimateRecordsCost([record({ model: 'sample-basic' })], table);

    expect(summary.estimated).toBe(true);
    expect(summary.source).toBe('テスト用ダミー');
    expect(summary.currency).toBe('USD');
  });
});

describe('Codex（OpenAI）モデル対応（Issue #30）', () => {
  const record = (over: Partial<IndexRecord>): IndexRecord => ({
    offset: 0,
    length: 1,
    type: 'assistant',
    kind: 'assistant',
    usage: usage({ input: 1_000_000 }),
    ...over,
  });

  /** cached input の割引率がモデルごとに異なるケース（o3 相当: input の 0.25 倍）。 */
  const codexTable: PriceTable = {
    ...table,
    models: {
      ...table.models,
      'sample-cache-explicit': { input: 2, output: 8, cacheRead: 0.5 },
    },
  };

  it('SPEC-COST-050: モデル単位の cacheRead 明示単価が倍率導出より優先して適用される', () => {
    const cost = estimateCost(
      { model: 'sample-cache-explicit', usage: usage({ cacheRead: 1_000_000 }) },
      codexTable,
    );
    // 倍率導出なら 2 × 0.1 = 0.2 だが、明示単価 0.5 を使う
    expect(cost.cacheRead).toBeCloseTo(0.5, 10);
  });

  it('SPEC-COST-051: cacheRead 明示単価の無いモデルは従来どおり input 単価 × read 倍率で計算される（既存結果不変）', () => {
    const cost = estimateCost(
      { model: 'sample-basic', usage: usage({ cacheRead: 1_000_000 }) },
      codexTable,
    );
    expect(cost.cacheRead).toBeCloseTo(1, 10); // 10 × 0.1
  });

  it('SPEC-COST-052: 価格表に出典確認済みの Codex モデルが載り、未確認の観測モデルは unknownModel 警告になる', async () => {
    const loaded = await loadPriceTable(DEFAULT_PRICE_TABLE_PATH);

    // OpenAI 公式価格ページ（2026-08-10 確認）で単価が取れたモデル
    expect(loaded.models['gpt-5.5']).toMatchObject({ input: 5, output: 30 });
    expect(loaded.models['gpt-5.4-mini']).toMatchObject({ input: 0.75, output: 4.5 });
    expect(loaded.models['gpt-5.3-codex']).toMatchObject({ input: 1.75, output: 14 });
    expect(loaded.models['o3']).toMatchObject({ input: 2, output: 8, cacheRead: 0.5 });
    expect(loaded.models['gpt-5.6-sol']).toMatchObject({ input: 5, output: 30 });
    expect(loaded.models['gpt-5.6-terra']).toMatchObject({ input: 2, output: 12 });
    expect(loaded.source).toContain('OpenAI');

    // 公式ページに無い観測モデルは推測で埋めず unknownModel 警告に回す
    expect(loaded.models['gpt-5-codex']).toBeUndefined();
    expect(loaded.models['gpt-5.1-codex']).toBeUndefined();
    const summary = estimateRecordsCost(
      [record({ model: 'gpt-5-codex' }), record({ model: 'gpt-5.1-codex' })],
      loaded,
    );
    expect(summary.unknownModels).toEqual(['gpt-5-codex', 'gpt-5.1-codex']);
  });
});
