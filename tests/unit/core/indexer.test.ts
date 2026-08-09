/**
 * インデックスの永続化・再利用判定・増分更新のテスト。仕様は docs/spec/SPEC-CORE.md。
 *
 * JSONL は追記のみが前提。縮小・mtime 逆行・スキーマ変更は「前提が崩れた」合図なので
 * 差分解析を諦めて全再構築する。
 */
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  INDEX_SCHEMA_VERSION,
  buildIndex,
  cachePathFor,
  decideStrategy,
  loadCache,
} from '../../../server/core/indexer.js';
import type { IndexCacheFile } from '../../../server/core/types.js';
import { appendJsonl, assistantLine, withTempDir, writeJsonl } from '../../helpers/fixtures.js';

const cacheStub = (over: Partial<IndexCacheFile> = {}): IndexCacheFile =>
  ({
    schemaVersion: INDEX_SCHEMA_VERSION,
    filePath: '/tmp/sample.jsonl',
    fileSize: 1000,
    mtimeMs: 1_700_000_000_000,
    lastOffset: 1000,
    records: [],
    summary: { recordCount: 0 },
    ...over,
  }) as IndexCacheFile;

/** セッション JSONL を 1 本作り、インデックスを組んで結果を返す。 */
async function setup(dir: string, lines: unknown[]) {
  const path = join(dir, 'session.jsonl');
  await writeJsonl(path, lines);
  const first = await buildIndex(path, { cacheDir: join(dir, '.cache') });
  return { path, cacheDir: join(dir, '.cache'), first };
}

