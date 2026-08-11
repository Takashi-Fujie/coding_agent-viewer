/**
 * Codex rollout の正規化。仕様は docs/design/CODEX.md（Issue #29）。
 *
 * Codex 固有の解釈はすべてこのモジュールに閉じ込める（viewer・API・集計は
 * IndexRecord / MessageBody だけを見る）。normalize.ts と同じく、他プロセスが
 * 書いたログなので形が想定と違っても例外を投げず「取れたものだけ取る」。
 *
 * 正本は response_item 側（実測: agent_message と 330:330 で出現順 1:1・本文完全一致）。
 * event_msg の複製（agent_message / agent_reasoning / user_message）と token_count（#30）
 * は捨てる。注入判定は本文先頭パターンのみ（event_msg とのペアリングは event が
 * 常に後行するため増分走査で成立しない。実測 2026-08-09）。
 */
import { truncatePreview } from '../core/normalize.js';
import type { BodyBlock, MessageBody } from '../core/normalize.js';
import type { IndexRecord, NormalizedUsage, RecordLocation } from '../core/types.js';
import type { RecordNormalizer } from './types.js';

/**
 * token_count の累積値（total_token_usage）。usage 会計はこの累積値の「増分」で
 * 確定させる（last_token_usage は同一累積値の重複記録で多重計上するため読まない）。
 */
interface CumulativeUsage {
  input: number;
  cachedInput: number;
  output: number;
}

/** 増分再開のためにキャッシュへ保存する走査文脈。フィールドは最小限に保つ。 */
interface CodexScanState {
  sessionId?: string | undefined;
  cwd?: string | undefined;
  version?: string | undefined;
  /** 直近の turn_context.model。次の turn_context まで有効。 */
  model?: string | undefined;
  /** 直近の task_started の timestamp（task_complete の durationMs 算出用）。 */
  turnStartedAt?: string | undefined;
  /** 正本（function_call 等）で見た call_id。対応する *_end を捨てるための照合キー。 */
  toolCallIds: string[];
  /**
   * 直近の token_count 累積値（会計 epoch の基準）。これが無い旧キャッシュ（v4）から
   * 増分再開すると累積値を全額計上してしまうため、INDEX_SCHEMA_VERSION 5 で全再構築させる。
   */
  prevUsage?: CumulativeUsage | undefined;
}

/** 自動注入と判定する本文先頭パターン（実測: 注入 77 件中 73 件を判別）。 */
const INJECTION_TAGS = ['environment_context', 'recommended_plugins', 'skill', 'realtime_delegation'];
const AGENTS_MD_PREFIX = '# AGENTS.md instructions for ';

/** ツール呼び出しの正本 payload.type。call ↔ output は call_id で結ぶ。 */
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_search_call']);
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);

/** レコードを生成しない event_msg（複製・メタ）。token_count は usage 会計（#30）で別処理。 */
const DROPPED_EVENT_TYPES = new Set([
  'agent_message',
  'agent_reasoning',
  'user_message',
  'thread_settings_applied',
]);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** content 配列（input_text / output_text / text の part）からテキストを取り出す。 */
function textFromParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => asString(asObject(part)?.['text']) ?? '')
    .filter((t) => t.length > 0)
    .join('\n');
}

/** reasoning の summary 配列からテキストを取り出す。 */
function textFromSummary(summary: unknown): string {
  return textFromParts(summary);
}

/** 本文先頭が既知の注入パターンか（タグは先頭のみ。途中出現は実入力とみなす）。 */
function isInjectedText(text: string): boolean {
  const head = text.trimStart();
  if (head.startsWith(AGENTS_MD_PREFIX)) return true;
  return INJECTION_TAGS.some((tag) => head.startsWith(`<${tag}>`));
}

/** ISO timestamp 2 つの差 ms。どちらかが読めなければ undefined。 */
function durationBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const from = Date.parse(start);
  const to = Date.parse(end);
  return Number.isFinite(from) && Number.isFinite(to) ? to - from : undefined;
}

