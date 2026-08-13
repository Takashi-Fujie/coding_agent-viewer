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
import { stat } from 'node:fs/promises';
import { buildIndex } from './core/indexer.js';
import { loadAliases, loadLedger, saveLedger } from './core/rename.js';
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
  /**
   * グループ ID（claude は ~/.claude/projects 直下のディレクトリ名、codex の cwd グループは
   * 同形式のパス縮約）。ソース中立のため単独では一意でなく、一意キーは (id, sourceId)
   * （SPEC-CORE-092。同一 id の claude / codex グループは表示層で 1 プロジェクトに束ねる）。
   */
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
  /**
   * リネーム追跡の台帳・エイリアスの置き場（SPEC-CORE-100〜109。本番はリポジトリ直下
   * `local/`・gitignore 済み）。省略時はリネーム追跡を行わない（既存テストの互換維持）。
   */
  localDir?: string | undefined;
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

  // resolveRepo のメモを rename 追跡と worktree 併合で共有する（同じ cwd を二重解決しない）
  const memo = new Map<string, RepoResolution | null>();
  let grouped = regroupCodexByCwd(projects);
  if (options.localDir !== undefined) {
    grouped = await consolidateRenames(grouped, options.localDir, memo);
  }
  return { projects: await consolidateWorktrees(grouped, memo), sessionsById, sourcesById };
}

/** パス由来のグループ id: cwd の非英数字 `-` 置換（SPEC-CORE-091）。
 * claude の実ディレクトリ名と同値のソース中立形式。同一 id の claude / codex グループは
 * 表示層（server/http.ts の displayProjects）で 1 プロジェクトに束ねられる。
 * ProjectEntry の一意キーは (id, sourceId)。 */
