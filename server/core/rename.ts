/**
 * プロジェクトディレクトリのリネーム追跡の台帳・エイリアス入出力（Issue #50）。
 * 仕様は docs/design/CORE.md「プロジェクトディレクトリのリネーム追跡」。
 *
 * 置き場（localDir。本番はリポジトリ直下 local/・gitignore 済み）は .cache と分ける。
 * キャッシュは「消しても全再構築できる」場所だが、台帳は消失済み旧パスの識別子という
 * 再構築不能な情報を含むため。ファイルが無い・壊れている場合は空扱いで続行する
 * （誤統合は起きず、統合されないだけに倒れる）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** ディレクトリ識別子。リネーム（mv）で不変、別ボリューム移動で dev が変わる。 */
export interface DirIdentity {
  dev: number;
  ino: number;
  /** 記録時点の実パス（デバッグ・手動マッピング作成の手がかり用）。 */
  cwd: string;
  /** 識別子（dev / ino / cwd）が変わったときの記録時刻。無変化の載せ替えでは更新しない。 */
  recordedAt: string;
}

/** local/dir-identity.json（機械管理・自動記録）。キーはグループ id。 */
export interface IdentityLedger {
  schemaVersion: number;
  entries: Record<string, DirIdentity>;
}

const SCHEMA_VERSION = 1;
const LEDGER_FILE = 'dir-identity.json';
const ALIASES_FILE = 'project-aliases.json';

export async function loadLedger(localDir: string): Promise<IdentityLedger> {
  const empty: IdentityLedger = { schemaVersion: SCHEMA_VERSION, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(localDir, LEDGER_FILE), 'utf8'));
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const { schemaVersion, entries } = parsed as { schemaVersion?: unknown; entries?: unknown };
  if (schemaVersion !== SCHEMA_VERSION || typeof entries !== 'object' || entries === null) {
    return empty;
  }
  for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    if (
      typeof e['dev'] === 'number' &&
      typeof e['ino'] === 'number' &&
      typeof e['cwd'] === 'string' &&
      typeof e['recordedAt'] === 'string'
    ) {
      empty.entries[id] = {
        dev: e['dev'],
        ino: e['ino'],
        cwd: e['cwd'],
        recordedAt: e['recordedAt'],
      };
    }
  }
  return empty;
}

/** atomic write（tmp + rename）。並行する loadSnapshot と書き込みが競合しても壊れた状態を残さない。 */
export async function saveLedger(localDir: string, ledger: IdentityLedger): Promise<void> {
  await mkdir(localDir, { recursive: true });
  const tmp = join(localDir, `${LEDGER_FILE}.tmp`);
  await writeFile(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  await rename(tmp, join(localDir, LEDGER_FILE));
}

/**
 * local/project-aliases.json（ユーザー編集）を読む。旧 cwd 実パス → 新 cwd 実パス。
 * 突き合わせは呼び出し側でパス縮約して行う。
 */
export async function loadAliases(localDir: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(localDir, ALIASES_FILE), 'utf8'));
  } catch {
    return {};
  }
  const aliases = (parsed as { aliases?: unknown } | null)?.aliases;
  if (typeof aliases !== 'object' || aliases === null) return {};
  const valid: Record<string, string> = {};
  for (const [oldPath, newPath] of Object.entries(aliases as Record<string, unknown>)) {
    if (typeof newPath === 'string') valid[oldPath] = newPath;
  }
  return valid;
}
