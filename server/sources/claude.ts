/**
 * Claude Code のログソース。仕様は docs/design/CORE.md（Issue #28）。
 *
 * `~/.claude/projects/` 直下のディレクトリをグループ（プロジェクト）、配下（再帰）の
 * `*.jsonl` をセッションとする。`.jsonl` を 1 件も含まないディレクトリも空グループとして
 * 返す。公開 ID・グループ ID・並び順を含め、抽象化前の store.ts と同一に保つ
 * （既存 API レスポンス不変が受け入れ条件）。
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DiscoveredGroup, LogSource } from './types.js';

export interface ClaudeSourceOptions {
  /** セッション JSONL のルート（本番は ~/.claude/projects）。 */
  logDir: string;
}

export function createClaudeSource(options: ClaudeSourceOptions): LogSource {
  return {
    id: 'claude',
    async discoverGroups(): Promise<DiscoveredGroup[]> {
      let dirents;
      try {
        dirents = await readdir(options.logDir, { withFileTypes: true });
      } catch {
        return [];
      }

      const groups: DiscoveredGroup[] = [];
      const dirs = dirents
        .filter((d) => d.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const dir of dirs) {
        const projectDir = join(options.logDir, dir.name);
        // サブディレクトリ（subagent の JSONL 置き場）も含めて再帰列挙する
        const entries = await readdir(projectDir, { recursive: true, withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
          .map((e) => join(e.parentPath, e.name))
          .sort();
        groups.push({
          groupId: dir.name,
          sessions: files.map((filePath) => ({ sessionId: basename(filePath, '.jsonl'), filePath })),
        });
      }
      return groups;
    },
  };
}
