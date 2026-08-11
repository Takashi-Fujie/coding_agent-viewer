// @vitest-environment jsdom
/**
 * SPEC-LIVE クライアント側（web/src/lib/live.ts・SessionHeader のライブ状態）。
 * 仕様は docs/design/LIVE.md。
 *
 * EventSource は jsdom に無いためコンストラクタ注入のフェイクで検証する。
 * SessionView の配線（reset での再取得・仮想スクロールへの反映）は人間動作確認と
 * E2E（Issue #10）が受け持ち、ここでは差分適用と接続状態のロジックを検証する。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceRowBuilder, applyAppend, openLive } from '../../../web/src/lib/live';
import type { LiveAppendPayload, LiveStatus } from '../../../web/src/lib/live';
import { buildRows, createRowBuilder } from '../../../web/src/lib/thread';
import { SessionHeader } from '../../../web/src/components/SessionHeader';
import { SessionView } from '../../../web/src/views/SessionView';
import { api } from '../../../web/src/api';
import type { MessageBody, MessageMeta, SessionDetail, SessionSummary } from '../../../web/src/lib/types';

// jsdom にはレイアウトが無く仮想スクロールが行を描画しないため、全行を素通しで
// 描画する代役に差し替える。実ブラウザの仮想化は E2E（SPEC-LIVE-066〜068）が受け持つ。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 96,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, index) => ({ key: index, index, start: index * 96 })),
    options: { scrollMargin: 0 },
    measureElement: () => undefined,
  }),
}));

vi.mock('../../../web/src/api', () => ({
  api: { session: vi.fn(), messages: vi.fn() },
}));

afterEach(cleanup);

/** ブラウザ EventSource の代役。emit でサーバからのイベントを模す。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(e: MessageEvent<string>) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (e: MessageEvent<string>) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

function esCtor(): typeof EventSource {
  return FakeEventSource as unknown as typeof EventSource;
}

function makeSummary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    recordCount: 2,
    skippedLineCount: 0,
    assistantCount: 1,
    userCount: 1,
    sidechainCount: 0,
    syntheticCount: 0,
    models: {
      'claude-sonnet-5': {
        messages: 1,
        input: 100,
        output: 200,
        cacheRead: 0,
        cacheCreation: 0,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        webSearch: 0,
        webFetch: 0,
      },
    },
    toolUseCounts: {},
    subagentTypes: {},
    skills: {},
    prNumbers: [],
    ...over,
  };
}

function meta(over: Partial<MessageMeta> & { index: number }): MessageMeta {
  return {
    offset: over.index * 100,
    length: 100,
    type: 'user',
    kind: 'user',
    uuid: `u-${String(over.index)}`,
    parentUuid: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeDetail(): SessionDetail {
  return {
    id: 'sess-1',
    projectId: '-home-dev-live',
    source: 'claude',
    summary: makeSummary(),
    cost: { estimated: true, source: 'test', currency: 'USD', total: 0.5, byModel: {}, unknownModels: [] },
    messages: [
      meta({ index: 0, kind: 'user', type: 'user', uuid: 'u-1', preview: '依頼文' }),
      meta({ index: 1, kind: 'assistant', type: 'assistant', uuid: 'a-1', parentUuid: 'u-1' }),
    ],
  };
}

describe('applyAppend', () => {
  it('SPEC-LIVE-020: append イベントで会話の末尾に新しいメッセージ行が追加される', () => {
    const detail = makeDetail();
    const payload: LiveAppendPayload = {
      start: 2,
      messages: [meta({ index: 2, kind: 'assistant', type: 'assistant', uuid: 'a-2', parentUuid: 'a-1' })],
      summary: makeSummary({ recordCount: 3, assistantCount: 2 }),
      cost: { estimated: true, source: 'test', currency: 'USD', total: 0.75, byModel: {}, unknownModels: [] },
    };

    const applied = applyAppend(detail, payload);
    expect(applied.messages.map((m) => m.uuid)).toEqual(['u-1', 'a-1', 'a-2']);

    const rows = buildRows(applied.messages);
    const messageRows = rows.filter((r) => r.type === 'message');
    expect(messageRows.at(-1)?.record.uuid).toBe('a-2');

    // 重複配信（同じ start の再送）は二重追記にならない
    const reapplied = applyAppend(applied, payload);
    expect(reapplied.messages.map((m) => m.uuid)).toEqual(['u-1', 'a-1', 'a-2']);
  });

  it('SPEC-LIVE-021: append イベントでヘッダの総トークン・推定コストが更新される', () => {
    const detail = makeDetail();
    const payload: LiveAppendPayload = {
      start: 2,
      messages: [meta({ index: 2, kind: 'assistant', type: 'assistant', uuid: 'a-2' })],
      summary: makeSummary({
        models: {
          'claude-sonnet-5': {
            messages: 2,
            input: 600_000,
            output: 400_000,
            cacheRead: 0,
            cacheCreation: 0,
            cacheCreation5m: 0,
            cacheCreation1h: 0,
            webSearch: 0,
            webFetch: 0,
          },
        },
      }),
      cost: { estimated: true, source: 'test', currency: 'USD', total: 9.99, byModel: {}, unknownModels: [] },
    };

    const applied = applyAppend(detail, payload);
    render(
      <SessionHeader
        title="ライブテスト"
        summary={applied.summary}
        costTotal={applied.cost.total}
        unknownModels={applied.cost.unknownModels}
      />,
    );
    expect(screen.getByText(/1\.0M tok/).textContent).toContain('1.0M');
    expect(screen.getByText(/\$9\.99/)).toBeTruthy();
  });
});

describe('openLive', () => {
  it('SPEC-LIVE-022: ライブ状態（接続中 / 切断）が表示され、接続の開閉に追従する', () => {
    FakeEventSource.instances = [];
    const statuses: LiveStatus[] = [];
    openLive({
      sessionId: 'sess-1',
      have: 2,
      onAppend: () => undefined,
      onReset: () => undefined,
      onStatus: (s) => statuses.push(s),
      eventSourceCtor: esCtor(),
    });

    const es = FakeEventSource.instances[0];
    expect(es?.url).toContain('/api/live?session=sess-1&have=2');
    es?.onopen?.(new Event('open'));
    es?.onerror?.(new Event('error'));
    es?.onopen?.(new Event('open'));
    expect(statuses).toEqual(['connected', 'disconnected', 'connected']);

    // 接続状態はヘッダのバッジとして表示される
    render(<SessionHeader title="t" summary={makeSummary()} costTotal={0} unknownModels={[]} live="connected" />);
    expect(screen.getByText(/ライブ/)).toBeTruthy();
    cleanup();
    render(<SessionHeader title="t" summary={makeSummary()} costTotal={0} unknownModels={[]} live="disconnected" />);
    expect(screen.getByText(/切断/)).toBeTruthy();
  });

  it('SPEC-LIVE-023: reset イベントでセッション詳細を取得し直す', () => {
    FakeEventSource.instances = [];
    const onReset = vi.fn();
    const onAppend = vi.fn();
    const live = openLive({
      sessionId: 'sess-1',
      have: 2,
      onAppend,
      onReset,
      onStatus: () => undefined,
      eventSourceCtor: esCtor(),
    });

    const es = FakeEventSource.instances[0];
    es?.emit('append', {
      start: 2,
      messages: [],
      summary: makeSummary(),
      cost: { estimated: true, source: 'test', currency: 'USD', total: 0, byModel: {}, unknownModels: [] },
    });
    expect(onAppend).toHaveBeenCalledTimes(1);

    es?.emit('reset', {});
    // 取得し直しの入口（SessionView が api.session() を呼び直すコールバック）が発火する
    expect(onReset).toHaveBeenCalledTimes(1);

    live.close();
    expect(es?.closed).toBe(true);
  });
});

describe('差分追記描画（Issue #33）', () => {
  const bodyOf = (text: string): MessageBody => ({ blocks: [{ type: 'text', text }] });

  it('SPEC-LIVE-064: append イベントで表示済み行の DOM 要素は作り直されず、新着行だけが追加される', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const sessionMock = vi.mocked(api.session);
    const messagesMock = vi.mocked(api.messages);
    sessionMock.mockResolvedValue(makeDetail());
    messagesMock.mockImplementation(async (_id, start, limit) => ({
      start,
      limit,
      total: start + limit,
      items: Array.from({ length: limit }, (_, i) => ({
        index: start + i,
        meta: meta({ index: start + i }),
        body: bodyOf(`本文${String(start + i)}`),
      })),
    }));

    render(<SessionView projectId="-home-dev-live" sessionId="sess-1" />);

    // 初期表示: 本文が遅延取得で埋まる
    await screen.findByText('本文0');
    await screen.findByText('本文1');
    const shown = screen.getByText('本文0');
    expect(messagesMock).toHaveBeenCalledWith('sess-1', 0, 2);

    const es = FakeEventSource.instances.at(-1);
    act(() => {
      es?.emit('append', {
        start: 2,
        messages: [meta({ index: 2, kind: 'assistant', type: 'assistant', uuid: 'a-2', preview: '新着' })],
        summary: makeSummary({ recordCount: 3, assistantCount: 2 }),
        cost: { estimated: true, source: 'test', currency: 'USD', total: 0.75, byModel: {}, unknownModels: [] },
      } satisfies LiveAppendPayload);
    });

    // 新着行だけが末尾に追加され、本文は不足分（start=2）だけ取得される
    await screen.findByText('本文2');
    expect(messagesMock).toHaveBeenLastCalledWith('sess-1', 2, 1);
    expect(messagesMock).toHaveBeenCalledTimes(2);

    // 表示済みメッセージの DOM 要素は追記の前後で同一（作り直されていない）
    expect(screen.getByText('本文0')).toBe(shown);

    vi.unstubAllGlobals();
  });

  it('SPEC-LIVE-065: start が既知件数と一致しない append は全再構築で適用され、表示が二重にならない', () => {
    const detail = makeDetail();
    const payload: LiveAppendPayload = {
      start: 2,
      messages: [meta({ index: 2, kind: 'assistant', type: 'assistant', uuid: 'a-2' })],
      summary: makeSummary({ recordCount: 3 }),
      cost: { estimated: true, source: 'test', currency: 'USD', total: 0.75, byModel: {}, unknownModels: [] },
    };

    const builder = createRowBuilder();
    builder.append(detail.messages);

    // start === count: 増分適用（同じ builder のまま）
    const applied = applyAppend(detail, payload);
    const advanced = advanceRowBuilder(builder, payload, applied.messages);
    expect(advanced).toBe(builder);
    expect(advanced.rows().map((r) => r.type === 'message' && r.record.uuid)).toEqual(['u-1', 'a-1', 'a-2']);

    // 同じ payload の再送（start 2 ≠ count 3）: 全再構築になり、行が二重にならない
    const reapplied = applyAppend(applied, payload);
    const rebuilt = advanceRowBuilder(advanced, payload, reapplied.messages);
    expect(rebuilt).not.toBe(advanced);
    expect(rebuilt.rows().map((r) => r.type === 'message' && r.record.uuid)).toEqual(['u-1', 'a-1', 'a-2']);
  });
});
