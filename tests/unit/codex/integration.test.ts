/**
 * SPEC-CODEX-066〜070: 増分・キャッシュ・API 統合・viewer 成立。仕様は docs/design/CODEX.md（Issue #29）。
 *
 * 走査文脈（turn_context の model 等）が増分再開で失われないことと、
 * viewer 側を一切変更せずに既存の行構築（buildRows）でチャットが成立することを確認する。
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../server/app.js';
import { buildIndex, cachePathFor, INDEX_SCHEMA_VERSION } from '../../../server/core/indexer.js';
import { scanFile } from '../../../server/core/scan.js';
import { createClaudeSource } from '../../../server/sources/claude.js';
import { createCodexSource } from '../../../server/sources/codex.js';
import { createCodexNormalizer } from '../../../server/sources/codex-normalize.js';
import { buildRows } from '../../../web/src/lib/thread';
import type { MessageMeta } from '../../../web/src/lib/types';
import { appendJsonl, pick, SAMPLE_FIXTURE, withTempDir, writeJsonl } from '../../helpers/fixtures.js';

const BASIC_FIXTURE = fileURLToPath(new URL('../../fixtures/codex/rollout-basic.jsonl', import.meta.url));
const ROLLOUT = 'rollout-2026-08-08T00-00-00-00000000-0000-7000-8000-000000000001.jsonl';

const at = (sec: number): string => `2026-08-08T00:00:${String(sec).padStart(2, '0')}.000Z`;

const HEAD_LINES = [
  { timestamp: at(0), type: 'session_meta', payload: { id: '00000000-0000-7000-8000-000000000001', cwd: '/home/user/synthetic-project', cli_version: '0.147.0' } },
  { timestamp: at(1), type: 'turn_context', payload: { turn_id: 'turn-001', model: 'gpt-5.5' } },
  { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<synthetic> 依頼文' }] } },
];

const APPENDED_ASSISTANT = {
  timestamp: at(3),
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '<synthetic> 応答' }] },
};

/** 日付階層に rollout を 1 本置いた Codex ツリーを作る。 */
async function buildCodexTree(root: string, lines: unknown[]): Promise<{ sessionsDir: string; filePath: string }> {
  const sessionsDir = join(root, 'sessions');
  const dayDir = join(sessionsDir, '2026', '08', '08');
  await mkdir(dayDir, { recursive: true });
  const filePath = join(dayDir, ROLLOUT);
  await writeJsonl(filePath, lines);
  return { sessionsDir, filePath };
}

