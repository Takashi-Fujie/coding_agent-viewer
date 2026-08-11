/**
 * セッション分析画面（SPEC-CHAT の本体）。仕様は docs/design/CHAT.md。
 *
 * メタ（IndexRecord）で骨格・集計を組み立て、本文は表示範囲だけ遅延取得する。
 * 会話は行配列へ平坦化し、window 基準の仮想スクロールで描画する（SPEC-CHAT-025）。
 */
import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { api } from '../api';
import { createBodyStore } from '../lib/bodystore';
import { buildExchanges } from '../lib/exchanges';
import { formatUsd } from '../lib/format';
import { advanceRowBuilder, applyAppend, openLive } from '../lib/live';
import type { LiveStatus } from '../lib/live';
import { createRowBuilder, filterRows } from '../lib/thread';
import { DividerLine } from '../components/DividerLine';
import { KindLegend } from '../components/KindLegend';
import { MessageBubble } from '../components/MessageBubble';
import { SessionHeader } from '../components/SessionHeader';
import { SidechainGroup } from '../components/SidechainGroup';
import { ToolRanking } from '../components/ToolRanking';
import { TurnCostChart } from '../components/TurnCostChart';
import { UsageTable } from '../components/UsageTable';
import { routeHash } from '../router';
import type { BodyStore } from '../lib/bodystore';
import type { Row, RowBuilder } from '../lib/thread';
import type { MessageBody, SessionDetail } from '../lib/types';

const PAGE_SIZE = 100;

export interface SessionViewProps {
  projectId: string;
  sessionId: string;
}

export function SessionView({ projectId, sessionId }: SessionViewProps) {
  const [detail, setDetail] = useState<SessionDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<number | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | undefined>();
  /** reset イベント（全再構築）で詳細を取得し直すための再読込キー（SPEC-LIVE-023）。 */
  const [reloadKey, setReloadKey] = useState(0);
  const storeRef = useRef<BodyStore | undefined>(undefined);
  /** 行の増分構築（SPEC-LIVE-060〜065）。append をまたいで平坦化状態を保持する。 */
  const builderRef = useRef<RowBuilder | undefined>(undefined);
  const detailRef = useRef<SessionDetail | undefined>(undefined);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let alive = true;
    let live: { close: () => void } | undefined;
    setDetail(undefined);
    setSelected(null);
    setLiveStatus(undefined);
    setRows([]);
    builderRef.current = undefined;
    detailRef.current = undefined;
    api.session(sessionId).then(
      (d) => {
        if (!alive) return;
        storeRef.current = createBodyStore({
          pageSize: PAGE_SIZE,
          total: d.messages.length,
          fetchPage: async (start, limit) =>
            (await api.messages(sessionId, start, limit)).items.map((item) => item.body),
        });
        const builder = createRowBuilder();
        builder.append(d.messages);
        builderRef.current = builder;
        detailRef.current = d;
        setDetail(d);
        setRows(builder.rows());
        // ライブ購読（SPEC-LIVE-020〜023）。追記は末尾へ差分適用し、集計は全量を差し替える
        live = openLive({
          sessionId,
          have: d.messages.length,
          onAppend: (payload) => {
            const prev = detailRef.current;
            if (!alive || !prev) return;
            const applied = applyAppend(prev, payload);
            detailRef.current = applied;
            storeRef.current?.grow(applied.messages.length);
            // 行は増分適用（SPEC-LIVE-060〜062）。start 不一致は全再構築（SPEC-LIVE-065）
            builderRef.current = advanceRowBuilder(builderRef.current, payload, applied.messages);
            setDetail(applied);
            setRows(builderRef.current.rows());
          },
          onReset: () => setReloadKey((k) => k + 1),
          onStatus: (status) => {
            if (alive) setLiveStatus(status);
          },
        });
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
      live?.close();
    };
  }, [sessionId, reloadKey]);

  const exchanges = useMemo(() => (detail ? buildExchanges(detail.messages) : []), [detail]);
  const visibleRows = useMemo(() => {
    if (selected === null) return rows;
    const exchange = exchanges.find((e) => e.index === selected);
    return exchange ? filterRows(rows, exchange) : rows;
  }, [rows, exchanges, selected]);

  if (error !== undefined) {
    return (
      <div className="dashwrap">
        <div className="note err">セッションを読み込めません: {error}</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="dashwrap">
        <div className="note">読み込み中…</div>
      </div>
    );
  }

  const title = detail.summary.title ?? detail.id;
  const subline = [
    detail.summary.cwd,
    detail.summary.gitBranch,
    detail.id,
    detail.summary.version !== undefined ? `v${detail.summary.version}` : undefined,
  ]
    .filter((v) => v !== undefined && v !== '')
    .join(' · ');

  return (
    <>
      <div className="crumbs">
        <a href={routeHash({ view: 'overview' })}>← Overview</a>
        <span className="sep">/</span>
        <a href={routeHash({ view: 'sessions', projectId })} className="mono">
          {detail.summary.cwd ?? projectId}
        </a>
        <span className="sep">/</span>
        <span>{title}</span>
      </div>
      <SessionHeader
        title={title}
        summary={detail.summary}
        costTotal={detail.cost.total}
        unknownModels={detail.cost.unknownModels}
        subline={subline}
        live={liveStatus}
      />
      <div className="dashwrap" style={{ paddingBottom: 0 }}>
        <div className="sectionlabel">このセッションの利用状況</div>
        <div className="card">
          <h2>
            やりとり別コスト
            <span className="est">ユーザー入力ごと・subagent 含む・推定・棒クリックで絞り込み</span>
            {selected !== null && (
              <span className="chip on" style={{ marginLeft: 10 }}>
                やりとり <b>#{selected + 1}</b> のみ表示
                <button onClick={() => setSelected(null)}>✕</button>
              </span>
            )}
          </h2>
          <TurnCostChart exchanges={exchanges} selected={selected} onSelect={setSelected} />
          {exchanges.some((e) => e.compacted) && (
            <div className="note">グレーの棒は compact で要約済みのやりとり（クリック不可）</div>
          )}
        </div>
        <div className="cols2">
          <div className="card">
            <h2>
              ツール別ランキング<span className="est">このセッション・呼び出し回数</span>
            </h2>
            <ToolRanking counts={detail.summary.toolUseCounts} />
          </div>
          <div className="card">
            <h2>
              MCP サーバ / subagent / Skill<span className="est">このセッション</span>
            </h2>
            <UsageTable summary={detail.summary} />
          </div>
        </div>
      </div>
      <div className="chatbody">
        <KindLegend />
        <VirtualConversation
          rows={visibleRows}
          store={storeRef.current}
          filtered={selected !== null}
          totalCost={detail.cost.total}
        />
      </div>
    </>
  );
}

