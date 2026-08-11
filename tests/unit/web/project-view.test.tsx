// @vitest-environment jsdom
/**
 * プロジェクト画面（SPEC-DASH-040）と worktree グルーピング（SPEC-DASH-101〜104）。
 * 仕様は docs/design/DASH.md。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionListView } from '../../../web/src/views/SessionListView';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  location.hash = '';
});

const PROJECT = {
  id: '-home-dev-project-a',
  sources: ['claude'],
  path: '/home/dev/project-a',
  range: { from: null, to: null },
  bySource: [{ source: 'claude', sessions: 1, records: 312, totalTokens: 4_200_000, estimatedCost: 1.84 }],
  daily: [
    { date: '2026-08-05', byModel: { 'claude-opus-5': 4000, 'claude-sonnet-5': 1000 }, cost: 0.9 },
    { date: '2026-08-06', byModel: { 'claude-opus-5': 2000 }, cost: 0.4 },
  ],
  sessions: [
    {
      id: 's-1',
      title: '認証まわりのリファクタリング',
      firstTimestamp: '2026-08-05T01:00:00.000Z',
      lastTimestamp: '2026-08-06T10:00:00.000Z',
      recordCount: 312,
      skippedLineCount: 0,
      totalTokens: 4_200_000,
      estimatedCost: 1.84,
      models: ['claude-opus-5'],
    },
  ],
};

describe('SessionListView（プロジェクト画面）', () => {
  it('SPEC-DASH-040: 日次モデル別チャートとセッション一覧を表示し、パンくずで Overview へ戻れる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(PROJECT), { status: 200 })),
    );
    render(<SessionListView projectId="-home-dev-project-a" />);

    // セッション一覧
    expect(await screen.findByText('認証まわりのリファクタリング')).toBeTruthy();

    // 日次モデル別チャート（モデル名の凡例付きコンボチャート）
    expect(screen.getByTestId('tokens-panel')).toBeTruthy();
    expect(screen.getByTestId('cost-panel')).toBeTruthy();
    const legend = screen.getByTestId('model-legend');
    expect(within(legend).getByText('claude-opus-5')).toBeTruthy();
    expect(within(legend).getByText('claude-sonnet-5')).toBeTruthy();

    // パンくずの戻り先は Overview（#/）
    const back = screen.getByRole('link', { name: /Overview/ });
    expect(back.getAttribute('href')).toBe('#/');
  });
});

/** worktree 統合済みプロジェクトの合成レスポンス。wt-b の方が wt-a より最終更新が新しい。 */
function sessionRow(over: {
  id: string;
  title: string;
  worktree: string | null;
  lastTimestamp: string;
  records?: number;
}) {
  return {
    id: over.id,
    source: 'claude',
    worktree: over.worktree,
    records: over.records ?? 10,
    title: over.title,
    firstTimestamp: '2026-08-05T00:00:00.000Z',
    lastTimestamp: over.lastTimestamp,
    recordCount: 10,
    skippedLineCount: 0,
    totalTokens: 1000,
    estimatedCost: 0.1,
    models: ['claude-opus-5'],
  };
}

const GROUPED_PROJECT = {
  id: '-home-dev-project-a',
  sources: ['claude'],
  path: '/home/dev/project-a',
  range: { from: null, to: null },
  bySource: [{ source: 'claude', sessions: 4, records: 40, totalTokens: 4000, estimatedCost: 0.4 }],
  daily: [{ date: '2026-08-05', byModel: { 'claude-opus-5': 4000 }, cost: 0.9 }],
  sessions: [
    sessionRow({ id: 's-m1', title: '本体の作業', worktree: null, lastTimestamp: '2026-08-06T10:00:00.000Z' }),
    sessionRow({ id: 's-a1', title: 'wt-a の新しい作業', worktree: 'wt-a', lastTimestamp: '2026-08-07T10:00:00.000Z' }),
    sessionRow({ id: 's-a2', title: 'wt-a の古い作業', worktree: 'wt-a', lastTimestamp: '2026-08-05T10:00:00.000Z' }),
    sessionRow({ id: 's-b1', title: 'wt-b の作業', worktree: 'wt-b', lastTimestamp: '2026-08-08T10:00:00.000Z' }),
  ],
};

