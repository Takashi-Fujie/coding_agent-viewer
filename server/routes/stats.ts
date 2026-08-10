/**
 * GET /api/stats/*。仕様は docs/design/API.md と docs/design/DASH.md（SPEC-DASH-020〜025）。
 *
 * summary のカウンタではなく records を走査する。日付・プロジェクトの絞り込みと
 * 「失敗数（tool_use と tool_result の id 突き合わせ）」「最終使用日時」が要るため。
 * id → ツール名の対応はセッション単位でリクエスト時に組み立てる（インデックスに
 * 永続化しない — 増分更新の境界をまたぐ結合状態を持たないため）。
 */
import { Router } from 'express';
import { filterByRange, modelDateRows } from '../aggregate.js';
import { parseRange, parseSource, parseTzOffset, projectsBySource, queryInt, queryString, wrap } from '../http.js';
import type { ApiContext } from '../http.js';
import type { Snapshot } from '../store.js';
import type { IndexRecord } from '../core/types.js';

const MCP_TOOL_RE = /^mcp__(.+?)__(.+)$/;
const DEFAULT_HOOK_LIMIT = 100;

export interface ToolStat {
  name: string;
  count: number;
  failures: number;
}

export interface McpStat {
  server: string;
  count: number;
  failures: number;
  tools: string[];
}

export interface ProjectToolStat {
  project: string;
  total: number;
  failures: number;
  byTool: Record<string, number>;
}

export interface UsageStat {
  name: string;
  count: number;
  lastTimestamp: string | null;
}

export interface HookEntry {
  timestamp: string | null;
  hookName: string;
  hookEvent: string | null;
  project: string;
  sessionId: string;
}

/** 絞り込み条件。project / source は指定が無ければ全対象。 */
interface StatsFilter {
  from: string | undefined;
  to: string | undefined;
  tzOffset: number;
  project: string | undefined;
  source: string | undefined;
}

function parseFilter(query: Record<string, unknown>, snapshot: Snapshot): StatsFilter {
  const { from, to } = parseRange(query);
  return {
    from,
    to,
    tzOffset: parseTzOffset(query),
    project: queryString(query['project']),
    source: parseSource(query, snapshot),
  };
}

/** プロジェクト × セッションのレコードを絞り込み付きで列挙する。 */
function* sessionRecords(
  snapshot: Snapshot,
  filter: StatsFilter,
): Generator<{ project: string; sessionId: string; records: IndexRecord[] }> {
  for (const project of projectsBySource(snapshot, filter.source)) {
    if (filter.project !== undefined && project.id !== filter.project) continue;
    for (const session of project.sessions) {
      yield {
        project: project.id,
        sessionId: session.id,
        records: filterByRange(session.index.records, filter.from, filter.to, filter.tzOffset),
      };
    }
  }
}

/** count 降順（同数は名前昇順）。 */
function byCountDesc<T extends { count: number; name?: string; server?: string }>(a: T, b: T): number {
  return b.count - a.count || (a.name ?? a.server ?? '').localeCompare(b.name ?? b.server ?? '');
}

