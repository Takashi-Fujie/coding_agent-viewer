// @vitest-environment jsdom
/**
 * SPEC-DASH-113〜114: 統合プロジェクトの画面表示（Issue #49）。仕様は docs/design/DASH.md。
 *
 * 統合行の複数ソースバッジ・未集計表示の条件（sources に claude を含まない行のみ）と、
 * プロジェクト詳細ヘッダのソース別内訳（複数ソースのときだけ表示）を検証する。
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewView } from '../../../web/src/views/OverviewView';
import { SessionListView } from '../../../web/src/views/SessionListView';
import { SourceFilterContext } from '../../../web/src/lib/source';
import type { SourceFilterValue } from '../../../web/src/lib/source';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  location.hash = '';
});

/** 統合プロジェクト行（claude + codex・合算値）。 */
const MERGED_PROJECT = {
  id: '-home-dev-shared',
  sources: ['claude', 'codex'],
  path: '/home/dev/shared',
  sessionCount: 3,
  totalTokens: 1200,
  estimatedCost: 0.8,
  records: 20,
  lastTimestamp: '2026-08-10T10:00:00.000Z',
};

/** codex 単独プロジェクト行（usage 未集計 = 0）。 */
const CODEX_ONLY_PROJECT = {
  id: '-home-dev-codex-only',
  sources: ['codex'],
  path: '/home/dev/codex-only',
  sessionCount: 1,
  totalTokens: 0,
  estimatedCost: 0,
  records: 4,
  lastTimestamp: '2026-08-10T11:00:00.000Z',
};

function overviewPayload(projects: unknown[]) {
  return {
    range: { from: null, to: null },
    totals: { tokens: { input: 1200, output: 0, cacheRead: 0, cacheCreation: 0 }, records: 24, sessions: 4, skippedLines: 0 },
    cost: { estimated: true, source: 'server/pricing.json', currency: 'USD', total: 0.8, byModel: {}, unknownModels: [] },
    byModel: {},
    daily: [{ date: '2026-08-10', tokens: { input: 1200, output: 0, cacheRead: 0, cacheCreation: 0 }, cost: 0.8 }],
    projects,
  };
}

function detailPayload(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: '-home-dev-shared',
    sources: ['claude', 'codex'],
    path: '/home/dev/shared',
    range: { from: null, to: null },
    daily: [],
    bySource: [
      { source: 'claude', sessions: 2, records: 16, totalTokens: 1200, estimatedCost: 0.8 },
      { source: 'codex', sessions: 1, records: 4, totalTokens: 0, estimatedCost: 0 },
    ],
    sessions: [
      {
        id: 's-claude-1',
        source: 'claude',
        worktree: null,
        records: 16,
        title: '<synthetic> claude セッション',
        firstTimestamp: '2026-08-10T09:00:00.000Z',
        lastTimestamp: '2026-08-10T10:00:00.000Z',
        recordCount: 16,
        skippedLineCount: 0,
        totalTokens: 1200,
        estimatedCost: 0.8,
        models: ['claude-sonnet-5'],
      },
      {
        id: 'codex:rollout-x',
        source: 'codex',
        worktree: null,
        records: 4,
        title: '<synthetic> codex セッション',
        firstTimestamp: '2026-08-10T10:30:00.000Z',
        lastTimestamp: '2026-08-10T11:00:00.000Z',
        recordCount: 4,
        skippedLineCount: 0,
        totalTokens: 0,
        estimatedCost: 0,
        models: [],
      },
    ],
    ...over,
  };
}

const provider: SourceFilterValue = {
  source: undefined,
  setSource: () => undefined,
  sources: [
    { id: 'claude', sessions: 3 },
    { id: 'codex', sessions: 2 },
  ],
};

function renderWith(node: React.ReactNode) {
  return render(<SourceFilterContext.Provider value={provider}>{node}</SourceFilterContext.Provider>);
}

describe('統合行のバッジと未集計表示（SPEC-DASH-113）', () => {
  it('SPEC-DASH-113: 統合行にはソースバッジが複数表示され、未集計表示は sources に claude を含まない行だけに出る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(overviewPayload([MERGED_PROJECT, CODEX_ONLY_PROJECT])), { status: 200 })),
    );

    renderWith(<OverviewView />);
    const table = await screen.findByTestId('project-table');

    // 統合行: Claude / Codex の両バッジ + 合算値の数値表示（未集計にしない）
    const mergedRow = within(table).getByText('shared', { selector: 'b' }).closest('tr')!;
    expect(within(mergedRow).getByText('Claude')).toBeTruthy();
    expect(within(mergedRow).getByText('Codex')).toBeTruthy();
    expect(within(mergedRow).queryByText('未集計')).toBeNull();

    // codex 単独行: バッジは Codex のみで、0 は未集計表示のまま
    const codexRow = within(table).getByText('codex-only', { selector: 'b' }).closest('tr')!;
    expect(within(codexRow).queryByText('Claude')).toBeNull();
    expect(within(codexRow).getAllByText('未集計').length).toBeGreaterThan(0);
  });
});

describe('プロジェクト詳細ヘッダのソース別内訳（SPEC-DASH-114）', () => {
  it('SPEC-DASH-114: 複数ソースのときヘッダに両バッジとソース別内訳（セッション数・トークン・コスト）が表示される', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(detailPayload()), { status: 200 })),
    );

    renderWith(<SessionListView projectId="-home-dev-shared" />);
    await screen.findByTestId('session-table');

    const head = document.querySelector('.chathead')!;
    expect(within(head as HTMLElement).getByText('Claude')).toBeTruthy();
    expect(within(head as HTMLElement).getByText('Codex')).toBeTruthy();

    const breakdown = screen.getByTestId('source-breakdown');
    // 内訳にソース名・セッション数・トークン・コストが含まれる
    expect(breakdown.textContent).toContain('Claude');
    expect(breakdown.textContent).toContain('2 セッション');
    expect(breakdown.textContent).toContain('Codex');
    expect(breakdown.textContent).toContain('1 セッション');
  });

  it('SPEC-DASH-114: 単一ソースのプロジェクトでは内訳を描画せず従来の見た目のまま', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            detailPayload({
              sources: ['claude'],
              bySource: [{ source: 'claude', sessions: 2, records: 16, totalTokens: 1200, estimatedCost: 0.8 }],
            }),
          ),
          { status: 200 },
        ),
      ),
    );

    renderWith(<SessionListView projectId="-home-dev-shared" />);
    await screen.findByTestId('session-table');

    expect(screen.queryByTestId('source-breakdown')).toBeNull();
  });
});
