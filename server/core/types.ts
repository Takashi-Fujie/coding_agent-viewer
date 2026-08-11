/**
 * インデックスのデータ構造。仕様は docs/spec/SPEC-CORE.md。
 *
 * 省略可能フィールドは `?: T | undefined` で宣言する。`exactOptionalPropertyTypes`
 * 下で正規化結果を素直に組み立てるためで、JSON 化時に undefined は落ちるので
 * キャッシュサイズには影響しない。
 */

/**
 * キャッシュ形式のバージョン。構造を変えたら必ず上げる（古いキャッシュは破棄される）。
 *
 * 2: usage に speed / service_tier を追加（SPEC-CORE-026）。上げないと古いキャッシュに
 *    speed が無いまま残り、fast mode のコストを静かに過小計上する。
 * 3: user に isToolError、attachment に hookName / hookEvent を追加（SPEC-DASH-001/002）。
 *    上げないと旧キャッシュのレコードが失敗 0 件・hook 履歴なしとして静かに欠損する。
 * 4: 走査文脈 scanState を追加（SPEC-CODEX-066/067）。上げないと scanState の無い旧
 *    キャッシュから増分再開したとき、Codex の model 関連付けが静かに失われる。
 * 5: scanState に token_count の会計基準 prevUsage を追加（SPEC-CODEX-089/090）。上げないと
 *    基準の無い旧キャッシュから増分再開したとき、累積値を全額計上する多重計上になる。
 */
export const INDEX_SCHEMA_VERSION = 5;

/** 走査で得られる生の 1 行。offset / length はバイト単位で、改行は length に含めない。 */
export interface RawLine {
  offset: number;
  length: number;
  text: string;
}

export interface RecordLocation {
  offset: number;
  length: number;
}

/** 正規化後のレコード分類。元の `type` は IndexRecord.type にそのまま残す。 */
export type RecordKind =
  | 'assistant'
  | 'user'
  | 'system'
  | 'attachment'
  | 'pr-link'
  | 'mode'
  | 'title'
  | 'last-prompt'
  | 'unknown';

/** トークン使用量。欠損は 0 で埋める（未知の形でも集計を落とさない）。 */
export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** cache_creation.ephemeral_5m_input_tokens */
  cacheCreation5m: number;
  /** cache_creation.ephemeral_1h_input_tokens。COST では input 単価 x2.0 で課金される。 */
  cacheCreation1h: number;
  webSearch: number;
  webFetch: number;
  serviceTier?: string | undefined;
  /** `fast` は単価が異なる（SPEC-COST-032）。既定値で埋めると undercount するので undefined のまま残す。 */
  speed?: string | undefined;
}

export interface ToolUseRef {
  id: string;
  name: string;
  /** Agent ツールの input.subagent_type */
  subagentType?: string | undefined;
  /** Skill ツールの input.skill */
  skill?: string | undefined;
}

/**
 * インデックスに載る軽量メタ。全文は持たず、詳細表示時に offset / length で seek して読む。
 */
export interface IndexRecord {
  offset: number;
  length: number;
  /** JSONL の元の type。未知 type もそのまま残す。 */
  type: string;
  kind: RecordKind;
  uuid?: string | undefined;
  parentUuid?: string | null | undefined;
  timestamp?: string | undefined;
  sessionId?: string | undefined;
  cwd?: string | undefined;
  gitBranch?: string | undefined;
  version?: string | undefined;
  isSidechain?: boolean | undefined;
  /** 本文の先頭 PREVIEW_LIMIT 字まで。 */
  preview?: string | undefined;

  // assistant
  model?: string | undefined;
  /** model が `<synthetic>`（クライアント生成メッセージ）かどうか。 */
  synthetic?: boolean | undefined;
  usage?: NormalizedUsage | undefined;
  requestId?: string | undefined;
  toolUses?: ToolUseRef[] | undefined;
  hasThinking?: boolean | undefined;
  /** attributionSkill、または Skill ツールの input.skill */
  skill?: string | undefined;

  // user
  isToolResult?: boolean | undefined;
  toolResultFor?: string | undefined;
  /** tool_result の is_error === true（stderr の有無では判定しない。SPEC-DASH-001）。 */
  isToolError?: boolean | undefined;

  // system
  subtype?: string | undefined;
  durationMs?: number | undefined;

  // attachment
  attachmentType?: string | undefined;
  /** attachment.type が hook_* のときの発火情報（SPEC-DASH-002）。 */
  hookName?: string | undefined;
  hookEvent?: string | undefined;

  // pr-link
  prNumber?: number | undefined;
  prRepository?: string | undefined;
  prUrl?: string | undefined;

  // mode / permission-mode
  mode?: string | undefined;

  // ai-title / custom-title
  title?: string | undefined;
  titleKind?: 'ai' | 'custom' | undefined;

  // last-prompt
  leafUuid?: string | undefined;
}

export interface ModelTotals {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  webSearch: number;
  webFetch: number;
}

/**
 * セッション要約。これ自体が累積状態であり、増分更新では保存済みの要約に
 * 差分レコードを足すだけで全再構築と同じ結果になる。
 */
export interface SessionSummary {
  sessionId?: string | undefined;
  cwd?: string | undefined;
  gitBranch?: string | undefined;
  version?: string | undefined;
  title?: string | undefined;
  titleKind?: 'ai' | 'custom' | undefined;
  firstTimestamp?: string | undefined;
  lastTimestamp?: string | undefined;
  recordCount: number;
  /** 壊れて JSON として読めなかった行の数。 */
  skippedLineCount: number;
  assistantCount: number;
  userCount: number;
  sidechainCount: number;
  syntheticCount: number;
  models: Record<string, ModelTotals>;
  toolUseCounts: Record<string, number>;
  subagentTypes: Record<string, number>;
  skills: Record<string, number>;
  prNumbers: number[];
}

export interface SessionIndex {
  filePath: string;
  fileSize: number;
  mtimeMs: number;
  /** 最後の「完全な行」の直後の位置。次回はここから差分を読む。 */
  lastOffset: number;
  /**
   * 走査終了時点の走査文脈（RecordNormalizer.serialize() の値）。増分再開時に
   * createNormalizer(state) へ渡して復元する。文脈を持たないソースは undefined。
   */
  scanState?: unknown;
  records: IndexRecord[];
  summary: SessionSummary;
}

export interface IndexCacheFile extends SessionIndex {
  schemaVersion: number;
  /**
   * インデックスを書き込んだソース id（Issue #31・SPEC-LIVE-043）。
   * 期待ソースと不一致なら再利用しない（別ソースのパーサで書かれた汚染キャッシュの自己修復）。
   * フィールド導入前の旧キャッシュは未記載 = 'claude' とみなす。
   */
  source?: string;
}
