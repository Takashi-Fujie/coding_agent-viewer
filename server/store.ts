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
import { resolveRepo } from './core/worktree.js';
import type { RepoResolution } from './core/worktree.js';
import type { SessionIndex } from './core/types.js';
import type { LogSource } from './sources/types.js';

export interface SessionEntry {
  /** 公開セッション ID（ソースが決める。claude は basename、それ以外は `<source>:<basename>`）。 */
  id: string;
  projectId: string;
  /** どのソースが発見したか。API DTO には露出させない内部フィールド。 */
  sourceId: string;
  /** worktree セッションのラベル（SPEC-CORE-087）。本体・非統合セッションは null。 */
  worktree: string | null;
  filePath: string;
  index: SessionIndex;
}

export interface ProjectEntry {
  /** グループ ID（claude は ~/.claude/projects 直下のディレクトリ名）。API の project id。 */
  id: string;
  /** グループを発見したソース（1 グループ 1 ソース。ソースをまたぐ併合はしない）。 */
  sourceId: string;
  /**
   * worktree 併合で確定した本体リポジトリのルート（SPEC-CORE-088）。
   * 表示パスはこれを優先する（worktree セッションが最新でも表示が worktree 側へ揺れない）。
   */
  rootPath?: string;
  sessions: SessionEntry[];
}

export interface Snapshot {
  projects: ProjectEntry[];
  sessionsById: Map<string, SessionEntry>;
  /** SessionEntry.sourceId からソースを引く（本文正規化のディスパッチ用）。 */
  sourcesById: Map<string, LogSource>;
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
  const sourcesById = new Map<string, LogSource>();

  for (const source of options.sources) {
    sourcesById.set(source.id, source);
    for (const group of await source.discoverGroups()) {
      const sessions: SessionEntry[] = [];
      for (const discovered of group.sessions) {
        const { index } = await buildIndex(discovered.filePath, { cacheDir: options.cacheDir, source });
        const entry: SessionEntry = {
          id: discovered.sessionId,
          projectId: group.groupId,
          sourceId: source.id,
          worktree: null,
          filePath: discovered.filePath,
          index,
        };
        sessions.push(entry);
        sessionsById.set(entry.id, entry);
      }
      projects.push({ id: group.groupId, sourceId: source.id, sessions });
    }
  }

  return { projects: await consolidateWorktrees(projects), sessionsById, sourcesById };
}

/** プロジェクトの代表 cwd（最終更新が新しいセッションのもの）。 */
function representativeCwd(project: ProjectEntry): string | null {
  let cwd: string | null = null;
  let latest = '';
  for (const session of project.sessions) {
    const summary = session.index.summary;
    if (
      summary.cwd !== undefined &&
      summary.cwd !== '' &&
      (cwd === null || (summary.lastTimestamp ?? '') > latest)
    ) {
      cwd = summary.cwd;
      latest = summary.lastTimestamp ?? '';
    }
  }
  return cwd;
}

/**
 * worktree セッションの本体統合（SPEC-CORE-085〜090・docs/design/CORE.md）。
 *
 * claude ソースのグループごとに代表 cwd を git の正式な仕組み（resolveRepo）で解決し、
 * worktree 由来のグループを本体ルートのグループへ併合する。本体グループが無ければ
 * 本体ルートから同形式の id（非英数字を `-` に置換）を合成する。解決は毎回 fs を見る
 * だけでキャッシュ等の永続状態に依存しない。
 */
async function consolidateWorktrees(projects: ProjectEntry[]): Promise<ProjectEntry[]> {
  const memo = new Map<string, RepoResolution | null>();
  const resolutions = new Map<ProjectEntry, RepoResolution>();
  for (const project of projects) {
    if (project.sourceId !== 'claude') continue;
    const cwd = representativeCwd(project);
    if (cwd === null) continue;
    let resolution = memo.get(cwd);
    if (resolution === undefined) {
      resolution = await resolveRepo(cwd);
      memo.set(cwd, resolution);
    }
    if (resolution !== null) resolutions.set(project, resolution);
  }

  // 本体グループ（cwd がルートと一致する非 worktree グループ）を root で引けるようにする
  const targetByRoot = new Map<string, ProjectEntry>();
  for (const project of projects) {
    const resolution = resolutions.get(project);
    if (resolution === undefined || resolution.worktree !== null) continue;
    if (representativeCwd(project) === resolution.root && !targetByRoot.has(resolution.root)) {
      targetByRoot.set(resolution.root, project);
    }
  }

  const result: ProjectEntry[] = [];
  for (const project of projects) {
    const resolution = resolutions.get(project);
    if (resolution === undefined || resolution.worktree === null) {
      if (resolution !== undefined) project.rootPath = resolution.root;
      result.push(project);
      continue;
    }

    let target = targetByRoot.get(resolution.root);
    if (target === undefined) {
      // 本体のプロジェクトディレクトリが無い場合は同形式の id を合成する（SPEC-CORE-086）
      target = {
        id: resolution.root.replace(/[^A-Za-z0-9]/g, '-'),
        sourceId: 'claude',
        rootPath: resolution.root,
        sessions: [],
      };
      targetByRoot.set(resolution.root, target);
      result.push(target);
    }
    target.rootPath = resolution.root;
    for (const session of project.sessions) {
      session.projectId = target.id;
      session.worktree = resolution.worktree;
      target.sessions.push(session);
    }
  }
  return result;
}
