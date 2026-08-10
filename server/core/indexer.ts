/**
 * インデックスの永続化・再利用判定・増分更新。仕様は docs/spec/SPEC-CORE.md。
 *
 * JSONL は追記のみが前提。縮小・mtime 逆行・スキーマ変更は「その前提が崩れた」合図なので、
 * 差分解析を諦めて全再構築する（間違ったインデックスを高速に作るより遅くても正しく作る）。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanFile } from './scan.js';
import { addToSummary, createSummary } from './summary.js';
import { INDEX_SCHEMA_VERSION } from './types.js';
import type { IndexCacheFile, SessionIndex } from './types.js';
import type { LogSource } from '../sources/types.js';

export { INDEX_SCHEMA_VERSION };

export type IndexStrategy = 'reuse' | 'incremental' | 'rebuild';

export interface BuildOptions {
  cacheDir: string;
  /** セッションを発見したソース。省略時は Claude 相当のステートレス正規化（後方互換）。 */
  source?: LogSource | undefined;
}

export interface BuildResult {
  index: SessionIndex;
  strategy: IndexStrategy;
  /** 今回実際に読み直したバイト数（reuse は 0）。 */
  parsedBytes: number;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** ファイルパスからキャッシュファイルのパスを決める（パスのハッシュで一意にする）。 */
export function cachePathFor(cacheDir: string, filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  return join(cacheDir, `index-${hash}.json`);
}

/** キャッシュを読む。存在しない・壊れている・形が違う場合は null（＝全再構築）。 */
export async function loadCache(cachePath: string): Promise<IndexCacheFile | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(cachePath, 'utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const cache = parsed as Partial<IndexCacheFile>;
  if (typeof cache.schemaVersion !== 'number' || !Array.isArray(cache.records)) return null;

  return cache as IndexCacheFile;
}

async function saveCache(cachePath: string, index: SessionIndex, source: string): Promise<void> {
  const payload: IndexCacheFile = { schemaVersion: INDEX_SCHEMA_VERSION, source, ...index };
  await mkdir(join(cachePath, '..'), { recursive: true });
  await writeFile(cachePath, JSON.stringify(payload), 'utf8');
}

/**
 * キャッシュと現在のファイル状態から、再利用 / 増分 / 全再構築のどれを取るかを決める。
 */
export function decideStrategy(
  cache: IndexCacheFile | null,
  current: FileStat,
  expectedSource = 'claude',
): IndexStrategy {
  if (!cache) return 'rebuild';
  if (cache.schemaVersion !== INDEX_SCHEMA_VERSION) return 'rebuild';
  // 別ソースのパーサで書かれたキャッシュは内容が信用できない（source 未記載は 'claude' 扱い）
  if ((cache.source ?? 'claude') !== expectedSource) return 'rebuild';
  // mtime の逆行はファイルの差し替え・巻き戻しを意味する
  if (current.mtimeMs < cache.mtimeMs) return 'rebuild';
  // 追記のみの前提が崩れている
  if (current.size < cache.fileSize) return 'rebuild';
  if (current.size === cache.fileSize && current.mtimeMs === cache.mtimeMs) return 'reuse';
  if (current.size > cache.lastOffset) return 'incremental';
  // サイズが増えていないのに mtime だけ進んだ = 追記と断定できない
  return 'rebuild';
}

/**
 * セッション JSONL のインデックスを構築する。可能ならキャッシュを再利用し、
 * 追記だけであれば差分バイトのみを解析する。
 */
export async function buildIndex(filePath: string, options: BuildOptions): Promise<BuildResult> {
  const stats = await stat(filePath);
  const cachePath = cachePathFor(options.cacheDir, filePath);
  const cache = await loadCache(cachePath);
  const expectedSource = options.source?.id ?? 'claude';
  const strategy = decideStrategy(cache, { size: stats.size, mtimeMs: stats.mtimeMs }, expectedSource);

  if (strategy === 'reuse' && cache) {
    const index: SessionIndex = {
      filePath: cache.filePath,
      fileSize: cache.fileSize,
      mtimeMs: cache.mtimeMs,
      lastOffset: cache.lastOffset,
      scanState: cache.scanState,
      records: cache.records,
      summary: cache.summary,
    };
    return { index, strategy, parsedBytes: 0 };
  }

  const resumeFrom = strategy === 'incremental' && cache ? cache.lastOffset : 0;
  // 増分再開では保存済みの走査文脈を復元する（全再構築なら初期状態から）。
  const normalizer = options.source?.createNormalizer(
    strategy === 'incremental' && cache ? cache.scanState : undefined,
  );
  const scan = await scanFile(filePath, resumeFrom, { normalizer });

  const isIncremental = strategy === 'incremental' && cache !== null;
  const records = isIncremental ? [...cache.records, ...scan.records] : scan.records;
  const summary = isIncremental ? cache.summary : createSummary();
  for (const record of scan.records) addToSummary(summary, record);
  summary.skippedLineCount += scan.skippedLineCount;

  const index: SessionIndex = {
    filePath,
    fileSize: stats.size,
    mtimeMs: stats.mtimeMs,
    lastOffset: scan.lastOffset,
    scanState: normalizer?.serialize(),
    records,
    summary,
  };
  await saveCache(cachePath, index, expectedSource);

  return { index, strategy, parsedBytes: stats.size - resumeFrom };
}
