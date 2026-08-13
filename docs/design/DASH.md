# SPEC-DASH — ダッシュボード（詳細設計書）

担当 Issue: #7（初版）→ #31（ソース切替・Codex 統合。末尾のセクション）→ #49（同一プロジェクトの Claude / Codex 表示統合）。人間向けの基本仕様書は [docs/spec/DASH.md](../spec/DASH.md)。画面の正本は [docs/mockups/viewer-mock.html](../mockups/viewer-mock.html)（subagent 実行トレースと「その他」集約行は対象外 — 基本仕様書「この Issue で扱わないもの」参照）。

## データモデル

### インデックス拡張（INDEX_SCHEMA_VERSION 2 → 3）

`server/core/normalize.ts` / `types.ts` を拡張する。版数を上げるので旧キャッシュは全再構築される（静かな欠損を防ぐ仕様通りの挙動）。

- **user レコード**: `isToolError?: boolean` — `tool_result` ブロックの `is_error === true` のとき true。stderr の有無では判定しない（警告出力を失敗扱いしないため）
- **attachment レコード**: `hookName?: string` / `hookEvent?: string` — `attachment.type` が `hook_` で始まるとき `attachment.hookName` / `attachment.hookEvent` を保持する（実ログ実測: `hook_success` に両フィールドが存在。2026-08-06）

### 失敗率の突き合わせはリクエスト時に行う

tool_result（user レコード）には `tool_use_id` しか無い。ツール名は同セッションの assistant レコードの `toolUses` に持つ id→name 対応をリクエスト時にメモリ上で構築して解決する。インデックス構築時に永続化しない（増分更新の境界をまたぐ結合状態を持たないため）。

## API

エンドポイント表の正本は [docs/design/API.md](API.md)（apiDrift 対象）。この Issue での変更:

### tzOffset（ローカル日付集計）

- 対象: `/api/overview` `/api/projects/:id` `/api/stats/tokens` `/api/stats/tools` `/api/stats/agents` `/api/stats/hooks`
- `tzOffset` = **UTC からの東向き分オフセット**（JST = 540）。クライアントは `-new Date().getTimezoneOffset()` を渡す
- サーバは `timestamp + tzOffset分` をシフトした上で先頭 10 文字を日付とする。`from` / `to` の閉区間フィルタも同じシフト後日付で比較する
- 検証: 整数かつ絶対値 840 以下。それ以外は 400。未指定は 0（UTC・後方互換）
- `aggregate.ts` の `dateOf` / `filterByRange` / `dailyOverview` / `dailyByModel` / `modelDateRows` に省略可能な `tzOffset` 引数を追加する（既定 0 で既存テストは不変）

### レスポンス拡張

- `/api/overview` の `byModel` を拡張: モデル別に `messages` / `input` / `output` / `cacheRead` / `cacheCreation` / `cacheCreation5m` / `cacheCreation1h` を返す。モデル別の推定コストは既存 `cost.byModel`（同じ正規化キー）と突き合わせて使い、トークンとコストを二重に持たない
- `/api/projects/:id` の日次モデル別系列に日次推定コスト `cost` を追加する（プロジェクト画面のコスト折れ線用）
- `/api/stats/tools` を集計元ごと再設計（summary カウンタ → records 走査）し、`from` / `to` / `tzOffset` / `project` で絞り込み可能にする:

```jsonc
{
  "tools": [{ "name": "Bash", "count": 120, "failures": 13 }],          // count 降順
  "mcp":   [{ "server": "github", "count": 20, "failures": 1,
              "tools": ["create_pr", "list_issues"] }],                  // mcp__<server>__<tool> を分解
  "byProject": [{ "project": "<id>", "total": 300, "failures": 21,
                  "byTool": { "Bash": 120, "Read": 90 } }]
}
```

- `/api/stats/agents` に `lastTimestamp`（最終使用・ISO 8601）を追加し、同じ絞り込みに対応する。skill の集計対象は `toolUses[].skill` のみ（既存 summary 集計と同一。attributionSkill は数えない — 二重計上を避ける）
- `/api/stats/hooks` を新設: hook 発火履歴を新しい順に返す。`limit`（既定 100）で打ち切り、超過時は `truncated: true`

