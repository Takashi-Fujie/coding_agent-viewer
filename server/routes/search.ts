/**
 * GET /api/search。仕様は docs/design/API.md（SPEC-API-040〜042）。
 *
 * 転置インデックスは作らない。131MB 規模ならストリーム grep で十分速く、
 * 更新コストもかからない（設計上の判断・AGENTS.md）。
 */
import { Router } from 'express';
import { iterateLines } from '../core/scan.js';
import { HttpError, parseSource, projectsBySource, queryInt, queryString, wrap } from '../http.js';
import type { ApiContext } from '../http.js';

const DEFAULT_LIMIT = 100;
/** ヒット前後をどれだけ preview に含めるか（字）。 */
const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 160;

export interface SearchHit {
  projectId: string;
  sessionId: string;
  /** ヒットしたセッションのソース id（SPEC-DASH-083）。 */
  source: string;
  offset: number;
  preview: string;
}

function previewAround(text: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - CONTEXT_BEFORE);
  return text.slice(start, matchIndex + queryLength + CONTEXT_AFTER);
}

export function searchRoutes(ctx: ApiContext): Router {
  const router = Router();

  router.get(
    '/api/search',
    wrap(async (req, res) => {
      const q = queryString(req.query['q']);
      if (q === undefined) throw new HttpError(400, 'q を指定してください');
      const limit = queryInt(req.query['limit'], DEFAULT_LIMIT);

      const snapshot = await ctx.load();
      const projects = projectsBySource(snapshot, parseSource(req.query, snapshot));
      const needle = q.toLowerCase();
      const hits: SearchHit[] = [];
      let truncated = false;

      outer: for (const project of projects) {
        for (const session of project.sessions) {
          for await (const line of iterateLines(session.filePath)) {
            const matchIndex = line.text.toLowerCase().indexOf(needle);
            if (matchIndex < 0) continue;

            // limit 到達後に次のヒットが見つかった時点で「打ち切った」と確定できる
            if (hits.length >= limit) {
              truncated = true;
              break outer;
            }
            hits.push({
              projectId: project.id,
              sessionId: session.id,
              source: project.sourceId,
              offset: line.offset,
              preview: previewAround(line.text, matchIndex, q.length),
            });
          }
        }
      }

      res.json({ q, limit, truncated, hits });
    }),
  );

  return router;
}
