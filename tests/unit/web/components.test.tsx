// @vitest-environment jsdom
/**
 * セッション分析画面コンポーネントの受け入れテスト。仕様は docs/design/CHAT.md。
 * ロジックは lib/ の純関数テストが担い、ここでは描画の要所だけを検証する。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DividerLine } from '../../../web/src/components/DividerLine';
import { KindLegend } from '../../../web/src/components/KindLegend';
import { MessageBubble } from '../../../web/src/components/MessageBubble';
import { SessionHeader } from '../../../web/src/components/SessionHeader';
import { SidechainGroup } from '../../../web/src/components/SidechainGroup';
import { ToolCall } from '../../../web/src/components/ToolCall';
import { ToolRanking } from '../../../web/src/components/ToolRanking';
import { TurnCostChart } from '../../../web/src/components/TurnCostChart';
import { UsageTable } from '../../../web/src/components/UsageTable';
import type { Exchange } from '../../../web/src/lib/exchanges';
import type { MessageMeta, SessionSummary } from '../../../web/src/lib/types';

afterEach(cleanup);

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    recordCount: 10,
    skippedLineCount: 0,
    assistantCount: 4,
    userCount: 3,
    sidechainCount: 2,
    syntheticCount: 0,
    compactionCount: 0,
    models: {
      'claude-opus-5': {
        messages: 4,
        input: 1000,
        output: 2000,
        cacheRead: 3000,
        cacheCreation: 400,
        cacheCreation5m: 300,
        cacheCreation1h: 100,
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

function assistantMeta(over: Partial<MessageMeta> = {}): MessageMeta {
  return {
    index: 0,
    offset: 0,
    length: 10,
    type: 'assistant',
    kind: 'assistant',
    model: 'claude-opus-5',
    usage: {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheCreation: 40,
      cacheCreation5m: 25,
      cacheCreation1h: 15,
      webSearch: 0,
      webFetch: 0,
    },
    cost: { total: 0.0123, unknownModel: false },
    ...over,
  } as MessageMeta;
}

describe('SessionHeader', () => {
  it('SPEC-CHAT-002: モデル・総トークン・推定コスト・破損スキップ行数を表示する', () => {
    render(
      <SessionHeader
        title="テストセッション"
        summary={summary({ skippedLineCount: 3 })}
        costTotal={1.84}
        unknownModels={[]}
      />,
    );
    expect(screen.getByText(/claude-opus-5/)).toBeTruthy();
    // 1000+2000+3000+400 = 6.4K tok
    expect(screen.getByText(/6\.4K tok/)).toBeTruthy();
    expect(screen.getByText(/\$1\.84 推定/)).toBeTruthy();
    expect(screen.getByText(/破損 3 行スキップ/)).toBeTruthy();
  });

  it('SPEC-CHAT-003: skippedLineCount が 0 のときは破損行の注意を出さない', () => {
    render(
      <SessionHeader title="t" summary={summary()} costTotal={0} unknownModels={[]} />,
    );
    expect(screen.queryByText(/破損/)).toBeNull();
  });
});

describe('KindLegend', () => {
  it('SPEC-CHAT-012: tool / MCP / agent / skill / model の凡例を表示する', () => {
    render(<KindLegend />);
    for (const label of ['tool', 'MCP', 'agent', 'skill', 'model']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

describe('ToolCall', () => {
  it('SPEC-CHAT-020: ツール呼び出しは既定で閉じた折りたたみとして描画される', () => {
    const { container } = render(
      <ToolCall
        toolUse={{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }}
        resultBody={{ blocks: [{ type: 'tool_result', toolUseId: 'tu1', text: '出力' }] }}
      />,
    );
    const details = container.querySelector('details');
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(screen.getByText('Bash')).toBeTruthy();
  });

  it('SPEC-CHAT-021: is_error の tool_result を失敗として明示する', () => {
    render(
      <ToolCall
        toolUse={{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }}
        resultBody={{
          blocks: [{ type: 'tool_result', toolUseId: 'tu1', text: 'boom', isError: true }],
        }}
      />,
    );
    expect(screen.getByText(/失敗/)).toBeTruthy();
  });
});

describe('MessageBubble', () => {
  it('SPEC-CHAT-022: assistant にモデルチップと thinking バッジを表示する', () => {
    render(
      <MessageBubble
        record={assistantMeta({ hasThinking: true })}
        toolResults={{}}
        body={{ blocks: [{ type: 'text', text: '応答' }] }}
      />,
    );
    expect(screen.getByText('claude-opus-5')).toBeTruthy();
    expect(screen.getByText('thinking')).toBeTruthy();
  });

  it('SPEC-CHAT-041: メッセージ単位のトークン内訳と推定コストを表示する', () => {
    render(
      <MessageBubble
        record={assistantMeta()}
        toolResults={{}}
        body={{ blocks: [{ type: 'text', text: '応答' }] }}
      />,
    );
    const cost = screen.getByText(/in 10 · out 20/);
    expect(cost.textContent).toContain('cache read 30');
    expect(cost.textContent).toContain('cache write 40（5m 25 / 1h 15）');
    expect(cost.textContent).toContain('$0.0123 推定');
  });
});

describe('DividerLine', () => {
  it('SPEC-CHAT-023: compact_boundary を compact 区切りとして表示する', () => {
    render(
      <DividerLine
        row={{
          type: 'compact',
          startIndex: 4,
          record: { index: 4, offset: 0, length: 1, type: 'system', kind: 'system' } as MessageMeta,
        }}
      />,
    );
    expect(screen.getByText(/compact/)).toBeTruthy();
  });

  it('SPEC-CHAT-024: turn_duration を「ターン完了 · 所要時間」区切りとして表示する', () => {
    render(
      <DividerLine
        row={{
          type: 'turn',
          startIndex: 5,
          record: {
            index: 5,
            offset: 0,
            length: 1,
            type: 'system',
            kind: 'system',
            durationMs: 42_000,
          } as MessageMeta,
        }}
      />,
    );
    expect(screen.getByText(/ターン完了 · 42 秒/)).toBeTruthy();
  });

  it('SPEC-CHAT-082: compact 区切り行の通し番号を「compaction #N」として表示する', () => {
    render(
      <DividerLine
        row={{
          type: 'compact',
          startIndex: 4,
          seq: 2,
          record: { index: 4, offset: 0, length: 1, type: 'system', kind: 'system' } as MessageMeta,
        }}
      />,
    );
    expect(screen.getByText(/compaction #2/)).toBeTruthy();
  });
});

describe('SidechainGroup', () => {
  it('SPEC-CHAT-031: 折りたたみで展開でき、使用モデルと推定コストを表示する', () => {
    const records = [
      {
        index: 2,
        offset: 0,
        length: 1,
        type: 'user',
        kind: 'user',
        isSidechain: true,
        preview: '調査して',
      } as MessageMeta,
      assistantMeta({ index: 3, model: 'claude-haiku-4-5', cost: { total: 0.014, unknownModel: false }, isSidechain: true }),
    ];
    const { container } = render(
      <SidechainGroup row={{ type: 'sidechain', startIndex: 2, records }} getBody={() => undefined} />,
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    // summary（折りたたみ見出し）と展開後の本文の両方に現れうるため複数一致を許す
    expect(screen.getAllByText(/claude-haiku-4-5/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\$0\.014/).length).toBeGreaterThan(0);
  });
});

describe('TurnCostChart', () => {
  const exchanges: Exchange[] = [
    { index: 0, startIndex: 0, endIndex: 3, preview: '前半', total: 0.01, compacted: true },
    { index: 1, startIndex: 3, endIndex: 6, preview: '後半', total: 0.05, compacted: false },
  ];

  it('SPEC-CHAT-044: 帯クリックで絞り込み、再クリックで解除する。compacted はクリック不可', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <TurnCostChart exchanges={exchanges} selected={null} onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByTestId('turn-band-1'));
    expect(onSelect).toHaveBeenLastCalledWith(1);

    rerender(<TurnCostChart exchanges={exchanges} selected={1} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('turn-band-1'));
    expect(onSelect).toHaveBeenLastCalledWith(null);

    onSelect.mockClear();
    fireEvent.click(screen.getByTestId('turn-band-0'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('SPEC-CHAT-081: markers の位置ごとに ⚡ マーカーを描画し、本数が一致する', () => {
    render(
      <TurnCostChart exchanges={exchanges} selected={null} onSelect={() => {}} markers={[1, 2]} />,
    );
    expect(screen.getAllByTestId('compaction-marker')).toHaveLength(2);
  });

  it('SPEC-CHAT-081: markers が空のときはマーカーを描画しない', () => {
    render(<TurnCostChart exchanges={exchanges} selected={null} onSelect={() => {}} markers={[]} />);
    expect(screen.queryByTestId('compaction-marker')).toBeNull();
  });
});

describe('ToolRanking', () => {
  it('SPEC-CHAT-050: ツール別ランキングを呼び出し回数の降順で表示する', () => {
    render(<ToolRanking counts={{ Bash: 5, Read: 9, Edit: 2 }} />);
    const labels = screen.getAllByTestId('tool-name').map((el) => el.textContent);
    expect(labels).toEqual(['Read', 'Bash', 'Edit']);
  });
});

describe('UsageTable', () => {
  it('SPEC-CHAT-051: MCP サーバ / subagent / Skill の一覧を回数付きで表示する', () => {
    render(
      <UsageTable
        summary={summary({
          toolUseCounts: { 'mcp__github__create_pr': 3, Bash: 5 },
          subagentTypes: { Explore: 1 },
          skills: { 'dev-cycle': 2 },
        })}
      />,
    );
    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('Explore')).toBeTruthy();
    expect(screen.getByText('dev-cycle')).toBeTruthy();
    // 通常ツール（Bash）は MCP 一覧に混ぜない
    expect(screen.queryByText('Bash')).toBeNull();
  });
});
