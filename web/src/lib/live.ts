/**
 * ライブ更新のクライアント側（SPEC-LIVE-020〜023）。仕様は docs/design/LIVE.md。
 *
 * 接続はブラウザ標準 EventSource に任せる（自動再接続・Last-Event-ID の再送を自前で
 * 実装しない）。jsdom に EventSource が無いためコンストラクタは注入できるようにする。
 */
import { createRowBuilder } from './thread';
import type { RowBuilder } from './thread';
import type { CostSummary, MessageMeta, SessionDetail, SessionSummary } from './types';

export type LiveStatus = 'connected' | 'disconnected';

/** SSE の append イベントの data。サーバ側 LiveAppendPayload と同形。 */
export interface LiveAppendPayload {
  start: number;
  messages: MessageMeta[];
  summary: SessionSummary;
  cost: CostSummary;
}

export interface OpenLiveOptions {
  sessionId: string;
  /** クライアントが既に持っているレコード件数（ここから先の差分を購読する）。 */
  have: number;
  onAppend: (payload: LiveAppendPayload) => void;
  onReset: () => void;
  onStatus: (status: LiveStatus) => void;
  /** テスト用の差し替え口。既定はブラウザの EventSource。 */
  eventSourceCtor?: typeof EventSource | undefined;
}

export interface LiveConnection {
  close: () => void;
}

export function openLive(options: OpenLiveOptions): LiveConnection {
  const Ctor = options.eventSourceCtor ?? EventSource;
  const url = `/api/live?session=${encodeURIComponent(options.sessionId)}&have=${String(options.have)}`;
  const source = new Ctor(url);

  source.onopen = () => options.onStatus('connected');
  source.onerror = () => options.onStatus('disconnected');
  source.addEventListener('append', (event) => {
    options.onAppend(JSON.parse((event as MessageEvent<string>).data) as LiveAppendPayload);
  });
  source.addEventListener('reset', () => options.onReset());

  return { close: () => source.close() };
}

/**
 * append イベントをセッション詳細へ適用する。summary / cost は全量置き換え、
 * messages は start 位置から追記する（再送・重複配信でも二重追記にならない）。
 */
export function applyAppend(detail: SessionDetail, payload: LiveAppendPayload): SessionDetail {
  return {
    ...detail,
    summary: payload.summary,
    cost: payload.cost,
    messages: [...detail.messages.slice(0, payload.start), ...payload.messages],
  };
}

/**
 * append イベントを行ビルダーへ適用する（SPEC-LIVE-065）。
 * start が既知件数と一致するときだけ増分適用し（既存行の参照を保つ）、
 * 一致しないとき（再送・巻き戻り）は適用済みメッセージ全量から作り直す。
 */
export function advanceRowBuilder(
  builder: RowBuilder | undefined,
  payload: LiveAppendPayload,
  appliedMessages: MessageMeta[],
): RowBuilder {
  if (builder && payload.start === builder.count) {
    builder.append(payload.messages);
    return builder;
  }
  const fresh = createRowBuilder();
  fresh.append(appliedMessages);
  return fresh;
}
