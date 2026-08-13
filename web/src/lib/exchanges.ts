/**
 * やりとり（exchange）分割とコスト合算（SPEC-CHAT-042/043/045）。仕様は docs/design/CHAT.md。
 *
 * ユーザー入力 1 回を 1 やりとりとし、次の入力の直前までの assistant（sidechain 含む）の
 * 推定コストを合算する。全やりとりの合計はセッション合計と常に一致させる。
 */
import type { MessageMeta } from './types';

export interface Exchange {
  /** 0 始まりの通し番号（棒グラフの #N 表示に使う）。 */
  index: number;
  /** このやりとりに属するレコード範囲 [startIndex, endIndex)。 */
  startIndex: number;
  endIndex: number;
  /** 開始したユーザー入力の冒頭。冒頭にユーザー入力が無い場合は undefined。 */
  preview?: string | undefined;
  /** 範囲内の推定コスト合算（sidechain 含む）。 */
  total: number;
  /** compact で要約済み（棒はグレー・クリック不可。コスト合計には含める）。 */
  compacted: boolean;
}

/** やりとりの開始レコードか（SPEC-CHAT-042）。 */
export function isExchangeStart(record: MessageMeta): boolean {
  return record.kind === 'user' && !record.isToolResult && !record.isSidechain;
}

export function buildExchanges(records: MessageMeta[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: Exchange | undefined;
  let lastBoundaryIndex = -1;

  for (const record of records) {
    if (record.kind === 'system' && record.subtype === 'compact_boundary') {
      lastBoundaryIndex = record.index;
    }

    if (isExchangeStart(record) || !current) {
      if (current) current.endIndex = record.index;
      current = {
        index: exchanges.length,
        startIndex: record.index,
        endIndex: record.index + 1,
        preview: isExchangeStart(record) ? record.preview : undefined,
        total: 0,
        compacted: false,
      };
      exchanges.push(current);
    }

    current.endIndex = record.index + 1;
    current.total += record.cost?.total ?? 0;
  }

  for (const exchange of exchanges) {
    exchange.compacted = exchange.startIndex < lastBoundaryIndex;
  }

  return exchanges;
}

/**
 * compaction マーカーの位置（SPEC-CHAT-080）。各 compact_boundary について
 * 「境界より前に開始したやりとりの数」を返す。棒グラフはこの位置の帯境界に
 * マーカーを立てる（= その位置のやりとりの直前で圧縮が起きた）。
 */
export function compactionMarkers(records: MessageMeta[], exchanges: Exchange[]): number[] {
  const markers: number[] = [];
  for (const record of records) {
    if (record.kind === 'system' && record.subtype === 'compact_boundary') {
      markers.push(exchanges.filter((e) => e.startIndex < record.index).length);
    }
  }
  return markers;
}
