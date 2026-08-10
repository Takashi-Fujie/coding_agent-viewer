/**
 * 型付き fetch クライアント。仕様は docs/design/CHAT.md / docs/design/DASH.md。
 * DTO はサーバの正規化型（lib/types.ts 経由）だけを参照する。
 */
import type {
  AgentStatsResponse,
  ConfigResponse,
  DailyModelRow,
  HookStatsResponse,
  MessagesPage,
  OverviewResponse,
  ProjectListItem,
  SearchResponse,
  SessionDetail,
  SessionListItem,
  SourcesResponse,
  ToolStatsResponse,
} from './lib/types';
import { localToday, presetRange, tzOffsetMinutes } from './lib/dates';
import type { PresetKey } from './lib/dates';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // JSON でないエラー応答はステータスのまま
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface ProjectDetail {
  id: string;
  source: string;
  path: string | null;
  range: { from: string | null; to: string | null };
  daily: DailyModelRow[];
  sessions: SessionListItem[];
}

/** 期間・タイムゾーンの絞り込みクエリ（SPEC-DASH-010 / 021）。 */
export interface RangeQuery {
  from?: string;
  to?: string;
  project?: string;
  limit?: number;
  /** ソース絞り込み（SPEC-DASH-081〜082）。未指定 = 全ソース。 */
  source?: string;
}

function query(params: RangeQuery): string {
  const search = new URLSearchParams();
  if (params.from !== undefined) search.set('from', params.from);
  if (params.to !== undefined) search.set('to', params.to);
  if (params.project !== undefined) search.set('project', params.project);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.source !== undefined) search.set('source', params.source);
  // 期間指定はローカル日付なので、常にブラウザの tz をサーバへ渡す
  search.set('tzOffset', String(tzOffsetMinutes()));
  return `?${search.toString()}`;
}

/** プリセットをローカル日付の from / to へ展開する（SPEC-DASH-031）。 */
export function presetQuery(preset: PresetKey): RangeQuery {
  return presetRange(preset, localToday());
}

export const api = {
  overview: (params: RangeQuery = {}) =>
    getJson<OverviewResponse>(`/api/overview${query(params)}`),
  projects: () => getJson<ProjectListItem[]>('/api/projects'),
  sources: () => getJson<SourcesResponse>('/api/sources'),
  project: (id: string, params: RangeQuery = {}) =>
    getJson<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}${query(params)}`),
  session: (id: string) => getJson<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  messages: (id: string, start: number, limit: number) =>
    getJson<MessagesPage>(
      `/api/sessions/${encodeURIComponent(id)}/messages?start=${start}&limit=${limit}`,
    ),
  statsTools: (params: RangeQuery = {}) =>
    getJson<ToolStatsResponse>(`/api/stats/tools${query(params)}`),
  statsAgents: (params: RangeQuery = {}) =>
    getJson<AgentStatsResponse>(`/api/stats/agents${query(params)}`),
  statsHooks: (params: RangeQuery = {}) =>
    getJson<HookStatsResponse>(`/api/stats/hooks${query(params)}`),
  search: (q: string, source?: string) =>
    getJson<SearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}${source !== undefined ? `&source=${encodeURIComponent(source)}` : ''}`,
    ),
  config: () => getJson<ConfigResponse>('/api/config'),
};
