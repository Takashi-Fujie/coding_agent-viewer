/**
 * Tools & Agents 画面（SPEC-DASH-050〜052）。仕様は docs/design/DASH.md。
 * 期間プリセット + プロジェクト選択が下の全カードを同じスライスで絞り込む。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, presetQuery } from '../api';
import type { RangeQuery } from '../api';
import { PRESETS } from '../lib/dates';
import type { PresetKey } from '../lib/dates';
import { SourceSwitch, useSourceFilter } from '../lib/source';
import type {
  AgentStatsResponse,
  ConfigResponse,
  HookStatsResponse,
  ProjectListItem,
  ToolStatsResponse,
} from '../lib/types';

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

function rate(failures: number, count: number): string {
  if (count === 0) return '—';
  return `${((failures / count) * 100).toFixed(1)}%`;
}

export function ToolsView() {
  const { source } = useSourceFilter();
  const [preset, setPreset] = useState<PresetKey>('30d');
  const [project, setProject] = useState<string>('');
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [tools, setTools] = useState<ToolStatsResponse | undefined>();
  const [agents, setAgents] = useState<AgentStatsResponse | undefined>();
  const [hooks, setHooks] = useState<HookStatsResponse | undefined>();
  const [config, setConfig] = useState<ConfigResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    const params: RangeQuery = { ...presetQuery(preset) };
    if (project !== '') params.project = project;
    if (source !== undefined) params.source = source;
    Promise.all([api.statsTools(params), api.statsAgents(params), api.statsHooks(params)]).then(
      ([t, a, h]) => {
        if (!alive) return;
        setTools(t);
        setAgents(a);
        setHooks(h);
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [preset, project, source]);

  useEffect(() => {
    let alive = true;
    api.config().then(
      (c) => {
        if (alive) setConfig(c);
      },
      () => {
        // 定義一覧が読めなくても実績側は表示できる
      },
    );
    api.projects().then(
      (list) => {
        if (alive) setProjects(list.filter((p) => p.sessionCount > 0));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const maxCount = useMemo(
    () => Math.max(...(tools?.tools.map((t) => t.count) ?? [0]), 1),
    [tools],
  );

  /** プロジェクト別テーブルの列にする上位ツール（全体ランキングの先頭 4 つ・MCP 以外）。 */
  const topTools = useMemo(
    () => (tools?.tools ?? []).filter((t) => !t.name.startsWith('mcp__')).slice(0, 4).map((t) => t.name),
    [tools],
  );

  const subagentCounts = new Map((agents?.subagents ?? []).map((s) => [s.name, s]));
  const definedAgents = config?.agents ?? [];
  /** 定義ファイルが無いが実績のある subagent（組み込み等）も一覧に足す。 */
  const extraAgents = (agents?.subagents ?? []).filter(
    (s) => !definedAgents.some((d) => d.name === s.name),
  );

  return (
    <>
      <div className="pagehead">
        <h1>Tools &amp; Agents</h1>
        <p>ツール・MCP・エージェント・スキルの利用状況。プロジェクトで絞り込める。</p>
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
          <select
            aria-label="プロジェクトで絞り込み"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">すべてのプロジェクト</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path ?? p.id}
              </option>
            ))}
          </select>
        </div>

        {error !== undefined && <div className="note err">読み込みに失敗しました: {error}</div>}

        <div className="sectionlabel">ツール / MCP</div>
        <div className="cols2">
          <div className="card">
            <h2>
              ツール別ランキング<span className="est">呼び出し回数</span>
            </h2>
            <div data-testid="tool-ranking">
              {(tools?.tools ?? []).slice(0, 12).map((t) => (
                <div className="hbar" key={t.name}>
                  <span className="lb mono">{t.name}</span>
                  <span className="track">
                    <i style={{ width: `${(t.count / maxCount) * 100}%` }} />
                  </span>
                  <span className="val">{t.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h2>
              失敗率<span className="est">tool_result のエラーから算出</span>
            </h2>
            <table data-testid="failure-table">
              <thead>
                <tr>
                  <th>ツール</th>
                  <th className="num">呼出</th>
                  <th className="num">失敗</th>
                  <th className="num">失敗率</th>
                </tr>
              </thead>
              <tbody>
                {(tools?.tools ?? [])
                  .filter((t) => t.failures > 0)
                  .slice(0, 12)
                  .map((t) => (
                    <tr key={t.name}>
                      <td className="mono">{t.name}</td>
                      <td className="num">{t.count.toLocaleString()}</td>
                      <td className="num">{t.failures.toLocaleString()}</td>
                      <td className="num">{rate(t.failures, t.count)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>
            プロジェクト別ツール利用<span className="est">呼び出し回数・上位ツール</span>
          </h2>
          <table data-testid="project-tools-table">
            <thead>
              <tr>
                <th>プロジェクト</th>
                {topTools.map((name) => (
                  <th className="num mono" key={name}>
                    {name}
                  </th>
                ))}
                <th className="num">MCP 計</th>
                <th className="num">合計</th>
                <th className="num">失敗率</th>
              </tr>
            </thead>
            <tbody>
              {(tools?.byProject ?? []).map((row) => {
                const mcpTotal = Object.entries(row.byTool)
                  .filter(([name]) => name.startsWith('mcp__'))
                  .reduce((sum, [, count]) => sum + count, 0);
                return (
                  <tr key={row.project}>
                    <td className="mono">{row.project}</td>
                    {topTools.map((name) => (
                      <td className="num" key={name}>
                        {(row.byTool[name] ?? 0).toLocaleString()}
                      </td>
                    ))}
                    <td className="num">{mcpTotal.toLocaleString()}</td>
                    <td className="num">{row.total.toLocaleString()}</td>
                    <td className="num">{rate(row.failures, row.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="cols2">
          <div className="card">
            <h2>
              MCP サーバ別内訳<span className="est">mcp__&lt;server&gt;__&lt;tool&gt; を分解</span>
            </h2>
            <table data-testid="mcp-table">
              <thead>
                <tr>
                  <th>サーバ</th>
                  <th>ツール</th>
                  <th className="num">呼出</th>
                  <th className="num">失敗率</th>
                </tr>
              </thead>
              <tbody>
                {(tools?.mcp ?? []).map((m) => (
                  <tr key={m.server}>
                    <td className="mono">{m.server}</td>
                    <td className="mono">{m.tools.join(', ')}</td>
                    <td className="num">{m.count.toLocaleString()}</td>
                    <td className="num">{rate(m.failures, m.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>hook 発火履歴</h2>
            <div className="scrolly">
              <table data-testid="hook-table">
              <thead>
                <tr>
                  <th>時刻</th>
                  <th>イベント</th>
                  <th>hook</th>
                  <th>プロジェクト</th>
                </tr>
              </thead>
              <tbody>
                {(hooks?.hooks ?? []).slice(0, 20).map((h, i) => (
                  <tr key={`${h.sessionId}-${h.timestamp}-${i}`}>
                    <td className="mono">{formatWhen(h.timestamp)}</td>
                    <td className="mono">{h.hookEvent ?? '—'}</td>
                    <td className="mono">{h.hookName}</td>
                    <td className="mono">{h.project}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
            {hooks?.truncated === true && <div className="note">最新分のみ表示（打ち切りあり）</div>}
          </div>
        </div>

        <div className="sectionlabel">エージェント / スキル</div>
        <div className="cols2">
          <div className="card">
            <h2>
              エージェント定義 × 起動実績<span className="est">期間内の起動回数</span>
            </h2>
            <table data-testid="agent-table">
              <thead>
                <tr>
                  <th>エージェント</th>
                  <th className="num">起動</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {definedAgents.map((agent) => {
                  const stat = subagentCounts.get(agent.name);
                  return (
                    <tr key={agent.name}>
                      <td className="mono">{agent.name}</td>
                      <td className="num">{stat?.count ?? 0}</td>
                      <td>
                        {stat === undefined && <span className="badge unused">⏸ 起動実績なし</span>}
                      </td>
                    </tr>
                  );
                })}
                {extraAgents.map((stat) => (
                  <tr key={stat.name}>
                    <td className="mono">{stat.name}</td>
                    <td className="num">{stat.count}</td>
                    <td>
                      <span className="pmeta">定義ファイルなし（組み込み等)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>
              Skill 呼び出し履歴<span className="est">期間内</span>
            </h2>
            <table data-testid="skill-table">
              <thead>
                <tr>
                  <th>スキル</th>
                  <th className="num">呼出</th>
                  <th>最終使用</th>
                </tr>
              </thead>
              <tbody>
                {(agents?.skills ?? []).map((s) => (
                  <tr key={s.name}>
                    <td className="mono">{s.name}</td>
                    <td className="num">{s.count}</td>
                    <td>{formatWhen(s.lastTimestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