```jsonc
{ "hooks": [{ "timestamp": "...", "hookName": "SessionStart:startup",
              "hookEvent": "SessionStart", "project": "<id>", "sessionId": "..." }],
  "truncated": false }
```

## 画面

### ルーティングとナビ（App.tsx / router.ts）

| ハッシュ | 画面 |
|---|---|
| `#/` | Overview（起点。#6 のプロジェクト一覧を置き換え） |
| `#/tools` | Tools & Agents |
| `#/projects/:id` | プロジェクト画面（既存 SessionListView をチャート付きに拡張） |
| `#/projects/:id/sessions/:sid` | セッション分析（#6 のまま） |

左ナビ（Overview / Tools & Agents の 2 項目 + brand + フッタ）を `App.tsx` に追加し、モックの `grid-template-columns: 208px 1fr` 構成に合わせる。「設定・定義」ナビは #9 で追加する。

### 新規モジュール

- `web/src/lib/dates.ts` — 期間プリセット（今日 / 7日 / 30日 / 90日 / 月初来）→ ローカル日付の `{ from, to }` と `tzOffset` を計算する純関数（基準日を引数に取り決定的にテストする）
- `web/src/lib/colors.ts` — モデル → 色の固定割り当て。トークン降順で `--s1`〜`--s4` を割り当て、5 番目以降はグレー。同一レスポンス内でドーナツ・積み上げが同じ割り当てを共有する
- `web/src/components/ComboChart.tsx` — 積み上げ棒 + コスト折れ線の上下 2 パネル（x 軸共有・SVG 直描画）。系列は汎用（Overview = トークン種別、プロジェクト = モデル別）。帯クリックで `onSelectDay(date | null)` を通知
- `web/src/components/Donut.tsx` — ドーナツ + 凡例
- `web/src/views/OverviewView.tsx` / `ToolsView.tsx` — 各画面
- チャート実装前に **`dataviz` skill を読み込む**。色は CSS 変数（モックの `--s1`〜`--s4`）、文字色はデータ色を着せない（text-never-wears-data-color）

### 全文検索 UI（Issue #10 で追加）

- Overview 上部に検索ボックスを置く。Enter で `GET /api/search?q=` を呼び、ヒット一覧（プロジェクト・セッション・preview 抜粋）を Overview 内のパネルに表示する
- ヒット行クリックで `#/projects/:projectId/sessions/:sessionId` へ遷移する
- 0 件は「該当なし」、`truncated: true` のときは打ち切りの明示を出す。✕ で検索状態を解除する
- 検索状態はローカル state（URL に載せない。日付絞り込みと同じ扱い）

### 絞り込みの状態

日付クリック絞り込み（選択帯ハイライト・チップ・✕ / 再クリック解除・「該当なし」行）は各画面のローカル state で持つ。URL には載せない（リロードで解除されてよい）。

## テスト方針

- サーバ: supertest + 合成フィクスチャ（既存 `tests/helpers/fixtures.ts` 方式）。フィクスチャに tool_use / tool_result（`is_error` あり・なし）・`mcp__` ツール名・hook attachment・複数日 / 複数モデル / 複数プロジェクトの行を追加する。巨大行・壊れた行・未知モデル・`<synthetic>` 行の混入は既存規約どおり維持する
- web: Vitest + jsdom + testing-library（#6 の規約どおり）。fetch は stub。チャートのクリックは SVG 要素への fireEvent で検証する
- レンダリングの総合確認はオーナー動作確認（実ログ）と #10 の Playwright に委ねる

## 受け入れ基準

### インデックス（normalize / スキーマ）

- [x] `SPEC-DASH-001` tool_result の `is_error: true` を持つ user レコードは isToolError が true になり、無いものは undefined のままになる
- [x] `SPEC-DASH-002` `hook_` で始まる attachment から hookName / hookEvent がインデックスに保持される
- [x] `SPEC-DASH-003` INDEX_SCHEMA_VERSION は 3 以上であり、isToolError / hook を持たない旧版キャッシュは再利用されず再構築される（#29 で 4 へ繰り上げ。SPEC-CODEX-067）

