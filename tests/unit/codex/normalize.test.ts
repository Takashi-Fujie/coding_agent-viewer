/**
 * SPEC-CODEX-050〜065: Codex rollout の会話正規化。仕様は docs/design/CODEX.md（Issue #29）。
 *
 * 行は合成データをテスト内で組み立てる（フィクスチャは耐性系 062 のみ使用）。
 * 正規化はステートフル（turn_context の model を後続行へ関連付ける）なので、
 * テストごとに createCodexNormalizer() を作り直して行列を流す。
 */
import { describe, expect, it } from 'vitest';
import {
  createCodexNormalizer,
  normalizeCodexBody,
} from '../../../server/sources/codex-normalize.js';
import { scanFile } from '../../../server/core/scan.js';
import type { IndexRecord } from '../../../server/core/types.js';
import { fileURLToPath } from 'node:url';
import { pick } from '../../helpers/fixtures.js';

const EDGE_FIXTURE = fileURLToPath(new URL('../../fixtures/codex/rollout-edge.jsonl', import.meta.url));

const at = (sec: number): string => `2026-08-08T00:00:${String(sec).padStart(2, '0')}.000Z`;

const sessionMeta = {
  timestamp: at(0),
  type: 'session_meta',
  payload: {
    id: '00000000-0000-7000-8000-000000000001',
    cwd: '/home/user/synthetic-project',
    cli_version: '0.147.0',
    source: 'cli',
  },
};

const turnContext = (model = 'gpt-5.5') => ({
  timestamp: at(1),
  type: 'turn_context',
  payload: { turn_id: 'turn-001', cwd: '/home/user/synthetic-project', model },
});