describe('SessionListView（worktree グルーピング）', () => {
  it('SPEC-DASH-101: セッション一覧が「本体」と worktree 名のグループ見出しに分かれ件数が付く', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(GROUPED_PROJECT), { status: 200 })),
    );
    render(<SessionListView projectId="-home-dev-project-a" />);
    await screen.findByText('本体の作業');

    const groups = screen.getAllByTestId('wt-group');
    const texts = groups.map((g) => g.textContent ?? '');
    expect(texts.some((t) => t.includes('本体') && t.includes('1'))).toBe(true);
    expect(texts.some((t) => t.includes('wt-a') && t.includes('2'))).toBe(true);
    expect(texts.some((t) => t.includes('wt-b') && t.includes('1'))).toBe(true);
  });

  it('SPEC-DASH-102: 本体が先頭・worktree は最終更新の新しい順、グループ内も最終更新の新しい順', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(GROUPED_PROJECT), { status: 200 })),
    );
    render(<SessionListView projectId="-home-dev-project-a" />);
    await screen.findByText('本体の作業');

    // グループ順: 本体 → wt-b（08-08）→ wt-a（08-07）
    const labels = screen.getAllByTestId('wt-group').map((g) => g.textContent ?? '');
    expect(labels[0]).toContain('本体');
    expect(labels[1]).toContain('wt-b');
    expect(labels[2]).toContain('wt-a');

    // wt-a グループ内は新しい順（s-a1 → s-a2）
    const table = screen.getByTestId('session-table');
    const rowTitles = within(table)
      .getAllByRole('row')
      .map((r) => r.textContent ?? '');
    const newer = rowTitles.findIndex((t) => t.includes('wt-a の新しい作業'));
    const older = rowTitles.findIndex((t) => t.includes('wt-a の古い作業'));
    expect(newer).toBeGreaterThan(-1);
    expect(newer).toBeLessThan(older);
  });

  it('SPEC-DASH-103: worktree セッションの無いプロジェクトではグループ見出しを描画しない', async () => {
    const flat = {
      ...GROUPED_PROJECT,
      sessions: [
        sessionRow({ id: 's-m1', title: '本体の作業', worktree: null, lastTimestamp: '2026-08-06T10:00:00.000Z' }),
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(flat), { status: 200 })),
    );
    render(<SessionListView projectId="-home-dev-project-a" />);
    await screen.findByText('本体の作業');
    expect(screen.queryAllByTestId('wt-group')).toHaveLength(0);
  });

  it('SPEC-DASH-104: 日付クリック絞り込み中もグループ表示が保たれる', async () => {
    const dayFiltered = {
      ...GROUPED_PROJECT,
      range: { from: '2026-08-05', to: '2026-08-05' },
      sessions: [
        sessionRow({ id: 's-a2', title: 'wt-a の古い作業', worktree: 'wt-a', lastTimestamp: '2026-08-05T10:00:00.000Z' }),
        sessionRow({ id: 's-m1', title: '本体の作業', worktree: null, lastTimestamp: '2026-08-06T10:00:00.000Z', records: 0 }),
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('from=')
          ? new Response(JSON.stringify(dayFiltered), { status: 200 })
          : new Response(JSON.stringify(GROUPED_PROJECT), { status: 200 }),
      ),
    );
    render(<SessionListView projectId="-home-dev-project-a" />);
    await screen.findByText('本体の作業');

    fireEvent.click(screen.getByTestId('band-2026-08-05'));
    // records > 0 の wt-a セッションだけが残り、グループ見出し付きで表示される
    await screen.findByText('wt-a の古い作業');
    const labels = screen.getAllByTestId('wt-group').map((g) => g.textContent ?? '');
    expect(labels.some((t) => t.includes('wt-a'))).toBe(true);
    expect(screen.queryByText('本体の作業')).toBeNull();
  });
});