### 集計（ローカル日付）

- [x] `SPEC-DASH-010` tzOffset（分・東向き）を渡すと日次集計と from / to フィルタがシフト後のローカル日付で丸められる
- [x] `SPEC-DASH-011` tzOffset が整数でない・絶対値 840 超のとき対象 API は 400 を返す
- [x] `SPEC-DASH-012` /api/overview の byModel はモデル別の messages・5m/1h キャッシュ内訳を含み、cost.byModel と同じ正規化キーで突き合わせられる
- [x] `SPEC-DASH-013` /api/projects/:id の日次モデル別系列は日次推定コストを含む

### 統計 API

- [x] `SPEC-DASH-020` /api/stats/tools はツール別の呼出数と失敗数を返し、失敗数は tool_use と tool_result の id 突き合わせで数える
- [x] `SPEC-DASH-021` /api/stats/tools は from / to / tzOffset / project で絞り込める
- [x] `SPEC-DASH-022` /api/stats/tools は mcp__server__tool 形式をサーバ別に分解した内訳（呼出数・失敗数・ツール名一覧）を返す
- [x] `SPEC-DASH-023` /api/stats/tools はプロジェクト別のツール別呼出数・合計・失敗数を返す
- [x] `SPEC-DASH-024` /api/stats/agents は subagent / skill 別の起動回数と最終使用日時を返す
- [x] `SPEC-DASH-025` /api/stats/hooks は hook 発火履歴（時刻・hookName・hookEvent・プロジェクト・セッション）を新しい順に返し、limit 超過分は truncated: true で打ち切る

### 画面 — ルーティングとナビ

- [x] `SPEC-DASH-030` #/ は Overview、#/tools は Tools & Agents に対応し、左ナビの 2 項目で相互に遷移できる
- [x] `SPEC-DASH-031` 期間プリセット（今日 / 7日 / 30日 / 90日 / 月初来）は基準日からローカル日付の from / to を決定的に計算する

### 画面 — Overview

- [x] `SPEC-DASH-032` Overview は総コスト（「推定」明示）・総トークンのタイルとモデル別ドーナツ 2 つ（トークン / コスト）を表示する
- [x] `SPEC-DASH-033` Overview の日次チャートはトークン種別の積み上げとコスト折れ線を x 軸共有の上下 2 パネルで表示する（二軸グラフにしない）
- [x] `SPEC-DASH-034` 日次チャートの帯クリックで直下の一覧が該当日に絞り込まれ、チップの ✕ と帯の再クリックで解除でき、活動が無い日は「該当なし」を表示する
- [x] `SPEC-DASH-035` 未知モデルがあるとき警告バナーに件数と「コストに含まれていない」ことを表示し、無いときバナーを出さない
- [x] `SPEC-DASH-036` プロジェクト一覧は全件を並び替え（最終更新 / コスト / セッション数）付きで表示し、行クリックでプロジェクト画面へ遷移する
- [x] `SPEC-DASH-037` モデル別内訳テーブルは input / output / cache write（5m/1h 内訳）/ cache read / 推定コストを表示し、単価未登録モデルには警告バッジを付ける

### 画面 — プロジェクト画面

- [x] `SPEC-DASH-040` プロジェクト画面は日次モデル別積み上げ + コスト折れ線とセッション一覧を表示し、パンくずで Overview へ戻れる
- [x] `SPEC-DASH-041` モデルの色割り当てはドーナツと積み上げチャートで共通の固定割り当てになる

### 画面 — Tools & Agents

- [x] `SPEC-DASH-050` Tools & Agents はツール別ランキング・失敗率・プロジェクト別ツール利用・MCP サーバ別内訳・hook 発火履歴を表示する
- [x] `SPEC-DASH-051` エージェント定義（/api/config）と起動実績（/api/stats/agents）を突き合わせ、起動 0 の定義に未使用バッジを表示する
- [x] `SPEC-DASH-052` Skill 呼び出し履歴は呼出回数と最終使用日時を表示する