function toolStats(snapshot: Snapshot, filter: StatsFilter) {
  const counts = new Map<string, ToolStat>();
  const byProject = new Map<string, ProjectToolStat>();

  for (const { project, records } of sessionRecords(snapshot, filter)) {
    // このセッション内の tool_use id → ツール名（失敗結果の突き合わせ用）
    const nameById = new Map<string, string>();

    const projectRow = byProject.get(project) ?? { project, total: 0, failures: 0, byTool: {} };
    byProject.set(project, projectRow);

    for (const record of records) {
      for (const toolUse of record.toolUses ?? []) {
        if (toolUse.id !== '') nameById.set(toolUse.id, toolUse.name);
        const stat = counts.get(toolUse.name) ?? { name: toolUse.name, count: 0, failures: 0 };
        stat.count += 1;
        counts.set(toolUse.name, stat);
        projectRow.total += 1;
        projectRow.byTool[toolUse.name] = (projectRow.byTool[toolUse.name] ?? 0) + 1;
      }
    }
    for (const record of records) {
      if (record.isToolError !== true || record.toolResultFor === undefined) continue;
      const name = nameById.get(record.toolResultFor);
      if (name === undefined) continue;
      counts.get(name)!.failures += 1;
      projectRow.failures += 1;
    }
  }

  const mcpByServer = new Map<string, McpStat & { toolSet: Set<string> }>();
  for (const stat of counts.values()) {
    const match = MCP_TOOL_RE.exec(stat.name);
    if (!match) continue;
    const [, server, tool] = match as unknown as [string, string, string];
    const row = mcpByServer.get(server) ?? {
      server,
      count: 0,
      failures: 0,
      tools: [],
      toolSet: new Set<string>(),
    };
    row.count += stat.count;
    row.failures += stat.failures;
    row.toolSet.add(tool);
    mcpByServer.set(server, row);
  }

  return {
    tools: [...counts.values()].sort(byCountDesc),
    mcp: [...mcpByServer.values()]
      .map(({ toolSet, ...row }) => ({ ...row, tools: [...toolSet].sort() }))
      .sort(byCountDesc),
    byProject: [...byProject.values()]
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total || a.project.localeCompare(b.project)),
  };
}

/** subagent / skill の起動回数と最終使用日時。 */
function usageStats(
  snapshot: Snapshot,
  filter: StatsFilter,
  pick: (record: IndexRecord) => (string | undefined)[],
): UsageStat[] {
  const stats = new Map<string, UsageStat>();
  for (const { records } of sessionRecords(snapshot, filter)) {
    for (const record of records) {
      for (const name of pick(record)) {
        if (name === undefined) continue;
        const stat = stats.get(name) ?? { name, count: 0, lastTimestamp: null };
        stat.count += 1;
        if (record.timestamp !== undefined && (stat.lastTimestamp === null || record.timestamp > stat.lastTimestamp)) {
          stat.lastTimestamp = record.timestamp;
        }
        stats.set(name, stat);
      }
    }
  }
  return [...stats.values()].sort(byCountDesc);
}

export function statsRoutes(ctx: ApiContext): Router {
  const router = Router();

  router.get(
    '/api/stats/tokens',
    wrap(async (req, res) => {
      const { from, to } = parseRange(req.query);
      const tzOffset = parseTzOffset(req.query);
      const snapshot = await ctx.load();
      const projects = projectsBySource(snapshot, parseSource(req.query, snapshot));
      const records = filterByRange(
        projects.flatMap((p) => p.sessions.flatMap((s) => s.index.records)),
        from,
        to,
        tzOffset,
      );
      res.json(modelDateRows(records, tzOffset));
    }),
  );

  router.get(
    '/api/stats/tools',
    wrap(async (req, res) => {
      const snapshot = await ctx.load();
      const filter = parseFilter(req.query, snapshot);
      res.json(toolStats(snapshot, filter));
    }),
  );

  router.get(
    '/api/stats/agents',
    wrap(async (req, res) => {
      const snapshot = await ctx.load();
      const filter = parseFilter(req.query, snapshot);
      res.json({
        subagents: usageStats(snapshot, filter, (r) => (r.toolUses ?? []).map((t) => t.subagentType)),
        skills: usageStats(snapshot, filter, (r) => (r.toolUses ?? []).map((t) => t.skill)),
      });
    }),
  );

  router.get(
    '/api/stats/hooks',
    wrap(async (req, res) => {
      const limit = queryInt(req.query['limit'], DEFAULT_HOOK_LIMIT);
      const snapshot = await ctx.load();
      const filter = parseFilter(req.query, snapshot);

      const hooks: HookEntry[] = [];
      for (const { project, sessionId, records } of sessionRecords(snapshot, filter)) {
        for (const record of records) {
          if (record.hookName === undefined) continue;
          hooks.push({
            timestamp: record.timestamp ?? null,
            hookName: record.hookName,
            hookEvent: record.hookEvent ?? null,
            project,
            sessionId,
          });
        }
      }
      hooks.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));

      res.json({ hooks: hooks.slice(0, limit), truncated: hooks.length > limit });
    }),
  );

  return router;
}
