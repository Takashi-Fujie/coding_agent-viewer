/**
 * SPEC-CODEX — Codex rollout JSONL 合成フィクスチャの契約検査。
 *
 * このテストは production コードを検証しない。docs/design/CODEX.md に記録した
 * 実測契約どおりの形をフィクスチャが持つことを機械的に担保し、
 * 後続 Issue（#28〜#31）の TDD がこのフィクスチャに依存できるようにする。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURE_DIR = join(__dirname, '../../fixtures/codex');
const DESIGN_DOC = join(__dirname, '../../../docs/design/CODEX.md');

interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface ContentPart {
  type?: string;
  text?: string;
}

/** テストが参照するフィールドだけを型付けした緩い payload 型（未知フィールドは unknown） */
interface CodexPayload {
  type?: string;
  role?: string;
  phase?: string;
  content?: ContentPart[] | string;
  call_id?: string;
  turn_id?: string;
  model?: string;
  id?: string;
  info?: {
    total_token_usage: TokenUsage;
    last_token_usage: TokenUsage;
    model_context_window?: number;
  } | null;
  [key: string]: unknown;
}

interface CodexRow {
  timestamp: string;
  type: string;
  payload: CodexPayload;
}

interface ParsedFixture {
  file: string;
  raw: string;
  /** JSON として読めた行（元の行番号つき） */
  records: Array<{ line: number; obj: CodexRow }>;
  /** JSON として読めなかった行数 */
  brokenCount: number;
  /** 末尾が改行で終わっているか */
  endsWithNewline: boolean;
}

function loadFixtures(): ParsedFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((file) => {
      const raw = readFileSync(join(FIXTURE_DIR, file), 'utf8');
      const endsWithNewline = raw.endsWith('\n');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const records: Array<{ line: number; obj: CodexRow }> = [];
      let brokenCount = 0;
      lines.forEach((line, i) => {
        try {
          records.push({ line: i + 1, obj: JSON.parse(line) as CodexRow });
        } catch {
          brokenCount++;
        }
      });
      return { file, raw, records, brokenCount, endsWithNewline };
    });
}

const fixtures = loadFixtures();
const all = fixtures.flatMap((f) => f.records.map((r) => r.obj));

const payloadsOf = (type: string, payloadType?: string) =>
  all
    .filter((o) => o?.type === type && (payloadType === undefined || o.payload?.type === payloadType))
    .map((o) => o.payload);

describe('SPEC-CODEX ドキュメント契約', () => {
  it('SPEC-CODEX-001: 詳細設計書に分類表・対応表・token_count 契約が確定/未観測の区別つきで記録されている', () => {
    const doc = readFileSync(DESIGN_DOC, 'utf8');
    for (const section of [
      '## 観測条件',
      '## 行の分類表',
      '## 重複の対応表',
      '## ツール呼び出しの対応表',
      '### 確定（観測範囲で反例 0）',
      '### 未観測・仮説',
    ]) {
      expect(doc, `セクション ${section} が無い`).toContain(section);
    }
  });
});

