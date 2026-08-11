/**
 * E2E フィクスチャの生成。仕様は docs/design/FLOW.md（E2E 基盤）。
 *
 * すべて合成データ（実ログのパス・プロンプト本文・permissions 実値を含まない）。
 * logDir には tests/fixtures/session-sample.jsonl（巨大行・壊れ行・未知モデル・
 * `<synthetic>` 行入り）のコピーと、E2E 用に組んだ 2 セッションを置く。
 * claudeDir には設定・定義画面（SPEC-CONFIG）用の最小レイアウトを敷く。
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  E2E_CLAUDE_DIR,
  E2E_LOG_DIR,
  E2E_PROJECT_ID,
  E2E_PROJECT_PATH,
  E2E_ROOT,
  E2E_WT_MAIN_PROJECT_ID,
  E2E_WT_NAME,
  E2E_WT_PROJECT_ID,
  E2E_WT_REPO_ROOT,
  LONG_TURNS,
  SEARCH_TOKEN,
  SESSION_LIVE,
  SESSION_LONG,
  SESSION_MAIN,
  SESSION_SAMPLE,
  SESSION_WT,
  SESSION_WT_MAIN,
  codexFilePath,
  sessionFilePath,
} from './env.js';

const SAMPLE_FIXTURE = fileURLToPath(
  new URL('../../fixtures/session-sample.jsonl', import.meta.url),
);

/**
 * Overview の既定プリセット（7日）に掛かるよう、E2E セッションのタイムスタンプは
 * 実行時刻基準にする（固定日付だと期間フィルタで集計から消える）。
 */
function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

interface LineOver {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  /** 省略時は E2E_PROJECT_PATH。worktree 統合の seed（Issue #41）が上書きする。 */
  cwd?: string;
}

function userLine(over: LineOver & { content: unknown }): Record<string, unknown> {
  return {
    type: 'user',
    isSidechain: false,
    userType: 'external',
    cwd: E2E_PROJECT_PATH,
    version: '9.9.9',
    gitBranch: 'main',
    message: { role: 'user', content: over.content },
    ...over,
  };
}

function assistantLine(
  over: LineOver & { model?: string; content: unknown[] },
): Record<string, unknown> {
  const { model, content, ...rest } = over;
  return {
    type: 'assistant',
    isSidechain: false,
    userType: 'external',
    cwd: E2E_PROJECT_PATH,
    version: '9.9.9',
    gitBranch: 'main',
    requestId: `req_e2e_${over.uuid}`,
    message: {
      id: `msg_e2e_${over.uuid}`,
      role: 'assistant',
      model: model ?? 'claude-sonnet-5',
      content,
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 400,
        cache_creation: { ephemeral_5m_input_tokens: 250, ephemeral_1h_input_tokens: 150 },
      },
    },
    ...rest,
  };
}

/** 分単位のオフセット（日次チャートに複数日の棒を立てるため日をまたいで分散させる）。 */
const TWO_DAYS = 2 * 24 * 60;
const ONE_DAY = 24 * 60;

/** E2E 主対象セッション: 検索トークン・ツール成功/失敗・複数モデル。2〜1 日前に配置。 */
function mainSessionLines(): Record<string, unknown>[] {
  const sid = SESSION_MAIN;
  return [
    userLine({
      uuid: 'u-e1-1',
      parentUuid: null,
      timestamp: iso(TWO_DAYS),
      sessionId: sid,
      content: `E2E 用の依頼文。${SEARCH_TOKEN}`,
    }),
    assistantLine({
      uuid: 'a-e1-1',
      parentUuid: 'u-e1-1',
      timestamp: iso(TWO_DAYS - 1),
      sessionId: sid,
      content: [
        { type: 'text', text: 'ビルドを実行します。' },
        { type: 'tool_use', id: 'toolu_e2e_0001', name: 'Bash', input: { command: 'npm run build' } },
      ],
    }),
    userLine({
      uuid: 'u-e1-2',
      parentUuid: 'a-e1-1',
      timestamp: iso(TWO_DAYS - 2),
      sessionId: sid,
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_e2e_0001',
          is_error: true,
          content: 'exit 1: 合成のビルド失敗ログ',
        },
      ],
    }),
    assistantLine({
      uuid: 'a-e1-2',
      parentUuid: 'u-e1-2',
      timestamp: iso(ONE_DAY),
      sessionId: sid,
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ビルドが失敗したため原因を調査します。' }],
    }),
    // 未知モデル（期間内）: Overview の警告バナー（SPEC-DASH-073）の対象
    assistantLine({
      uuid: 'a-e1-3',
      parentUuid: 'a-e1-2',
      timestamp: iso(ONE_DAY - 1),
      sessionId: sid,
      model: 'claude-imaginary-9',
      content: [{ type: 'text', text: '価格表に無い合成モデルの応答。' }],
    }),
  ];
}

