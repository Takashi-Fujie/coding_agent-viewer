/**
 * 表示行への平坦化と sidechain 分離（SPEC-CHAT-020/025/030）。仕様は docs/design/CHAT.md。
 */
import { describe, expect, it } from 'vitest';
import { buildRows, createRowBuilder } from '../../../web/src/lib/thread';
import type { MessageMeta } from '../../../web/src/lib/types';

let seq = 0;

function meta(over: Partial<MessageMeta>): MessageMeta {
  seq += 1;
  return {
    index: over.index ?? seq,
    offset: seq * 100,
    length: 100,
    type: over.kind ?? 'user',
    kind: 'user',
    ...over,
  } as MessageMeta;
}

describe('buildRows', () => {
  it('SPEC-CHAT-020: tool_use と tool_result を tool_use_id で対応付け、独立した行にしない', () => {
    const assistant = meta({
      index: 0,
      kind: 'assistant',
      uuid: 'a1',
      toolUses: [{ id: 'tu1', name: 'Bash' }],
    });
    const result = meta({
      index: 1,
      kind: 'user',
      uuid: 'u1',
      isToolResult: true,
      toolResultFor: 'tu1',
    });

    const rows = buildRows([assistant, result]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.type !== 'message') throw new Error('message 行が先頭にありません');
    expect(row.record.uuid).toBe('a1');
    expect(row.toolResults['tu1']?.uuid).toBe('u1');
  });

  it('SPEC-CHAT-025: メイン列・区切り・sidechain グループを 1 次元の行配列へ平坦化する', () => {
    const records = [
      meta({ index: 0, kind: 'user', uuid: 'u1', preview: '調べて' }),
      meta({ index: 1, kind: 'assistant', uuid: 'a1' }),
      meta({ index: 2, kind: 'system', subtype: 'turn_duration', durationMs: 42_000 }),
      meta({ index: 3, kind: 'title', title: '無関係なメタ行' }),
      meta({ index: 4, kind: 'system', subtype: 'compact_boundary' }),
      meta({ index: 5, kind: 'user', uuid: 'u2', preview: '続けて' }),
    ];

    expect(buildRows(records).map((r) => r.type)).toEqual([
      'message',
      'message',
      'turn',
      'compact',
      'message',
    ]);
  });

  it('SPEC-CHAT-030: isSidechain のレコードを parentUuid で連結して分岐にまとめる', () => {
    const records = [
      meta({ index: 0, kind: 'user', uuid: 'u1' }),
      meta({ index: 1, kind: 'assistant', uuid: 'a1', toolUses: [{ id: 'tu1', name: 'Agent', subagentType: 'Explore' }] }),
      meta({ index: 2, kind: 'user', uuid: 's1', parentUuid: null, isSidechain: true, preview: '洗い出して' }),
      meta({ index: 3, kind: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, model: 'claude-haiku-4-5' }),
      meta({ index: 4, kind: 'assistant', uuid: 'a2', parentUuid: 'a1' }),
      // 2 本目の分岐（並列 subagent の interleave を模す）
      meta({ index: 5, kind: 'user', uuid: 's3', parentUuid: null, isSidechain: true }),
    ];

    const rows = buildRows(records);

    expect(rows.map((r) => r.type)).toEqual(['message', 'message', 'sidechain', 'message', 'sidechain']);
    const branch = rows[2];
    if (branch?.type !== 'sidechain') throw new Error('sidechain 行がありません');
    expect(branch.records.map((r) => r.uuid)).toEqual(['s1', 's2']);
  });
});

