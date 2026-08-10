# SPEC-LIVE — ファイル監視とライブ更新（詳細設計書）

担当 Issue: #8（初版）→ #31（Codex ライブ更新。末尾のセクション）。人間向けの基本仕様書は [docs/spec/LIVE.md](../spec/LIVE.md)。

## 実装方針

`chokidar` で `logDir` 配下の `*.jsonl` を監視 → 変更検知 → SPEC-CORE の増分解析（`buildIndex` の incremental 戦略）→ **SSE（Server-Sent Events）** で差分を push → クライアントは開いているセッションだけを更新する。

伝送方式は Issue 本文の WebSocket から SSE へ変更した（要件合意時の決定・Issue #8 コメント参照）。片方向 push のみなので双方向接続は不要で、SSE なら通常の Express ルートとして実装でき（apiDrift 突き合わせに乗る）、再接続と追い付きをブラウザ標準 `EventSource` の自動再接続 + `Last-Event-ID` で賄える。

### 構成

```
server/
  live.ts           # LiveHub: 購読管理・デバウンス・差分計算・chokidar 監視（transport 非依存）
  routes/live.ts    # GET /api/live（SSE の書式化と接続ライフサイクルだけの薄い層）
web/src/lib/
  live.ts           # EventSource ラッパ（接続状態・append / reset のコールバック）
web/src/views/SessionView.tsx   # 統合（末尾追記・ヘッダ更新・ライブ状態表示）
```

### サーバ（LiveHub）

- `createLiveHub({ logDir, cacheDir, loadTable })` で生成し、`AppOptions.hub` として `createApp` へ注入する（省略時は createApp が内部生成）。テストは自前で生成して `close()` で chokidar を確実に破棄する
- **監視**: chokidar は `logDir` を `ignoreInitial: true` で監視し、`add` / `change` の `*.jsonl` のみ扱う。新規ファイルも自動で対象に入る。watcher は最初の購読者が現れたときに開始する（購読者ゼロの間はファイル変更があっても何もしないため、挙動は常時監視と等価）
- **セッション対応付け**: sessionId はファイル名から拡張子を除いたもの（store.ts と同じ規約）。変更されたファイルのセッションに購読者がいなければ**解析せずに捨てる**（開いていない画面のために重い解析をしない）
- **デバウンス**: 同一ファイルの連続イベントは約 150ms まとめて 1 回の解析・配信にする
- **差分計算**: `buildIndex()`（キャッシュ経由の増分解析）で最新レコード列を取得し、購読者ごとの既知件数 `have` より後ろ `records.slice(have)` を配信する。`records.length < have`（縮小→全再構築）なら `reset` を配信する
- **耐障害**: 解析・読み取りの例外は捕捉してその回の配信をスキップし、監視と接続は維持する。watcher の `error` イベントも同様に無視して継続する

### SSE プロトコル（GET /api/live）

- クエリ: `session`（必須・セッション id）、`have`（クライアントが保持済みのレコード件数。省略時 0）
- 存在しない session id は SSE を開始する前に 404 を返す
- レスポンスは `Content-Type: text/event-stream`。接続直後、`have` より新しいレコードがあれば即座に追い付き分を配信する
- イベント `id:` には配信後の総レコード件数を入れる。EventSource の自動再接続が送る `Last-Event-ID` ヘッダを `have` クエリより優先し、切断中の取りこぼしを再接続時に追い付き配信する
- 約 25 秒間隔でコメント行（`: ping`）を書き、プロキシ等のアイドル切断を防ぐ

| イベント | data | 意味 |
|---|---|---|
| `append` | `{ start, messages, summary, cost }` | `start` 番目以降に `messages` を追記。`summary` / `cost` は更新後の全量 |
| `reset` | `{}` | 全再構築が起きた。クライアントはセッション詳細を取得し直す |

`messages` の要素は `GET /api/sessions/:id` の `messages` と同形（`{ index, ...IndexRecord, cost? }`。assistant にはメッセージ単位の推定コスト付き）。`summary` / `cost` も同エンドポイントの同名フィールドと同形とし、クライアントに差分適用ロジック以外の新しい型を持ち込まない。

### クライアント

- `web/src/lib/live.ts`: `openLive({ sessionId, have, onAppend, onReset, onStatus, eventSourceCtor? })`。`eventSourceCtor` はテストで差し替えるためのコンストラクタ注入（jsdom に EventSource が無いため）。`onStatus` は `'connected' | 'disconnected'` を通知する。再接続は EventSource 標準に任せ、自前のリトライは実装しない
- `SessionView`: 詳細取得後に接続し、`append` で `detail.messages` へ追記・`summary` / `cost` を差し替える。`reset` で `api.session()` を取得し直す。切替・アンマウント時は接続を閉じる
- `bodystore`: 総件数が増えたとき、取得済みの完全ページは保持し、**末尾の部分ページだけをキャッシュから落として**再取得できるようにする（`grow(newTotal)` を追加）
- ライブ状態はヘッダのバッジで表示する（接続中 / 切断）

