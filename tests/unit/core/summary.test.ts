/**
 * セッション要約（横断集計）のテスト。仕様は docs/spec/SPEC-CORE.md。
 *
 * 要約はミュータブルな累積状態そのものをキャッシュに保存する。増分更新時は
 * 保存済み要約に差分レコードを足すだけで全再構築と一致する（SPEC-CORE-046）。
 */
import { describe, it, expect } from 'vitest';
import { addToSummary, createSummary } from '../../../server/core/summary.js';
import { normalizeRecord } from '../../../server/core/normalize.js';
import { scanFile } from '../../../server/core/scan.js';
import type { IndexRecord } from '../../../server/core/types.js';
import { SAMPLE_FIXTURE, assistantLine } from '../../helpers/fixtures.js';

const at = { offset: 0, length: 1 };

function summarize(raws: unknown[]) {
  const summary = createSummary();
  for (const raw of raws) {
    const record = normalizeRecord(raw, at);
    if (record) addToSummary(summary, record);
  }
  return summary;
}

describe('createSummary / addToSummary', () => {
  it('SPEC-CORE-030: model 別に input / output / cacheRead / cacheCreation を合計する', () => {
    const usage = (input: number, output: number) => ({
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 },
    });

    const summary = summarize([
      assistantLine({ uuid: 'a1', model: 'claude-sonnet-5', usage: usage(1, 2) }),
      assistantLine({ uuid: 'a2', model: 'claude-sonnet-5', usage: usage(3, 4) }),
      assistantLine({ uuid: 'a3', model: 'claude-opus-5', usage: usage(5, 6) }),
    ]);

    expect(summary.models['claude-sonnet-5']).toEqual({
      messages: 2,
      input: 4,
      output: 6,
      cacheRead: 200,
      cacheCreation: 20,
      cacheCreation5m: 12,
      cacheCreation1h: 8,
      webSearch: 0,
      webFetch: 0,
    });
    expect(summary.models['claude-opus-5']?.messages).toBe(1);
    expect(summary.models['claude-opus-5']?.input).toBe(5);
  });

  it('SPEC-CORE-031: tool_use 名ごとの呼び出し回数を集計する', () => {
    const summary = summarize([
      assistantLine({
        uuid: 'a1',
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ],
      }),
      assistantLine({
        uuid: 'a2',
        content: [
          { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't4', name: 'Agent', input: { subagent_type: 'sample-reviewer' } },
          { type: 'tool_use', id: 't5', name: 'Skill', input: { skill: 'sample-skill' } },
        ],
      }),
    ]);

    expect(summary.toolUseCounts).toEqual({ Bash: 2, Read: 1, Agent: 1, Skill: 1 });
    expect(summary.subagentTypes).toEqual({ 'sample-reviewer': 1 });
    expect(summary.skills).toEqual({ 'sample-skill': 1 });
  });

  it('SPEC-CORE-032: 最初と最後の timestamp、assistant / user のメッセージ件数を集計する', () => {
    const summary = summarize([
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'a' } },
      assistantLine({ uuid: 'a1', timestamp: '2026-01-01T00:00:05.000Z' }),
      { type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:09.000Z', message: { role: 'user', content: 'b' } },
      // timestamp を持たないレコードは最初 / 最後の判定に影響しない
      { type: 'mode', mode: 'default' },
    ]);

    expect(summary.firstTimestamp).toBe('2026-01-01T00:00:01.000Z');
    expect(summary.lastTimestamp).toBe('2026-01-01T00:00:09.000Z');
    expect(summary.userCount).toBe(2);
    expect(summary.assistantCount).toBe(1);
    expect(summary.recordCount).toBe(4);
  });

  it('SPEC-CORE-032: 時刻が前後して現れても最小 / 最大を保つ', () => {
    const summary = summarize([
      assistantLine({ uuid: 'a1', timestamp: '2026-01-01T00:00:05.000Z' }),
      assistantLine({ uuid: 'a2', timestamp: '2026-01-01T00:00:01.000Z' }),
    ]);

    expect(summary.firstTimestamp).toBe('2026-01-01T00:00:01.000Z');
    expect(summary.lastTimestamp).toBe('2026-01-01T00:00:05.000Z');
  });

  it('SPEC-CORE-033: セッションのタイトルは customTitle を aiTitle より優先する', () => {
    const aiFirst = summarize([
      { type: 'ai-title', aiTitle: 'AI 生成' },
      { type: 'custom-title', customTitle: '手動' },
    ]);
    // 出現順が逆でも custom が勝つ（後から来た ai-title で上書きされない）
    const customFirst = summarize([
      { type: 'custom-title', customTitle: '手動' },
      { type: 'ai-title', aiTitle: 'AI 生成' },
    ]);
    const aiOnly = summarize([{ type: 'ai-title', aiTitle: 'AI 生成' }]);

    expect(aiFirst.title).toBe('手動');
    expect(customFirst.title).toBe('手動');
    expect(aiOnly.title).toBe('AI 生成');
  });

  it('SPEC-DASH-120: compact_boundary レコードを compactionCount として数え、無いセッションでは 0 になる', () => {
    const counted = summarize([
      assistantLine({ uuid: 'a1' }),
      { type: 'system', subtype: 'compact_boundary', uuid: 'sys1' },
      // 他の system（turn_duration 等）は数えない
      { type: 'system', subtype: 'turn_duration', durationMs: 1000, uuid: 'sys2' },
      { type: 'system', subtype: 'compact_boundary', uuid: 'sys3' },
    ]);
    expect(counted.compactionCount).toBe(2);

    const none = summarize([assistantLine({ uuid: 'a1' })]);
    expect(none.compactionCount).toBe(0);
  });

  it('SPEC-CORE-014: synthetic メッセージを件数として区別できる', async () => {
    const result = await scanFile(SAMPLE_FIXTURE);
    const summary = createSummary();
    result.records.forEach((r: IndexRecord) => addToSummary(summary, r));

    expect(summary.syntheticCount).toBe(1);
    expect(summary.models['<synthetic>']?.messages).toBe(1);
    expect(summary.prNumbers).toEqual([42]);
    expect(summary.title).toBe('サンプルセッション（手動命名）');
  });
});
