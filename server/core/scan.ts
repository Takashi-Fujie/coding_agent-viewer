/**
 * JSONL の byte offset 付きストリーム走査。仕様は docs/spec/SPEC-CORE.md。
 *
 * readline を使わないのは byte offset が取れないため。offset を持たないと
 * 「表示時に該当行だけ seek して読む」設計が成立しない。生バッファを自前で
 * 走査し、改行（0x0A）位置から offset / length を確定させる。
 */
import { open } from 'node:fs/promises';
import { normalizeRecord } from './normalize.js';
import type { RecordNormalizer } from '../sources/types.js';
import type { IndexRecord, RawLine } from './types.js';

/** 既定の読み込みチャンクサイズ。実測で 1 行最大 1.3MB なので余裕を持たせる。 */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

const NEWLINE = 0x0a;

export interface ScanOptions {
  chunkSize?: number;
  /** ソース固有の正規化器。省略時は Claude のステートレス正規化（後方互換）。 */
  normalizer?: RecordNormalizer | undefined;
}

export interface ScanResult {
  records: IndexRecord[];
  /** JSON として読めずスキップした行の数。 */
  skippedLineCount: number;
  /** 最後の「完全な行」の直後の位置。書き込み途中の末尾行は含まない。 */
  lastOffset: number;
}

/**
 * 改行で終わっている行だけを offset 付きで順に返す。
 *
 * 末尾が改行で終わっていない場合、その断片は「書き込み途中の行」とみなして
 * 返さない。ここを確定させると、次回の増分更新で同じ行が二重に現れる。
 */
export async function* iterateLines(
  filePath: string,
  startOffset = 0,
  options: ScanOptions = {},
): AsyncGenerator<RawLine> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const handle = await open(filePath, 'r');

  try {
    const chunk = Buffer.allocUnsafe(chunkSize);
    // pending は「まだ改行が見つかっていない残り」。pendingStart はその先頭の絶対 offset。
    let pending = Buffer.alloc(0);
    let pendingStart = startOffset;
    let position = startOffset;

    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      pending = pending.length === 0
        ? Buffer.from(chunk.subarray(0, bytesRead))
        : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

      let searchFrom = 0;
      for (;;) {
        const newlineAt = pending.indexOf(NEWLINE, searchFrom);
        if (newlineAt === -1) break;

        const line = pending.subarray(searchFrom, newlineAt);
        yield {
          offset: pendingStart + searchFrom,
          length: line.length,
          text: line.toString('utf8'),
        };
        searchFrom = newlineAt + 1;
      }

      if (searchFrom > 0) {
        pending = Buffer.from(pending.subarray(searchFrom));
        pendingStart += searchFrom;
      }
    }
  } finally {
    await handle.close();
  }
}

/** iterateLines を配列に集める（テストと小さいファイル向け）。 */
export async function collectLines(
  filePath: string,
  startOffset = 0,
  options: ScanOptions = {},
): Promise<RawLine[]> {
  const lines: RawLine[] = [];
  for await (const line of iterateLines(filePath, startOffset, options)) lines.push(line);
  return lines;
}

/** 記録した offset / length の 1 行だけを読み出す。 */
export async function readLineAt(filePath: string, offset: number, length: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    // 大きい行は 1 回の read で埋まらないことがあるので、必要分まで繰り返す。
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** 記録した offset / length の 1 行を読み、JSON として返す。 */
export async function readRecordAt(filePath: string, offset: number, length: number): Promise<unknown> {
  return JSON.parse(await readLineAt(filePath, offset, length));
}

/**
 * startOffset から末尾まで走査し、正規化済みレコードを返す。
 * 壊れた JSON 行はスキップして走査を継続する（1 行の破損で全体を落とさない）。
 */
export async function scanFile(
  filePath: string,
  startOffset = 0,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const records: IndexRecord[] = [];
  let skippedLineCount = 0;
  let lastOffset = startOffset;

  for await (const line of iterateLines(filePath, startOffset, options)) {
    lastOffset = line.offset + line.length + 1;
    if (line.text.trim().length === 0) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line.text);
    } catch {
      skippedLineCount += 1;
      continue;
    }

    const location = { offset: line.offset, length: line.length };
    const record = options.normalizer
      ? options.normalizer.normalize(raw, location)
      : normalizeRecord(raw, location);
    if (record) records.push(record);
  }

  return { records, skippedLineCount, lastOffset };
}
