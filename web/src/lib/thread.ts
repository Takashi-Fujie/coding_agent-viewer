/**
 * レコード列から表示行への平坦化（SPEC-CHAT-020/025/030）。仕様は docs/design/CHAT.md。
 *
 * 仮想スクロールはこの 1 次元の行配列に対して行う。tool_result は独立行にせず
 * 発行元 assistant の行に取り付け、sidechain は parentUuid で連結して分岐行にまとめる。
 */
import type { MessageMeta } from './types';

export interface MessageRow {
  type: 'message';
  /** 行の並び・やりとり絞り込みに使う代表レコード位置。 */
  startIndex: number;
  record: MessageMeta;
  /** tool_use_id → 対応する tool_result レコード（SPEC-CHAT-020）。 */
  toolResults: Record<string, MessageMeta>;
}

export interface DividerRow {
  type: 'compact' | 'turn';
  startIndex: number;
  record: MessageMeta;
  /** compact 区切りの 1 始まり通し番号（SPEC-CHAT-082）。turn には付かない。 */
  seq?: number;
}

export interface SidechainRow {
  type: 'sidechain';
  startIndex: number;
  records: MessageMeta[];
}

export type Row = MessageRow | DividerRow | SidechainRow;

/** メイン列に行として現れない補助メタ（タイトル・モード等）。 */
const HIDDEN_KINDS = new Set(['title', 'mode', 'last-prompt', 'attachment', 'pr-link', 'unknown']);

export interface RowBuilder {
  /** これまでに消費したレコード件数（増分適用の起点判定用）。 */
  readonly count: number;
  /** 追記レコードを取り込む。既存行への取り付けは copy-on-write で行参照を置き換える。 */
  append: (records: MessageMeta[]) => void;
  /** 現在の行配列。呼び出しごとに新しい配列を返すが、変化のない行の参照は維持する。 */
  rows: () => Row[];
}

/**
 * 行配列の増分構築（SPEC-LIVE-060〜063）。ライブ追記で全行を作り直さないために、
 * 平坦化の内部状態（分岐・tool_use の対応表）を append をまたいで保持する。
 * 既存行に手を入れるとき（tool_result の取り付け・sidechain の連結）は、その行だけを
 * 新しいオブジェクトに置き換える。React 側は参照比較だけで再描画の要否を判定できる。
 */
export function createRowBuilder(): RowBuilder {
  const rows: Row[] = [];
  /** sidechain の uuid → 属する分岐行の rows 内位置。parentUuid の連結でチェーンを辿る。 */
  const branchByUuid = new Map<string, number>();
  /** tool_use_id → その tool_use を発行した assistant 行の rows 内位置。 */
  const ownerByToolUseId = new Map<string, number>();
  let count = 0;
  /** compact 区切りの通し番号。増分 append をまたいで継続する（SPEC-CHAT-083）。 */
  let compactSeq = 0;

  function append(records: MessageMeta[]): void {
    count += records.length;
    for (const record of records) {
      if (record.isSidechain) {
        const at = record.parentUuid ? branchByUuid.get(record.parentUuid) : undefined;
        if (at === undefined) {
          rows.push({ type: 'sidechain', startIndex: record.index, records: [record] });
          if (record.uuid) branchByUuid.set(record.uuid, rows.length - 1);
        } else {
          const branch = rows[at] as SidechainRow;
          rows[at] = { ...branch, records: [...branch.records, record] };
          if (record.uuid) branchByUuid.set(record.uuid, at);
        }
        continue;
      }

      if (HIDDEN_KINDS.has(record.kind)) continue;

      if (record.kind === 'system') {
        if (record.subtype === 'compact_boundary') {
          compactSeq += 1;
          rows.push({ type: 'compact', startIndex: record.index, record, seq: compactSeq });
        } else if (record.durationMs !== undefined) {
          rows.push({ type: 'turn', startIndex: record.index, record });
        }
        // それ以外の system はメイン列に出さない
        continue;
      }

      if (record.kind === 'user' && record.isToolResult) {
        const at = record.toolResultFor ? ownerByToolUseId.get(record.toolResultFor) : undefined;
        if (at !== undefined && record.toolResultFor) {
          const owner = rows[at] as MessageRow;
          rows[at] = {
            ...owner,
            toolResults: { ...owner.toolResults, [record.toolResultFor]: record },
          };
          continue;
        }
        // 発行元が見つからない結果は落とさず独立行として残す
      }

      rows.push({ type: 'message', startIndex: record.index, record, toolResults: {} });
      for (const toolUse of record.toolUses ?? []) {
        ownerByToolUseId.set(toolUse.id, rows.length - 1);
      }
    }
  }

  return {
    get count() {
      return count;
    },
    append,
    rows: () => rows.slice(),
  };
}

export function buildRows(records: MessageMeta[]): Row[] {
  const builder = createRowBuilder();
  builder.append(records);
  return builder.rows();
}

/** やりとり絞り込み（SPEC-CHAT-044）: 指定範囲のレコードで始まる行だけ残す。 */
export function filterRows(rows: Row[], range: { startIndex: number; endIndex: number }): Row[] {
  return rows.filter((row) => row.startIndex >= range.startIndex && row.startIndex < range.endIndex);
}