### 画面 — 全文検索（Issue #10）

- [x] `SPEC-DASH-060` Overview の検索ボックスで語を送ると /api/search のヒット一覧（プロジェクト・セッション・抜粋）を表示する
- [x] `SPEC-DASH-061` 検索ヒットのクリックでそのセッションのセッション分析画面へ遷移する
- [x] `SPEC-DASH-062` ヒット 0 件のとき「該当なし」を表示し、truncated のとき打ち切りを明示する

### E2E（Issue #10・tests/e2e）

- [x] `SPEC-DASH-070` Overview に総コスト（推定）・総トークン・プロジェクト一覧が合成ログの内容で描画される
- [x] `SPEC-DASH-071` Overview の検索から合成ログ内の語でヒットし、クリックでセッション分析画面へ遷移できる
- [x] `SPEC-DASH-072` Tools & Agents にツール別ランキングが描画される
- [x] `SPEC-DASH-073` 未知モデルを含む合成ログで Overview の警告バナーに件数が表示される

---

# ソース切替と Codex 統合（Issue #31）

基本仕様書は [docs/spec/DASH.md](../spec/DASH.md) の同名セクション。ライブ更新は [LIVE.md](LIVE.md) 側。

## データモデル

### ProjectEntry / DTO への source 露出

- `server/store.ts` の `ProjectEntry` に `sourceId: string` を追加する（グループは単一ソースから発見されるため 1 グループ 1 ソース。ソースをまたぐ併合はしない）
- API DTO に `source: string` を追加する: `ProjectListItem`・プロジェクト詳細のセッション行・`GET /api/sessions/:id` のレスポンス・検索ヒット行。`SessionEntry.sourceId` の「API に露出させない」という #28 の内部規約は本 Issue で改訂する（UI 識別が要件になったため）
- グループ ID の名前空間はソース間で分けない（#28 の決定を維持）。Codex のグループ ID は `YYYY-MM-DD`、Claude は `-` 縮約ディレクトリ名で形式が重ならず、`/api/projects/:id` の探索は従来どおり id 一致でよい。**形式が重なる新ソースを将来足すときはグループ ID にも接頭辞を導入する**（この判断をここに残す。→ #45 で Codex を cwd グルーピングに変えた際、この判断に従い `codex:` 接頭辞を導入した。docs/design/CODEX.md 参照）

### 範囲フィルタ後のレコード件数

- `ProjectListItem` とセッション行に `records: number`（from / to / tzOffset 適用後のレコード件数）を追加する
- 日付クリック絞り込みのクライアント側条件を `totalTokens > 0 || estimatedCost > 0` から **`records > 0`** に変える（`OverviewView.tsx` / `SessionListView.tsx`）。usage が構造的に 0 の Codex 行も、その日に活動があれば一覧に残る。その日にレコードが無い行は従来どおり落ちる

## API

エンドポイント表の正本は [API.md](API.md)。この Issue での変更:

- **`GET /api/sources` を新設**: 登録済みソースの一覧 `{ sources: [{ id, sessions }] }` を返す（`sessions` は発見済みセッション数。ルート不存在のソースは 0）。切替 UI の表示・disabled 判定に使う
- **`source` クエリを追加**: `/api/overview` `/api/projects` `/api/projects/:id` `/api/search` `/api/stats/tokens` `/api/stats/tools` `/api/stats/agents` `/api/stats/hooks` が `source=<id>` を受け、集計・一覧・検索の対象を指定ソースのグループに絞る。未指定は全ソース（後方互換）。登録に無いソース id は 400
- 絞り込みは `snapshot.projects` を `sourceId` でフィルタしてから既存集計へ流す共通ヘルパ（`server/http.ts` の `parseSource`）で行う。合計値・チャート・byModel・cost もフィルタ後レコードから計算されるため、見せかけの行隠しにならない

## 画面