const seedLines = [
  { type: 'ai-title', aiTitle: 'サンプル', sessionId: 's-1' },
  { type: 'user', uuid: 'u-1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: '依頼' } },
  assistantLine({ uuid: 'a-1', timestamp: '2026-01-01T00:00:02.000Z' }),
];

describe('decideStrategy', () => {
  it('SPEC-CORE-041: fileSize と mtimeMs が一致するキャッシュは再利用する', () => {
    const cache = cacheStub();

    expect(decideStrategy(cache, { size: 1000, mtimeMs: 1_700_000_000_000 })).toBe('reuse');
  });

  it('SPEC-CORE-042: fileSize が lastOffset より大きければ増分更新する', () => {
    const cache = cacheStub({ fileSize: 1000, lastOffset: 1000 });

    expect(decideStrategy(cache, { size: 1500, mtimeMs: 1_700_000_100_000 })).toBe('incremental');
  });

  it('SPEC-CORE-042: 未完了の末尾行があった場合は lastOffset から差分を読み直す', () => {
    // 前回走査時に末尾が書き込み途中で、fileSize(1000) > lastOffset(900) だった状態
    const cache = cacheStub({ fileSize: 1000, lastOffset: 900 });

    expect(decideStrategy(cache, { size: 1200, mtimeMs: 1_700_000_100_000 })).toBe('incremental');
  });

  it('SPEC-CORE-043: fileSize が縮小したら全再構築する', () => {
    const cache = cacheStub();

    expect(decideStrategy(cache, { size: 400, mtimeMs: 1_700_000_100_000 })).toBe('rebuild');
  });

  it('SPEC-CORE-044: mtimeMs が逆行したら全再構築する', () => {
    const cache = cacheStub();

    expect(decideStrategy(cache, { size: 1500, mtimeMs: 1_600_000_000_000 })).toBe('rebuild');
  });

  it('SPEC-CORE-045: schemaVersion が現行と異なるキャッシュは全再構築する', () => {
    const cache = cacheStub({ schemaVersion: INDEX_SCHEMA_VERSION + 1 });

    expect(decideStrategy(cache, { size: 1000, mtimeMs: 1_700_000_000_000 })).toBe('rebuild');
  });

  it('SPEC-CORE-045: キャッシュが無ければ全再構築する', () => {
    expect(decideStrategy(null, { size: 1000, mtimeMs: 1_700_000_000_000 })).toBe('rebuild');
  });

  it('SPEC-CORE-043: サイズが変わらず mtime だけ進んだ場合は追記と断定できないため全再構築する', () => {
    const cache = cacheStub();

    expect(decideStrategy(cache, { size: 1000, mtimeMs: 1_700_000_100_000 })).toBe('rebuild');
  });
});

describe('buildIndex', () => {
  it('SPEC-CORE-040: .cache/index-<hash>.json に schemaVersion / fileSize / mtimeMs / lastOffset / records / summary を保存する', async () => {
    await withTempDir(async (dir) => {
      const { path, cacheDir, first } = await setup(dir, seedLines);
      const stats = await stat(path);

      const cachePath = cachePathFor(cacheDir, path);
      expect(cachePath).toMatch(/index-[0-9a-f]+\.json$/);

      const saved = JSON.parse(await readFile(cachePath, 'utf8')) as IndexCacheFile;
      expect(saved.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
      expect(saved.fileSize).toBe(stats.size);
      expect(saved.mtimeMs).toBe(stats.mtimeMs);
      expect(saved.lastOffset).toBe(stats.size);
      expect(saved.records).toHaveLength(3);
      expect(saved.summary.recordCount).toBe(3);
      expect(first.strategy).toBe('rebuild');
    });
  });

  it('SPEC-CORE-040: 同じファイルパスなら同じキャッシュパスに、違えば違うパスになる', () => {
    expect(cachePathFor('/c', '/a/session.jsonl')).toBe(cachePathFor('/c', '/a/session.jsonl'));
    expect(cachePathFor('/c', '/a/session.jsonl')).not.toBe(cachePathFor('/c', '/b/session.jsonl'));
  });

  it('SPEC-CORE-041: 変更が無ければ再解析せずキャッシュを再利用する', async () => {
    await withTempDir(async (dir) => {
      const { path, cacheDir } = await setup(dir, seedLines);

      const second = await buildIndex(path, { cacheDir });

      expect(second.strategy).toBe('reuse');
      expect(second.index.records).toHaveLength(3);
    });
  });

  it('SPEC-CORE-042: 追記があった場合は差分バイトのみを解析して追記する', async () => {
    await withTempDir(async (dir) => {
      const { path, cacheDir, first } = await setup(dir, seedLines);

      await appendJsonl(path, [assistantLine({ uuid: 'a-2', timestamp: '2026-01-01T00:00:03.000Z' })]);
      const second = await buildIndex(path, { cacheDir });

      expect(second.strategy).toBe('incremental');
      expect(second.parsedBytes).toBeLessThan(first.index.fileSize);
      expect(second.index.records).toHaveLength(4);
      expect(second.index.records.slice(0, 3)).toEqual(first.index.records);
      expect(second.index.summary.assistantCount).toBe(2);
    });
  });

  it('SPEC-CORE-046: 増分更新後のインデックスは全再構築の結果と一致する', async () => {
    await withTempDir(async (dir) => {
      const { path, cacheDir } = await setup(dir, seedLines);
      await appendJsonl(path, [
        assistantLine({ uuid: 'a-2', model: 'claude-opus-5', timestamp: '2026-01-01T00:00:03.000Z' }),
        { type: 'custom-title', customTitle: '手動タイトル', sessionId: 's-1' },
        { type: 'pr-link', sessionId: 's-1', prNumber: 7, prRepository: 'owner/repo' },
      ]);

      const incremental = await buildIndex(path, { cacheDir });
      const rebuilt = await buildIndex(path, { cacheDir: join(dir, '.cache-fresh') });

      expect(incremental.strategy).toBe('incremental');
      expect(rebuilt.strategy).toBe('rebuild');
      expect(incremental.index.records).toEqual(rebuilt.index.records);
      expect(incremental.index.summary).toEqual(rebuilt.index.summary);
      expect(incremental.index.lastOffset).toBe(rebuilt.index.lastOffset);
    });
  });

  it('SPEC-CORE-043: ファイルが縮小していたら全再構築する', async () => {
    await withTempDir(async (dir) => {
      const { path, cacheDir } = await setup(dir, seedLines);

      await writeJsonl(path, [seedLines[0]]);
      const second = await buildIndex(path, { cacheDir });

      expect(second.strategy).toBe('rebuild');
      expect(second.index.records).toHaveLength(1);
    });
  });

  it('SPEC-CORE-044: mtime が逆行していたら全再構築する', async () => {
    await withTempDir(async (dir) => {
      const { path, cacheDir } = await setup(dir, seedLines);

      await appendJsonl(path, [assistantLine({ uuid: 'a-2', timestamp: '2026-01-01T00:00:03.000Z' })]);
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await utimes(path, past, past);
      const second = await buildIndex(path, { cacheDir });

      expect(second.strategy).toBe('rebuild');
      expect(second.index.records).toHaveLength(4);
    });
  });

  it('SPEC-CORE-045: 壊れたキャッシュファイルは読み捨てて全再構築する', async () => {
    await withTempDir(async (dir) => {
      const { path, cacheDir } = await setup(dir, seedLines);
      const cachePath = cachePathFor(cacheDir, path);

      await writeFile(cachePath, '{ これは JSON では', 'utf8');

      expect(await loadCache(cachePath)).toBeNull();
      expect((await buildIndex(path, { cacheDir })).strategy).toBe('rebuild');
    });
  });
});

describe('SPEC-DASH: スキーマ版数', () => {
  it('SPEC-DASH-003: INDEX_SCHEMA_VERSION は 3 以上である（isToolError / hook を持たない旧キャッシュを再利用しない）', () => {
    expect(INDEX_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });
});
