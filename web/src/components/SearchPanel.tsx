/**
 * 全セッション横断の全文検索パネル（SPEC-DASH-060〜062）。仕様は docs/design/DASH.md。
 *
 * 検索状態はローカル state（URL に載せない）。サーバはストリーム grep なので
 * 入力のたびには叩かず、明示的な送信（Enter / ボタン）でのみ実行する。
 */
import { useState } from 'react';
import { api } from '../api';
import { SourceBadge, useSourceFilter } from '../lib/source';
import { routeHash } from '../router';
import type { SearchResponse } from '../lib/types';

export function SearchPanel() {
  const { source } = useSourceFilter();
  const [q, setQ] = useState('');
  const [result, setResult] = useState<SearchResponse | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const word = q.trim();
    if (word.length === 0) return;
    setBusy(true);
    setError(undefined);
    api.search(word, source).then(
      (res) => {
        setResult(res);
        setBusy(false);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };

  const clear = () => {
    setQ('');
    setResult(undefined);
    setError(undefined);
  };

  return (
    <div className="card" data-testid="search-panel">
      <h2>
        全文検索<span className="est">全セッション横断・ストリーム grep</span>
      </h2>
      <form className="searchrow" onSubmit={submit} role="search">
        <input
          type="search"
          aria-label="全文検索"
          placeholder="全セッションを検索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          検索
        </button>
        {result !== undefined && (
          <button type="button" aria-label="検索結果を閉じる" onClick={clear}>
            ✕
          </button>
        )}
      </form>
      {error !== undefined && <div className="note err">検索に失敗しました: {error}</div>}
      {result !== undefined && (
        <div data-testid="search-hits">
          {result.truncated && (
            <div className="note">ヒットが多いため {result.limit} 件で打ち切りました</div>
          )}
          {result.hits.length === 0 ? (
            <div className="note">該当なし</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>プロジェクト / セッション</th>
                  <th>抜粋</th>
                </tr>
              </thead>
              <tbody>
                {result.hits.map((h) => (
                  <tr
                    key={`${h.sessionId}:${String(h.offset)}`}
                    className="rowlink"
                    onClick={() => {
                      location.hash = routeHash({
                        view: 'session',
                        projectId: h.projectId,
                        sessionId: h.sessionId,
                      });
                    }}
                  >
                    <td>
                      <span className="mono">{h.projectId}</span>
                      <SourceBadge source={h.source} />
                      <span className="pmeta mono">{h.sessionId}</span>
                    </td>
                    <td className="mono">{h.preview}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
