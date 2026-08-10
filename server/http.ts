/**
 * ルート共通の HTTP ヘルパ。仕様は docs/design/API.md。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { DATE_RE } from './aggregate.js';
import type { PriceTable } from './cost.js';
import type { LiveHub } from './live.js';
import type { Snapshot } from './store.js';

/** 各ルートへ注入する依存。テストは logDir / cacheDir / claudeDir を差し替える。 */
export interface ApiContext {
  load(): Promise<Snapshot>;
  loadTable(): Promise<PriceTable>;
  claudeDir: string;
  /** ライブ配信のハブ（SPEC-LIVE）。 */
  hub: LiveHub;
}

/** ステータスコード付きのエラー。エラーミドルウェアが JSON へ変換する。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** async ハンドラの拒否をエラーミドルウェアへ確実に流す。 */
export function wrap(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/** クエリ値を string として取り出す（配列・オブジェクトは無いものとして扱う）。 */
export function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 正の整数クエリ。無い・不正なら既定値。 */
export function queryInt(value: unknown, fallback: number): number {
  const raw = queryString(value);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface DateRange {
  from: string | undefined;
  to: string | undefined;
}

/**
 * tzOffset（分・UTC からの東向き。JST = 540）を検証して取り出す（SPEC-DASH-011)。
 * 未指定は 0（UTC）。整数でない・絶対値 840 超は 400。
 */
export function parseTzOffset(query: Record<string, unknown>): number {
  const raw = queryString(query['tzOffset']);
  if (raw === undefined) return 0;
  if (!/^-?\d+$/.test(raw) || Math.abs(Number.parseInt(raw, 10)) > 840) {
    throw new HttpError(400, `tzOffset は絶対値 840 以下の整数（分）で指定してください: ${raw}`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * source クエリ（ソース id）を検証して取り出す（SPEC-DASH-081〜082）。
 * 未指定は undefined（全ソース）。登録に無い id は 400。
 */
export function parseSource(query: Record<string, unknown>, snapshot: Snapshot): string | undefined {
  const raw = queryString(query['source']);
  if (raw === undefined) return undefined;
  if (!snapshot.sourcesById.has(raw)) {
    throw new HttpError(400, `未登録のソースです: ${raw}`);
  }
  return raw;
}

/** source 指定があればそのソースのグループだけに絞る（未指定は全ソース）。 */
export function projectsBySource(snapshot: Snapshot, source: string | undefined) {
  return source === undefined
    ? snapshot.projects
    : snapshot.projects.filter((p) => p.sourceId === source);
}

/** from / to（YYYY-MM-DD）を検証して取り出す。不正な形式は 400。 */
export function parseRange(query: Record<string, unknown>): DateRange {
  const range: DateRange = { from: undefined, to: undefined };
  for (const key of ['from', 'to'] as const) {
    const value = queryString(query[key]);
    if (value === undefined) continue;
    if (!DATE_RE.test(value)) {
      throw new HttpError(400, `${key} は YYYY-MM-DD 形式で指定してください: ${value}`);
    }
    range[key] = value;
  }
  return range;
}