describe('増分・キャッシュ', () => {
  it('SPEC-CODEX-066: 走査文脈がキャッシュへ保存され、増分再開でも全再構築と同一のレコード列になる', async () => {
    await withTempDir(async (dir) => {
      const { sessionsDir, filePath } = await buildCodexTree(dir, HEAD_LINES);
      const source = createCodexSource({ sessionsDir });
      const cacheDir = join(dir, 'cache-a');

      const first = await buildIndex(filePath, { cacheDir, source });
      expect(first.strategy).toBe('rebuild');

      // turn_context を含まない追記。文脈が保存されていなければ model が失われる
      await appendJsonl(filePath, [APPENDED_ASSISTANT]);
      const second = await buildIndex(filePath, { cacheDir, source });
      expect(second.strategy).toBe('incremental');
      const appended = pick(second.index.records, (r) => r.kind === 'assistant', '追記 assistant');
      expect(appended.model).toBe('gpt-5.5');

      // 全再構築（別キャッシュ）と完全一致する
      const rebuilt = await buildIndex(filePath, { cacheDir: join(dir, 'cache-b'), source });
      expect(second.index.records).toEqual(rebuilt.index.records);
      expect(second.index.summary).toEqual(rebuilt.index.summary);
    });
  });

  it('SPEC-CODEX-067: INDEX_SCHEMA_VERSION の繰り上げにより scanState の無い旧キャッシュは全再構築される', async () => {
    expect(INDEX_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    await withTempDir(async (dir) => {
      const { sessionsDir, filePath } = await buildCodexTree(dir, HEAD_LINES);
      const source = createCodexSource({ sessionsDir });
      const cacheDir = join(dir, 'cache');

      await buildIndex(filePath, { cacheDir, source });
      // 旧バージョンのキャッシュを装う（scanState の無い形式）
      const cachePath = cachePathFor(cacheDir, filePath);
      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>;
      cache['schemaVersion'] = INDEX_SCHEMA_VERSION - 1;
      delete cache['scanState'];
      await writeFile(cachePath, JSON.stringify(cache), 'utf8');

      const rebuilt = await buildIndex(filePath, { cacheDir, source });
      expect(rebuilt.strategy).toBe('rebuild');
    });
  });
});

describe('API 統合', () => {
  it('SPEC-CODEX-068: codexSessionsDir 指定時のみ Codex ソースが登録され、GET /api/sessions/:id/messages で Codex セッションの本文が返る', async () => {
    await withTempDir(async (dir) => {
      const { sessionsDir } = await buildCodexTree(dir, [...HEAD_LINES, APPENDED_ASSISTANT]);
      const logDir = join(dir, 'projects');
      await mkdir(logDir, { recursive: true });
      const sessionId = `codex:${ROLLOUT.replace(/\.jsonl$/, '')}`;

      const withCodex = createApp({
        logDir,
        cacheDir: join(dir, 'cache-with'),
        claudeDir: dir,
        codexSessionsDir: sessionsDir,
      });
      const res = await request(withCodex).get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      expect(res.status).toBe(200);
      const bodyTexts = (res.body.items as { body: { blocks: { text?: string }[] } }[])
        .flatMap((item) => item.body.blocks.map((b) => b.text ?? ''));
      expect(bodyTexts.join('\n')).toContain('<synthetic> 応答');

      // 未指定なら Codex セッションは存在しない
      const withoutCodex = createApp({ logDir, cacheDir: join(dir, 'cache-without'), claudeDir: dir });
      const missing = await request(withoutCodex).get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      expect(missing.status).toBe(404);
    });
  });
});

describe('viewer 成立（既存 buildRows・無変更）', () => {
  it('SPEC-CODEX-069: Codex 正規化レコードは既存の行構築（buildRows）で user / assistant / ツール呼び出し＋結果がメイン列に成立し、注入・developer はメイン列に出ない', async () => {
    const normalizer = createCodexNormalizer();
    const { records } = await scanFile(BASIC_FIXTURE, 0, { normalizer });
    const metas: MessageMeta[] = records.map((record, index) => ({ index, ...record }));
    const rows = buildRows(metas);

    const messageRows = rows.filter((row) => row.type === 'message');
    // 実ユーザー入力と assistant 応答がメイン列にある
    expect(messageRows.some((row) => row.record.kind === 'user' && !row.record.isToolResult)).toBe(true);
    expect(messageRows.some((row) => row.record.kind === 'assistant')).toBe(true);

    // ツール結果は発行元 assistant 行へ取り付く
    const owner = pick(messageRows, (row) => (row.record.toolUses?.length ?? 0) > 0, 'ツール呼び出し行');
    const callId = owner.record.toolUses?.[0]?.id ?? '';
    expect(owner.toolResults[callId]).toBeDefined();

    // 注入・developer はメイン列に現れない（attachment は HIDDEN_KINDS）
    for (const row of messageRows) {
      expect(row.record.kind).not.toBe('attachment');
      expect(row.record.preview ?? '').not.toContain('<environment_context>');
    }
  });
});

describe('Claude 既存挙動の維持', () => {
  it('SPEC-CODEX-070: Claude ソースの正規化結果・API レスポンスは従来と一致する（既存テスト不変）', async () => {
    await withTempDir(async (dir) => {
      // source 省略（従来の呼び出し）と Claude ソース明示で完全一致する
      const plain = await buildIndex(SAMPLE_FIXTURE, { cacheDir: join(dir, 'cache-plain') });
      const viaSource = await buildIndex(SAMPLE_FIXTURE, {
        cacheDir: join(dir, 'cache-source'),
        source: createClaudeSource({ logDir: dir }),
      });
      expect(viaSource.index.records).toEqual(plain.index.records);
      expect(viaSource.index.summary).toEqual(plain.index.summary);
    });
  });
});
