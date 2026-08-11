/**
 * usage から推定コストを算出する。仕様は docs/spec/SPEC-COST.md。
 *
 * ここで出る金額は常に「推定」である。単価は変動するので server/pricing.json に外出しし、
 * 価格表に無いモデルはサイレントに 0 円扱いせず unknownModel を立てて UI に警告を出す。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { IndexRecord, NormalizedUsage } from './core/types.js';

/** 単価の分母。単価は $/1M tokens で表現する。 */
export const TOKENS_PER_UNIT = 1_000_000;

/** 既定の価格表の場所。ユーザーが編集できるよう実行時に読み込む（バンドルしない）。 */
export const DEFAULT_PRICE_TABLE_PATH = fileURLToPath(new URL('./pricing.json', import.meta.url));

/** モデル ID 末尾の日付サフィックス（例: `-20251001`）。 */
const DATE_SUFFIX = /-\d{8}$/;

export interface Rate {
  input: number;
  output: number;
}

export interface IntroRate extends Rate {
  /** この日（YYYY-MM-DD）までは導入価格。当日を含む。 */
  until: string;
}

export interface ModelPrice extends Rate {
  /** fast mode の単価。未定義のモデルで fast が来たら unknownRate を立てる。 */
  fast?: Rate | undefined;
  intro?: IntroRate | undefined;
  /**
   * cached input の明示単価（$/1M）。OpenAI は割引率がモデルごとに異なるため（例: o3 は
   * input の 0.25 倍）、指定があれば input × cacheMultipliers.read の導出より優先する。
   * fast / intro 適用時はその単価体系の倍率導出へ戻る（明示値は標準単価の実測値のため）。
   */
  cacheRead?: number | undefined;
}

export interface CacheMultipliers {
  read: number;
  write5m: number;
  write1h: number;
}

export interface PriceTable {
  version: number;
  currency: string;
  unit: string;
  /** 単価の出典。UI に「推定」と併せて表示する。 */
  source: string;
  cacheMultipliers: CacheMultipliers;
  models: Record<string, ModelPrice>;
}

export interface CostInput {
  model?: string | undefined;
  /** 導入価格の期間判定に使う。無い場合は導入価格を適用しない。 */
  timestamp?: string | undefined;
  speed?: string | undefined;
  usage?: NormalizedUsage | undefined;
}

export interface CostBreakdown {
  /** 正規化後のモデル ID。 */
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  total: number;
  /** 価格表に無いモデル。cost は 0 だが 0 円と断定してはならない。 */
  unknownModel: boolean;
  /** 単価が引けなかった条件（fast 単価未定義など）。金額は暫定値。 */
  unknownRate: boolean;
  introApplied: boolean;
  fastApplied: boolean;
  /** 5m / 1h の内訳が無く 5m と仮定した。 */
  cacheSplitAssumed: boolean;
}

export interface ModelCost {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  total: number;
  unknownModel: boolean;
  unknownRate: boolean;
  introApplied: boolean;
  fastApplied: boolean;
}

export interface CostSummary {
  /** 常に true。表示側で「推定コスト」と明示するための印。 */
  estimated: true;
  source: string;
  currency: string;
  total: number;
  byModel: Record<string, ModelCost>;
  /** 価格表に無かったモデル名（昇順）。UI の警告に使う。 */
  unknownModels: string[];
}

/**
 * モデル ID を価格表のキーへ正規化する。実ログには `claude-haiku-4-5-20251001` のような
 * dated ID が現れるため、8 桁の日付サフィックスだけを取り除く。
 */
export function normalizeModelId(model: string): string {
  return model.replace(DATE_SUFFIX, '');
}

function isPriceTable(value: unknown): value is PriceTable {
  if (typeof value !== 'object' || value === null) return false;
  const table = value as Partial<PriceTable>;
  return (
    typeof table.source === 'string' &&
    typeof table.cacheMultipliers === 'object' &&
    table.cacheMultipliers !== null &&
    typeof table.models === 'object' &&
    table.models !== null
  );
}

/**
 * 価格表を読み込む。ユーザーが手で編集するファイルなので、壊れていたら
 * 黙って既定値へ倒さずエラーにする（誤った金額を出すより止まる方がよい）。
 */
export async function loadPriceTable(filePath: string = DEFAULT_PRICE_TABLE_PATH): Promise<PriceTable> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (cause) {
    throw new Error(`価格表を読み込めません: ${filePath}`, { cause });
  }

  if (!isPriceTable(parsed)) {
    throw new Error(`価格表の形式が不正です: ${filePath}`);
  }

  return parsed;
}

/** 導入価格の期間内か。日付単位（UTC）で比較し、until 当日は含む。 */
function isWithinIntro(timestamp: string | undefined, until: string): boolean {
  if (!timestamp) return false;
  return timestamp.slice(0, 10) <= until.slice(0, 10);
}

