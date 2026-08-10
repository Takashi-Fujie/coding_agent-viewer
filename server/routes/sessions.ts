/**
 * GET /api/sessions/:id, /api/sessions/:id/messages。
 * 仕様は docs/design/API.md（SPEC-API-030〜034）。
 *
 * 本文はインデックスの offset / length で該当行だけを seek して読む
 * （最大 69MB のファイルを全読みしない。SPEC-API-032）。
 */
import { Router } from 'express';
import { normalizeBody } from '../core/normalize.js';
import { readRecordAt } from '../core/scan.js';
import { estimateRecordsCost } from '../cost.js';
import { toMessageMetas } from '../messages.js';
import { HttpError, queryInt, wrap } from '../http.js';
import type { ApiContext } from '../http.js';
import type { SessionEntry, Snapshot } from '../store.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function findSession(snapshot: Snapshot, id: unknown): SessionEntry {
  const session = typeof id === 'string' ? snapshot.sessionsById.get(id) : undefined;
  if (!session) throw new HttpError(404, `セッションが見つかりません: ${String(id)}`);
  return session;
}

export function sessionRoutes(ctx: ApiContext): Router {
  const router = Router();

  router.get(
    '/api/sessions/:id',
    wrap(async (req, res) => {
      const [snapshot, table] = await Promise.all([ctx.load(), ctx.loadTable()]);
      const session = findSession(snapshot, req.params['id']);

      res.json({
        id: session.id,
        projectId: session.projectId,
        source: session.sourceId,
        summary: session.index.summary,
        cost: estimateRecordsCost(session.index.records, table),
        // assistant メタにはメッセージ単位の推定コストを付ける（SPEC-CHAT-040）。
        // SSE の append と同形を保つため messages.ts に一本化している（SPEC-LIVE-011）。
        messages: toMessageMetas(session.index.records, table),
      });
    }),
  );

  router.get(
    '/api/sessions/:id/messages',
    wrap(async (req, res) => {
      const snapshot = await ctx.load();
      const session = findSession(snapshot, req.params['id']);

      const start = queryInt(req.query['start'], 0);
      const limit = Math.min(queryInt(req.query['limit'], DEFAULT_LIMIT), MAX_LIMIT);
      const records = session.index.records;
      const page = records.slice(start, start + limit);

      // 本文正規化はソース固有（Codex は content 構造が異なる）。発見したソースへ委ねる。
      const toBody = snapshot.sourcesById.get(session.sourceId)?.normalizeBody ?? normalizeBody;
      const items = await Promise.all(
        page.map(async (record, i) => ({
          index: start + i,
          meta: record,
          body: toBody(await readRecordAt(session.filePath, record.offset, record.length)),
        })),
      );

      res.json({ start, limit, total: records.length, items });
    }),
  );

  return router;
}