/** ライブ更新テスト用の最小セッション（テストが後から追記する）。 */
function liveSessionLines(): Record<string, unknown>[] {
  const sid = SESSION_LIVE;
  return [
    userLine({
      uuid: 'u-e2-1',
      parentUuid: null,
      timestamp: iso(30),
      sessionId: sid,
      content: 'ライブ更新の対象セッション。',
    }),
    assistantLine({
      uuid: 'a-e2-1',
      parentUuid: 'u-e2-1',
      timestamp: iso(29),
      sessionId: sid,
      content: [{ type: 'text', text: '初期状態の応答。' }],
    }),
  ];
}

/**
 * 仮想スクロール追従テスト用の長いセッション（Issue #40）。
 * ビューポート + overscan を大きく超える行数にし、既知モデルのみ・SEARCH_TOKEN 無しで
 * dash.spec の集計 assert（未知モデル 1 件・検索ヒット）を壊さない。
 */
function longSessionLines(): Record<string, unknown>[] {
  const sid = SESSION_LONG;
  const lines: Record<string, unknown>[] = [];
  let prev: string | null = null;
  for (let n = 1; n <= LONG_TURNS; n++) {
    const u = `u-e3-${String(n)}`;
    const a = `a-e3-${String(n)}`;
    lines.push(
      userLine({
        uuid: u,
        parentUuid: prev,
        timestamp: iso(ONE_DAY - n * 2),
        sessionId: sid,
        content: `長いセッションの依頼 ${String(n)}`,
      }),
      assistantLine({
        uuid: a,
        parentUuid: u,
        timestamp: iso(ONE_DAY - n * 2 + 1),
        sessionId: sid,
        content: [{ type: 'text', text: `長いセッションの応答 ${String(n)}` }],
      }),
    );
    prev = a;
  }
  return lines;
}

/** ライブ更新テストが追記する行（tests 側からも import する）。 */
export function liveAppendLine(n: number): Record<string, unknown> {
  return assistantLine({
    uuid: `a-e2-app-${String(n)}`,
    parentUuid: 'a-e2-1',
    timestamp: new Date().toISOString(),
    sessionId: SESSION_LIVE,
    content: [{ type: 'text', text: `ライブ追記メッセージ ${String(n)}` }],
  });
}

/**
 * Codex 合成 rollout（Issue #31・usage は #30 まで未集計 = token_count 行を持たない）。
 * ローカル日付の「今日」の日付ディレクトリに置く（日付クリック絞り込みの検証用）。
 */
function codexSessionLines(): Record<string, unknown>[] {
  return [
    {
      timestamp: iso(25),
      type: 'session_meta',
      payload: { id: '00000000-0000-7000-8000-0000000000c1', cwd: '/home/dev/sample-codex', cli_version: '0.147.0' },
    },
    { timestamp: iso(24), type: 'turn_context', payload: { turn_id: 'turn-e2e-1', model: 'gpt-5.5' } },
    {
      timestamp: iso(23),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex E2E の依頼文。' }] },
    },
    {
      timestamp: iso(22),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex 初期応答。' }] },
    },
  ];
}

/** Codex ライブ更新テストが追記する行（tests 側からも import する）。 */
export function codexAppendLine(n: number): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: `Codex ライブ追記 ${String(n)}` }],
    },
  };
}