### 依存の追加

`chokidar` を dependencies に追加する。`ws` は使わない。

## 実測（Issue #8 時点・進行中の実セッションで確認）

| 指標 | 値 |
|---|---|
| 対象 | 進行中セッション 約 1.0 MB・287 レコード時点 |
| 接続時の追い付き配信（have=285） | 即時（`start: 285` の append・id 287） |
| 追記検知 → append 到着 | 数秒以内に id 287 → 289 → 292 と連鎖（start にギャップ・重複なし） |
| 画面反映（リロードなし） | ヘッダが 20.7M → 21.7M tok、$38.57 → $39.72 に自動追従。「● ライブ」バッジ点灯 |

## 受け入れ基準

### 監視と増分解析（server/live.ts）

- [x] `SPEC-LIVE-001` JSONL への追記を検知し、増分解析で追記分のレコードだけを配信する
- [x] `SPEC-LIVE-002` 監視開始後に新しく作成された JSONL ファイルも自動で監視対象に入る
- [x] `SPEC-LIVE-003` 監視対象の解析でエラーが起きても落ちず、以後の変更検知を継続する
- [x] `SPEC-LIVE-004` 同一ファイルへの短時間の連続追記は 1 回の解析・配信にまとめる
- [x] `SPEC-LIVE-005` 購読者がいないセッションのファイル変更では解析を行わない

### SSE 配信（GET /api/live）

- [x] `SPEC-LIVE-010` GET /api/live は text/event-stream で応答し、session で指定したセッションの変更だけを配信する
- [x] `SPEC-LIVE-011` append イベントは追加メッセージ（メッセージ単位コスト付き）と更新後の summary / cost を含み、id は総レコード件数になる
- [x] `SPEC-LIVE-012` 接続時に have より新しいレコードがあれば直ちに追い付き分を配信する
- [x] `SPEC-LIVE-013` Last-Event-ID ヘッダは have クエリより優先され、再接続時の追い付き起点になる
- [x] `SPEC-LIVE-014` 全再構築でレコード件数が減ったら reset イベントを配信する
- [x] `SPEC-LIVE-015` 存在しない session id には SSE を開始せず 404 と JSON エラーを返す
- [x] `SPEC-LIVE-016` クライアントの切断で購読が解除され、以後の変更が残った接続にだけ配信される

### クライアント（web/src/lib/live.ts・SessionView）

- [x] `SPEC-LIVE-020` append イベントで会話の末尾に新しいメッセージ行が追加される
- [x] `SPEC-LIVE-021` append イベントでヘッダの総トークン・推定コストが更新される
- [x] `SPEC-LIVE-022` ライブ状態（接続中 / 切断）が表示され、接続の開閉に追従する
- [x] `SPEC-LIVE-023` reset イベントでセッション詳細を取得し直す
- [x] `SPEC-LIVE-024` 総件数が増えたとき取得済みの完全ページは保持し、末尾の部分ページだけ再取得する

### E2E（Issue #10・tests/e2e）

- [x] `SPEC-LIVE-030` セッション分析画面を開いた状態で JSONL に追記すると、リロードなしで新しいメッセージが会話の末尾に現れる
- [x] `SPEC-LIVE-031` 追記に合わせてヘッダの総トークンが増える
- [x] `SPEC-LIVE-032` 別セッションを開いた状態では、他セッションへの追記で表示中の会話が変わらない

---

# Codex ライブ更新（Issue #31）

基本仕様書は [docs/spec/LIVE.md](../spec/LIVE.md) の同名セクション。#8 実装の 3 つの Claude 前提を解く。

## 現状の問題（#31 着手時の実測）

1. **監視ルートが Claude のみ**: `createLiveHub` は `logDir`（`~/.claude/projects`）しか監視しない。`~/.codex/sessions` を見る仕組みが無い
2. **セッション ID の不一致**: `live.ts` の `sessionIdOf` は `basename(filePath, '.jsonl')` を返すが、Codex の公開 ID は `codex:<basename>`（SPEC-CORE-073）。watcher を足しても購読者と照合できない
3. **キャッシュ汚染**: SessionView は Codex セッションでも無条件に SSE 購読し、hub の `refresh()` が `buildIndex` を **source 未指定**（= Claude 相当のステートレス正規化）で呼ぶ。購読直後の追い付き配信で Codex rollout が Claude パーサで再解析され、壊れたインデックスがキャッシュを上書きする。以後 size / mtime 不変なら reuse され続ける（**現在の main で実際に起きる不具合**）

