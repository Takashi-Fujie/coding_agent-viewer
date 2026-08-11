/**
 * ルート共通の HTTP ヘルパ。仕様は docs/design/API.md。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { DATE_RE } from './aggregate.js';
import type { PriceTable } from './cost.js';
import type { LiveHub } from './live.js';
import type { ProjectEntry, Snapshot } from './store.js';

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

/**
 * 同一 id のソース別グループを表示用に束ねたもの（SPEC-CORE-092・Issue #49）。
 * 内部データは 1 グループ 1 ソースのまま、API・画面に出る手前でだけ統合する。
 */
export interface DisplayProject {
  id: string;
  /** 同一 id を構成するソース別グループ（1 件なら従来と同じ単一ソースの行）。 */
  entries: ProjectEntry[];
}

/**
 * snapshot.projects を id で束ねて表示プロジェクトの一覧にする。並びは先頭出現位置。
 * source 指定時は部分表示（SPEC-CORE-093）: 選択ソースの**グループ**を持つ表示プロジェクト
 * だけを残し、entries を選択ソース分に絞る。判定はエントリの有無であってセッション数では
 * ない（セッション 0 件の claude 空グループは claude 選択で従来どおり残る）。
 */
export function displayProjects(snapshot: Snapshot, source: string | undefined): DisplayProject[] {
  const groups: DisplayProject[] = [];
  const byId = new Map<string, DisplayProject>();
  for (const project of snapshot.projects) {
    let group = byId.get(project.id);
    if (group === undefined) {
      group = { id: project.id, entries: [] };
      byId.set(project.id, group);
      groups.push(group);
    }
    group.entries.push(project);
  }
  if (source === undefined) return groups;
  return groups
    .filter((g) => g.entries.some((e) => e.sourceId === source))
    .map((g) => ({ id: g.id, entries: g.entries.filter((e) => e.sourceId === source) }));
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
