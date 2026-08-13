/**
 * E2E の共有定数。仕様は docs/design/FLOW.md（E2E 基盤）。
 *
 * サーバ起動スクリプト（server.ts・webServer プロセス）とテスト（*.spec.ts・
 * Playwright ワーカープロセス）は別プロセスなので、フィクスチャの置き場所は
 * 乱数や一時ディレクトリではなく決定的なパス（.cache/e2e・gitignore 済み）で共有する。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_PORT = 4519;
export const E2E_BASE_URL = `http://127.0.0.1:${String(E2E_PORT)}`;

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const E2E_ROOT = join(REPO_ROOT, '.cache', 'e2e');
export const E2E_LOG_DIR = join(E2E_ROOT, 'projects');
export const E2E_CACHE_DIR = join(E2E_ROOT, 'cache');
export const E2E_CLAUDE_DIR = join(E2E_ROOT, 'claude');

/** 合成プロジェクト（cwd = /home/dev/sample-project の変換形）。 */
export const E2E_PROJECT_ID = '-home-dev-sample-project';
export const E2E_PROJECT_PATH = '/home/dev/sample-project';

/** tests/fixtures/session-sample.jsonl のコピー（巨大行・壊れ行・未知モデル入り）。 */
export const SESSION_SAMPLE = 's0000000-0000-4000-8000-000000000001';
/** E2E 主対象セッション（ツール失敗・検索トークン入り）。 */
export const SESSION_MAIN = 's0000000-0000-4000-8000-0000000000e1';
/** ライブ更新テストが追記する専用セッション。 */
export const SESSION_LIVE = 's0000000-0000-4000-8000-0000000000e2';
/** 仮想スクロール追従テスト用の長いセッション（Issue #40）。 */
export const SESSION_LONG = 's0000000-0000-4000-8000-0000000000e3';
/** compaction 表示テスト用のセッション（Issue #52。compact_boundary 1 件入り）。 */
export const SESSION_COMPACT = 's0000000-0000-4000-8000-0000000000e6';
/** SESSION_LONG のメッセージ往復数（user + assistant で LONG_TURNS * 2 行）。 */
export const LONG_TURNS = 40;

export function sessionFilePath(sessionId: string): string {
  return join(E2E_LOG_DIR, E2E_PROJECT_ID, `${sessionId}.jsonl`);
}

/** 全文検索 E2E が探す一意な合成トークン。 */
export const SEARCH_TOKEN = 'E2E検索専用トークンXYZQ';

/* ---- worktree 統合（Issue #41） ---- */

/** 合成の本体リポジトリ（実在する fs 構造として seed が組み立てる）。 */
export const E2E_WT_REPO_ROOT = join(E2E_ROOT, 'repo');
export const E2E_WT_NAME = 'wt-e2e';
/** 本体側プロジェクト（cwd = E2E_WT_REPO_ROOT）。統合後の id はこれになる。 */
export const E2E_WT_MAIN_PROJECT_ID = 'proj-e2e-wt-main';
/** worktree 側プロジェクト（統合されて一覧から消える側）。 */
export const E2E_WT_PROJECT_ID = 'proj-e2e-wt';
export const SESSION_WT_MAIN = 's0000000-0000-4000-8000-0000000000e4';
export const SESSION_WT = 's0000000-0000-4000-8000-0000000000e5';

/* ---- Codex ソース（Issue #31） ---- */

export const E2E_CODEX_DIR = join(E2E_ROOT, 'codex-sessions');
/** Codex 合成 rollout（`rollout-*.jsonl` 命名。timestamp / UUID は解釈されない）。 */
export const CODEX_ROLLOUT = 'rollout-e2e-00000000-0000-7000-8000-0000000000c1';
export const SESSION_CODEX = `codex:${CODEX_ROLLOUT}`;

/**
 * Codex グループ（= 日付ディレクトリ）はローカル日付の「今日」。
 * seed（サーバプロセス）とテスト（Playwright ワーカー）が同じ計算で共有する。
 */
export function codexDayId(): string {
  const d = new Date(Date.now() - 30 * 60_000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${String(d.getFullYear())}-${mm}-${dd}`;
}

export function codexFilePath(): string {
  const [y, m, d] = codexDayId().split('-') as [string, string, string];
  return join(E2E_CODEX_DIR, y, m, d, `${CODEX_ROLLOUT}.jsonl`);
}

/* ---- Claude / Codex 表示統合（Issue #49） ---- */

/** Claude と同一 cwd（E2E_PROJECT_PATH）で作業した Codex rollout。統合行の seed。 */
export const CODEX_ROLLOUT_SHARED = 'rollout-e2e-00000000-0000-7000-8000-0000000000c2';

export function codexSharedFilePath(): string {
  const [y, m, d] = codexDayId().split('-') as [string, string, string];
  return join(E2E_CODEX_DIR, y, m, d, `${CODEX_ROLLOUT_SHARED}.jsonl`);
}
