/**
 * ソース切替（source filter）の共有状態と切替 UI（SPEC-DASH-085〜086・Issue #31）。
 *
 * 選択は App レベルの state（Context 経由）で保持し、ハッシュ遷移で失われない。
 * URL には載せない（日付絞り込みと同じ扱い）。
 */
import { createContext, useContext } from 'react';
import type { SourceInfo } from './types';

export interface SourceFilterValue {
  /** 選択中のソース id。undefined = 全ソース（既定）。 */
  source: string | undefined;
  setSource(source: string | undefined): void;
  /** /api/sources の結果（登録済みソースとセッション数）。 */
  sources: SourceInfo[];
}

export const SourceFilterContext = createContext<SourceFilterValue>({
  source: undefined,
  setSource: () => undefined,
  sources: [],
});

export function useSourceFilter(): SourceFilterValue {
  return useContext(SourceFilterContext);
}

const SOURCE_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** ソース id の表示名（未知 id はそのまま出す）。 */
export function sourceLabel(id: string): string {
  return SOURCE_LABELS[id] ?? id;
}

/**
 * 全ソース / Claude / Codex のセグメント切替。常時表示し、セッション 0 件の
 * ソースは disabled にする（2026-08-09 オーナー合意。SPEC-DASH-086）。
 */
export function SourceSwitch() {
  const { source, setSource, sources } = useSourceFilter();
  return (
    <div className="presets srcswitch" data-testid="source-switch">
      <button className={source === undefined ? 'on' : ''} onClick={() => setSource(undefined)}>
        全ソース
      </button>
      {sources.map((s) => (
        <button
          key={s.id}
          className={source === s.id ? 'on' : ''}
          disabled={s.sessions === 0}
          title={s.sessions === 0 ? 'このソースのセッションはありません' : undefined}
          onClick={() => setSource(s.id)}
        >
          {sourceLabel(s.id)}
        </button>
      ))}
    </div>
  );
}

/** 一覧・検索ヒットの行に付けるソースバッジ（SPEC-DASH-087）。 */
export function SourceBadge({ source }: { source: string }) {
  return <span className={`badge src src-${source}`}>{sourceLabel(source)}</span>;
}