function toJsonl(lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/**
 * worktree 統合の seed（Issue #41・SPEC-DASH-105〜106）。
 * 実在する worktree 構造（本体 .git ディレクトリ + worktree の .git ファイル / commondir）を
 * E2E_ROOT 配下に組み立て、本体 / worktree それぞれの cwd を持つセッションを置く。
 * 既知モデルのみ・SEARCH_TOKEN 無しで、既存 dash.spec の集計 assert を壊さない。
 */
async function seedWorktree(): Promise<void> {
  const adminDir = join(E2E_WT_REPO_ROOT, '.git', 'worktrees', E2E_WT_NAME);
  const worktreeRoot = join(E2E_WT_REPO_ROOT, '.claude', 'worktrees', E2E_WT_NAME);
  await mkdir(adminDir, { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(join(worktreeRoot, '.git'), `gitdir: ${adminDir}\n`, 'utf8');
  await writeFile(join(adminDir, 'commondir'), '../..\n', 'utf8');

  await mkdir(join(E2E_LOG_DIR, E2E_WT_MAIN_PROJECT_ID), { recursive: true });
  await mkdir(join(E2E_LOG_DIR, E2E_WT_PROJECT_ID), { recursive: true });
  await writeFile(
    join(E2E_LOG_DIR, E2E_WT_MAIN_PROJECT_ID, `${SESSION_WT_MAIN}.jsonl`),
    toJsonl([
      userLine({
        uuid: 'u-e4-1',
        parentUuid: null,
        timestamp: iso(120),
        sessionId: SESSION_WT_MAIN,
        cwd: E2E_WT_REPO_ROOT,
        content: '本体リポジトリでの依頼文。',
      }),
      assistantLine({
        uuid: 'a-e4-1',
        parentUuid: 'u-e4-1',
        timestamp: iso(119),
        sessionId: SESSION_WT_MAIN,
        cwd: E2E_WT_REPO_ROOT,
        content: [{ type: 'text', text: '本体リポジトリでの応答。' }],
      }),
    ]),
    'utf8',
  );
  await writeFile(
    join(E2E_LOG_DIR, E2E_WT_PROJECT_ID, `${SESSION_WT}.jsonl`),
    toJsonl([
      userLine({
        uuid: 'u-e5-1',
        parentUuid: null,
        timestamp: iso(60),
        sessionId: SESSION_WT,
        cwd: worktreeRoot,
        content: 'worktree での依頼文。',
      }),
      assistantLine({
        uuid: 'a-e5-1',
        parentUuid: 'u-e5-1',
        timestamp: iso(59),
        sessionId: SESSION_WT,
        cwd: worktreeRoot,
        content: [{ type: 'text', text: 'worktree での応答。' }],
      }),
    ]),
    'utf8',
  );
}

/** 合成 ~/.claude 相当（設定・定義画面用）。 */
async function seedClaudeDir(): Promise<void> {
  await mkdir(join(E2E_CLAUDE_DIR, 'agents'), { recursive: true });
  await mkdir(join(E2E_CLAUDE_DIR, 'skills', 'sample-skill'), { recursive: true });
  await mkdir(join(E2E_CLAUDE_DIR, 'plugins'), { recursive: true });

  // 起動実績が無い定義（未使用バッジの対象）
  await writeFile(
    join(E2E_CLAUDE_DIR, 'agents', 'sample-unused-agent.md'),
    '---\nname: sample-unused-agent\ndescription: 起動実績のない合成エージェント\ntools: Read, Grep\nmodel: sonnet\n---\n本文\n',
  );
  // frontmatter が壊れた定義（パース不能でも一覧に残る）
  await writeFile(
    join(E2E_CLAUDE_DIR, 'agents', 'sample-broken-agent.md'),
    '---\nname: sample-broken-agent\n閉じの --- が無い壊れた定義\n',
  );
  await writeFile(
    join(E2E_CLAUDE_DIR, 'skills', 'sample-skill', 'SKILL.md'),
    '---\nname: sample-skill\ndescription: 合成スキル\n---\n本文\n',
  );
  await writeFile(
    join(E2E_CLAUDE_DIR, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'sample-plugin@sample-marketplace': [{ scope: 'user' }] } }),
  );
  await writeFile(
    join(E2E_CLAUDE_DIR, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Read', 'Glob'], deny: [], ask: [] },
      hooks: {},
      enabledPlugins: ['sample-plugin@sample-marketplace'],
    }),
  );
  await writeFile(
    join(E2E_CLAUDE_DIR, 'history.jsonl'),
    toJsonl([
      { project: E2E_PROJECT_PATH, timestamp: 1_770_000_000_000 },
      { project: '/home/dev/history-only-project', timestamp: 1_760_000_000_000 },
      { broken: true },
    ]),
  );
}

/** フィクスチャ一式を毎回ゼロから敷き直す（決定的な初期状態）。 */
export async function seed(): Promise<void> {
  await rm(E2E_ROOT, { recursive: true, force: true });
  await mkdir(join(E2E_LOG_DIR, E2E_PROJECT_ID), { recursive: true });

  await cp(SAMPLE_FIXTURE, sessionFilePath(SESSION_SAMPLE));
  await writeFile(sessionFilePath(SESSION_MAIN), toJsonl(mainSessionLines()), 'utf8');
  await writeFile(sessionFilePath(SESSION_LIVE), toJsonl(liveSessionLines()), 'utf8');
  await writeFile(sessionFilePath(SESSION_LONG), toJsonl(longSessionLines()), 'utf8');

  const codexPath = codexFilePath();
  await mkdir(dirname(codexPath), { recursive: true });
  await writeFile(codexPath, toJsonl(codexSessionLines()), 'utf8');

  await seedWorktree();
  await seedClaudeDir();
}