describe('SPEC-CODEX フィクスチャ: 基本形', () => {
  it('SPEC-CODEX-010: 全行が {timestamp, type, payload} 形式で、観測 5 種の top-level type をすべて含む', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    for (const o of all) {
      expect(typeof o.timestamp).toBe('string');
      expect(typeof o.type).toBe('string');
      expect(o.payload).toBeTypeOf('object');
    }
    const types = new Set(all.map((o) => o.type));
    for (const t of ['session_meta', 'turn_context', 'response_item', 'event_msg', 'world_state']) {
      expect(types, `top-level type ${t} が無い`).toContain(t);
    }
  });

  it('SPEC-CODEX-011: token_count が確定契約（内数関係・total 一致・累積単調増加・増加遷移の増分 = last）を満たす', () => {
    for (const f of fixtures) {
      let prev: TokenUsage | null = null;
      for (const { obj } of f.records) {
        if (obj.type !== 'event_msg' || obj.payload?.type !== 'token_count' || !obj.payload.info) continue;
        const tot: TokenUsage = obj.payload.info.total_token_usage;
        const last: TokenUsage = obj.payload.info.last_token_usage;
        expect(tot.cached_input_tokens).toBeLessThanOrEqual(tot.input_tokens);
        expect(tot.reasoning_output_tokens).toBeLessThanOrEqual(tot.output_tokens);
        expect(tot.total_tokens).toBe(tot.input_tokens + tot.output_tokens);
        if (prev) {
          expect(tot.total_tokens).toBeGreaterThanOrEqual(prev.total_tokens);
          const delta = tot.total_tokens - prev.total_tokens;
          if (delta > 0) expect(delta, `${f.file}: 増分と last の不一致`).toBe(last.total_tokens);
        }
        prev = tot;
      }
    }
  });

  it('SPEC-CODEX-012: 1 ターンに複数の token_count を含むターンと、同一累積値の重複記録を含む', () => {
    let multiPerTurn = false;
    let duplicateCumulative = false;
    for (const f of fixtures) {
      let inTurnCount = 0;
      let prevTotal = -1;
      for (const { obj } of f.records) {
        if (obj.type !== 'event_msg') continue;
        const p = obj.payload;
        if (p?.type === 'task_started') inTurnCount = 0;
        if (p?.type === 'token_count' && p.info) {
          inTurnCount++;
          if (inTurnCount >= 2) multiPerTurn = true;
          const tot = p.info.total_token_usage;
          if (tot.total_tokens === prevTotal && p.info.last_token_usage.total_tokens > 0) {
            duplicateCumulative = true;
          }
          prevTotal = tot.total_tokens;
        }
      }
    }
    expect(multiPerTurn, '1 ターン複数 token_count が無い').toBe(true);
    expect(duplicateCumulative, '同一累積値の重複記録が無い').toBe(true);
  });

  it('SPEC-CODEX-013: info: null の token_count 行を含む', () => {
    const nullInfo = payloadsOf('event_msg', 'token_count').filter((p) => p.info === null);
    expect(nullInfo.length).toBeGreaterThanOrEqual(1);
  });

  it('SPEC-CODEX-014: 注入 user メッセージ・developer・画像 content を含み、user 側は event_msg と 1:1 にならない', () => {
    const userItems = payloadsOf('response_item', 'message').filter((p) => p.role === 'user');
    const texts = userItems.map((p) =>
      Array.isArray(p.content) ? p.content.map((c) => c.text ?? '').join('') : String(p.content ?? ''),
    );
    expect(texts.some((t) => t.startsWith('<environment_context>')), 'タグ付き注入が無い').toBe(true);
    expect(texts.some((t) => t.startsWith('# AGENTS.md instructions for ')), 'AGENTS.md 形タグ無し注入が無い').toBe(true);
    const developer = payloadsOf('response_item', 'message').filter((p) => p.role === 'developer');
    expect(developer.length, 'developer message が無い').toBeGreaterThanOrEqual(1);
    const withImage = userItems.filter(
      (p) => Array.isArray(p.content) && p.content.some((c) => c.type === 'input_image'),
    );
    expect(withImage.length, '画像 content が無い').toBeGreaterThanOrEqual(1);
    const evUser = payloadsOf('event_msg', 'user_message');
    expect(userItems.length, 'user 側が 1:1 になっている').toBeGreaterThan(evUser.length);
  });

  it('SPEC-CODEX-015: assistant 発言は event_msg と response_item の件数が一致し、phase 両種を含む', () => {
    for (const f of fixtures) {
      const evAgent = f.records.filter(
        (r) => r.obj.type === 'event_msg' && r.obj.payload?.type === 'agent_message',
      );
      const riAsst = f.records.filter(
        (r) =>
          r.obj.type === 'response_item' &&
          r.obj.payload?.type === 'message' &&
          r.obj.payload.role === 'assistant',
      );
      expect(evAgent.length, `${f.file}: assistant 件数不一致`).toBe(riAsst.length);
    }
    const phases = new Set(
      payloadsOf('response_item', 'message')
        .filter((p) => p.role === 'assistant')
        .map((p) => p.phase),
    );
    expect(phases).toContain('commentary');
    expect(phases).toContain('final_answer');
  });

  it('SPEC-CODEX-016: call_id で結合できるツール呼び出しと、対応の無いイベント専用 *_end の両方を含む', () => {
    const callIds = new Set(
      [...payloadsOf('response_item', 'function_call'), ...payloadsOf('response_item', 'custom_tool_call')].map(
        (p) => p.call_id,
      ),
    );
    const fcOut = payloadsOf('response_item', 'function_call_output');
    const ctcOut = payloadsOf('response_item', 'custom_tool_call_output');
    expect(fcOut.some((p) => callIds.has(p.call_id)), 'function_call の call_id 結合ペアが無い').toBe(true);
    expect(ctcOut.some((p) => callIds.has(p.call_id)), 'custom_tool_call の call_id 結合ペアが無い').toBe(true);
    const endEvents = [
      ...payloadsOf('event_msg', 'exec_command_end'),
      ...payloadsOf('event_msg', 'mcp_tool_call_end'),
      ...payloadsOf('event_msg', 'patch_apply_end'),
      ...payloadsOf('event_msg', 'web_search_end'),
    ];
    expect(endEvents.some((p) => callIds.has(p.call_id)), 'call_id 一致の *_end が無い').toBe(true);
    expect(endEvents.some((p) => !callIds.has(p.call_id)), 'イベント専用の *_end が無い').toBe(true);
  });
});

