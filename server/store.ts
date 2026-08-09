/**
 * ログディレクトリのスナップショット構築。仕様は docs/design/API.md と docs/design/CORE.md（Issue #28）。
 *
 * セッションの発見はログソース抽象（server/sources/）に委ね、ここは配置規約を知らない。
 * ソースが返した一覧を buildIndex に流し、グループ（プロジェクト相当）ごとにまとめるだけ。
 *
 * リクエストごとに buildIndex() を呼ぶ。鮮度管理（reuse / incremental / rebuild）は
 * SPEC-CORE の decideStrategy に委ねるため、ここでは TTL を持たない
 * （変更が無ければ stat のコストだけで最新のインデックスが得られる）。
 */
import { buildIndex } from './core/indexer.js';
import type { SessionIndex } from './core/types.js';
import type { LogSource } from './sources/types.js';

export interface SessionEntry {
  /** 公開セッション ID（ソースが決める。claude は basename、それ以外は `<source>:<basename>`）。 */
  id: string;
  projectId: string;
  /** どのソースが発見したか。API DTO には露出させない内部フィールド。 */
  sourceId: string;
  filePath: string;
  index: SessionIndex;
}

export interface ProjectEntry {
  /** グループ ID（claude は ~/.claude/projects 直下のディレクトリ名）。API の project id。 */
  id: string;
  sessions: SessionEntry[];
}

export interface Snapshot {
  projects: ProjectEntry[];
  sessionsById: Map<string, SessionEntry>;
}

export interface StoreOptions {
  sources: LogSource[];
  cacheDir: string;
}

/**
 * 全ソースの発見結果をインデックス化してスナップショットにまとめる。
 * グループはソースが返した順序のまま並べる（claude ソースは名前順で返すため従来と同一）。
 * セッションを持たない空グループも保持する（.jsonl の無いプロジェクトディレクトリは
 * 旧実装でも空プロジェクトとして API に現れていた）。
 */
export async function loadSnapshot(options: StoreOptions): Promise<Snapshot> {
  const projects: ProjectEntry[] = [];
  const sessionsById = new Map<string, SessionEntry>();

  for (const source of options.sources) {
    for (const group of await source.discoverGroups()) {
      const sessions: SessionEntry[] = [];
      for (const discovered of group.sessions) {
        const { index } = await buildIndex(discovered.filePath, { cacheDir: options.cacheDir });
        const entry: SessionEntry = {
          id: discovered.sessionId,
          projectId: group.groupId,
          sourceId: source.id,
          filePath: discovered.filePath,
          index,
        };
        sessions.push(entry);
        sessionsById.set(entry.id, entry);
      }
      projects.push({ id: group.groupId, sessions });
    }
  }

  return { projects, sessionsById };
}