## 実装方針

### hub の複数ソース監視（1・2 の解決）

- `createLiveHub` の入力を `{ roots: Array<{ source: LogSource; dir: string }>, cacheDir, loadTable }` に変える。`createApp` は Claude の `logDir` と Codex の `sessionsDir` を登録する（Codex 未設定のテストは従来どおり Claude のみ）
- chokidar は全 root をまとめて監視する。`add` / `change` の `*.jsonl` を、パスがどの root 配下かで所属ソースに解決する。**新規日付ディレクトリ配下の新規 rollout も既存の再帰監視（`add` イベント）で自動的に対象へ入る**（#8 の SPEC-LIVE-002 と同じ機構。ディレクトリ単位の特別扱いは実装しない）
- `LogSource` に `sessionIdFor(filePath: string): string | null` を追加し、公開 ID の規約（claude = basename、それ以外 = `<source>:<basename>`）を各ソースに置く。`live.ts` の `sessionIdOf` はこれを呼ぶ（ID 規約の重複定義をなくす）。Codex ソースは `rollout-*.jsonl` 命名に一致しないファイルに null を返し、監視対象から除く（発見規約と同一）

### stat ポーリングの保証層（実装中の実測で追加）

macOS の fsevents（chokidar）は**新規ディレクトリ連鎖の直後、その配下のイベントを永続的に取りこぼすことがある**（#31 実測: 6 回中 3 回、後続の追記の change も一切届かない）。新規日付ディレクトリの初回セッションでライブ更新が無言で死ぬ実害になるため、watcher に加えて**購読中ファイル限定の stat ポーリング**（`pollMs` 既定 1000ms）を保証層として置く。

- 対象は購読中のファイルだけ（stat のコストのみ。SPEC-LIVE-005「購読の無いセッションを解析しない」と両立）
- 基準値は**購読時点**で観測する（初回 tick を基準にするとファイル作成そのものを変化として検知できない）
- refresh 成功時に配信済み状態を基準へ反映し、watcher が先に拾った成長をポーリングが二重解析しない
- 購読者ゼロになってもタイマーは残るが、tick は購読リストが空なら何もしない（unref 済みでプロセス終了は妨げない）
- 導入後の実測（新規日付ディレクトリ + 新規 rollout + 追記、pollMs 100）: 8/8 回で配信成立。初回検知 52〜156ms・追記追随 50〜103ms（watcher が生きている回は watcher が先に拾い、取りこぼし回はポーリングが拾う）

### refresh のソース正規化とキャッシュの自己修復（3 の解決）

- hub の `refresh()` は解決した所属ソースを `buildIndex(filePath, { cacheDir, source })` に渡す（store.ts と同じ呼び方に揃える）
- **インデックスキャッシュに `source: string` を記録する**（`IndexCacheFile` へ追加。`INDEX_SCHEMA_VERSION` は変えない）。`decideStrategy` は「キャッシュの source と期待ソースの不一致」を rebuild 条件に加える。**source 未記載のキャッシュは 'claude' とみなす** — これにより:
  - 既存の正常な Claude キャッシュは再構築されない（未記載 = claude = 一致）
  - Claude パーサで書かれた汚染キャッシュ（未記載）は、Codex ソースで読んだ瞬間に不一致 → rebuild され自動修復される（#29 で正しく書かれた Codex キャッシュも未記載のため 1 回だけ再構築されるが、正しい内容で書き直されるだけで害はない）

## 受け入れ基準（Issue #31）

### 監視とソース解決（server/live.ts・server/sources）

- [x] `SPEC-LIVE-040` Codex rollout への追記を検知し、`codex:` 接頭辞の公開 ID で購読者と照合して append を配信する
- [x] `SPEC-LIVE-041` 監視開始後に新しく作られた日付ディレクトリ配下の新規 rollout も自動で監視対象に入る
- [x] `SPEC-LIVE-042` ライブ更新の再解析は所属ソースの正規化で行われ、Codex セッションを購読しても Claude パーサで再解析されない
- [x] `SPEC-LIVE-043` インデックスキャッシュは書き込んだソースを記録し、期待ソースと不一致のキャッシュ（source 未記載の非 claude を含む）は再利用されず全再構築される

### E2E（tests/e2e）

- [x] `SPEC-LIVE-050` Codex 合成 rollout のセッション分析画面を開いた状態で追記すると、リロードなしで新しいメッセージが末尾に現れる
- [x] `SPEC-LIVE-051` 別セッションを開いた状態では、Codex rollout への追記で表示中の会話が変わらない
