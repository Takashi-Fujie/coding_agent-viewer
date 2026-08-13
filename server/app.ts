/**
 * Express アプリの生成。仕様は docs/design/API.md。
 *
 * logDir / cacheDir / claudeDir を注入可能にし、テストは合成ログの一時ディレクトリで
 * アプリを組み立てる（実ログ ~/.claude に触れない）。listen はここでは行わない
 * （supertest がポート無しで直接叩けるように、bind は server/index.ts の責務）。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { loadPriceTable } from './cost.js';
import { HttpError } from './http.js';
import type { ApiContext } from './http.js';
import { createLiveHub } from './live.js';
import type { LiveHub } from './live.js';
import { loadSnapshot } from './store.js';
import { createClaudeSource } from './sources/claude.js';
import { createCodexSource } from './sources/codex.js';
import { configRoutes } from './routes/config.js';
import { liveRoutes } from './routes/live.js';
import { overviewRoutes } from './routes/overview.js';
import { projectRoutes } from './routes/projects.js';
import { searchRoutes } from './routes/search.js';
import { sessionRoutes } from './routes/sessions.js';
import { sourceRoutes } from './routes/sources.js';
import { statsRoutes } from './routes/stats.js';

export interface AppOptions {
  /** セッション JSONL のルート（本番は ~/.claude/projects）。 */
  logDir: string;
  cacheDir: string;
  /** 設定・定義の読み取り元（本番は ~/.claude）。 */
  claudeDir: string;
  /**
   * Codex rollout のルート（本番は ~/.codex/sessions）。指定されたときだけ Codex
   * ソースを登録する（SPEC-CODEX-068。既定で実 ~/.codex に触れさせない）。
   */
  codexSessionsDir?: string | undefined;
  /** 価格表のパス。省略時は server/pricing.json。 */
  priceTablePath?: string | undefined;
  /**
   * リネーム追跡の台帳・エイリアスの置き場（SPEC-CORE-100〜109。本番はリポジトリ直下
   * `local/`・gitignore 済み）。省略時はリネーム追跡を行わない。
   */
  localDir?: string | undefined;
  /** フロントエンドのビルド成果物（本番は web/dist）。存在するときだけ静的配信する。 */
  webDistDir?: string | undefined;
  /**
   * ライブ配信のハブ（SPEC-LIVE）。省略時は内部生成する。
   * テストは自前で生成して渡し、終了時に close() で chokidar を確実に破棄する。
   */
  hub?: LiveHub | undefined;
}

/** 既定のフロントエンド成果物の場所（`npm run build:web` の出力先）。 */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../web/dist', import.meta.url));

export function createApp(options: AppOptions): Express {
  const loadTable = (): ReturnType<typeof loadPriceTable> => loadPriceTable(options.priceTablePath);
  // 発見（store）と監視（hub）で同じソース実体・同じルートを共有する
  const roots = [{ source: createClaudeSource({ logDir: options.logDir }), dir: options.logDir }];
  if (options.codexSessionsDir !== undefined) {
    roots.push({
      source: createCodexSource({ sessionsDir: options.codexSessionsDir }),
      dir: options.codexSessionsDir,
    });
  }
  const sources = roots.map((r) => r.source);
  const ctx: ApiContext = {
    load: () => loadSnapshot({ sources, cacheDir: options.cacheDir, localDir: options.localDir }),
    loadTable,
    claudeDir: options.claudeDir,
    hub: options.hub ?? createLiveHub({ roots, cacheDir: options.cacheDir, loadTable }),
  };

  const app = express();

  // フロントエンド成果物の静的配信（SPEC-CHAT-060）。ハッシュルーティングなので
  // SPA fallback は不要で、index.html と静的アセットを返すだけでよい。
  const webDistDir = options.webDistDir ?? DEFAULT_WEB_DIST_DIR;
  if (existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
  }

  app.use(overviewRoutes(ctx));
  app.use(projectRoutes(ctx));
  app.use(sessionRoutes(ctx));
  app.use(searchRoutes(ctx));
  app.use(sourceRoutes(ctx));
  app.use(statsRoutes(ctx));
  app.use(configRoutes(ctx));
  app.use(liveRoutes(ctx));

  // どのルートにも一致しなかったリクエスト
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `存在しないパスです: ${req.path}` });
  });

  // ハンドラが投げた例外・拒否を JSON へ変換する（サーバは落とさない）
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
