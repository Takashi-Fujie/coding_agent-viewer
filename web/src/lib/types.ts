/**
 * viewer が参照する DTO 型。仕様は docs/design/CHAT.md。
 *
 * サーバの正規化 DTO（server/core/types.ts）と同形を保つため型だけを輸入する。
 * Claude 固有の生 JSONL 構造はここに現れない（normalize 側に閉じ込める）。
 */
import type { IndexRecord, SessionSummary } from '../../../server/core/types';
import type { BodyBlock, MessageBody } from '../../../server/core/normalize';
import type { CostSummary } from '../../../server/cost';
import type {
  DailyModelRow,
  DailyOverviewRow,
  ModelTokenBreakdown,
  TokenTotals,
} from '../../../server/aggregate';
import type {
  HookEntry,
  McpStat,
  ProjectToolStat,
  ToolStat,
  UsageStat,
} from '../../../server/routes/stats';

export type {
  BodyBlock,
  CostSummary,
  DailyModelRow,
  DailyOverviewRow,
  HookEntry,
  IndexRecord,
  McpStat,
  MessageBody,
  ModelTokenBreakdown,
  ProjectToolStat,
  SessionSummary,
  TokenTotals,
  ToolStat,
  UsageStat,
};

/** メッセージ単位の推定コスト（サーバ側 estimateCost の要約。SPEC-CHAT-040）。 */
export interface MessageCost {
  total: number;
  unknownModel: boolean;
}

/** GET /api/sessions/:id の messages 要素。 */
export type MessageMeta = IndexRecord & {
  index: number;
  cost?: MessageCost | undefined;
};

/** GET /api/sessions/:id のレスポンス。 */
export interface SessionDetail {
  id: string;
  projectId: string;
  /** セッションを発見したソース id（SPEC-DASH-083）。 */
  source: string;
  summary: SessionSummary;
  cost: CostSummary;
  messages: MessageMeta[];
}

/** GET /api/projects の 1 要素（簡易入口用。#7 で本実装に置き換える）。 */
export interface ProjectListItem {
  id: string;
  /** グループを発見したソース id（SPEC-DASH-083）。 */
  source: string;
  /** セッションの cwd 由来の実パス（SPEC-CHAT-004）。cwd が取れないときは null。 */
  path: string | null;
  sessionCount: number;
  totalTokens: number;
  estimatedCost: number;
  /** 範囲フィルタ後のレコード件数（SPEC-DASH-084）。日別絞り込みの基準。 */
  records: number;
  lastTimestamp: string | null;
}

/** GET /api/projects/:id の sessions の 1 要素。 */
export interface SessionListItem {
  id: string;
  /** セッションを発見したソース id（SPEC-DASH-083）。 */
  source: string;
  /** 範囲フィルタ後のレコード件数（SPEC-DASH-084）。日別絞り込みの基準。 */
  records: number;
  title: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  recordCount: number;
  skippedLineCount: number;
  totalTokens: number;
  estimatedCost: number;
  models: string[];
}

/** GET /api/sessions/:id/messages のレスポンス。 */
export interface MessagesPage {
  start: number;
  limit: number;
  total: number;
  items: Array<{ index: number; meta: IndexRecord; body: MessageBody }>;
}

/** GET /api/overview のレスポンス（SPEC-DASH-012 で byModel を拡張）。 */
export interface OverviewResponse {
  range: { from: string | null; to: string | null };
  totals: {
    tokens: TokenTotals;
    records: number;
    sessions: number;
    skippedLines: number;
  };
  cost: CostSummary;
  byModel: Record<string, ModelTokenBreakdown>;
  daily: DailyOverviewRow[];
  projects: ProjectListItem[];
}

/** GET /api/search のヒット 1 件（SPEC-API-040・SPEC-DASH-060）。 */
export interface SearchHit {
  projectId: string;
  sessionId: string;
  /** ヒットしたセッションのソース id（SPEC-DASH-083）。 */
  source: string;
  offset: number;
  preview: string;
}

/** GET /api/search のレスポンス。 */
export interface SearchResponse {
  q: string;
  limit: number;
  truncated: boolean;
  hits: SearchHit[];
}

/** GET /api/stats/tools のレスポンス（SPEC-DASH-020〜023）。 */
export interface ToolStatsResponse {
  tools: ToolStat[];
  mcp: McpStat[];
  byProject: ProjectToolStat[];
}

/** GET /api/stats/agents のレスポンス（SPEC-DASH-024）。 */
export interface AgentStatsResponse {
  subagents: UsageStat[];
  skills: UsageStat[];
}

/** GET /api/stats/hooks のレスポンス（SPEC-DASH-025）。 */
export interface HookStatsResponse {
  hooks: HookEntry[];
  truncated: boolean;
}

/** エージェント・スキル定義（GET /api/config。SPEC-CONFIG-001〜003）。 */
export interface AgentDefinition {
  name: string;
  path: string;
  description: string | null;
  tools: string[] | null;
  model: string | null;
  parseError: boolean;
}

export interface SkillDefinition {
  name: string;
  path: string;
  description: string | null;
  parseError: boolean;
}

export interface PluginInfo {
  name: string;
  marketplace: string;
}

export interface HistoryProject {
  project: string;
  count: number;
  lastTimestamp: string | null;
}

/** GET /api/config のレスポンス（SPEC-API-060）。settings は表示時に選別する。 */
export interface ConfigResponse {
  claudeDir: string;
  agents: AgentDefinition[];
  skills: SkillDefinition[];
  plugins: PluginInfo[];
  settings: unknown;
  history: HistoryProject[];
}

/** GET /api/sources の 1 要素（SPEC-DASH-080）。 */
export interface SourceInfo {
  id: string;
  sessions: number;
}

/** GET /api/sources のレスポンス。 */
export interface SourcesResponse {
  sources: SourceInfo[];
}