- **切替 UI**: セグメント切替（全ソース / Claude / Codex・`lib/source.tsx` の `SourceSwitch`）を Overview と Tools & Agents の期間フィルタ横（`.filterrow` 内）に置く（2026-08-09 オーナー合意で左ナビから移動）。選択は App レベルの state（Context）で保持し（ハッシュ遷移で失われない）、URL には載せない。既定は全ソース。`/api/sources` で Codex のセッション数が 0 なら「Codex」を disabled にする（切替 UI 自体は常時表示。2026-08-09 オーナー合意）
- 各画面は選択ソースを API の `source` クエリへ渡して再取得する（クライアント側で行を隠さない）
- **ソースバッジ**: プロジェクト一覧・セッション一覧・検索ヒット・プロジェクト画面のヘッダに DTO の `source` に基づくバッジ（`claude` / `codex` の表示名）を付ける。全ソース表示時も付ける（絞り込み時だけ出すと見分けの用を成さないため）
- **グループの行ラベル**（#45 改定）: ソース不問で cwd 末尾の basename（path の無いグループは `id`）。cwd フルパスのサブテキスト表示は従来どおり残す（`OverviewView.tsx` の一覧行・`SessionListView.tsx` のヘッダ / パンくず）。#31 時点の「Codex は日付グループのため `id` をラベルにする」という分岐は、#45 の cwd グルーピングで不要になり廃止した
- Codex 行のコスト・トークン欄は 0 のとき「—（未集計）」表示にする（#30 で集計が入るまでの暫定。Claude 行の 0 は従来どおり数値表示）

## 受け入れ基準（Issue #31）

### API — ソース情報と絞り込み

