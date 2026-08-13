/**
 * セッション要約の累積。仕様は docs/spec/SPEC-CORE.md。
 *
 * 要約は「累積状態そのもの」であり、そのままキャッシュへ保存する。増分更新は
 * 保存済み要約に差分レコードを足すだけで済み、全再構築と結果が一致する（SPEC-CORE-046）。
 * そのため加算は順序に依存しない形（合計・件数・min/max）だけで構成する。
 */
import type { IndexRecord, ModelTotals, SessionSummary } from './types.js';

const emptyTotals = (): ModelTotals => ({
  messages: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  cacheCreation5m: 0,
  cacheCreation1h: 0,
  webSearch: 0,
  webFetch: 0,
});

export function createSummary(): SessionSummary {
  return {
    recordCount: 0,
    skippedLineCount: 0,
    assistantCount: 0,
    userCount: 0,
    sidechainCount: 0,
    syntheticCount: 0,
    compactionCount: 0,
    models: {},
    toolUseCounts: {},
    subagentTypes: {},
    skills: {},
    prNumbers: [],
  };
}

function bump(counter: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * usage の合算は kind 不問（SPEC-CODEX-091）。Codex の token_count 増分レコードは
 * kind system で usage を持つ。messages / assistantCount のカウントは assistant のみ。
 */
function accumulateUsage(summary: SessionSummary, record: IndexRecord): void {
  const usage = record.usage;
  if (!usage) return;

  const model = record.model ?? '(unknown)';
  const totals = (summary.models[model] ??= emptyTotals());
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheCreation += usage.cacheCreation;
  totals.cacheCreation5m += usage.cacheCreation5m;
  totals.cacheCreation1h += usage.cacheCreation1h;
  totals.webSearch += usage.webSearch;
  totals.webFetch += usage.webFetch;
}

function accumulateAssistant(summary: SessionSummary, record: IndexRecord): void {
  summary.assistantCount += 1;
  if (record.synthetic) summary.syntheticCount += 1;

  const model = record.model ?? '(unknown)';
  const totals = (summary.models[model] ??= emptyTotals());
  totals.messages += 1;

  for (const toolUse of record.toolUses ?? []) {
    bump(summary.toolUseCounts, toolUse.name);
    bump(summary.subagentTypes, toolUse.subagentType);
    bump(summary.skills, toolUse.skill);
  }
}

/** レコード 1 件を要約に反映する。 */
export function addToSummary(summary: SessionSummary, record: IndexRecord): void {
  summary.recordCount += 1;
  if (record.isSidechain) summary.sidechainCount += 1;
  accumulateUsage(summary, record);

  summary.sessionId ??= record.sessionId;
  summary.cwd ??= record.cwd;
  summary.gitBranch ??= record.gitBranch;
  summary.version ??= record.version;

  if (record.timestamp) {
    if (!summary.firstTimestamp || record.timestamp < summary.firstTimestamp) {
      summary.firstTimestamp = record.timestamp;
    }
    if (!summary.lastTimestamp || record.timestamp > summary.lastTimestamp) {
      summary.lastTimestamp = record.timestamp;
    }
  }

  switch (record.kind) {
    case 'assistant':
      accumulateAssistant(summary, record);
      break;

    case 'user':
      summary.userCount += 1;
      break;

    case 'system':
      // 会話の compact 区切りと同じ判定（SPEC-DASH-120）。Codex 正規化はこの
      // subtype を生成しないため、Codex セッションでは常に 0 のまま
      if (record.subtype === 'compact_boundary') summary.compactionCount += 1;
      break;

    case 'title':
      // 手動で付けたタイトルは AI 生成より優先する（出現順に関わらず）。
      if (record.title && (record.titleKind === 'custom' || summary.titleKind !== 'custom')) {
        summary.title = record.title;
        summary.titleKind = record.titleKind;
      }
      break;

    case 'pr-link':
      if (record.prNumber !== undefined && !summary.prNumbers.includes(record.prNumber)) {
        summary.prNumbers.push(record.prNumber);
      }
      break;

    default:
      break;
  }
}
