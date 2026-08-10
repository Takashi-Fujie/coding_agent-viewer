// @vitest-environment jsdom
/**
 * Overview 画面（SPEC-DASH-032〜037・SPEC-CHAT-005）。仕様は docs/design/DASH.md。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewView } from '../../../web/src/views/OverviewView';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  location.hash = '';
});

const BY_MODEL = {
  'claude-opus-5': {
    input: 1_210_000,
    output: 840_000,
    cacheRead: 28_400_000,
    cacheCreation: 2_100_000,
    messages: 1208,
    cacheCreation5m: 1_900_000,
    cacheCreation1h: 200_000,
  },
  'claude-imaginary-9': {
    input: 8100,
    output: 3200,
    cacheRead: 0,
    cacheCreation: 0,
    messages: 14,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
  },
};

const COST = {
  estimated: true,
  source: 'server/pricing.json',
  currency: 'USD',
  total: 12.47,
  byModel: {
    'claude-opus-5': { messages: 1208, total: 12.47, unknownModel: false },
    'claude-imaginary-9': { messages: 14, total: 0, unknownModel: true },
  },
  unknownModels: ['claude-imaginary-9'],
};

const PROJECTS = [
  {
    id: '-home-dev-newer',
    source: 'claude',
    records: 10,
    path: '/home/dev/newer',
    sessionCount: 3,
    totalTokens: 1000,
    estimatedCost: 0.5,
    lastTimestamp: '2026-08-06T10:00:00.000Z',
  },
  {
    id: '-home-dev-costly',
    source: 'claude',
    records: 5,
    path: '/home/dev/costly',
    sessionCount: 1,
    totalTokens: 9000,
    estimatedCost: 9.9,
    lastTimestamp: '2026-08-04T10:00:00.000Z',
  },
  {
    id: '-home-dev-memory-only',
    source: 'claude',
    records: 0,
    path: null,
    sessionCount: 0,
    totalTokens: 0,
    estimatedCost: 0,
    lastTimestamp: null,
  },
];

const DAILY = [
  { date: '2026-08-04', tokens: { input: 1000, output: 500, cacheRead: 4000, cacheCreation: 800 }, cost: 0.5 },
  { date: '2026-08-05', tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, cost: 0 },
  { date: '2026-08-06', tokens: { input: 3000, output: 800, cacheRead: 9000, cacheCreation: 1200 }, cost: 1.2 },
];

function payload(over: Record<string, unknown> = {}) {
  return {
    range: { from: null, to: null },
    totals: {
      tokens: { input: 1_218_100, output: 843_200, cacheRead: 28_400_000, cacheCreation: 2_100_000 },
      records: 100,
      sessions: 4,
      skippedLines: 0,
    },
    cost: COST,
    byModel: BY_MODEL,
    daily: DAILY,
    projects: PROJECTS,
    ...over,
  };
}

/**
 * /api/overview を絞り込みクエリで出し分ける stub。
 * from === to（日付クリックの単日取得）のときは「08-06 だけ活動」を返す。
 */
function stubApi(main: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(String(url), 'http://localhost');
      expect(u.pathname).toBe('/api/overview');
      const from = u.searchParams.get('from');
      const to = u.searchParams.get('to');
      if (from !== null && from === to) {
        // 単日: 08-06 だけ newer プロジェクトが活動、それ以外の日は活動なし
        const active = from === '2026-08-06' ? [PROJECTS[0]] : [];
        return new Response(JSON.stringify(payload({ projects: active })), { status: 200 });
      }
      return new Response(JSON.stringify(payload(main)), { status: 200 });
    }),
  );
}

