# SPEC-API — HTTP API（詳細設計書）

担当 Issue: #5。人間向けの基本仕様書は [docs/spec/API.md](../spec/API.md)。

## エンドポイント

> **注意**: この節に `METHOD /api/...` 形式で書いた行は `npm run spec:check` の突き合わせ対象になる。実装（`server/routes/`）と対応が取れた状態でのみ記述する。

| エンドポイント | 説明 | 主なクエリ |
|---|---|---|
| `GET /api/overview` | 全体集計（総トークン・推定コスト・モデル別・日次系列・プロジェクト一覧） | `from` `to`（YYYY-MM-DD）`tzOffset` `source` |
| `GET /api/projects` | プロジェクト一覧（セッション数・トークン・推定コスト・最終更新） | `source` |
| `GET /api/projects/:id` | プロジェクト詳細（日次モデル別系列 + 日次推定コスト・セッション一覧） | `from` `to` `tzOffset` `source` |
| `GET /api/sessions/:id` | セッション要約（モデル・トークン・推定コスト・skip 行数・メッセージメタ） | — |
| `GET /api/sessions/:id/messages` | メッセージ本文（offset seek・ページング） | `start` `limit` |
| `GET /api/search` | 全文検索（ストリーム grep） | `q` `limit` `source` |
| `GET /api/sources` | 登録済みログソースの一覧（id・発見済みセッション数。SPEC-DASH-080） | — |
| `GET /api/stats/tokens` | モデル別 × 日別トークン | `from` `to` `tzOffset` `source` |
| `GET /api/stats/tools` | ツール別呼出・失敗数、MCP サーバ別内訳、プロジェクト別利用（SPEC-DASH-020〜023） | `from` `to` `tzOffset` `project` `source` |
| `GET /api/stats/agents` | subagent / skill 別の起動実績と最終使用日時 | `from` `to` `tzOffset` `project` `source` |
| `GET /api/stats/hooks` | hook 発火履歴（新しい順・SPEC-DASH-025） | `from` `to` `tzOffset` `project` `limit` `source` |
| `GET /api/live` | セッション差分の SSE 配信（詳細は [LIVE.md](LIVE.md)） | `session` `have` |
| `GET /api/config` | `~/.claude/` の agents / skills / plugins / settings / history（詳細は docs/design/CONFIG.md） | — |
| `GET /api/pricing` | 価格表（コストが「推定」であることの明示付き） | — |

## データモデル・実装方針

### 構成

```
server/
  index.ts          # エントリポイント。127.0.0.1 のみに listen（既定 4517、PORT で上書き）
  app.ts            # Express アプリ生成（logDir / cacheDir を注入可能にしテストから合成ログを使う）
  store.ts          # インデックスの保持と鮮度管理
  routes/
    overview.ts     # /api/overview
    projects.ts     # /api/projects, /api/projects/:id
    sessions.ts     # /api/sessions/:id, /api/sessions/:id/messages
    search.ts       # /api/search
    stats.ts        # /api/stats/*
    config.ts       # /api/config, /api/pricing
```

- ルート定義には **`/api/` からのフルパス**を書く（apiDrift の抽出対象になるため。`app.use('/api', ...)` のプレフィックス分割はしない）
- viewer に返す DTO は `server/core/types.ts` の正規化済み型（`SessionSummary` / `IndexRecord`）と、この Issue で追加する集計 DTO のみ。**Claude 固有の生 JSONL 構造をレスポンスに露出させない**

### store（鮮度管理）

- リクエスト時に `buildIndex()` を呼ぶ。キャッシュ戦略（reuse / incremental / rebuild）は SPEC-CORE の `decideStrategy` に委ねるため、追加の TTL は設けない（stat のコストのみで最新が得られる）
- セッションの発見と ID の付与はログソース抽象（`server/sources/`・Issue #28）に委ね、store は配置規約を知らない。Claude ソースの規約（プロジェクト = `~/.claude/projects/` 直下のディレクトリ、セッション = 配下再帰の `*.jsonl`、id = 拡張子を除いたファイル名）は `server/sources/claude.ts` に定義がある。詳細は [CORE.md](CORE.md) の「ログソース抽象とセッション発見」

### 日次集計

- レコードの `timestamp`（ISO 8601）を **UTC 日付**（先頭 10 文字・YYYY-MM-DD）に丸め、日 × モデル × トークン種別で加算する。タイムゾーン変換をしないことで環境（開発機 JST / CI UTC）に依存しない決定的な集計にする。ローカル日付での表示調整が必要なら SPEC-DASH（#7）で扱う
- Overview の日次系列は**トークン種別**（input / output / cacheRead / cacheCreation）+ 日次推定コスト、プロジェクト詳細の日次系列は**モデル別**とする（SPEC-DASH の表示上の約束に対応）
- `from` / `to` は日付文字列の辞書順比較で閉区間フィルタする。不正な形式は 400