/** 行配列を window 仮想スクロールで描画する。 */
function VirtualConversation({
  rows,
  store,
  filtered,
  totalCost,
}: {
  rows: Row[];
  store: BodyStore | undefined;
  filtered: boolean;
  totalCost: number;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 96,
    overscan: 8,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  return (
    <div ref={listRef}>
      {filtered && (
        <div className="note" style={{ marginBottom: 10 }}>
          やりとりで絞り込み中（セッション全体の推定コスト: {formatUsd(totalCost)}）
        </div>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              <RowView row={row} store={store} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 行 1 件の描画。message / sidechain 行は表示時に本文ページを取得する（SPEC-CHAT-026）。
 * memo 化により、ライブ追記で参照の変わらない既存行は再描画されない（SPEC-LIVE-064）。
 */
const RowView = memo(function RowView({ row, store }: { row: Row; store: BodyStore | undefined }) {
  const [, bump] = useReducer((c: number) => c + 1, 0);

  const indices = useMemo(() => {
    if (row.type === 'message') {
      return [row.record.index, ...Object.values(row.toolResults).map((r) => r.index)];
    }
    if (row.type === 'sidechain') return row.records.map((r) => r.index);
    return [];
  }, [row]);

  useEffect(() => {
    if (!store) return;
    let alive = true;
    for (const index of indices) {
      if (store.peek(index) === undefined) {
        void store.ensure(index).then(() => {
          if (alive) bump();
        });
      }
    }
    return () => {
      alive = false;
    };
  }, [store, indices]);

  const getBody = (index: number): MessageBody | undefined => store?.peek(index);

  switch (row.type) {
    case 'compact':
    case 'turn':
      return <DividerLine row={row} />;
    case 'sidechain':
      return <SidechainGroup row={row} getBody={getBody} />;
    case 'message':
      return (
        <MessageBubble
          record={row.record}
          toolResults={row.toolResults}
          body={getBody(row.record.index)}
          getBody={getBody}
        />
      );
  }
});
