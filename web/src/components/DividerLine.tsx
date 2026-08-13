/**
 * 会話の区切り表示（SPEC-CHAT-023/024/082）。compact 境界とターン所要時間。
 */
import { formatDuration } from '../lib/format';
import type { DividerRow } from '../lib/thread';

export function DividerLine({ row }: { row: DividerRow }) {
  if (row.type === 'compact') {
    // 通し番号付きで強調表示（SPEC-CHAT-082。番号はグラフの ⚡ マーカーと一致する）
    return (
      <div className="divider compaction" title={`compaction #${String(row.seq ?? 1)} 発生`}>
        ⚡ compaction #{row.seq ?? 1} — 以前の会話を要約
      </div>
    );
  }
  const ms = row.record.durationMs ?? 0;
  return <div className="divider">ターン完了 · {formatDuration(ms)}</div>;
}
