/**
 * Overview 画面（SPEC-DASH-032〜037・SPEC-CHAT-005）。仕様は docs/design/DASH.md。
 *
 * 日付クリックの絞り込みは、選択日を from = to にした /api/overview の再取得で行う
 * （プロジェクト × 日の対応をクライアントに二重実装しない）。チャートは期間全体の
 * 取得結果を保持したまま、一覧だけを単日の結果で差し替える。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, presetQuery } from '../api';
import { ComboChart } from '../components/ComboChart';
import { Donut } from '../components/Donut';
import { SearchPanel } from '../components/SearchPanel';
import { assignModelColors } from '../lib/colors';
import { SourceBadge, SourceSwitch, useSourceFilter } from '../lib/source';
import { PRESETS } from '../lib/dates';
import type { PresetKey } from '../lib/dates';
import { formatTokens, formatUsd } from '../lib/format';
import { routeHash } from '../router';
import type { ModelTokenBreakdown, OverviewResponse, ProjectListItem } from '../lib/types';

type SortKey = 'recent' | 'cost' | 'sessions';

/** クライアント生成の擬似メッセージ。単価が無いのは当然なので警告対象にしない。 */
const SYNTHETIC_MODEL = '<synthetic>';

const TOKEN_SERIES = [
  { key: 'input', label: 'input', color: 'var(--s1)' },
  { key: 'output', label: 'output', color: 'var(--s2)' },
  { key: 'cacheCreation', label: 'cache write', color: 'var(--s3)' },
  { key: 'cacheRead', label: 'cache read', color: 'var(--s4)' },
] as const;

function totalTokens(breakdown: ModelTokenBreakdown): number {
  return breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheCreation;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

function basename(path: string | null): string | undefined {
  if (!path) return undefined;
  return path.split('/').filter((p) => p.length > 0).at(-1);
}

function sortProjects(projects: ProjectListItem[], sort: SortKey): ProjectListItem[] {
  const sorted = [...projects];
  switch (sort) {
    case 'recent':
      return sorted.sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''));
    case 'cost':
      return sorted.sort((a, b) => b.estimatedCost - a.estimatedCost);
    case 'sessions':
      return sorted.sort((a, b) => b.sessionCount - a.sessionCount);
  }
}

