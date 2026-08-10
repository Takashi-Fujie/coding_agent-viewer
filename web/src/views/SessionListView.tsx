/**
 * プロジェクト画面（SPEC-DASH-040）。仕様は docs/design/DASH.md。
 * 日次モデル別チャート + セッション一覧。日付クリックはその日のセッションへの
 * 絞り込み（from = to の再取得。Overview と同じ方式）。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ProjectDetail } from '../api';
import { ComboChart } from '../components/ComboChart';
import { assignModelColors } from '../lib/colors';
import { SourceBadge } from '../lib/source';
import { formatTokens, formatUsd } from '../lib/format';
import { routeHash } from '../router';
import type { SessionListItem } from '../lib/types';

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

export function SessionListView({ projectId }: { projectId: string }) {
  const [detail, setDetail] = useState<ProjectDetail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [daySessions, setDaySessions] = useState<SessionListItem[] | undefined>();

  useEffect(() => {
    let alive = true;
    api.project(projectId).then(
      (d) => {
        if (alive) setDetail(d);
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (selectedDay === null) {
      setDaySessions(undefined);
      return;
    }
    let alive = true;
    api.project(projectId, { from: selectedDay, to: selectedDay }).then(
      (d) => {
        // usage 0 の Codex セッションも、その日にレコードがあれば残す（SPEC-DASH-088）
        if (alive) setDaySessions(d.sessions.filter((s) => s.records > 0));
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [projectId, selectedDay]);

  const models = useMemo(() => {
    if (!detail) return [];
    const tokens = new Map<string, number>();
    for (const day of detail.daily) {
      for (const [model, value] of Object.entries(day.byModel)) {
        tokens.set(model, (tokens.get(model) ?? 0) + value);
      }
    }
    // トークン 0 のモデル（<synthetic> 等）は凡例・積み上げに出さない
    return [...tokens.entries()]
      .filter(([, total]) => total > 0)
      .map(([name, total]) => ({ name, tokens: total }));
  }, [detail]);

  const modelColors = useMemo(() => assignModelColors(models), [models]);

  const listSource =
    selectedDay !== null ? (daySessions ?? []) : (detail?.sessions ?? []);
  const sessions = [...listSource].sort((a, b) =>
    (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? ''),
  );

  const totalTokensAll = detail?.sessions.reduce((s, x) => s + x.totalTokens, 0) ?? 0;
  const totalCostAll = detail?.sessions.reduce((s, x) => s + x.estimatedCost, 0) ?? 0;

  return (
    <>
      <div className="crumbs">
        <a href={routeHash({ view: 'overview' })}>← Overview</a>
        <span className="sep">/</span>
        <span className="mono">
          {detail?.source !== undefined && detail.source !== 'claude'
            ? projectId
            : (detail?.path ?? projectId)}
        </span>
      </div>
      <div className="chathead">
        {/* Codex グループの主ラベルは日付（グループ ID）。cwd 末尾にしない（SPEC-DASH-087） */}
        <span className="t">
          {detail?.source !== undefined && detail.source !== 'claude'
            ? projectId
            : (detail?.path?.split('/').at(-1) ?? projectId)}
        </span>
        {detail !== undefined && <SourceBadge source={detail.source} />}
        <span className="badge">{detail?.sessions.length ?? '…'} セッション</span>
        <span className="badge">{formatTokens(totalTokensAll)} tok</span>
        <span className="badge">{formatUsd(totalCostAll)} 推定</span>
        {detail?.path && <div className="sub mono">{detail.path}</div>}
      </div>
      <div className="dashwrap">
        {error !== undefined && <div className="note err">読み込みに失敗しました: {error}</div>}

        <div className="card">
          <h2>
            日次モデル別トークンとコスト
            <span className="est">このプロジェクト・積み上げ + 推定コスト・x 軸共有</span>
          </h2>
          <div className="legend" data-testid="model-legend">
            {models.map((m) => (
              <span key={m.name}>
                <i style={{ background: modelColors.get(m.name) }} />
                {m.name}
              </span>
            ))}
          </div>
          {detail && (
            <ComboChart
              days={detail.daily.map((d) => d.date)}
              series={models.map((m) => ({
                key: m.name,
                label: m.name,
                color: modelColors.get(m.name) ?? 'var(--baseline)',
                values: detail.daily.map((d) => d.byModel[m.name] ?? 0),
              }))}
              cost={detail.daily.map((d) => d.cost)}
              selected={selectedDay}
              onSelectDay={setSelectedDay}
            />
          )}
        </div>

        <div className="card">
          <h2>
            セッション<span className="est">クリックで会話分析へ・グラフの日付クリックで絞り込み</span>
            {selectedDay !== null && (
              <span className="chip on" style={{ marginLeft: 10 }}>
                <b>{selectedDay}</b>&nbsp;に活動したセッション
                <button aria-label="絞り込み解除" onClick={() => setSelectedDay(null)}>
                  ✕
                </button>
              </span>
            )}
          </h2>
          {detail === undefined && error === undefined && <div className="note">読み込み中…</div>}
          {detail !== undefined && (
            <table data-testid="session-table">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>セッション</th>
                  <th>モデル</th>
                  <th className="num">msg</th>
                  <th className="num">トークン</th>
                  <th className="num">コスト推定</th>
                  <th>最終更新</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.id}
                    className="rowlink"
                    onClick={() => {
                      location.hash = routeHash({ view: 'session', projectId, sessionId: s.id });
                    }}
                  >
                    <td>
                      <b>{s.title ?? s.id}</b>
                      <SourceBadge source={s.source} />
                    </td>
                    <td className="mono">{s.models.join(', ')}</td>
                    <td className="num">{s.recordCount.toLocaleString()}</td>
                    {/* Codex の usage は #30 まで未集計（SPEC-DASH-089） */}
                    <td className="num">
                      {s.source !== 'claude' && s.totalTokens === 0 ? (
                        <span className="est">未集計</span>
                      ) : (
                        formatTokens(s.totalTokens)
                      )}
                    </td>
                    <td className="num">
                      {s.source !== 'claude' && s.estimatedCost === 0 ? (
                        <span className="est">未集計</span>
                      ) : (
                        formatUsd(s.estimatedCost)
                      )}
                    </td>
                    <td>{formatWhen(s.lastTimestamp)}</td>
                  </tr>
                ))}
                {selectedDay !== null && daySessions !== undefined && sessions.length === 0 && (
                  <tr>
                    <td colSpan={6} className="note">
                      この日に活動したセッションはありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