/** 欠損・不正値を 0 とみなす（未知の usage 形でも会計を落とさない）。 */
function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** token_count の payload から累積値を読む。info が無い・オブジェクトでなければ undefined。 */
function readCumulative(payload: Record<string, unknown>): CumulativeUsage | undefined {
  const info = asObject(payload['info']);
  if (!info) return undefined;
  const total = asObject(info['total_token_usage']) ?? {};
  return {
    input: toCount(total['input_tokens']),
    cachedInput: toCount(total['cached_input_tokens']),
    output: toCount(total['output_tokens']),
  };
}

function restorePrevUsage(value: unknown): CumulativeUsage | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  return {
    input: toCount(obj['input']),
    cachedInput: toCount(obj['cachedInput']),
    output: toCount(obj['output']),
  };
}

function restoreState(state: unknown): CodexScanState {
  const obj = asObject(state);
  const ids = Array.isArray(obj?.['toolCallIds'])
    ? (obj['toolCallIds'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  return {
    sessionId: asString(obj?.['sessionId']),
    cwd: asString(obj?.['cwd']),
    version: asString(obj?.['version']),
    model: asString(obj?.['model']),
    turnStartedAt: asString(obj?.['turnStartedAt']),
    toolCallIds: ids,
    prevUsage: restorePrevUsage(obj?.['prevUsage']),
  };
}

/**
 * Codex rollout の 1 走査分の正規化器。state は前回 serialize() の値（増分再開用）。
 */
export function createCodexNormalizer(state?: unknown): RecordNormalizer {
  const ctx = restoreState(state);
  const toolCallIds = new Set(ctx.toolCallIds);

  /** 全レコード共通のメタ（走査文脈由来のフィールドを含む）。 */
  function common(raw: Record<string, unknown>, location: RecordLocation) {
    return {
      offset: location.offset,
      length: location.length,
      timestamp: asString(raw['timestamp']),
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      version: ctx.version,
    };
  }

  function normalizeResponseItem(
    raw: Record<string, unknown>,
    payload: Record<string, unknown>,
    location: RecordLocation,
  ): IndexRecord | null {
    const payloadType = asString(payload['type']) ?? '';

    if (payloadType === 'message') {
      const role = asString(payload['role']);
      const text = textFromParts(payload['content']);

      if (role === 'assistant') {
        return {
          ...common(raw, location),
          type: payloadType,
          kind: 'assistant',
          model: ctx.model,
          preview: truncatePreview(text),
        };
      }
      if (role === 'developer' || (role === 'user' && isInjectedText(text))) {
        return {
          ...common(raw, location),
          type: payloadType,
          kind: 'attachment',
          attachmentType: role === 'developer' ? 'developer' : 'injected',
          preview: truncatePreview(text),
        };
      }
      if (role === 'user') {
        return {
          ...common(raw, location),
          type: payloadType,
          kind: 'user',
          preview: truncatePreview(text),
        };
      }
      // 未知 role は捨てずに残す（前方互換）
      return { ...common(raw, location), type: payloadType, kind: 'unknown' };
    }

    if (payloadType === 'reasoning') {
      return {
        ...common(raw, location),
        type: payloadType,
        kind: 'assistant',
        model: ctx.model,
        hasThinking: true,
        preview: truncatePreview(textFromSummary(payload['summary'])),
      };
    }

    if (TOOL_CALL_TYPES.has(payloadType)) {
      const callId = asString(payload['call_id']) ?? '';
      const name = asString(payload['name']) ?? payloadType;
      if (callId) toolCallIds.add(callId);
      const args = asString(payload['arguments']) ?? asString(payload['input']) ?? '';
      return {
        ...common(raw, location),
        type: payloadType,
        kind: 'assistant',
        model: ctx.model,
        toolUses: [{ id: callId, name }],
        preview: truncatePreview(`${name} ${args}`),
      };
    }

    if (TOOL_OUTPUT_TYPES.has(payloadType)) {
      return {
        ...common(raw, location),
        type: payloadType,
        kind: 'user',
        isToolResult: true,
        toolResultFor: asString(payload['call_id']),
        preview: truncatePreview(textFromParts(payload['output']) || (asString(payload['output']) ?? '')),
      };
    }

    return { ...common(raw, location), type: payloadType, kind: 'unknown' };
  }

  function normalizeEventMsg(
    raw: Record<string, unknown>,
    payload: Record<string, unknown>,
    location: RecordLocation,
  ): IndexRecord | null {
    const payloadType = asString(payload['type']) ?? '';

    if (DROPPED_EVENT_TYPES.has(payloadType)) return null;

    if (payloadType === 'token_count') {
      // usage 会計（#30）: セッション累積値の増分だけを計上する。
      // rate_limits は課金と無関係、last_token_usage は重複記録で多重計上するため読まない。
      const cumulative = readCumulative(payload);
      if (!cumulative) return null; // info: null・不正形は状態を変えずスキップ

      const prev = ctx.prevUsage ?? { input: 0, cachedInput: 0, output: 0 };
      ctx.prevUsage = cumulative;

      // 減少 = reset / compaction / resume 巻き戻り。会計 epoch を切り替え、
      // この行は計上せず新基準から数える（過大計上より過小計上に倒す。オーナー裁定・案 B）。
      if (
        cumulative.input < prev.input ||
        cumulative.cachedInput < prev.cachedInput ||
        cumulative.output < prev.output
      ) {
        return null;
      }

      const deltaInput = cumulative.input - prev.input;
      const deltaCached = cumulative.cachedInput - prev.cachedInput;
      const deltaOutput = cumulative.output - prev.output;
      if (deltaInput === 0 && deltaOutput === 0) return null; // 同一累積値の重複記録

      // cached は input の内数（実測契約）。増分単位では逆転し得るので負にクランプする。
      // reasoning は output の内数なので別掲しない。cache write 相当は Codex に未観測。
      const usage: NormalizedUsage = {
        input: Math.max(0, deltaInput - deltaCached),
        output: deltaOutput,
        cacheRead: deltaCached,
        cacheCreation: 0,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        webSearch: 0,
        webFetch: 0,
      };
      // kind system + subtype token_count は viewer のメイン列に出ない
      // （system の表示条件は compact_boundary か durationMs 有りのみ）。
      return {
        ...common(raw, location),
        type: payloadType,
        kind: 'system',
        subtype: payloadType,
        model: ctx.model,
        usage,
      };
    }

    if (payloadType === 'task_started') {
      ctx.turnStartedAt = asString(raw['timestamp']);
      return null;
    }

    if (payloadType === 'task_complete') {
      const durationMs = durationBetween(ctx.turnStartedAt, asString(raw['timestamp']));
      ctx.turnStartedAt = undefined;
      return {
        ...common(raw, location),
        type: payloadType,
        kind: 'system',
        subtype: payloadType,
        durationMs,
      };
    }

    if (payloadType === 'error') {
      return {
        ...common(raw, location),
        type: payloadType,
        kind: 'system',
        subtype: payloadType,
        preview: truncatePreview(asString(payload['message']) ?? ''),
      };
    }

    if (payloadType.endsWith('_end')) {
      const callId = asString(payload['call_id']);
      // 正本（call / output）と結ばれるイベントは重複なので捨てる
      if (callId !== undefined && toolCallIds.has(callId)) return null;
      return {
        ...common(raw, location),
        type: payloadType,
        kind: 'user',
        isToolResult: true,
        toolResultFor: callId,
        preview: truncatePreview(endEventText(payload)),
      };
    }

    return { ...common(raw, location), type: payloadType, kind: 'unknown' };
  }

  return {
    normalize(raw: unknown, location: RecordLocation): IndexRecord | null {
      const obj = asObject(raw);
      if (!obj) return null;

      const type = asString(obj['type']) ?? '';
      const payload = asObject(obj['payload']) ?? {};

      switch (type) {
        case 'session_meta':
          ctx.sessionId = asString(payload['id']) ?? ctx.sessionId;
          ctx.cwd = asString(payload['cwd']) ?? ctx.cwd;
          ctx.version = asString(payload['cli_version']) ?? ctx.version;
          return null;

        case 'turn_context':
          ctx.model = asString(payload['model']) ?? ctx.model;
          ctx.cwd = asString(payload['cwd']) ?? ctx.cwd;
          return null;

        case 'world_state':
          return null;

        case 'response_item':
          return normalizeResponseItem(obj, payload, location);

        case 'event_msg':
          return normalizeEventMsg(obj, payload, location);

        default:
          // 未知 top-level type は捨てない（前方互換）
          return { ...common(obj, location), type, kind: 'unknown' };
      }
    },

    serialize(): unknown {
      const snapshot: CodexScanState = { ...ctx, toolCallIds: [...toolCallIds] };
      return snapshot;
    },
  };
}

/** *_end イベントから表示テキストを取り出す（取れるものだけ）。 */
function endEventText(payload: Record<string, unknown>): string {
  return (
    asString(payload['stdout']) ??
    asString(payload['formatted_output']) ??
    asString(payload['result']) ??
    asString(payload['message']) ??
    textFromParts(payload['content'])
  );
}

/** *_end イベントの失敗判定（exec の exit_code ≠ 0、明示の success=false）。 */
function endEventIsError(payload: Record<string, unknown>): boolean {
  const exitCode = payload['exit_code'];
  if (typeof exitCode === 'number' && exitCode !== 0) return true;
  return payload['success'] === false;
}

/** arguments（JSON 文字列）を可能なら parse して返す。失敗時は生文字列のまま。 */
function parseArguments(value: unknown): unknown {
  const text = asString(value);
  if (text === undefined) return value;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Codex rollout の 1 行を表示用の本文へ正規化する（SPEC-CODEX-063〜065）。
 * 走査文脈を要しない（本文はその行の中で完結する）。
 */
export function normalizeCodexBody(raw: unknown): MessageBody {
  const obj = asObject(raw);
  const payload = asObject(obj?.['payload']);
  if (!obj || !payload) return { blocks: [] };

  const payloadType = asString(payload['type']) ?? '';

  if (payloadType === 'message') {
    const blocks: BodyBlock[] = [];
    const content = payload['content'];
    for (const item of Array.isArray(content) ? content : []) {
      const part = asObject(item);
      if (!part) continue;
      const partType = asString(part['type']) ?? '';
      const text = asString(part['text']);
      if (text !== undefined && (partType === 'input_text' || partType === 'output_text' || partType === 'text')) {
        blocks.push({ type: 'text', text });
      } else if (partType === 'input_image') {
        blocks.push({ type: 'other', text: '[画像]' });
      } else {
        blocks.push({ type: 'other', text: text ?? '' });
      }
    }
    return { role: asString(payload['role']), blocks };
  }

  if (payloadType === 'reasoning') {
    return { blocks: [{ type: 'thinking', text: textFromSummary(payload['summary']) }] };
  }

  if (TOOL_CALL_TYPES.has(payloadType)) {
    return {
      blocks: [
        {
          type: 'tool_use',
          id: asString(payload['call_id']),
          name: asString(payload['name']) ?? payloadType,
          input: parseArguments(payload['arguments'] ?? payload['input']),
        },
      ],
    };
  }

  if (TOOL_OUTPUT_TYPES.has(payloadType)) {
    return {
      blocks: [
        {
          type: 'tool_result',
          toolUseId: asString(payload['call_id']),
          text: textFromParts(payload['output']) || (asString(payload['output']) ?? ''),
        },
      ],
    };
  }

  if (payloadType.endsWith('_end')) {
    return {
      blocks: [
        {
          type: 'tool_result',
          toolUseId: asString(payload['call_id']),
          text: endEventText(payload),
          isError: endEventIsError(payload) ? true : undefined,
        },
      ],
    };
  }

  // error・未知 type は取れるテキストだけ返す
  const text = asString(payload['message']) ?? asString(payload['text']) ?? '';
  return { blocks: text.length > 0 ? [{ type: 'text', text }] : [] };
}