describe('SPEC-CODEX フィクスチャ: resume・切替・途中終了', () => {
  it('SPEC-CODEX-020: 同一セッション id の session_meta が複数回追記され、resume 後も累積が継続する', () => {
    const target = fixtures.find((f) => {
      const metas = f.records.filter((r) => r.obj.type === 'session_meta');
      return metas.length >= 2 && new Set(metas.map((r) => r.obj.payload.id)).size === 1;
    });
    expect(target, '同一 id の session_meta 複数追記ファイルが無い').toBeDefined();
    // resume（2 個目の session_meta）以降にも token_count があり、リセットされない
    const records = target!.records;
    const secondMetaIdx = records.findIndex(
      (r, i) => r.obj.type === 'session_meta' && records.slice(0, i).some((x) => x.obj.type === 'session_meta'),
    );
    const before = records
      .slice(0, secondMetaIdx)
      .filter((r) => r.obj.type === 'event_msg' && r.obj.payload?.type === 'token_count' && r.obj.payload.info);
    const after = records
      .slice(secondMetaIdx)
      .filter((r) => r.obj.type === 'event_msg' && r.obj.payload?.type === 'token_count' && r.obj.payload.info);
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(after.length).toBeGreaterThanOrEqual(1);
    const lastBefore = before.at(-1)!.obj.payload.info!.total_token_usage.total_tokens;
    const firstAfter = after[0]!.obj.payload.info!.total_token_usage.total_tokens;
    expect(firstAfter, 'resume 後に累積がリセットされている').toBeGreaterThan(lastBefore);
  });

  it('SPEC-CODEX-021: turn_context のモデルが途中で切り替わり、切替後も累積がリセットされない', () => {
    const target = fixtures.find(
      (f) => new Set(f.records.filter((r) => r.obj.type === 'turn_context').map((r) => r.obj.payload.model)).size >= 2,
    );
    expect(target, 'モデル切替ファイルが無い').toBeDefined();
    // ファイル全体で累積が単調増加のままであること（リセット無し）は SPEC-CODEX-011 が担保する。
    // ここでは切替後にも token_count が出現することを確認する。
    const records = target!.records;
    const firstModel = records.find((r) => r.obj.type === 'turn_context')!.obj.payload.model;
    const switchIdx = records.findIndex((r) => r.obj.type === 'turn_context' && r.obj.payload.model !== firstModel);
    const afterSwitch = records
      .slice(switchIdx)
      .filter((r) => r.obj.type === 'event_msg' && r.obj.payload?.type === 'token_count' && r.obj.payload.info);
    expect(afterSwitch.length).toBeGreaterThanOrEqual(1);
  });

  it('SPEC-CODEX-022: task_started に対応する task_complete の無い途中終了ターンを含む', () => {
    let orphanTurn = false;
    for (const f of fixtures) {
      const started = f.records
        .filter((r) => r.obj.type === 'event_msg' && r.obj.payload?.type === 'task_started')
        .map((r) => r.obj.payload.turn_id);
      const completed = new Set(
        f.records
          .filter((r) => r.obj.type === 'event_msg' && r.obj.payload?.type === 'task_complete')
          .map((r) => r.obj.payload.turn_id),
      );
      if (started.some((id) => !completed.has(id))) orphanTurn = true;
    }
    expect(orphanTurn, '途中終了ターンが無い').toBe(true);
  });
});

