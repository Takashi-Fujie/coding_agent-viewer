/**
 * cwd から git の正式な仕組みで本体リポジトリを解決する。
 * 仕様は docs/design/CORE.md「worktree セッションの本体統合（Issue #41）」。
 *
 * エンコード済みディレクトリ名の文字列一致には依存せず、`.git` の実体
 * （worktree ではファイルで `gitdir:` を持つ）を辿る。cwd が消えていても
 * 実在する祖先から `.git` に到達できれば統合を維持できる（永続状態に依存しない）。
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface RepoResolution {
  /** 本体リポジトリのルート絶対パス。 */
  root: string;
  /**
   * 統合時に使う worktree ラベル。実在する worktree なら worktree ルートのディレクトリ名、
   * cwd 消失後の解決なら basename(cwd)。null は「cwd が本体リポジトリ内にある（統合不要）」。
   */
  worktree: string | null;
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/** worktree の `.git` ファイル（`gitdir:` 行）から本体リポジトリのルートを解決する。 */
async function resolveMainRoot(gitFilePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(gitFilePath, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
  if (!match || match[1] === undefined) return null;
  const adminDir = resolve(dirname(gitFilePath), match[1].trim());

  let commondir: string;
  try {
    commondir = (await readFile(join(adminDir, 'commondir'), 'utf8')).trim();
  } catch {
    return null;
  }
  // commondir は管理ディレクトリ基準の相対パス（絶対パスのこともある）。
  // 既定の ../.. は共通 .git ディレクトリ自身を指し、本体ルートはその親。
  const commonGitDir = resolve(adminDir, commondir);
  const root = commonGitDir.endsWith('.git') ? dirname(commonGitDir) : commonGitDir;
  return root;
}

/**
 * cwd から親へ向かって最初の `.git` を探し、本体リポジトリを解決する。
 * cwd が実在しない場合は実在する最も近い祖先から探索する（worktree 削除後の統合維持）。
 * `.git` に到達できなければ null（従来どおり単独プロジェクトのまま）。
 */
export async function resolveRepo(cwd: string): Promise<RepoResolution | null> {
  const target = resolve(cwd);

  // 実在する最も近いディレクトリまで遡る
  let start = target;
  let cwdExists = true;
  while ((await statOrNull(start))?.isDirectory() !== true) {
    const parent = dirname(start);
    if (parent === start) return null;
    cwdExists = false;
    start = parent;
  }

  for (let dir = start; ; ) {
    const dotGit = join(dir, '.git');
    const st = await statOrNull(dotGit);
    if (st?.isFile() === true) {
      // worktree。gitdir → commondir で本体ルートへ
      const root = await resolveMainRoot(dotGit);
      if (root === null) return null;
      return { root, worktree: cwdExists ? basename(dir) : basename(target) };
    }
    if (st?.isDirectory() === true) {
      // 通常リポジトリ。cwd が実在するなら統合不要（サブディレクトリ起動を本体へ寄せない）。
      // cwd 消失後にここへ到達した場合は、消えたディレクトリの作業として本体へ統合する
      return { root: dir, worktree: cwdExists ? null : basename(target) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