function pathGroupId(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Codex セッションの cwd 再グルーピング（SPEC-CODEX-100〜103・docs/design/CODEX.md）。
 * 発見層の日付グループは中間表現のまま、summary.cwd（session_meta 由来・first-wins）を持つ
 * セッションを cwd 単位のグループへ移す。cwd の無いセッションは日付グループへ残し、
 * 空になった日付グループは一覧から消す。codex グループは id 昇順に並べ直す。
 */
function regroupCodexByCwd(projects: ProjectEntry[]): ProjectEntry[] {
  const others: ProjectEntry[] = [];
  const codexGroups: ProjectEntry[] = [];
  const byCwd = new Map<string, ProjectEntry>();
  let insertAt = -1;

  for (const project of projects) {
    if (project.sourceId !== 'codex') {
      others.push(project);
      continue;
    }
    if (insertAt === -1) insertAt = others.length;
    const remaining: SessionEntry[] = [];
    for (const session of project.sessions) {
      const cwd = session.index.summary.cwd;
      if (cwd === undefined || cwd === '') {
        remaining.push(session);
        continue;
      }
      const id = pathGroupId(cwd);
      let group = byCwd.get(id);
      if (group === undefined) {
        group = { id, sourceId: 'codex', sessions: [] };
        byCwd.set(id, group);
        codexGroups.push(group);
      }
      session.projectId = id;
      group.sessions.push(session);
    }
    if (remaining.length > 0) {
      project.sessions = remaining;
      codexGroups.push(project);
    }
  }

  if (codexGroups.length === 0) return others;
  codexGroups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  others.splice(insertAt, 0, ...codexGroups);
  return others;
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
 * プロジェクトディレクトリのリネーム追跡（SPEC-CORE-100〜109・docs/design/CORE.md）。
 *
 * worktree 併合の**前**に置く。本体リポジトリごとリネームされると旧 worktree グループの
 * cwd も消失して `.git` を辿れず worktree 併合では救済できないため、台帳には併合前の
 * グループ id ごとに**解決済み本体ルート**の識別子 (dev, ino) を記録しておき、消失した
 * グループを同じ識別子を持つ現存グループの id へ改名・併合する。
 *
 * 旧ログディレクトリはリネーム後も残り続けて毎回再発見されるため、この変換は
 * 一度きりの移行ではなく毎スナップショットで冪等に適用される（台帳エントリは削除しない）。
 */
async function consolidateRenames(
  projects: ProjectEntry[],
  localDir: string,
  memo: Map<string, RepoResolution | null>,
): Promise<ProjectEntry[]> {
  const resolve = async (cwd: string): Promise<RepoResolution | null> => {
    let resolution = memo.get(cwd);
    if (resolution === undefined) {
      resolution = await resolveRepo(cwd);
      memo.set(cwd, resolution);
    }
    return resolution;
  };
  const [ledger, aliases] = await Promise.all([loadLedger(localDir), loadAliases(localDir)]);

  // 識別パス（解決済み本体ルート優先）を stat し、現存グループの識別子逆引きと
  // 消失グループの検出、台帳の更新を行う
  const vanished = new Set<ProjectEntry>();
  const liveByKey = new Map<string, { project: ProjectEntry; isMain: boolean }>();
  let ledgerChanged = false;
  for (const project of projects) {
    const cwd = representativeCwd(project);
    if (cwd === null) continue; // 代表パスを持たないグループは対象外（SPEC-CORE-107）
    const resolution = await resolve(cwd);
    const idPath = resolution?.root ?? cwd;
    let info;
    try {
      info = await stat(idPath);
    } catch {
      vanished.add(project);
      continue;
    }
    const entry = ledger.entries[project.id];
    if (
      entry === undefined ||
      entry.dev !== info.dev ||
      entry.ino !== info.ino ||
      entry.cwd !== idPath
    ) {
      ledger.entries[project.id] = {
        dev: info.dev,
        ino: info.ino,
        cwd: idPath,
        recordedAt: new Date().toISOString(),
      };
      ledgerChanged = true;
    }
    // 改名先には本体（worktree でないグループ）を優先する。worktree グループも同じ本体
    // ルートの識別子を持つため、先勝ちだと改名先が worktree の id になり得る
    const key = `${String(info.dev)}:${String(info.ino)}`;
    const isMain = resolution === null || resolution.worktree === null;
    const live = liveByKey.get(key);
    if (live === undefined || (!live.isMain && isMain)) liveByKey.set(key, { project, isMain });
  }
  if (ledgerChanged) await saveLedger(localDir, ledger);

  // エイリアス（旧パス縮約 → 新パス縮約）。元の id からのみ引くため適用は 1 ホップで止まる
  const aliasByOldId = new Map<string, string>();
  for (const [oldPath, newPath] of Object.entries(aliases)) {
    const oldId = pathGroupId(oldPath);
    const newId = pathGroupId(newPath);
    if (oldId !== newId) aliasByOldId.set(oldId, newId);
  }

  const retag = (project: ProjectEntry, id: string): void => {
    project.id = id;
    for (const session of project.sessions) session.projectId = id;
  };
  let renamed = false;
  for (const project of projects) {
    const aliasTarget = aliasByOldId.get(project.id);
    if (aliasTarget !== undefined) {
      retag(project, aliasTarget);
      renamed = true;
      continue;
    }
    if (!vanished.has(project)) continue;
    const entry = ledger.entries[project.id];
    if (entry === undefined) continue;
    const live = liveByKey.get(`${String(entry.dev)}:${String(entry.ino)}`);
    if (live === undefined || live.project.id === project.id) continue;
    retag(project, live.project.id);
    renamed = true;
  }
  if (!renamed) return projects;

  // 改名で同 id 同ソースになったグループを実併合する（(id, sourceId) 一意の維持。
  // ソースが違う同 id は #49 の表示統合が束ねるためここでは併合しない）
  const byKey = new Map<string, ProjectEntry>();
  const result: ProjectEntry[] = [];
  for (const project of projects) {
    const key = `${project.sourceId} ${project.id}`;
    const receiver = byKey.get(key);
    if (receiver === undefined) {
      byKey.set(key, project);
      result.push(project);
      continue;
    }
    for (const session of project.sessions) {
      session.projectId = receiver.id;
      receiver.sessions.push(session);
    }
  }
  return result;
}

/** worktree 併合の対象ソース（SPEC-CORE-090。#45 で codex を追加）。 */
const CONSOLIDATED_SOURCES = new Set(['claude', 'codex']);

/**
 * worktree セッションの本体統合（SPEC-CORE-085〜090・docs/design/CORE.md）。
 *
 * 対象ソースのグループごとに代表 cwd を git の正式な仕組み（resolveRepo）で解決し、
 * worktree 由来のグループを本体ルートのグループへ併合する。本体グループが無ければ
 * 本体ルートから同形式の id（非英数字 `-` 置換・ソース不問）を合成する。
 * 併合先の解決はソース内に閉じる（同じ本体ルートでも
 * claude と codex のグループは併合しない）。解決は毎回 fs を見るだけで
 * キャッシュ等の永続状態に依存しない。
 */
async function consolidateWorktrees(
  projects: ProjectEntry[],
  memo: Map<string, RepoResolution | null> = new Map(),
): Promise<ProjectEntry[]> {
  const resolutions = new Map<ProjectEntry, RepoResolution>();
  for (const project of projects) {
    if (!CONSOLIDATED_SOURCES.has(project.sourceId)) continue;
    const cwd = representativeCwd(project);
    if (cwd === null) continue;
    let resolution = memo.get(cwd);
    if (resolution === undefined) {
      resolution = await resolveRepo(cwd);
      memo.set(cwd, resolution);
    }
    if (resolution !== null) resolutions.set(project, resolution);
  }

  // 本体グループ（cwd がルートと一致する非 worktree グループ）をソース + root で引けるようにする
  const targetKey = (sourceId: string, root: string): string => `${sourceId} ${root}`;
  const targetByRoot = new Map<string, ProjectEntry>();
  for (const project of projects) {
    const resolution = resolutions.get(project);
    if (resolution === undefined || resolution.worktree !== null) continue;
    const key = targetKey(project.sourceId, resolution.root);
    if (representativeCwd(project) === resolution.root && !targetByRoot.has(key)) {
      targetByRoot.set(key, project);
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

    const key = targetKey(project.sourceId, resolution.root);
    let target = targetByRoot.get(key);
    if (target === undefined) {
      // 本体のグループが無い場合は同形式の id を合成する（SPEC-CORE-086 / SPEC-CORE-095）
      target = {
        id: pathGroupId(resolution.root),
        sourceId: project.sourceId,
        rootPath: resolution.root,
        sessions: [],
      };
      targetByRoot.set(key, target);
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
