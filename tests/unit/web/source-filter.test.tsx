// @vitest-environment jsdom
/**
 * SPEC-DASH-085〜089: ソース切替 UI と識別表示（Issue #31）。仕様は docs/design/DASH.md。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewView } from '../../../web/src/views/OverviewView';
import { SourceFilterContext, SourceSwitch } from '../../../web/src/lib/source';
import type { SourceFilterValue } from '../../../web/src/lib/source';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  location.hash = '';
});

const CLAUDE_PROJECT = {
  id: '-home-dev-sample',
  sources: ['claude'],
  path: '/home/dev/sample',
  sessionCount: 2,
  totalTokens: 1000,
  estimatedCost: 0.5,
  records: 10,
  lastTimestamp: '2026-08-06T10:00:00.000Z',
};

const CODEX_PROJECT = {
  id: '-home-dev-codex-proj',
  sources: ['codex'],
  path: '/home/dev/codex-proj',
  sessionCount: 1,
  totalTokens: 0,
  estimatedCost: 0,
  records: 4,
  lastTimestamp: '2026-08-06T11:00:00.000Z',
};

/** cwd 欠損の日付フォールバックグループ（path 無し → id 表示）。 */
const CODEX_DATE_FALLBACK = {
  id: '2026-08-06',
  sources: ['codex'],
  path: null,
  sessionCount: 1,
  totalTokens: 0,
  estimatedCost: 0,
  records: 2,
  lastTimestamp: '2026-08-06T12:00:00.000Z',
};

function payload(projects: unknown[]) {
  return {
    range: { from: null, to: null },
    totals: { tokens: { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0 }, records: 14, sessions: 3, skippedLines: 0 },
    cost: { estimated: true, source: 'server/pricing.json', currency: 'USD', total: 0.5, byModel: {}, unknownModels: [] },
    byModel: {},
    daily: [{ date: '2026-08-06', tokens: { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0 }, cost: 0.5 }],
    projects,
  };
}

function provider(value: Partial<SourceFilterValue> = {}): SourceFilterValue {
  return {
    source: undefined,
    setSource: () => undefined,
    sources: [
      { id: 'claude', sessions: 2 },
      { id: 'codex', sessions: 1 },
    ],
    ...value,
  };
}

function renderOverview(value: SourceFilterValue) {
  return render(
    <SourceFilterContext.Provider value={value}>
      <OverviewView />
    </SourceFilterContext.Provider>,
  );
}

describe('SourceSwitch（SPEC-DASH-085 / 086）', () => {
  it('SPEC-DASH-085: 全ソース / Claude / Codex の切替が表示され、クリックで選択が変わる', () => {
    const setSource = vi.fn();
    render(
      <SourceFilterContext.Provider value={provider({ setSource })}>
        <SourceSwitch />
      </SourceFilterContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(setSource).toHaveBeenCalledWith('codex');
    fireEvent.click(screen.getByRole('button', { name: '全ソース' }));
    expect(setSource).toHaveBeenCalledWith(undefined);
  });

  it('SPEC-DASH-085: 選択中のソースが API の source クエリに乗る', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(String(url), 'http://localhost');
      expect(u.searchParams.get('source')).toBe('codex');
      return new Response(JSON.stringify(payload([CODEX_PROJECT])), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderOverview(provider({ source: 'codex' }));
    await screen.findByTestId('project-table');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('SPEC-DASH-086: Codex のセッションが 0 件のとき Codex の選択肢は disabled になる', () => {
    render(
      <SourceFilterContext.Provider
        value={provider({ sources: [{ id: 'claude', sessions: 2 }, { id: 'codex', sessions: 0 }] })}
      >
        <SourceSwitch />
      </SourceFilterContext.Provider>,
    );

    expect((screen.getByRole('button', { name: 'Codex' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Claude' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ソースの識別表示（SPEC-DASH-087 / 089）', () => {
  it('SPEC-DASH-087: 一覧の行にソースバッジが付き、行ラベルはソース不問で cwd 末尾（path 無しは id）になる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload([CLAUDE_PROJECT, CODEX_PROJECT, CODEX_DATE_FALLBACK])), { status: 200 })),
    );

    renderOverview(provider());
    const table = await screen.findByTestId('project-table');

    // Codex 行: claude と同じ cwd 末尾ラベル + バッジ（#45 改定）
    const codexRow = within(table).getByText('codex-proj', { selector: 'b' }).closest('tr')!;
    expect(within(codexRow).getByText('Codex')).toBeTruthy();
    // Claude 行: 従来どおり cwd 末尾ラベル + バッジ
    const claudeRow = within(table).getByText('sample', { selector: 'b' }).closest('tr')!;
    expect(within(claudeRow).getByText('Claude')).toBeTruthy();
  });

  it('SPEC-CODEX-106: codex グループの行ラベルが cwd 末尾の basename になり、path の無いグループは id 表示になる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload([CODEX_PROJECT, CODEX_DATE_FALLBACK])), { status: 200 })),
    );

    renderOverview(provider());
    const table = await screen.findByTestId('project-table');

    // cwd ありグループ: basename ラベル（id の縮約形は出さない）
    expect(within(table).getByText('codex-proj', { selector: 'b' })).toBeTruthy();
    expect(within(table).queryByText('-home-dev-codex-proj', { selector: 'b' })).toBeNull();
    // cwd 欠損の日付フォールバックグループ: id（日付）ラベル
    expect(within(table).getByText('2026-08-06', { selector: 'b' })).toBeTruthy();
  });

  it('SPEC-DASH-089: Codex 行のコスト・トークン欄は 0 円と断定せず未集計表示になる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload([CLAUDE_PROJECT, CODEX_PROJECT])), { status: 200 })),
    );

    renderOverview(provider());
    const table = await screen.findByTestId('project-table');
    const codexRow = within(table).getByText('codex-proj', { selector: 'b' }).closest('tr')!;

    expect(within(codexRow).getAllByText('未集計').length).toBeGreaterThan(0);
    expect(within(codexRow).queryByText('$0.00')).toBeNull();
  });
});

describe('日別絞り込み（SPEC-DASH-088）', () => {
  it('SPEC-DASH-088: 日付クリック絞り込みは records > 0 を基準にし、usage 0 の Codex 行も一覧に残る', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(String(url), 'http://localhost');
        if (u.searchParams.get('from') !== null && u.searchParams.get('from') === u.searchParams.get('to')) {
          // 単日取得: usage 0 の Codex 行 + その日にレコードの無い Claude 行
          return new Response(
            JSON.stringify(payload([CODEX_PROJECT, { ...CLAUDE_PROJECT, totalTokens: 0, estimatedCost: 0, records: 0 }])),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(payload([CLAUDE_PROJECT, CODEX_PROJECT])), { status: 200 });
      }),
    );

    renderOverview(provider());
    await screen.findByTestId('project-table');

    // チャートの帯クリック（2026-08-06）で単日へ絞り込む
    fireEvent.click(screen.getByTestId('band-2026-08-06'));
    await screen.findByTestId('day-chip');

    const table = screen.getByTestId('project-table');
    // usage 0 でも records > 0 の Codex 行は残る
    expect(within(table).getByText('codex-proj', { selector: 'b' })).toBeTruthy();
    // その日にレコードの無い Claude 行は落ちる
    expect(within(table).queryByText('sample', { selector: 'b' })).toBeNull();
  });
});