describe('createRowBuilder', () => {
  it('SPEC-LIVE-060: 増分適用で変化のない既存行の参照が保たれ、新着行だけが末尾に追加される', () => {
    const builder = createRowBuilder();
    builder.append([
      meta({ index: 0, kind: 'user', uuid: 'u1', preview: '調べて' }),
      meta({ index: 1, kind: 'assistant', uuid: 'a1' }),
    ]);
    const before = builder.rows();

    builder.append([
      meta({ index: 2, kind: 'user', uuid: 'u2', preview: '続けて' }),
      meta({ index: 3, kind: 'assistant', uuid: 'a2' }),
    ]);
    const after = builder.rows();

    expect(after).toHaveLength(4);
    // 既存行はオブジェクト参照ごと維持される
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]?.type).toBe('message');
    expect(after[3]?.type).toBe('message');
    // rows() は呼び出しごとに新しい配列を返す（React の変更検知用）
    expect(after).not.toBe(before);
  });

  it('SPEC-LIVE-061: 追記された tool_result は発行元 assistant 行に取り付き、その行だけ参照が置き換わる', () => {
    const builder = createRowBuilder();
    builder.append([
      meta({ index: 0, kind: 'user', uuid: 'u1' }),
      meta({ index: 1, kind: 'assistant', uuid: 'a1', toolUses: [{ id: 'tu1', name: 'Bash' }] }),
    ]);
    const before = builder.rows();

    builder.append([
      meta({ index: 2, kind: 'user', uuid: 'r1', isToolResult: true, toolResultFor: 'tu1' }),
    ]);
    const after = builder.rows();

    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    // 発行元の行だけが新しい参照になり、tool_result を保持する
    expect(after[1]).not.toBe(before[1]);
    const owner = after[1];
    if (owner?.type !== 'message') throw new Error('assistant 行がありません');
    expect(owner.toolResults['tu1']?.uuid).toBe('r1');
    // 置き換え前の行オブジェクトは変異していない（copy-on-write）
    const old = before[1];
    if (old?.type !== 'message') throw new Error('assistant 行がありません');
    expect(old.toolResults['tu1']).toBeUndefined();
  });

  it('SPEC-LIVE-062: 追記された sidechain の続きは既存の分岐行に連結され、その行だけ参照が置き換わる', () => {
    const builder = createRowBuilder();
    builder.append([
      meta({ index: 0, kind: 'user', uuid: 'u1' }),
      meta({ index: 1, kind: 'user', uuid: 's1', parentUuid: null, isSidechain: true }),
    ]);
    const before = builder.rows();

    builder.append([
      meta({ index: 2, kind: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true }),
    ]);
    const after = builder.rows();

    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    const branch = after[1];
    if (branch?.type !== 'sidechain') throw new Error('sidechain 行がありません');
    expect(branch.records.map((r) => r.uuid)).toEqual(['s1', 's2']);
    const old = before[1];
    if (old?.type !== 'sidechain') throw new Error('sidechain 行がありません');
    expect(old.records).toHaveLength(1);
  });

  it('SPEC-LIVE-063: 増分適用の結果は同じレコード列を一括で平坦化した結果と一致する', () => {
    const records = [
      meta({ index: 0, kind: 'user', uuid: 'u1', preview: '調べて' }),
      meta({ index: 1, kind: 'assistant', uuid: 'a1', toolUses: [{ id: 'tu1', name: 'Agent' }] }),
      meta({ index: 2, kind: 'user', uuid: 's1', parentUuid: null, isSidechain: true }),
      meta({ index: 3, kind: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true }),
      meta({ index: 4, kind: 'user', uuid: 'r1', isToolResult: true, toolResultFor: 'tu1' }),
      meta({ index: 5, kind: 'system', subtype: 'turn_duration', durationMs: 1000 }),
      meta({ index: 6, kind: 'title', title: '隠しメタ' }),
      meta({ index: 7, kind: 'system', subtype: 'compact_boundary' }),
      meta({ index: 8, kind: 'user', uuid: 'u2', preview: '続けて' }),
    ];

    const builder = createRowBuilder();
    // 1 件ずつの追記でも一括平坦化と同じ結果になる
    for (const record of records) builder.append([record]);

    expect(builder.rows()).toEqual(buildRows(records));
    expect(builder.count).toBe(records.length);
  });

  it('SPEC-CHAT-083: 増分 append をまたいでも compact 区切りの通し番号が連番で継続する', () => {
    const builder = createRowBuilder();
    builder.append([
      meta({ index: 0, kind: 'user', uuid: 'u1' }),
      meta({ index: 1, kind: 'system', subtype: 'compact_boundary' }),
    ]);
    builder.append([
      meta({ index: 2, kind: 'user', uuid: 'u2' }),
      meta({ index: 3, kind: 'system', subtype: 'compact_boundary' }),
    ]);

    const seqs = builder
      .rows()
      .filter((row) => row.type === 'compact')
      .map((row) => (row.type === 'compact' ? row.seq : undefined));
    expect(seqs).toEqual([1, 2]);
  });
});
