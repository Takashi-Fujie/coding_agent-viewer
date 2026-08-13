/**
 * やりとり（exchange）分割とコスト合算（SPEC-CHAT-042/043/045）。仕様は docs/design/CHAT.md。
 */
import { describe, expect, it } from 'vitest';
import { buildExchanges, compactionMarkers } from '../../../web/src/lib/exchanges';
import type { MessageMeta } from '../../../web/src/lib/types';

function meta(index: number, over: Partial<MessageMeta>): MessageMeta {
  return {
    index,
    offset: index * 100,
    length: 100,
    type: over.kind ?? 'user',
    kind: 'user',
    ...over,
  } as MessageMeta;
}

const cost = (total: number) => ({ total, unknownModel: false });

describe('buildExchanges', () => {
  it('SPEC-CHAT-042: sidechain と tool_result を除く user レコードごとにやりとりを開始する', () => {
    const records = [
      meta(0, { kind: 'user', preview: '1 件目' }),
      meta(1, { kind: 'assistant', cost: cost(0.01) }),
      meta(2, { kind: 'user', isToolResult: true, toolResultFor: 'tu1' }),
      meta(3, { kind: 'user', isSidechain: true }),
      meta(4, { kind: 'user', preview: '2 件目' }),
    ];

    const exchanges = buildExchanges(records);

    expect(exchanges).toHaveLength(2);
    expect(exchanges.map((e) => e.startIndex)).toEqual([0, 4]);
    expect(exchanges[0]?.preview).toBe('1 件目');
  });

  it('SPEC-CHAT-043: 全やりとりのコスト合計（sidechain 含む）はレコード全体の合計と一致する', () => {
    const records = [
      meta(0, { kind: 'user' }),
      meta(1, { kind: 'assistant', cost: cost(0.01) }),
      meta(2, { kind: 'assistant', isSidechain: true, cost: cost(0.02) }),
      meta(3, { kind: 'user' }),
      meta(4, { kind: 'assistant', cost: cost(0.04) }),
    ];

    const exchanges = buildExchanges(records);
    const total = exchanges.reduce((a, e) => a + e.total, 0);

    expect(exchanges.map((e) => e.total)).toEqual([0.03, 0.04]);
    expect(total).toBeCloseTo(0.07, 10);
  });

  it('SPEC-CHAT-045: compact_boundary より前に開始したやりとりは compacted になる', () => {
    const records = [
      meta(0, { kind: 'user' }),
      meta(1, { kind: 'assistant', cost: cost(0.01) }),
      meta(2, { kind: 'system', subtype: 'compact_boundary' }),
      meta(3, { kind: 'user' }),
      meta(4, { kind: 'assistant', cost: cost(0.02) }),
    ];

    const exchanges = buildExchanges(records);

    expect(exchanges.map((e) => e.compacted)).toEqual([true, false]);
    // compacted でもコスト合計には含まれる（整合を崩さない）
    expect(exchanges.reduce((a, e) => a + e.total, 0)).toBeCloseTo(0.03, 10);
  });

  it('SPEC-CHAT-080: compactionMarkers は境界より前に開始したやりとり数を位置として返し、境界が無ければ空になる', () => {
    const records = [
      meta(0, { kind: 'user' }),
      meta(1, { kind: 'assistant', cost: cost(0.01) }),
      meta(2, { kind: 'system', subtype: 'compact_boundary' }),
      meta(3, { kind: 'user' }),
      meta(4, { kind: 'system', subtype: 'compact_boundary' }),
    ];
    const exchanges = buildExchanges(records);

    // 境界 index 2 の前に開始したやりとりは 1 件、境界 index 4 の前は 2 件
    expect(compactionMarkers(records, exchanges)).toEqual([1, 2]);

    const plain = [meta(0, { kind: 'user' }), meta(1, { kind: 'assistant', cost: cost(0.01) })];
    expect(compactionMarkers(plain, buildExchanges(plain))).toEqual([]);
  });
});
