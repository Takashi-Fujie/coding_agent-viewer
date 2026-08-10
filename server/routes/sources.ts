/**
 * GET /api/sources。仕様は docs/design/DASH.md（SPEC-DASH-080・Issue #31）。
 *
 * 切替 UI の表示と disabled 判定（セッション 0 件のソース）に使う。
 * ルートが存在しないソースも登録されていれば 0 件で返す（UI から見えなくしない）。
 */
import { Router } from 'express';
import { wrap } from '../http.js';
import type { ApiContext } from '../http.js';

export interface SourceInfo {
  id: string;
  sessions: number;
}

export function sourceRoutes(ctx: ApiContext): Router {
  const router = Router();

  router.get(
    '/api/sources',
    wrap(async (_req, res) => {
      const snapshot = await ctx.load();

      const counts = new Map<string, number>();
      for (const id of snapshot.sourcesById.keys()) counts.set(id, 0);
      for (const project of snapshot.projects) {
        counts.set(project.sourceId, (counts.get(project.sourceId) ?? 0) + project.sessions.length);
      }

      const sources: SourceInfo[] = [...counts].map(([id, sessions]) => ({ id, sessions }));
      res.json({ sources });
    }),
  );

  return router;
}