- [x] `SPEC-DASH-080` GET /api/sources は登録済みソースの id と発見済みセッション数を返し、ルートが無いソースは 0 件として返す
- [x] `SPEC-DASH-081` GET /api/overview は source クエリで指定ソースだけの合計・モデル別・日次系列・プロジェクト一覧になり、未指定なら全ソース合算になる
- [x] `SPEC-DASH-082` /api/projects・/api/projects/:id・/api/search・/api/stats/* も source で絞り込め、未登録のソース id には 400 を返す
- [x] `SPEC-DASH-083` プロジェクト一覧・セッション一覧・検索ヒット・セッション要約の各 DTO に source が含まれる
- [x] `SPEC-DASH-084` プロジェクト一覧・セッション一覧の各行は範囲フィルタ後のレコード件数 records を含む

### 画面 — 切替と識別

- [x] `SPEC-DASH-085` ヘッダの切替（全ソース / Claude / Codex）で一覧・合計値・チャートが選択ソースだけの値になり、選択は画面遷移をまたいで保持される
- [x] `SPEC-DASH-086` Codex のセッションが 0 件のとき切替 UI は表示されたまま「Codex」の選択肢が disabled になる
- [x] `SPEC-DASH-087` 一覧・検索ヒットの行にソースバッジが付き、グループの行ラベルはソース不問で cwd 末尾の basename（path の無いグループはグループ ID）になる（#45 改定。旧: Codex は日付ラベル）
- [x] `SPEC-DASH-088` 日付クリック絞り込みは records > 0 を基準にし、usage 0 の Codex 行もその日に活動があれば一覧に残る
- [x] `SPEC-DASH-089` Codex 行のコスト・トークン欄は 0 円と断定せず未集計表示になる

### E2E（tests/e2e）

- [x] `SPEC-DASH-090` 切替で「Codex」を選ぶと Overview が Codex グループだけになり、「Claude」を選ぶと Codex グループが消えて従来値と一致する
- [x] `SPEC-DASH-091` Codex グループの行にソースバッジと cwd 末尾ラベルが描画される（#45 改定。旧: 日付ラベル）
- [x] `SPEC-DASH-092` 日付クリック絞り込みで usage 0 の Codex セッションが一覧に残る
- [x] `SPEC-DASH-093` Codex セッションが無い seed では「Codex」選択肢が disabled 表示になる

---

# worktree グルーピング表示（Issue #41）

基本仕様書は [docs/spec/DASH.md](../spec/DASH.md) の同名セクション。統合の判定・併合は [CORE.md](CORE.md) の「worktree セッションの本体統合」側（SPEC-CORE-080〜090）。

## データモデル・API

- `/api/projects/:id` のセッション行 DTO に `worktree: string | null` を追加する（`SessionEntry.worktree` をそのまま露出。本体・非統合セッションは null）。エンドポイントの追加・変更は無し
- プロジェクト一覧・Overview は併合済みの snapshot をそのまま集計するため変更不要（行数・合算はストア側で確定している）

## 画面（SessionListView）

- セッション一覧を `worktree` 値でグループ分けし、グループ見出し（「本体」/ worktree 名）と件数を表示する
- グループの並び: 本体が先頭、worktree はグループ内の最新 lastTimestamp の新しい順。グループ内の行順は従来どおり最終更新の新しい順
- 全セッションの `worktree` が null のプロジェクトでは見出しを描画せず、従来と同一の表になる（worktree を使わない利用者の画面は変わらない）
- 日付クリック絞り込み（`daySessions`）でも同じグループ分けを適用する（`records > 0` の絞り込みは従来どおり）

## 受け入れ基準（Issue #41）

### API

- [x] `SPEC-DASH-100` /api/projects/:id のセッション行に worktree（worktree 名・本体は null）が含まれる

### 画面

- [x] `SPEC-DASH-101` プロジェクト詳細のセッション一覧が「本体」と worktree 名のグループ見出しに分かれ、各グループに件数が表示される
- [x] `SPEC-DASH-102` グループは本体が先頭で worktree は最終更新の新しい順に並び、グループ内の行は最終更新の新しい順のまま
- [x] `SPEC-DASH-103` worktree セッションの無いプロジェクトではグループ見出しを描画しない
- [x] `SPEC-DASH-104` 日付クリック絞り込み中もグループ表示が保たれ、その日に活動のあるセッションだけが各グループに残る

### E2E（tests/e2e）

- [x] `SPEC-DASH-105` worktree セッションを含む seed で、Overview のプロジェクト一覧に worktree の行が現れず本体プロジェクトへ統合される
- [x] `SPEC-DASH-106` 統合されたプロジェクトの詳細で「本体」と worktree 名のグループが描画される

## 実測値（2026-08-09・Issue #31 実装時）

実ログで `/api/sources` が claude 27 / codex 21 セッションを返し、`source=codex` の
Overview は 11 グループ / 2,535 レコード / トークン・コスト 0（画面は「未集計」表示・
0 円と断定しない）。全ソース時の総コスト・総トークンは Claude のみ選択時と一致
（Codex の usage が構造的に 0 のため）。切替 UI・バッジ・日付ラベル・日別絞り込みは
実ログのレンダリングで確認。既知の制約: dailyOverview は usage 由来のため、Codex の
活動しか無い日はチャートに帯が出ない（#30 の usage 会計で解消される）。

## 実測値（2026-08-06・Issue #7 実装時）

実ログ（17 ファイル / 96.0 MB / 9,730 レコード）で、`GET /api/overview` の
totals.records・cost.total が同時点の `npm run report` と完全一致（9,730 / $1399.40）。
unknownModels は `<synthetic>` のみ（表示側で警告対象から除外・0 実績モデルは内訳に出さない）。
Tools & Agents は実ログからツールランキング・失敗率（is_error 突き合わせ）・MCP サーバ別内訳・
hook 発火履歴（PostToolUse / SessionStart 等）・エージェント定義 8 件 × 起動実績・
Skill 履歴（最終使用日時付き）を描画できることをレンダリングで確認。
日付クリック絞り込み（チップ・解除・該当なし）とドリルダウン遷移も実ログで動作確認済み。

---

# 同一プロジェクトの Claude / Codex 表示統合（Issue #49）

基本仕様書は [docs/spec/DASH.md](../spec/DASH.md) の同名セクション。store / API 層のマージ機構（`DisplayProject`・グループ id のソース中立化・部分表示の判定規則）は [CORE.md](CORE.md) の同名セクション（SPEC-CORE-091〜096）。

## API（DTO 変更）

- **`ProjectListItem.source: string` → `sources: string[]`**（SPEC-DASH-083 改定）。表示グループを構成するソース id の配列（entries の出現順 = ソース登録順。単一ソースは要素 1 の配列）。`/api/projects/:id` のトップレベル `source` も同様に `sources` へ変える。セッション行・検索ヒット・`GET /api/sessions/:id` の `source` は**単数のまま**（セッションは常に単一ソース）
- 統合行の集計は entries 全セッションの合算: `sessionCount` / `totalTokens` / `estimatedCost` / `records` / `lastTimestamp`（max）。`path` は rootPath を持つエントリを優先し、無ければ従来の最新セッション cwd 規則
- **`/api/projects/:id` に `bySource` を追加**: 範囲フィルタ後のソース別内訳。単一ソースのプロジェクトでも返す（形を条件分岐させない。UI 側で出し分ける）

```jsonc
{ "id": "...", "sources": ["claude", "codex"], "path": "...",
  "bySource": [{ "source": "claude", "sessions": 8, "records": 1200,
                 "totalTokens": 3400000, "estimatedCost": 12.3 }, ...],
  "daily": [...], "sessions": [...] }  // sessions は entries の連結（各行の source / worktree は従来どおり）
```

- 日次チャート系列（`daily`）は両ソース合算のモデル別のまま（Codex のモデルが同じ系列空間に混ざる。ソース別分割はしない）
- エンドポイント・クエリの追加は無し（[API.md](API.md) の表は変更なし）

## 画面

- **OverviewView（一覧行）**: `SourceBadge` を `sources` の全要素分並べる。未集計表示の条件を `p.source !== 'claude'` から **`!p.sources.includes('claude')`** に変える（統合行は claude を含むため数値表示になる。codex-only 行は従来どおり未集計表示）
- **SessionListView（詳細ヘッダ）**: バッジを `sources` 全要素分並べる。`sources.length > 1` のときだけヘッダ合計の下にソース別内訳（`bySource` のセッション数・トークン・コスト）を 1 行で表示する。単一ソースでは内訳を描画せず従来の見た目のまま
- セッション行・worktree グループ分け・日付クリック絞り込み（records > 0）は変更なし。ソース切替は既存の `source` クエリ連動のまま（部分表示の挙動はサーバ側 SPEC-CORE-093 で決まる）

## 既存 SPEC の改定（#49）

| ID | 改定内容 |
|---|---|
| `SPEC-DASH-081` / `SPEC-DASH-082` | 「指定ソースだけの合計・一覧になる」は維持。ただしグループの単位が表示グループになり、統合プロジェクトは行が残って値が選択ソース分になる（部分表示。SPEC-CORE-093） |
| `SPEC-DASH-083` | プロジェクト系 DTO の `source` → `sources: string[]`。セッション・検索ヒットは単数のまま。対応テストも書き換え |
| `SPEC-DASH-085` | 切替で「選択ソースだけの値になる」は維持。統合行が消えずに部分表示になる点を明記 |
| `SPEC-DASH-087` | 行ラベル規則は不変（ソース不問で basename）。バッジが複数になり得る点のみ |
| `SPEC-DASH-090` E2E | 「Claude を選ぶと Codex グループが消える」→「codex-only グループが消え、統合グループは Claude のみの値で残る」。対応テストも書き換え |
| `SPEC-CODEX-100〜105` | グループ id の `codex:` 接頭辞を廃止（CORE.md SPEC-CORE-091〜095 に改定内容を記載）。対応テストも書き換え |

## 受け入れ基準（Issue #49・API / 画面）

### API

- [x] `SPEC-DASH-110` プロジェクト一覧の統合行は 1 行になり、sources に両ソースを含み、セッション数・トークン・コスト・records・lastTimestamp が両ソースの合算になる（path は本体ルート）
- [x] `SPEC-DASH-111` /api/projects/:id は統合 id で両ソースのセッションを返し、範囲フィルタ後のソース別内訳 bySource を含む
- [x] `SPEC-DASH-112` source クエリ指定時、統合プロジェクトの詳細は選択ソースのセッション・集計だけになり、id・URL は統合 id のまま変わらない

### 画面

- [x] `SPEC-DASH-113` 統合行にはソースバッジが複数表示され、未集計表示は sources に claude を含まない行だけに出る
- [x] `SPEC-DASH-114` プロジェクト詳細のヘッダは複数ソースのときだけソース別内訳（セッション数・トークン・コスト）を表示し、単一ソースでは従来の見た目のまま

### E2E（tests/e2e）

- [x] `SPEC-DASH-115` 同一 cwd の claude / codex seed でプロジェクト一覧が 1 行になり、両ソースバッジと合算値が描画される
- [x] `SPEC-DASH-116` ソース切替で統合行が残って値が選択ソース分になり、`codex:` 付き旧プロジェクト URL は 404 になる

## 実測（#49・2026-08-11）

- 実ログ（claude 38 / codex 24 セッション）でプロジェクト一覧が 22 行になり、統合行は 2 件
  （agent_viewer: claude 30 + codex 2 の 32 セッション、Game: claude + codex）。`codex:` 接頭辞の id は一覧に 0 件
- 統合プロジェクト詳細の bySource: claude 30 セッション / 11,908 records、codex 2 セッション / 75 records。
  sessions 配列の合計（32）と一致
- ソース切替の部分表示: codex 選択で統合行が sources=['codex']・2 セッションになり（16 行）、
  claude 選択で 30 セッション（8 行）。`codex:` 付き旧 URL は 404・統合 id の URL は 200
- verify 全 pass（unit 341 / E2E 29）・report 照合 OK・spec:check 乖離なし（claude 集計は前後不変）

---

# セッション一覧の compaction 回数列（Issue #52）

基本仕様は [docs/spec/DASH.md](../spec/DASH.md) の同名セクション。セッション分析画面側（マーカー・区切り線）は [docs/design/CHAT.md](CHAT.md)。

## データモデル・実装方針

- `SessionSummary` に `compactionCount: number` を追加する。`server/core/summary.ts` の `addToSummary` で `kind === 'system' && subtype === 'compact_boundary'` のレコードを数える（順序非依存の加算のみ → 増分更新で全再構築と一致する既存性質 SPEC-CORE-046 に乗る）
- 集計はソース中立（Codex 正規化は compact_boundary を生成しないため常に 0）。**Codex の「—」表示はサーバではなく画面側で `source !== 'claude'` により行う**（0 と集計不能の区別は表示の関心事。DTO に Codex 分岐を持ち込まない）
- **キャッシュ互換**: summary はキャッシュに保存されるため、旧キャッシュは compactionCount を持たない。増分更新では過去分を数え直せないため `INDEX_SCHEMA_VERSION` を **6** に繰り上げて全再構築させる
- API: `GET /api/projects/:id` の sessions 要素（`SessionListItem`）に `compactionCount: number` を追加する（エンドポイント追加ではないため apiDrift 対象外）。範囲フィルタの影響を受けない要約値（recordCount 等と同じ扱い）
- 画面: `SessionListView` のテーブルに「compaction」列を「コスト推定」の次に追加する。claude ソースは 0 を含む数値、それ以外のソースは「—」。worktree グループ見出し・空メッセージの colSpan を 6 → 7 に更新する

## 受け入れ基準

- [x] `SPEC-DASH-120` SessionSummary の compactionCount は compact_boundary レコード数を数え、無いセッションでは 0 になる
- [x] `SPEC-DASH-121` INDEX_SCHEMA_VERSION の繰り上げ（6）により compactionCount の無い旧キャッシュは全再構築される
- [x] `SPEC-DASH-122` GET /api/projects/:id の sessions 要素に compactionCount が含まれる
- [x] `SPEC-DASH-123` セッション一覧の「コスト推定」の次に compaction 列が表示され、claude セッションは 0 を含む回数、claude 以外のソースは「—」になる

### E2E（tests/e2e）

- [x] `SPEC-DASH-124` compact_boundary を含む seed でセッション一覧に回数が表示され、セッション分析画面の ⚡ マーカー・通し番号付き区切り線の本数と一致する
