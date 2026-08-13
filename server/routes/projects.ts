/**
 * GET /api/projects, /api/projects/:id。仕様は docs/design/API.md（SPEC-API-020〜022）。
 */
import { Router } from 'express';
import { dailyByModel, filterByRange, tokenTotals } from '../aggregate.js';
import { estimateRecordsCost } from '../cost.js';
import { HttpError, displayProjects, parseRange, parseSource, parseTzOffset, wrap } from '../http.js';
import type { ApiContext } from '../http.js';
import type { ProjectEntry, SessionEntry } from '../store.js';
import type { PriceTable } from '../cost.js';
import type { IndexRecord } from '../core/types.js';
import { displayPath, projectListItem } from './overview.js';

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
    compactionCount: summary.compactionCount,
    models: Object.keys(summary.models).sort(),
  };
}

/**
 * ソース別内訳の 1 行（SPEC-DASH-111）。統合プロジェクトのヘッダ表示用に、
 * 範囲フィルタ後のレコードでエントリ（= 単一ソースのグループ）ごとの集計を出す。
 */
function sourceBreakdown(
  entry: ProjectEntry,
  table: PriceTable,
  filter: (records: IndexRecord[]) => IndexRecord[],
): Record<string, unknown> {
  const records = filter(entry.sessions.flatMap((s) => s.index.records));
  const tokens = tokenTotals(records);
  return {
    source: entry.sourceId,
    sessions: entry.sessions.length,
    records: records.length,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation,
    estimatedCost: estimateRecordsCost(records, table).total,
  };
}

export function projectRoutes(ctx: ApiContext): Router {
  const router = Router();

  router.get(
    '/api/projects',
    wrap(async (req, res) => {
      const [snapshot, table] = await Promise.all([ctx.load(), ctx.loadTable()]);
      const projects = displayProjects(snapshot, parseSource(req.query, snapshot));
      res.json(projects.map((p) => projectListItem(p, table)));
    }),
  );

  router.get(
    '/api/projects/:id',
    wrap(async (req, res) => {
      const { from, to } = parseRange(req.query);
      const tzOffset = parseTzOffset(req.query);
      const [snapshot, table] = await Promise.all([ctx.load(), ctx.loadTable()]);
      const projects = displayProjects(snapshot, parseSource(req.query, snapshot));

      const project = projects.find((p) => p.id === req.params['id']);
      if (!project) {
        throw new HttpError(404, `プロジェクトが見つかりません: ${req.params['id']}`);
      }

      const inRange = (rs: IndexRecord[]): IndexRecord[] => filterByRange(rs, from, to, tzOffset);
      const sessions = project.entries.flatMap((e) => e.sessions);
      const records = inRange(sessions.flatMap((s) => s.index.records));

      res.json({
        id: project.id,
        sources: project.entries.map((e) => e.sourceId),
        path: displayPath(project),
        range: { from: from ?? null, to: to ?? null },
        daily: dailyByModel(records, table, tzOffset),
        // 範囲フィルタ後のソース別内訳（SPEC-DASH-111）。単一ソースでも形を変えず返す
        bySource: project.entries.map((e) => sourceBreakdown(e, table, inRange)),
        sessions: sessions.map((s) => sessionListItem(s, table, inRange)),
      });
    }),
  );

  return router;
}