### 検索

- 転置インデックスは作らない。`iterateLines()` で全セッションをストリーム走査し、部分一致（大文字小文字を無視）したら sessionId・offset・preview を返す
- 既定 100 件で打ち切り、`truncated: true` を返す（黙って切らない）

### エラー

- 存在しない id は `404` + `{ "error": "<説明>" }`。不正なクエリは `400` + 同形式。ハンドラ内の例外は `500` + 同形式でサーバは落ちない

### 依存の追加

`express` を dependencies に、`@types/express` / `supertest` / `@types/supertest` を devDependencies に追加する。テストは supertest でアプリを直接叩く（listen 不要・ポート衝突しない）。

## 受け入れ基準

### サーバ基本

- [x] `SPEC-API-001` サーバは 127.0.0.1 のみに bind し、既定ポートは 4517、環境変数 PORT で上書きできる
- [x] `SPEC-API-002` 存在しない API パスへのリクエストに 404 と `{ error }` 形式の JSON を返す
- [x] `SPEC-API-003` ハンドラ内で例外が発生しても 500 の JSON を返しサーバは落ちない

### Overview

- [x] `SPEC-API-010` GET /api/overview は総トークン・推定コスト・モデル別内訳を返し、値は estimateRecordsCost の結果と一致する
- [x] `SPEC-API-011` GET /api/overview は from / to（YYYY-MM-DD）で期間を閉区間フィルタでき、不正な日付形式には 400 を返す
- [x] `SPEC-API-012` 価格表に無いモデルがあるとき unknownModels に列挙して返す（0 円で黙らせない）
- [x] `SPEC-API-013` GET /api/overview は日次系列（日付 × トークン種別の内訳 + 日次推定コスト）を返す

### プロジェクト

- [x] `SPEC-API-020` GET /api/projects はプロジェクト一覧（id・セッション数・総トークン・推定コスト・最終更新日時）を返す
- [x] `SPEC-API-021` GET /api/projects/:id は日次モデル別トークン系列とセッション一覧を返す
- [x] `SPEC-API-022` 存在しない project id には 404 と JSON エラーを返す

### セッション

- [x] `SPEC-API-030` GET /api/sessions/:id は要約（モデル別トークン・推定コスト・skippedLineCount）とメッセージメタ一覧を返す
- [x] `SPEC-API-031` GET /api/sessions/:id/messages は start / limit のページングで指定範囲のメッセージ本文だけを返す
- [x] `SPEC-API-032` メッセージ本文はインデックスの offset / length で該当行だけを seek して読む（ファイル全体を読み直さない）
- [x] `SPEC-API-033` 壊れた JSONL 行を含むセッションでもエラーにならず、skippedLineCount がレスポンスに含まれる
- [x] `SPEC-API-034` 存在しない session id には 404 と JSON エラーを返す

### 検索

- [x] `SPEC-API-040` GET /api/search?q= は全セッションを横断し、ヒットした行の sessionId・offset・preview を返す
- [x] `SPEC-API-041` q が未指定または空のとき 400 を返す
- [x] `SPEC-API-042` ヒットが limit（既定 100）を超えたら打ち切り、truncated: true で明示する

### 統計

- [x] `SPEC-API-050` GET /api/stats/tokens はモデル別 × 日別のトークン集計を返す
- [x] `SPEC-API-051` GET /api/stats/tools はツール別呼び出し回数を降順で返す
- [x] `SPEC-API-052` GET /api/stats/agents は subagent 別・skill 別の起動回数を返す

### 設定・価格表

- [x] `SPEC-API-060` GET /api/config は agents / skills / plugins / settings / history を返し、対象が無い場合は空一覧（settings は null）を返す。plugins は installed_plugins.json 由来（Issue #9 で「plugins/ 直下のディレクトリ名の羅列」から改訂）
- [x] `SPEC-API-061` GET /api/pricing は価格表と、コストが推定であることを示す source を返す

## 実測値（2026-08-06・Issue #5 完了時）

実ログ（15 ファイル / 89.7 MB / 8,331 レコード）に対する同時点の突き合わせで、
`GET /api/overview` の totals.records・cost.total が `npm run report` と完全一致
（8,331 レコード / $1151.40）。unknownModels は `<synthetic>` のみ。
最大セッション（約 69MB・3,082 レコード）の要約・messages ページングとも応答良好。
404 / 400 / 500 のエラー応答はすべて `{ error }` 形式の JSON。
