/**
 * GET /api/overview。仕様は docs/design/API.md（SPEC-API-010〜013）。
 */
import { Router } from 'express';
import { dailyOverview, filterByRange, tokenTotals, tokensByModel } from '../aggregate.js';
import { estimateRecordsCost } from '../cost.js';
import { parseRange, parseSource, parseTzOffset, projectsBySource, wrap } from '../http.js';
import type { ApiContext } from '../http.js';
import type { ProjectEntry } from '../store.js';
import type { PriceTable } from '../cost.js';
import type { IndexRecord } from '../core/types.js';

export interface ProjectListItem {
  id: string;
  /** グループを発見したソース id（SPEC-DASH-083）。UI のバッジ・行ラベル切替に使う。 */
  source: string;
  /**
   * セッションの cwd 由来の実パス（SPEC-CHAT-004）。ディレクトリ名は `/` が `-` に
   * 変換された不可逆形式なので復号せず、ログの cwd を正とする。cwd が無ければ null。
   */
  path: string | null;
  sessionCount: number;
  totalTokens: number;
  estimatedCost: number;
  /** 範囲フィルタ後のレコード件数（SPEC-DASH-084）。usage 0 でも日別絞り込みで消さない基準。 */
  records: number;
  lastTimestamp: string | null;
}

/** プロジェクトの表示用実パス。最終更新が新しいセッションの cwd を採用する。 */
export function projectPath(project: ProjectEntry): string | null {
  let path: string | null = null;
  let latest = '';
  for (const session of project.sessions) {
    const { cwd, lastTimestamp } = session.index.summary;
    if (cwd !== undefined && cwd !== '' && (path === null || (lastTimestamp ?? '') > latest)) {
      path = cwd;
      latest = lastTimestamp ?? '';
    }
  }
  return path;
}

/** プロジェクト一覧の 1 行。/api/projects と Overview のプロジェクト一覧で共用する。 */
export function projectListItem(
  project: ProjectEntry,
  table: PriceTable,
  filter?: (records: IndexRecord[]) => IndexRecord[],
): ProjectListItem {
  const records = project.sessions.flatMap((s) => s.index.records);
  const filtered = filter ? filter(records) : records;
  const tokens = tokenTotals(filtered);

  let lastTimestamp: string | null = null;
  for (const session of project.sessions) {
    const last = session.index.summary.lastTimestamp;
    if (last && (!lastTimestamp || last > lastTimestamp)) lastTimestamp = last;
  }

  return {
    id: project.id,
    source: project.sourceId,
    path: projectPath(project),
    sessionCount: project.sessions.length,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation,
    estimatedCost: estimateRecordsCost(filtered, table).total,
    records: filtered.length,
    lastTimestamp,
  };
}

export function overviewRoutes(ctx: ApiContext): Router {
  const router = Router();

  router.get(
    '/api/overview',
    wrap(async (req, res) => {
      const { from, to } = parseRange(req.query);
      const tzOffset = parseTzOffset(req.query);
      const [snapshot, table] = await Promise.all([ctx.load(), ctx.loadTable()]);
      const projects = projectsBySource(snapshot, parseSource(req.query, snapshot));

      const all = projects.flatMap((p) => p.sessions.flatMap((s) => s.index.records));
      const records = filterByRange(all, from, to, tzOffset);
      const inRange = (rs: IndexRecord[]): IndexRecord[] => filterByRange(rs, from, to, tzOffset);

      let sessions = 0;
      let skippedLines = 0;
      for (const project of projects) {
        sessions += project.sessions.length;
        for (const session of project.sessions) {
          skippedLines += session.index.summary.skippedLineCount;
        }
      }

      res.json({
        range: { from: from ?? null, to: to ?? null },
        totals: {
          tokens: tokenTotals(records),
          records: records.length,
          sessions,
          skippedLines,
        },
        cost: estimateRecordsCost(records, table),
        byModel: tokensByModel(records),
        daily: dailyOverview(records, table, tzOffset),
        projects: projects.map((p) => projectListItem(p, table, inRange)),
      });
    }),
  );

  return router;
}
