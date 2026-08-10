/**
 * アプリ骨格・左ナビ・ハッシュルーティング（SPEC-CHAT-001 / SPEC-DASH-030）。
 * 仕様は docs/design/DASH.md。
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { SourceFilterContext } from './lib/source';
import type { SourceInfo } from './lib/types';
import { parseRoute, routeHash } from './router';
import { ConfigView } from './views/ConfigView';
import { OverviewView } from './views/OverviewView';
import { ToolsView } from './views/ToolsView';
import { SessionListView } from './views/SessionListView';
import { SessionView } from './views/SessionView';

export function App() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  // ソース切替（SPEC-DASH-085）。App の state なのでハッシュ遷移をまたいで保持される
  const [source, setSource] = useState<string | undefined>(undefined);
  const [sources, setSources] = useState<SourceInfo[]>([]);

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  useEffect(() => {
    let alive = true;
    api.sources().then(
      (res) => {
        // 形が想定と違う応答（旧サーバ等）では切替を出さないだけで画面は成立させる
        if (alive) setSources(Array.isArray(res.sources) ? res.sources : []);
      },
      () => undefined, // 取得失敗時は切替を出さないだけで画面は成立させる
    );
    return () => {
      alive = false;
    };
  }, []);

  // ドリルダウン画面（プロジェクト / セッション）では Overview 側をアクティブ表示にする
  const activeNav =
    route.view === 'tools' ? 'tools' : route.view === 'config' ? 'config' : 'overview';

  return (
    <SourceFilterContext.Provider value={{ source, setSource, sources }}>
    <div className="app">
      <nav className="nav">
        <div className="brand">
          agent-viewer<small>コーディングエージェントログビューア</small>
        </div>
        <div className="group">ダッシュボード</div>
        <a
          href={routeHash({ view: 'overview' })}
          className={activeNav === 'overview' ? 'active' : ''}
        >
          Overview
        </a>
        <a href={routeHash({ view: 'tools' })} className={activeNav === 'tools' ? 'active' : ''}>
          Tools &amp; Agents
        </a>
        <div className="group">環境</div>
        <a href={routeHash({ view: 'config' })} className={activeNav === 'config' ? 'active' : ''}>
          設定
        </a>
        <div className="foot">
          127.0.0.1 のみ
          <br />
          ローカル専用・外部公開なし
        </div>
      </nav>
      <main className="appmain">
        {route.view === 'overview' && <OverviewView />}
        {route.view === 'tools' && <ToolsView />}
        {route.view === 'config' && <ConfigView />}
        {route.view === 'sessions' && <SessionListView projectId={route.projectId} />}
        {route.view === 'session' && (
          <SessionView
            key={route.sessionId}
            projectId={route.projectId}
            sessionId={route.sessionId}
          />
        )}
      </main>
    </div>
    </SourceFilterContext.Provider>
  );
}