export function OverviewView() {
  const { source } = useSourceFilter();
  const [preset, setPreset] = useState<PresetKey>('7d');
  const [data, setData] = useState<OverviewResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  /** 選択日に活動したプロジェクト（単日の再取得結果）。 */
  const [dayProjects, setDayProjects] = useState<ProjectListItem[] | undefined>();
  const [sort, setSort] = useState<SortKey>('recent');
  const [showEmpty, setShowEmpty] = useState(false);

  useEffect(() => {
    let alive = true;
    setSelectedDay(null);
    setDayProjects(undefined);
    api.overview({ ...presetQuery(preset), ...(source !== undefined ? { source } : {}) }).then(
      (res) => {
        if (alive) setData(res);
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [preset, source]);

  useEffect(() => {
    if (selectedDay === null) {
      setDayProjects(undefined);
      return;
    }
    let alive = true;
    api
      .overview({ from: selectedDay, to: selectedDay, ...(source !== undefined ? { source } : {}) })
      .then(
        (res) => {
          if (alive) {
            // usage が構造的に 0 の Codex 行も、その日にレコードがあれば残す（SPEC-DASH-088）
            setDayProjects(res.projects.filter((p) => p.records > 0));
          }
        },
        (e: Error) => {
          if (alive) setError(e.message);
        },
      );
    return () => {
      alive = false;
    };
  }, [selectedDay, source]);

  const modelColors = useMemo(() => {
    if (!data) return new Map<string, string>();
    return assignModelColors(
      Object.entries(data.byModel).map(([name, b]) => ({ name, tokens: totalTokens(b) })),
    );
  }, [data]);

  if (error !== undefined) {
    return (
      <div className="dashwrap">
        <div className="note err">読み込みに失敗しました: {error}</div>
      </div>
    );
  }

  const unknownModels = data?.cost.unknownModels.filter((m) => m !== SYNTHETIC_MODEL) ?? [];
  // トークン・コストとも 0 のモデル（<synthetic> 等）は内訳表示から除く
  const models = data
    ? Object.keys(data.byModel).filter(
        (m) => totalTokens(data.byModel[m]!) > 0 || (data.cost.byModel[m]?.total ?? 0) > 0,
      )
    : [];
  const presetLabel = PRESETS.find((p) => p.key === preset)?.label ?? '';

  const listSource = selectedDay !== null ? (dayProjects ?? []) : (data?.projects ?? []);
  const visibleProjects = sortProjects(
    listSource.filter((p) => showEmpty || p.sessionCount > 0),
    sort,
  );

  return (
    <>
      <div className="pagehead">
        <h1>Overview</h1>
        <p>全体俯瞰 → 気になるプロジェクト・セッションを選んで分析へ。コストはすべて pricing.json に基づく推定値。</p>
      </div>
      <div className="dashwrap">
        <div className="filterrow">
          <div className="presets">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                className={p.key === preset ? 'on' : ''}
                onClick={() => setPreset(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <SourceSwitch />
          {selectedDay !== null && (
            <span className="chip on" data-testid="day-chip">
              <b>{selectedDay}</b>&nbsp;に活動したプロジェクト
              <button aria-label="絞り込み解除" onClick={() => setSelectedDay(null)}>
                ✕
              </button>
            </span>
          )}
        </div>

        <SearchPanel />

        {unknownModels.length > 0 && (
          <div className="warnbanner" data-testid="unknown-banner">
            <span className="ic">⚠</span>
            <span>
              <b>未知モデル {unknownModels.length} 件</b>（<code>{unknownModels.join(', ')}</code>
              ）の単価が pricing.json にありません。該当分はコストに<b>含まれていません</b>
              （0 円扱いにはしていません）。
            </span>
          </div>
        )}

        <div className="tiles">
          <div className="tile hero" data-testid="tile-cost">
            <div className="lb">
              総コスト <span className="est">（推定・{presetLabel}）</span>
            </div>
            <div className="v">{data ? formatUsd(data.cost.total) : '…'}</div>
          </div>
          <div className="tile" data-testid="tile-tokens">
            <div className="lb">総トークン</div>
            <div className="v">
              {data
                ? formatTokens(
                    data.totals.tokens.input +
                      data.totals.tokens.output +
                      data.totals.tokens.cacheRead +
                      data.totals.tokens.cacheCreation,
                  )
                : '…'}
            </div>
          </div>
          <div className="card">
            <h2>
              モデル別利用状況<span className="est">トークン / コスト推定</span>
            </h2>
            <div className="donuts">
              <Donut
                title="トークン"
                testId="donut-tokens"
                format={formatTokens}
                items={models.map((m) => ({
                  label: m,
                  color: modelColors.get(m) ?? 'var(--baseline)',
                  value: totalTokens(data!.byModel[m]!),
                }))}
              />
              <Donut
                title="コスト（推定）"
                testId="donut-cost"
                format={formatUsd}
                items={models.map((m) => ({
                  label: m,
                  color: modelColors.get(m) ?? 'var(--baseline)',
                  value: data!.cost.byModel[m]?.total ?? 0,
                }))}
              />
            </div>
          </div>
        </div>

        <div className="card">
          <h2>
            日次トークンとコスト
            <span className="est">積み上げ + 推定コスト・日付クリックでその日のプロジェクトに絞り込み</span>
          </h2>
          <div className="legend">
            {TOKEN_SERIES.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
          {data && (
            <ComboChart
              days={data.daily.map((d) => d.date)}
              series={TOKEN_SERIES.map((s) => ({
                ...s,
                values: data.daily.map((d) => d.tokens[s.key]),
              }))}
              cost={data.daily.map((d) => d.cost)}
              selected={selectedDay}
              onSelectDay={setSelectedDay}
            />
          )}
        </div>

        <div className="card">
          <h2>
            プロジェクト<span className="est">クリックでプロジェクト画面へ</span>
          </h2>
          <div className="listctl">
            <label className="note">
              <input
                type="checkbox"
                checked={showEmpty}
                onChange={(e) => setShowEmpty(e.target.checked)}
              />
              セッション 0 件のプロジェクトも表示
            </label>
            <select
              aria-label="プロジェクトの並び替え"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="recent">並び: 最終更新</option>
              <option value="cost">並び: コスト</option>
              <option value="sessions">並び: セッション数</option>
            </select>
          </div>
          <table data-testid="project-table">
            <thead>
              <tr>
                <th style={{ width: '42%' }}>プロジェクト</th>
                <th className="num">セッション</th>
                <th className="num">トークン</th>
                <th className="num">コスト推定</th>
                <th>最終更新</th>
              </tr>
            </thead>
            <tbody>
              {visibleProjects.map((p) => (
                <tr
                  key={p.id}
                  className="rowlink"
                  onClick={() => {
                    location.hash = routeHash({ view: 'sessions', projectId: p.id });
                  }}
                >
                  <td>
                    {/* 行ラベルはソース不問で cwd 末尾。path の無いグループ（cwd 欠損の日付フォールバック等）は id（SPEC-DASH-087） */}
                    <b>{basename(p.path) ?? p.id}</b>
                    {/* 統合行は構成ソースのバッジを全て並べる（SPEC-DASH-113） */}
                    {p.sources.map((s) => (
                      <SourceBadge key={s} source={s} />
                    ))}
                    {p.path !== null && <span className="pmeta mono">{p.path}</span>}
                  </td>
                  <td className="num">
                    {p.sessionCount}
                  </td>
                  {/* 未集計表示は claude を含まない行のみ（SPEC-DASH-089 / 113。claude を含む統合行は数値表示） */}
                  <td className="num">
                    {!p.sources.includes('claude') && p.totalTokens === 0 ? (
                      <span className="est">未集計</span>
                    ) : (
                      formatTokens(p.totalTokens)
                    )}
                  </td>
                  <td className="num">
                    {!p.sources.includes('claude') && p.estimatedCost === 0 ? (
                      <span className="est">未集計</span>
                    ) : (
                      <b>{formatUsd(p.estimatedCost)}</b>
                    )}
                  </td>
                  <td>{formatWhen(p.lastTimestamp)}</td>
                </tr>
              ))}
              {selectedDay !== null && dayProjects !== undefined && visibleProjects.length === 0 && (
                <tr>
                  <td colSpan={5} className="note">
                    この日に活動したプロジェクトはありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>
            モデル別内訳<span className="est">テーブルビュー</span>
          </h2>
          <table data-testid="model-table">
            <thead>
              <tr>
                <th>モデル</th>
                <th className="num">msg</th>
                <th className="num">input</th>
                <th className="num">output</th>
                <th className="num">cache write (5m/1h)</th>
                <th className="num">cache read</th>
                <th className="num">コスト推定</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const b = data!.byModel[m]!;
                const c = data!.cost.byModel[m];
                const unknown = c?.unknownModel === true;
                return (
                  <tr key={m}>
                    <td>
                      <span className="mono">{m}</span>
                      {unknown && <span className="badge warn">⚠ 単価未登録</span>}
                    </td>
                    <td className="num">{b.messages.toLocaleString()}</td>
                    <td className="num">{formatTokens(b.input)}</td>
                    <td className="num">{formatTokens(b.output)}</td>
                    <td className="num">
                      {formatTokens(b.cacheCreation5m)} / {formatTokens(b.cacheCreation1h)}
                    </td>
                    <td className="num">{formatTokens(b.cacheRead)}</td>
                    <td className="num">{unknown ? '—' : formatUsd(c?.total ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