describe('SPEC-CODEX フィクスチャ: 耐性', () => {
  it('SPEC-CODEX-030: 壊れた JSON 行・未知 top-level type・未知 payload.type・既知 type への未知フィールド・未知モデルを含む', () => {
    expect(
      fixtures.reduce((n, f) => n + f.brokenCount, 0),
      '壊れた JSON 行が無い',
    ).toBeGreaterThanOrEqual(1);
    const knownTop = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'world_state']);
    expect(all.some((o) => !knownTop.has(o.type)), '未知 top-level type が無い').toBe(true);
    const knownEventPayloads = new Set([
      'token_count', 'agent_message', 'user_message', 'task_started', 'task_complete',
      'agent_reasoning', 'exec_command_end', 'patch_apply_end', 'mcp_tool_call_end',
      'web_search_end', 'thread_settings_applied', 'error',
    ]);
    expect(
      payloadsOf('event_msg').some((p) => !knownEventPayloads.has(p.type ?? '')),
      '未知 payload.type が無い',
    ).toBe(true);
    const knownTokenCountKeys = new Set(['type', 'info', 'rate_limits']);
    expect(
      payloadsOf('event_msg', 'token_count').some((p) => Object.keys(p).some((k) => !knownTokenCountKeys.has(k))),
      '既知 type への未知フィールドが無い',
    ).toBe(true);
    const observedModels = new Set([
      'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5-codex', 'gpt-5.1-codex', 'o3', 'gpt-5.6-sol', 'gpt-5.6-terra',
    ]);
    expect(
      payloadsOf('turn_context').some((p) => !observedModels.has(p.model ?? '')),
      '未知モデルが無い',
    ).toBe(true);
  });

  it('SPEC-CODEX-031: 50KB を超える巨大行と、改行の無い不完全な末尾行を含む', () => {
    const hasGiantLine = fixtures.some((f) => f.raw.split('\n').some((l) => Buffer.byteLength(l, 'utf8') > 50 * 1024));
    expect(hasGiantLine, '50KB+ の巨大行が無い').toBe(true);
    expect(fixtures.some((f) => !f.endsWithNewline), '改行の無い不完全な末尾行が無い').toBe(true);
  });

  it('SPEC-CODEX-032: output の無い function_call（途中終了）を含む', () => {
    const outIds = new Set(payloadsOf('response_item', 'function_call_output').map((p) => p.call_id));
    const orphanCalls = payloadsOf('response_item', 'function_call').filter((p) => !outIds.has(p.call_id));
    expect(orphanCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('SPEC-CODEX 匿名化', () => {
  it('SPEC-CODEX-040: フィクスチャに実ユーザー名・実プロジェクト名・ホームディレクトリ実パスを含む文字列が無い', () => {
    // フィクスチャのパスは /home/user/synthetic-project に統一する。
    // 実行環境固有の文字列（ユーザー名・ホームディレクトリ名）はコードに書かず実行時に導出する
    // （禁止語をリテラルで書くと、この検査自体が public リポジトリへの漏洩源になるため）。
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const forbidden = [
      /\/Users\//,
      /agent_viewer/i,
      /coding_agent-viewer/i,
      new RegExp(escape(userInfo().username), 'i'),
      new RegExp(escape(basename(homedir())), 'i'),
    ];
    for (const f of fixtures) {
      for (const pattern of forbidden) {
        expect(pattern.test(f.raw), `${f.file}: 禁止パターン ${pattern} を含む`).toBe(false);
      }
    }
  });
});