function amount(tokens: number, unitPrice: number): number {
  return (tokens / TOKENS_PER_UNIT) * unitPrice;
}

const emptyBreakdown = (model: string): CostBreakdown => ({
  model,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  total: 0,
  unknownModel: false,
  unknownRate: false,
  introApplied: false,
  fastApplied: false,
  cacheSplitAssumed: false,
});

/** 1 レコード分の推定コストを求める。 */
export function estimateCost(input: CostInput, table: PriceTable): CostBreakdown {
  const model = normalizeModelId(input.model ?? '');
  const price = model.length > 0 ? table.models[model] : undefined;

  if (!price) {
    return { ...emptyBreakdown(model), unknownModel: true };
  }

  const usage = input.usage;
  if (!usage) return emptyBreakdown(model);

  // fast mode は単価そのものが別物なので導入価格より優先する。
  let rate: Rate = { input: price.input, output: price.output };
  let fastApplied = false;
  let introApplied = false;
  let unknownRate = false;

  if (input.speed === 'fast') {
    if (price.fast) {
      rate = price.fast;
      fastApplied = true;
    } else {
      // 0 円にはせず通常単価で暫定計算し、値が過小である可能性を明示する。
      unknownRate = true;
    }
  } else if (price.intro && isWithinIntro(input.timestamp, price.intro.until)) {
    rate = { input: price.intro.input, output: price.intro.output };
    introApplied = true;
  }

  // 内訳が無く合計だけある場合は安い側（5m）に倒し、仮定したことを記録する。
  const cacheSplitAssumed =
    usage.cacheCreation > 0 && usage.cacheCreation5m === 0 && usage.cacheCreation1h === 0;
  const write5mTokens = cacheSplitAssumed ? usage.cacheCreation : usage.cacheCreation5m;
  const write1hTokens = cacheSplitAssumed ? 0 : usage.cacheCreation1h;

  const { read, write5m, write1h } = table.cacheMultipliers;
  // cached input は明示単価があれば優先する（SPEC-COST-050。fast / intro 適用時は倍率導出）。
  const cacheReadPrice =
    !fastApplied && !introApplied && price.cacheRead !== undefined
      ? price.cacheRead
      : rate.input * read;
  const breakdown: CostBreakdown = {
    model,
    input: amount(usage.input, rate.input),
    output: amount(usage.output, rate.output),
    cacheRead: amount(usage.cacheRead, cacheReadPrice),
    cacheWrite5m: amount(write5mTokens, rate.input * write5m),
    cacheWrite1h: amount(write1hTokens, rate.input * write1h),
    total: 0,
    unknownModel: false,
    unknownRate,
    introApplied,
    fastApplied,
    cacheSplitAssumed,
  };
  breakdown.total =
    breakdown.input +
    breakdown.output +
    breakdown.cacheRead +
    breakdown.cacheWrite5m +
    breakdown.cacheWrite1h;

  return breakdown;
}

const emptyModelCost = (): ModelCost => ({
  messages: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  total: 0,
  unknownModel: false,
  unknownRate: false,
  introApplied: false,
  fastApplied: false,
});

/**
 * レコード群を集計する。usage を持つレコード（kind 不問）を対象にする（SPEC-CODEX-091）。
 * messages のカウントだけは assistant に限る（Codex の usage 増分レコードを件数に数えない）。
 */
export function estimateRecordsCost(records: IndexRecord[], table: PriceTable): CostSummary {
  const byModel: Record<string, ModelCost> = {};
  const unknownModels = new Set<string>();
  let total = 0;

  for (const record of records) {
    if (!record.usage) continue;

    const cost = estimateCost(
      {
        model: record.model,
        timestamp: record.timestamp,
        speed: record.usage.speed,
        usage: record.usage,
      },
      table,
    );

    if (cost.unknownModel) unknownModels.add(cost.model);

    const totals = (byModel[cost.model] ??= emptyModelCost());
    if (record.kind === 'assistant') totals.messages += 1;
    totals.input += cost.input;
    totals.output += cost.output;
    totals.cacheRead += cost.cacheRead;
    totals.cacheWrite5m += cost.cacheWrite5m;
    totals.cacheWrite1h += cost.cacheWrite1h;
    totals.total += cost.total;
    totals.unknownModel ||= cost.unknownModel;
    totals.unknownRate ||= cost.unknownRate;
    totals.introApplied ||= cost.introApplied;
    totals.fastApplied ||= cost.fastApplied;

    total += cost.total;
  }

  return {
    estimated: true,
    source: table.source,
    currency: table.currency,
    total,
    byModel,
    unknownModels: [...unknownModels].sort(),
  };
}