describe('OverviewView', () => {
  it('SPEC-DASH-032: 総コスト（推定明示）・総トークンのタイルとモデル別ドーナツ 2 つを表示する', async () => {
    stubApi();
    render(<OverviewView />);

    const hero = await screen.findByTestId('tile-cost');
    expect(hero.textContent).toContain('$12.47');
    expect(hero.textContent).toContain('推定');
    expect(screen.getByTestId('tile-tokens').textContent).toContain('32.6M');

    expect(within(screen.getByTestId('donut-tokens')).getByText('claude-opus-5')).toBeTruthy();
    expect(within(screen.getByTestId('donut-cost')).getByText('claude-opus-5')).toBeTruthy();
  });

  it('SPEC-DASH-034: 帯クリックで一覧が絞り込まれ、チップと ✕ で解除でき、活動が無い日は「該当なし」', async () => {
    stubApi();
    render(<OverviewView />);
    await screen.findByTestId('tile-cost');

    // 08-06 をクリック → newer だけに絞り込まれチップが出る
    fireEvent.click(screen.getByTestId('band-2026-08-06'));
    const chip = await screen.findByTestId('day-chip');
    expect(chip.textContent).toMatch(/2026-08-06.*に活動したプロジェクト/);
    const table = screen.getByTestId('project-table');
    expect(await within(table).findByText('/home/dev/newer')).toBeTruthy();
    expect(within(table).queryByText('/home/dev/costly')).toBeNull();

    // ✕ で解除
    fireEvent.click(screen.getByRole('button', { name: '絞り込み解除' }));
    expect(await within(table).findByText('/home/dev/costly')).toBeTruthy();

    // 活動の無い 08-05 は「該当なし」
    fireEvent.click(screen.getByTestId('band-2026-08-05'));
    expect(await within(table).findByText(/この日に活動したプロジェクトはありません/)).toBeTruthy();
  });

  it('SPEC-DASH-035: 未知モデルがあるとき警告バナーに件数と「含まれていない」を表示し、無ければ出さない', async () => {
    stubApi();
    render(<OverviewView />);
    const banner = await screen.findByTestId('unknown-banner');
    expect(banner.textContent).toContain('未知モデル 1 件');
    expect(banner.textContent).toContain('含まれていません');

    cleanup();
    vi.unstubAllGlobals();
    // <synthetic> はクライアント生成の擬似メッセージなので警告対象にしない
    stubApi({ cost: { ...COST, unknownModels: ['<synthetic>'] } });
    render(<OverviewView />);
    await screen.findByTestId('tile-cost');
    expect(screen.queryByTestId('unknown-banner')).toBeNull();
  });

  it('SPEC-DASH-036: プロジェクト一覧を並び替え付きで全件表示し、行クリックでプロジェクト画面へ遷移する', async () => {
    stubApi();
    render(<OverviewView />);
    const table = screen.getByTestId('project-table');
    await within(table).findByText('/home/dev/newer');

    // 既定: 最終更新降順
    let rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('newer');

    // コスト順に切り替え
    fireEvent.change(screen.getByLabelText('プロジェクトの並び替え'), {
      target: { value: 'cost' },
    });
    rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('costly');

    fireEvent.click(within(table).getByText('/home/dev/newer').closest('tr')!);
    expect(location.hash).toBe('#/projects/-home-dev-newer');
  });

  it('SPEC-CHAT-005: セッション数 0 のプロジェクトは既定で隠れ、チェックを入れると表示される', async () => {
    stubApi();
    render(<OverviewView />);
    const table = screen.getByTestId('project-table');
    await within(table).findByText('/home/dev/newer');
    expect(within(table).queryByText('-home-dev-memory-only')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(await within(table).findByText('-home-dev-memory-only')).toBeTruthy();
  });

  it('SPEC-DASH-037: モデル別内訳テーブルは 5m/1h 内訳と推定コストを表示し、単価未登録モデルに警告バッジを付ける', async () => {
    stubApi();
    render(<OverviewView />);
    const table = await screen.findByTestId('model-table');

    const opus = within(table).getByText('claude-opus-5').closest('tr')!;
    // cache write の 5m / 1h 内訳
    expect(opus.textContent).toContain('1.9M / 200.0K');
    expect(opus.textContent).toContain('$12.47');

    const unknown = within(table).getByText('claude-imaginary-9').closest('tr')!;
    expect(unknown.textContent).toContain('単価未登録');
  });
});