const userMessage = (text: string) => ({
  timestamp: at(2),
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

const assistantMessage = (text = '<synthetic> 応答') => ({
  timestamp: at(3),
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
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

describe('Codex レコード正規化', () => {
  it('SPEC-CODEX-050: response_item の assistant message は kind assistant になり直近の turn_context.model が付く', () => {
    const records = normalizeAll([sessionMeta, turnContext('gpt-5.5'), assistantMessage()]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'assistant', model: 'gpt-5.5' });
    expect(records[0]?.preview).toContain('<synthetic> 応答');
  });

  it('SPEC-CODEX-051: turn_context 出現前の assistant 系レコードは model が undefined のまま例外を投げない', () => {
    const records = normalizeAll([
      assistantMessage(),
      { timestamp: at(2), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '<synthetic>' }] } },
    ]);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.kind).toBe('assistant');
      expect(record.model).toBeUndefined();
    }
  });

  it('SPEC-CODEX-052: response_item の実ユーザー入力は kind user になり isToolResult が付かない', () => {
    const records = normalizeAll([sessionMeta, userMessage('<synthetic> 依頼文')]);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe('user');
    expect(records[0]?.isToolResult).toBeFalsy();
    expect(records[0]?.preview).toContain('依頼文');
  });

  it('SPEC-CODEX-053: 本文先頭が既知注入パターンの user message と developer message は kind attachment になる', () => {
    const injected = [
      '<environment_context>\n<synthetic> env</environment_context>',
      '<recommended_plugins>\n<synthetic> plugins</recommended_plugins>',
      '<skill>\n<synthetic> skill</skill>',
      '<realtime_delegation>\n<synthetic> delegation</realtime_delegation>',
      '# AGENTS.md instructions for /home/user/synthetic-project\n<synthetic>',
    ];
    const records = normalizeAll(injected.map((text) => userMessage(text)));
    expect(records).toHaveLength(injected.length);
    for (const record of records) {
      expect(record.kind).toBe('attachment');
      expect(record.attachmentType).toBe('injected');
    }

    const developer = normalizeAll([
      { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<synthetic> 指示' }] } },
    ]);
    expect(developer[0]).toMatchObject({ kind: 'attachment', attachmentType: 'developer' });
  });

  it('SPEC-CODEX-054: 既知パターンに合わない user message は kind user のまま残る（安全側）', () => {
    // タグが「先頭以外」にある実入力はパターン誤爆させない（実測で 33 件観測した形）
    const records = normalizeAll([
      userMessage('<synthetic> 本文の途中に <skill> が出てくる実入力'),
      userMessage('<synthetic> パターンに合わない未知の注入かもしれない本文'),
    ]);
    expect(records.map((r) => r.kind)).toEqual(['user', 'user']);
  });

  it('SPEC-CODEX-055: reasoning は kind assistant・hasThinking=true になる', () => {
    const records = normalizeAll([
      turnContext('gpt-5.5'),
      { timestamp: at(2), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '<synthetic> thinking' }], encrypted_content: 'x' } },
    ]);
    expect(records[0]).toMatchObject({ kind: 'assistant', hasThinking: true, model: 'gpt-5.5' });
    expect(records[0]?.preview).toContain('thinking');
  });

  it('SPEC-CODEX-056: function_call / custom_tool_call / tool_search_call は kind assistant になり toolUses に call_id と name を持つ', () => {
    const records = normalizeAll([
      turnContext(),
      { timestamp: at(2), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["echo"]}', call_id: 'call-001' } },
      { timestamp: at(3), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '<synthetic>', call_id: 'call-002' } },
      { timestamp: at(4), type: 'response_item', payload: { type: 'tool_search_call', call_id: 'call-003' } },
    ]);
    expect(records).toHaveLength(3);
    expect(records[0]?.toolUses).toEqual([{ id: 'call-001', name: 'shell' }]);
    expect(records[1]?.toolUses).toEqual([{ id: 'call-002', name: 'apply_patch' }]);
    expect(records[2]?.toolUses?.[0]?.id).toBe('call-003');
    for (const record of records) expect(record.kind).toBe('assistant');
  });

  it('SPEC-CODEX-057: function_call_output / custom_tool_call_output / tool_search_output は kind user・isToolResult=true・toolResultFor=call_id になる', () => {
    const records = normalizeAll([
      { timestamp: at(2), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-001', output: '<synthetic> ok' } },
      { timestamp: at(3), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-002', output: '<synthetic> done' } },
      { timestamp: at(4), type: 'response_item', payload: { type: 'tool_search_output', call_id: 'call-003' } },
    ]);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ kind: 'user', isToolResult: true, toolResultFor: 'call-001' });
    expect(records[1]?.toolResultFor).toBe('call-002');
    expect(records[2]?.toolResultFor).toBe('call-003');
  });

  it('SPEC-CODEX-058: event_msg の agent_message / agent_reasoning / user_message / token_count はレコードを生成しない', () => {
    const records = normalizeAll([
      { timestamp: at(2), type: 'event_msg', payload: { type: 'agent_message', message: '<synthetic> 応答' } },
      { timestamp: at(3), type: 'event_msg', payload: { type: 'agent_reasoning', text: '<synthetic>' } },
      { timestamp: at(4), type: 'event_msg', payload: { type: 'user_message', message: '<synthetic> 依頼文' } },
      { timestamp: at(5), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 100 } } } },
    ]);
    expect(records).toHaveLength(0);
  });

  it('SPEC-CODEX-059: call_id が正本と結ばれる *_end はレコードを生成せず、結ばれない *_end は kind user・isToolResult の独立レコードになる', () => {
    const records = normalizeAll([
      { timestamp: at(2), type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'call-001' } },
      { timestamp: at(3), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-001', output: '<synthetic>' } },
      { timestamp: at(4), type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'call-001', exit_code: 0 } },
      { timestamp: at(5), type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'call-999', result: '<synthetic>' } },
    ]);
    // call / output / 独立 *_end の 3 件（結ばれた exec_command_end は消える）
    expect(records).toHaveLength(3);
    const orphan = pick(records, (r) => r.toolResultFor === 'call-999', '独立 *_end');
    expect(orphan).toMatchObject({ kind: 'user', isToolResult: true });
  });

  it('SPEC-CODEX-060: session_meta / turn_context / world_state / thread_settings_applied はレコードを生成せず、sessionId・cwd・version が後続レコードへ引き継がれる', () => {
    const records = normalizeAll([
      sessionMeta,
      { timestamp: at(1), type: 'world_state', payload: { full: true } },
      { timestamp: at(1), type: 'event_msg', payload: { type: 'thread_settings_applied' } },
      turnContext(),
      userMessage('<synthetic> 依頼文'),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: '00000000-0000-7000-8000-000000000001',
      cwd: '/home/user/synthetic-project',
      version: '0.147.0',
      timestamp: at(2),
    });
  });

  it('SPEC-CODEX-061: task_complete は kind system になり task_started からの durationMs を持つ（timestamp 欠損時は durationMs 無しで生成する）', () => {
    const records = normalizeAll([
      { timestamp: at(2), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-001' } },
      { timestamp: at(7), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-001' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-002' } },
    ]);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: 'system', durationMs: 5000 });
    expect(records[1]?.kind).toBe('system');
    expect(records[1]?.durationMs).toBeUndefined();
  });

  it('SPEC-CODEX-062: 壊れた JSON 行・未知 type・output の無い call・巨大行を含むファイルでも正規化は例外を投げず、未知 type は kind unknown で残る', async () => {
    const normalizer = createCodexNormalizer();
    const result = await scanFile(EDGE_FIXTURE, 0, { normalizer });
    expect(result.skippedLineCount).toBeGreaterThanOrEqual(1);
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records.some((r) => r.kind === 'unknown')).toBe(true);
  });
});

describe('Codex 本文正規化（normalizeCodexBody）', () => {
  it('SPEC-CODEX-063: message の content が text ブロックへ、input_image が other ブロックへ変換される', () => {
    const body = normalizeCodexBody({
      timestamp: at(2),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<synthetic> 依頼文' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    });
    expect(body.role).toBe('user');
    expect(body.blocks[0]).toMatchObject({ type: 'text', text: '<synthetic> 依頼文' });
    expect(body.blocks[1]?.type).toBe('other');
  });

  it('SPEC-CODEX-064: reasoning の summary が thinking ブロックへ変換される', () => {
    const body = normalizeCodexBody({
      timestamp: at(2),
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '<synthetic> thinking' }], encrypted_content: 'x' },
    });
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]).toMatchObject({ type: 'thinking', text: '<synthetic> thinking' });
  });

  it('SPEC-CODEX-065: ツール呼び出しは tool_use ブロック（id=call_id・name・input）へ、output は tool_result ブロック（toolUseId=call_id）へ変換される', () => {
    const call = normalizeCodexBody({
      timestamp: at(2),
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"command":["echo"]}', call_id: 'call-001' },
    });
    expect(call.blocks[0]).toMatchObject({ type: 'tool_use', id: 'call-001', name: 'shell', input: { command: ['echo'] } });

    const output = normalizeCodexBody({
      timestamp: at(3),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-001', output: '<synthetic> ok' },
    });
    expect(output.blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 'call-001', text: '<synthetic> ok' });
  });
});
