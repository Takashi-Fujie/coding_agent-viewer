/**
 * やりとり別コスト棒グラフ（SPEC-CHAT-044/045/081）。
 * 帯クリックで絞り込み・再クリックで解除。compact 済みはグレーでクリック不可。
 * compaction 発生位置には ⚡ マーカーを立てる。
 */
import { formatUsd } from '../lib/format';
import type { Exchange } from '../lib/exchanges';

export interface TurnCostChartProps {
  exchanges: Exchange[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  /** compaction 発生位置（compactionMarkers の出力。SPEC-CHAT-081）。 */
  markers?: number[] | undefined;
}

const W = 960;
const H = 150;
const PAD_L = 46;
const PAD_B = 22;
const PLOT_H = H - PAD_B - 8;

export function TurnCostChart({ exchanges, selected, onSelect, markers }: TurnCostChartProps) {
  if (exchanges.length === 0) return null;

  const max = Math.max(...exchanges.map((e) => e.total), 1e-9);
  const band = (W - PAD_L - 6) / exchanges.length;
  const barW = Math.min(26, band * 0.6);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      role="img"
      aria-label="ユーザー入力ごとの推定コスト棒グラフ"
    >
      <line x1={PAD_L} y1={8 + PLOT_H} x2={W - 6} y2={8 + PLOT_H} stroke="var(--baseline)" />
      <text x={PAD_L - 6} y={14} textAnchor="end" fontSize="10" fill="var(--muted)">
        {formatUsd(max)}
      </text>
      {exchanges.map((exchange, i) => {
        const h = (exchange.total / max) * PLOT_H;
        const x = PAD_L + band * i;
        const isSelected = selected === exchange.index;
        return (
          <g
            key={exchange.index}
            data-testid={`turn-band-${exchange.index}`}
            style={{ cursor: exchange.compacted ? 'default' : 'pointer' }}
            onClick={() => {
              if (exchange.compacted) return;
              onSelect(isSelected ? null : exchange.index);
            }}
          >
            {isSelected && <rect x={x} y={0} width={band} height={H - PAD_B + 4} fill="var(--wash)" rx={4} />}
            <rect x={x} y={0} width={band} height={H - PAD_B + 4} fill="transparent" />
            <rect
              x={x + (band - barW) / 2}
              y={8 + PLOT_H - h}
              width={barW}
              height={h}
              fill={exchange.compacted ? 'var(--baseline)' : 'var(--s1)'}
              rx={2}
            />
            <text
              x={x + band / 2}
              y={H - 8}
              textAnchor="middle"
              fontSize="9"
              fill="var(--muted)"
            >
              #{exchange.index + 1}
            </text>
          </g>
        );
      })}
      {/* compaction マーカー（SPEC-CHAT-081）: 発生位置の帯境界に ⚡ と縦破線 */}
      {(markers ?? []).map((pos, i) => {
        const x = PAD_L + band * pos;
        // ネイティブ title は表示までの遅延（約 1 秒）を変えられないため、
        // CSS :hover + transition-delay 0.3s の自前 tooltip を使う（styles.css の .cmark）
        const tipW = 264;
        const tipH = 28;
        // ラベルは右側に出し、右端で見切れる場合は左側へ反転する
        const tipRight = x + 10 + tipW <= W - 6;
        const tipX = tipRight ? x + 10 : x - 10 - tipW;
        return (
          <g key={`marker-${String(i)}`} data-testid="compaction-marker" className="cmark">
            {/* 点線はアイコンの下端（y=20）から。アイコンと重ねない */}
            <line x1={x} y1={20} x2={x} y2={8 + PLOT_H} stroke="var(--s1)" strokeDasharray="3 3" />
            <text x={x} y={16} textAnchor="middle" fontSize="17" fill="var(--s1)">
              ⚡
            </text>
            {/* 細い線・小さな文字だけではホバー判定が難しいため、透明の当たり領域を重ねる */}
            <rect
              x={x - 8}
              y={0}
              width={16}
              height={8 + PLOT_H}
              fill="transparent"
              pointerEvents="all"
            />
            {/* 見た目はブラウザ標準 tooltip 風（白背景・細枠・黒文字）に、
                影と余白を足して背景のチャートから浮かせる。表示は 0.3 秒遅延 */}
            <g className="cmark-tip" pointerEvents="none">
              <rect
                x={tipX}
                y={4}
                width={tipW}
                height={tipH}
                rx={5}
                fill="var(--surface)"
                stroke="var(--baseline)"
              />
              <text
                x={tipX + tipW / 2}
                y={4 + tipH / 2 + 4}
                textAnchor="middle"
                fontSize="12"
                fill="var(--ink)"
              >
                compaction #{i + 1} 発生 — 以前の会話を要約
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
