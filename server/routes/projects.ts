/**
 * GET /api/projects, /api/projects/:id。仕様は docs/design/API.md（SPEC-API-020〜022）。
 */
import { Router } from 'express';
import { dailyByModel, filterByRange } from '../aggregate.js';
import { estimateRecordsCost } from '../cost.js';
import { HttpError, parseRange, parseSource, parseTzOffset, projectsBySource, wrap } from '../http.js';
import type { ApiContext } from '../http.js';
import type { SessionEntry } from '../store.js';
import type { PriceTable } from '../cost.js';
import type { IndexRecord } from '../core/types.js';
import { projectListItem, projectPath } from './overview.js';

/**
 * セッション一覧の 1 行。トークン・コストは範囲フィルタ後のレコードで計算する
 * （日付クリック絞り込みで from = to を渡すと「その日の活動量」になる。SPEC-DASH-040）。
 * recordCount / モデル一覧などのメタは要約のまま（セッション全体の性質を表す）。
 */
function sessionListItem(
  session: SessionEntry,
  table: PriceTable,
  filter: (records: IndexRecord[]) => IndexRecord[],
): Record<string, unknown> {
  const summary = session.index.summary;
  const records = filter(session.index.records);
  const filteredCount = records.length;
  let totalTokens = 0;
  for (const record of records) {
    if (record.kind !== 'assistant' || record.usage === undefined) continue;
    totalTokens +=
      record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheCreation;
  }

  return {
    id: session.id,
    source: session.sourceId,
    // worktree 併合されたセッションのラベル（SPEC-DASH-100）。本体・非統合は null
    worktree: session.worktree,
    records: filteredCount,
    title: summary.title ?? null,
    firstTimestamp: summary.firstTimestamp ?? null,
    lastTimestamp: summary.lastTimestamp ?? null,
    recordCount: summary.recordCount,
    skippedLineCount: summary.skippedLineCount,
    totalTokens,
    estimatedCost: estimateRecordsCost(records, table).total,
    models: Object.keys(summary.models).sort(),
  };
}

export function projectRoutes(ctx: ApiContext): Router {
  const router = Router();

  router.get(
    '/api/projects',
    wrap(async (req, res) => {
      const [snapshot, table] = await Promise.all([ctx.load(), ctx.loadTable()]);
      const projects = projectsBySource(snapshot, parseSource(req.query, snapshot));
      res.json(projects.map((p) => projectListItem(p, table)));
    }),
  );

  router.get(
    '/api/projects/:id',
    wrap(async (req, res) => {
      const { from, to } = parseRange(req.query);
      const tzOffset = parseTzOffset(req.query);
      const [snapshot, table] = await Promise.all([ctx.load(), ctx.loadTable()]);
      const projects = projectsBySource(snapshot, parseSource(req.query, snapshot));

      const project = projects.find((p) => p.id === req.params['id']);
      if (!project) {
        throw new HttpError(404, `プロジェクトが見つかりません: ${req.params['id']}`);
      }

      const records = filterByRange(
        project.sessions.flatMap((s) => s.index.records),
        from,
        to,
        tzOffset,
      );

      res.json({
        id: project.id,
        source: project.sourceId,
        path: projectPath(project),
        range: { from: from ?? null, to: to ?? null },
        daily: dailyByModel(records, table, tzOffset),
        sessions: project.sessions.map((s) =>
          sessionListItem(s, table, (rs) => filterByRange(rs, from, to, tzOffset)),
        ),
      });
    }),
  );

  return router;
}
