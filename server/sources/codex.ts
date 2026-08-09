/**
 * Codex CLI のログソース。仕様は docs/design/CORE.md（Issue #28）と docs/design/CODEX.md。
 *
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` の日付階層を再帰探索し、日付 `YYYY-MM-DD`
 * をグループとする（rollout を含む日付のみ。空の日付ディレクトリはグループにしない）。
 * `session_index.jsonl` は読まない（rollout ファイル単独で発見が成立する。
 * インデックスが欠けた・壊れた環境でもセッションを取りこぼさないため）。
 * ファイル名の timestamp / UUID は解釈しない（パースが必要になるのは #29 以降）。
 *
 * 注意: #28 の時点ではアプリ構成（server/app.ts）に登録しない。正規化（#29）の無い
 * 状態で登録すると全行 unknown の壊れたセッションが集計へ漏れる。
 */
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { DiscoveredGroup, LogSource } from './types.js';

export interface CodexSourceOptions {
  /** rollout JSONL のルート（本番は ~/.codex/sessions）。 */
  sessionsDir: string;
}

/** rollout 命名（`rollout-*.jsonl`）だけをセッションとして扱う。 */
const ROLLOUT_FILE = /^rollout-.+\.jsonl$/;
/** 日付階層 `YYYY/MM/DD` の検出用。合わない場所にあるファイルはグループを持てないため無視する。 */
const DATE_DIRS = /^(\d{4})[/\\](\d{2})[/\\](\d{2})$/;

export function createCodexSource(options: CodexSourceOptions): LogSource {
  return {
    id: 'codex',
    async discoverGroups(): Promise<DiscoveredGroup[]> {
      let entries;
      try {
        entries = await readdir(options.sessionsDir, { recursive: true, withFileTypes: true });
      } catch {
        return [];
      }

      const groups: DiscoveredGroup[] = [];
      const groupsById = new Map<string, DiscoveredGroup>();
      const files = entries
        .filter((e) => e.isFile() && ROLLOUT_FILE.test(e.name))
        .map((e) => join(e.parentPath, e.name))
        .sort();
      for (const filePath of files) {
        const relDir = relative(options.sessionsDir, dirname(filePath));
        const date = DATE_DIRS.exec(relDir);
        if (!date) continue;
        const groupId = `${date[1]}-${date[2]}-${date[3]}`;
        let group = groupsById.get(groupId);
        if (!group) {
          group = { groupId, sessions: [] };
          groupsById.set(groupId, group);
          groups.push(group);
        }
        group.sessions.push({ sessionId: `codex:${basename(filePath, '.jsonl')}`, filePath });
      }
      return groups;
    },
  };
}
