# SPEC-CORE — JSONL パーサとインデクサ（詳細設計書）

担当 Issue: #2（パーサ・インデクサ）/ #4（実測値照合レポート）/ #28（ログソース抽象化とセッション発見）。人間向けの基本仕様書は [docs/spec/CORE.md](../spec/CORE.md)。

## 設計上の制約

- **1 行 = 1 レコードを byte offset 付きで走査する。** インデックスに保持するのは軽量メタ（offset, length, type, kind, uuid, parentUuid, timestamp, model, usage, tool_use 名, 本文プレビュー 200 字）のみ。全文はメモリに載せず、詳細表示時に offset で seek して該当行だけ読む。
- **キャッシュ**: `.cache/index-<hash(path)>.json` に `{schemaVersion, filePath, fileSize, mtimeMs, lastOffset, records, summary}` を保存。
- **増分更新**: JSONL は追記のみなので `fileSize > lastOffset` なら差分だけ解析。ファイル縮小・mtime 逆行を検知したら全再構築。
- **壊れた JSON 行はスキップして継続する**（1 行の破損で全体を落とさない）。
- **末尾の未完了行は確定させない。** 改行で終わっていない行は書き込み途中とみなして `lastOffset` に含めない。確定させると次回の増分更新で同じ行が二重に現れる。

## ログソース抽象とセッション発見（Issue #28）

### データモデル

`server/sources/types.ts` に置く。

```ts
/** 発見された 1 セッション。ファイルの中身はまだ読んでいない（発見はパスと命名だけで成立させる）。 */
interface DiscoveredSession {
  /** API に露出する公開 ID。既定ソース（claude）は basename のまま、それ以外は `<source>:<basename>`。 */
  sessionId: string;
  filePath: string;
}

/** グループ（プロジェクト相当）。空グループも表現できる入れ子構造にする（下記の旧挙動保存）。 */
interface DiscoveredGroup {
  /** claude はディレクトリ名、codex は日付 `YYYY-MM-DD`（暫定・#31 で見直し可）。 */
  groupId: string;
  sessions: DiscoveredSession[];
}

interface LogSource {
  /** ソース識別子（'claude' / 'codex'）。ID 接頭辞の名前空間に使う。 */
  id: string;
  /** ルート配下を走査してグループとセッションを返す。ルートが無ければ空配列（エラーにしない）。 */
  discoverGroups(): Promise<DiscoveredGroup[]>;
}
```

返り値をフラットなセッション一覧ではなく**グループ単位**にしているのは、`.jsonl` を 1 件も
含まないプロジェクトディレクトリ（旧 loadSnapshot はセッション 0 件のプロジェクトとして
API に返していた。実ログに 4 件実在）を表現するため。フラットな一覧では空グループの
存在情報が落ち、`/api/projects` の結果が変わってしまう。

### 実装方針

- `server/sources/claude.ts`: 現在 `store.ts` にある走査（logDir 直下ディレクトリ = プロジェクト、配下再帰の `*.jsonl` = セッション）をそのまま移す。**公開 ID・グループ ID・並び順・空プロジェクトの扱いを含め従来と同一**（既存テスト不変が受け入れの根拠）
- `server/sources/codex.ts`: `sessionsDir`（本番 `~/.codex/sessions`）配下の `YYYY/MM/DD` 日付階層を再帰探索し、`rollout-*.jsonl` 命名に一致するファイルだけをセッションとする。グループは rollout を含む日付のみ（空の日付ディレクトリはグループにしない）。`session_index.jsonl` は読まない（rollout 単独で発見が成立する）。ファイル名の timestamp / UUID の**解釈はしない**（basename をそのまま ID に使う。パースが必要になるのは #29 以降）
- `server/store.ts`: `loadSnapshot({ sources, cacheDir })` へ変更し、ソース一覧を反復して `buildIndex` を呼ぶだけにする（配置規約の知識を持たない）。`SessionEntry` に `sourceId` を追加する（内部フィールド。API DTO には露出させない）
- `server/app.ts`: `AppOptions` は変更しない。`logDir` から Claude ソースを構築して渡す。**#28 では Codex ソースを登録しない**（正規化の無い状態で登録すると全行 unknown のセッションが集計に漏れるため。#29 で登録する）
- インデックス処理（`buildIndex`）は現状 Claude 固有の normalize を内蔵している。#29 でソースごとの normalize を差し込むとき、この `LogSource` にインデックス構築のフックを追加する（#28 では発見の抽象までとし、先回りのインターフェースを作らない）
- キャッシュパスは既に `hash(絶対パス)` で命名しているため、ソース間で衝突しない（追加対応は不要）
- `server/live.ts` の `sessionIdOf`（basename 規約の複製）は #28 では変更しない（監視対象が Claude logDir のみのため）。複数ルート監視と合わせて #31 で ID 導出をソース抽象へ寄せる
- `scripts/report.ts` は独自走査の Claude 専用ツールであり、変更しない

### テスト方針

発見のテストは一時ディレクトリに実命名規約（`rollout-<ISO日時（ハイフン区切り）>-<UUIDv7>.jsonl`）どおりのツリーを組み立てて検証する（`tests/fixtures/codex/` の内容フィクスチャは中身の契約用であり、発見テストには使わない）。

## worktree セッションの本体統合（Issue #41）

基本仕様書は [docs/spec/CORE.md](../spec/CORE.md) の同名セクション。画面のグルーピング表示は [DASH.md](DASH.md) 側。

### データモデル

```ts
// server/core/worktree.ts（新設）
/** cwd から git の正式な仕組みで本体リポジトリを解決した結果。 */
interface RepoResolution {
  /** 本体リポジトリのルート絶対パス。 */
  root: string;
  /**
   * 統合時に使う worktree ラベル。実在する worktree なら worktree ルートのディレクトリ名、
   * cwd 消失後の解決なら basename(cwd)。null は「cwd が本体リポジトリ内にある（統合不要）」。
   */
  worktree: string | null;
}
/** 解決不能（.git が見つからない）なら null。fs アクセスは stat / 小ファイル read のみ。 */
function resolveRepo(cwd: string): Promise<RepoResolution | null>;
```

- `server/store.ts` の `ProjectEntry` に `rootPath?: string` を追加する（併合で確定した本体ルート。`projectPath()` は `rootPath` があればそれを優先する。無ければ従来どおり最新セッションの cwd — worktree セッションが最新のとき表示パスが worktree 側へ揺れるのを防ぐ）
- `SessionEntry` に `worktree: string | null` を追加する（worktree ラベル。本体・非統合セッションは null。API DTO への露出は DASH 側）

### 解決アルゴリズム

1. **cwd が実在する場合**: cwd から親へ向かって最初の `.git` を探す
   - `.git` が**ファイル** → worktree。`gitdir: <管理dir>` を読み、`<管理dir>/commondir`（相対パスは管理 dir 基準で解決）が指す共通 `.git` の親を本体ルートとする。worktree ルートは `.git` ファイルを含むディレクトリ
   - `.git` が**ディレクトリ** → 通常リポジトリ。統合対象にしない（`worktreeRoot: null`。リポジトリ内サブディレクトリ起動のセッションを本体へ寄せる挙動変更はしない）
2. **cwd が実在しない場合**（worktree 削除後）: 実在する最も近い祖先ディレクトリから親へ向かって `.git`（ファイル / ディレクトリ）を探す。見つかったリポジトリのルートを本体とし、worktree ラベルは `basename(cwd)` とする（worktree ルートはもう存在せず特定できないため）。この規則により、**削除済みのリポジトリ内サブディレクトリも本体へ統合される**（ディレクトリが消えた以上そのリポジトリの作業として扱うのが自然、という判断をここに残す）
3. どちらでも `.git` に到達しなければ解決不能（null）。従来どおり単独プロジェクトのまま

### 併合（loadSnapshot の後段）

- 併合は **claude ソースのグループのみ**対象（Codex は日付グループで cwd ベースでないため対象外）
- 発見・インデックス化の後、プロジェクトごとに代表 cwd（最新セッションの `summary.cwd`）で `resolveRepo` を呼ぶ（同一プロジェクト内のセッションは同じ起動 cwd を共有するため代表 1 回で足りる。cwd ごとにメモ化）
- `worktreeRoot` が得られたプロジェクトを、本体ルートが代表 cwd と一致するプロジェクト（= 本体）へ併合する。併合後の id は**本体プロジェクトの従来 id**。本体プロジェクトが存在しない場合は、本体ルートの `[^A-Za-z0-9]` を `-` に置換した同形式の id を合成する
- 併合したセッションの `projectId` は併合先 id に書き換え、`sessionsById` も併合後の値で引けるようにする。旧 worktree グループの id は projects 一覧から消える（`/api/projects/:id` は既存の 404 挙動に落ちる）
- worktree ラベル: 実在時は `basename(worktreeRoot)`、削除後は `basename(cwd)`。本体セッションは null
- 解決は毎リクエスト（loadSnapshot ごと）に行う。コストは claude プロジェクト数 × 祖先段数の stat / 小 read のみで、キャッシュ・スキーマ変更は不要（正しさを永続状態に依存させない）

### テスト方針

- 一時ディレクトリに worktree の実構造（`.git` ファイル + `gitdir:` 行、管理 dir の `commondir`）を**手組み**して検証する（実 `git worktree` コマンドに依存しない）
- worktree 削除後のケースはディレクトリを作らない（または消す）ことで再現する
- フィクスチャの cwd は合成パスのみ（public リポジトリのため実パスを書かない）

### 実測値（2026-08-11・Issue #41 実装時）

実ログで claude プロジェクトが 24 → 21 件（worktree 3 グループが本体へ統合）。本体プロジェクトは
5 → 25 セッション（本体 5 + worktree 17/2/1 の合算と一致）。表示パスは本体ルートのまま。
`/api/overview` の records / sessions / cost 合計は統合前後で完全一致（統合は見せ方のみの変更）。
`npm run report` も照合 OK。

## 実測（Issue #2 時点）

| 指標 | 値 |
|---|---|
| 対象 | 15 ファイル / 131.9 MB |
| 初回構築（全 15 本） | 434 ms |
| 無変更時の再構築（全 reuse） | 84 ms |
| 最大ファイル 69.1 MB 単体 | 89 ms / RSS 増分 45.7 MB |
| インデックス件数 | 11,003 件（未知 type 0 / 破損行 0） |
| キャッシュ総サイズ | 5.8 MB（元データの 4.4%） |

破損行・未知 type は実ログには現れないため、耐性の検証は合成フィクスチャ（`tests/fixtures/session-sample.jsonl`）でのみ可能である。

## 受け入れ基準

### 走査とオフセット

- [x] `SPEC-CORE-001` JSONL を 1 行 = 1 レコードとして byte offset と byte 長を付けて走査する
- [x] `SPEC-CORE-002` 記録した offset / length で該当行のみを seek して読み出せる
- [x] `SPEC-CORE-003` 50KB を超える巨大行も打ち切らずに 1 レコードとして扱う
- [x] `SPEC-CORE-004` 壊れた JSON 行はスキップして走査を継続し、skippedLineCount に数える
- [x] `SPEC-CORE-005` 改行で終わっていない末尾行は未完了として扱い、走査結果にも lastOffset にも含めない
- [x] `SPEC-CORE-006` インデックスが保持する本文プレビューは 200 字までに切り詰める

### レコード正規化

- [x] `SPEC-CORE-010` assistant から model / requestId / isSidechain を取り出す
- [x] `SPEC-CORE-011` assistant の content から thinking / text / tool_use を判別し、tool_use は id と name を保持する
- [x] `SPEC-CORE-012` usage の cache_creation を 5m / 1h に分けて保持する
- [x] `SPEC-CORE-013` usage の server_tool_use から web_search / web_fetch 回数を取り出す
- [x] `SPEC-CORE-014` model が `<synthetic>` の行は synthetic フラグを立てて集計と区別する
- [x] `SPEC-CORE-015` user の content が string / 配列のいずれでもプレビューを生成する
- [x] `SPEC-CORE-016` user の tool_result は対応する tool_use_id を保持する
- [x] `SPEC-CORE-017` system は subtype と durationMs を保持する
- [x] `SPEC-CORE-018` attachment は attachment.type を保持する
- [x] `SPEC-CORE-019` pr-link は prNumber / prRepository / prUrl を保持する
- [x] `SPEC-CORE-020` mode / permission-mode は mode 値を保持する
- [x] `SPEC-CORE-021` ai-title / custom-title を title として保持し、種別（ai / custom）を区別する
- [x] `SPEC-CORE-022` file-history-snapshot / queue-operation は初期スコープ外としてスキップする
- [x] `SPEC-CORE-023` 未知の type も unknown 分類で保持し、レコードを捨てない
- [x] `SPEC-CORE-024` Agent tool_use の input.subagent_type をサブエージェント起動として抽出する
- [x] `SPEC-CORE-025` Skill tool_use の input.skill と assistant の attributionSkill を skill 利用として抽出する
- [x] `SPEC-CORE-026` usage の speed / service_tier を保持する（fast mode は単価が異なるため SPEC-COST が参照する）

### セッション要約

- [x] `SPEC-CORE-030` model 別に input / output / cacheRead / cacheCreation トークンを合計する
- [x] `SPEC-CORE-031` tool_use 名ごとの呼び出し回数を集計する
- [x] `SPEC-CORE-032` 最初と最後の timestamp、assistant / user のメッセージ件数を集計する
- [x] `SPEC-CORE-033` セッションのタイトルは customTitle を aiTitle より優先する

### キャッシュと増分更新

- [x] `SPEC-CORE-040` `.cache/index-<hash>.json` に schemaVersion / fileSize / mtimeMs / lastOffset / records / summary を保存する
- [x] `SPEC-CORE-041` fileSize と mtimeMs が一致するキャッシュは再解析せず再利用する
- [x] `SPEC-CORE-042` fileSize > lastOffset のときは差分バイトのみを解析して追記する
- [x] `SPEC-CORE-043` キャッシュに記録した fileSize より小さくなる縮小を検知したら全再構築する
- [x] `SPEC-CORE-044` mtimeMs がキャッシュより過去へ逆行したら全再構築する
- [x] `SPEC-CORE-045` schemaVersion が現行と異なるキャッシュは破棄して全再構築する
- [x] `SPEC-CORE-046` 増分更新後のインデックスは同一ファイルを全再構築した結果と一致する

### ログソース抽象とセッション発見（Issue #28）

- [x] `SPEC-CORE-070` loadSnapshot はログソース一覧を受け取り、配置規約を知らずにソースが発見したセッションだけをインデックス化する
- [x] `SPEC-CORE-071` Claude ソースは logDir 直下のディレクトリをグループ、配下再帰の *.jsonl をセッションとして従来の loadSnapshot と同一の一覧を返す
- [x] `SPEC-CORE-072` Claude ソースの公開セッション ID は接頭辞なしの basename のまま変わらない
- [x] `SPEC-CORE-073` Claude 以外のソースの公開セッション ID は `<source>:<basename>` 形式になり、同名ファイルがあってもソース間で衝突しない
- [x] `SPEC-CORE-074` Codex ソースは sessions 配下の YYYY/MM/DD 日付階層を再帰探索し、rollout-*.jsonl を日付 `YYYY-MM-DD` のグループでセッションとして発見する
- [x] `SPEC-CORE-075` Codex ソースは session_index.jsonl を読まず、rollout ファイル単独でセッションを発見する
- [x] `SPEC-CORE-076` rollout 命名に一致しないファイルと .jsonl 以外の拡張子は発見対象にしない
- [x] `SPEC-CORE-077` ルートディレクトリが存在しないソースは空一覧を返し、エラーにしない
- [x] `SPEC-CORE-078` アプリ構成には Claude ソースのみ登録され、既存 API レスポンスと集計値が変わらない
- [x] `SPEC-CORE-079` .jsonl を含まないプロジェクトディレクトリも空グループとして返し、従来どおりセッション 0 件のプロジェクトとして API に現れる

### worktree セッションの本体統合（Issue #41）

- [x] `SPEC-CORE-080` cwd から親へ辿った最初の `.git` がファイルのとき、gitdir と commondir を解決して本体リポジトリのルートと worktree ルートを得る
- [x] `SPEC-CORE-081` commondir の相対パスは管理ディレクトリ基準で解決する
- [x] `SPEC-CORE-082` cwd が実在しないとき、実在する最も近い祖先から親へ `.git` を探して本体ルートを得る
- [x] `SPEC-CORE-083` `.git` がディレクトリ（通常リポジトリ）の cwd は統合対象にしない
- [x] `SPEC-CORE-084` どの祖先にも `.git` が無い cwd は解決不能として null を返し、プロジェクトは従来のまま単独で残る
- [x] `SPEC-CORE-085` 本体ルートが同じ claude プロジェクトは 1 つに併合され、id は本体プロジェクトの従来 id になる
- [x] `SPEC-CORE-086` 本体プロジェクトが存在しない場合は本体ルートから同形式の id（非英数字を `-` に置換）を合成して併合する
- [x] `SPEC-CORE-087` 併合後のセッションは projectId が併合先になり、worktree ラベル（実在時は worktree ルート名・削除後は cwd 名）を持ち、本体セッションは null を持つ
- [x] `SPEC-CORE-088` 併合後のプロジェクトの表示パスは本体ルートになる（worktree セッションが最新でも worktree パスにしない）
- [x] `SPEC-CORE-089` 旧 worktree グループの id は projects 一覧に現れない（/api/projects/:id は 404 になる）
- [x] `SPEC-CORE-090` Codex ソースのグループは併合対象にしない

### 実測値照合レポート（Issue #4・`scripts/report.ts`）

照合ロジックは実ログに依存しない純関数として `scripts/report-lib.ts` に分離し、unit テストの対象とする。`scripts/report.ts` は実ログ走査と入出力のみを担う薄い CLI とする。

- [x] `SPEC-CORE-050` レコード群から kind 別件数の分布を集計して出力する
- [x] `SPEC-CORE-051` ツール別呼び出し回数を集計して出力する
- [x] `SPEC-CORE-052` モデル別トークン合計（input / output / cacheRead / cacheCreation）と推定コストを出力する
- [x] `SPEC-CORE-053` モデル別の実効レート（推定コスト ÷ 総トークン）が基準値の ±10% を超えたら照合失敗とする
- [x] `SPEC-CORE-054` 基準値に無いモデル・トークン 0 のモデルは実効レート照合の対象外とし、一覧には表示する
- [x] `SPEC-CORE-055` コスト内訳（input / output / cacheRead / cacheWrite5m / cacheWrite1h）の和が合計と一致しなければ照合失敗とする
- [x] `SPEC-CORE-056` 未知 type・未知モデルの出現は照合失敗にせず警告として出力する
- [x] `SPEC-CORE-057` 照合失敗が 1 件以上あれば非ゼロ終了し、なければ 0 で終了する
- [x] `SPEC-CORE-058` 最大サイズのセッションについて初回構築（キャッシュ破棄後）とキャッシュ再利用の所要時間を計測して出力する
- [x] `SPEC-CORE-059` レポート全文を `reports/` 配下に JSON で書き出し、標準出力には要約を出す
- [x] `SPEC-CORE-060` 実ログディレクトリが存在しない環境では照合せず、その旨を表示して 0 で終了する

#### 基準値（事前調査時点の実効レート）

基準値は `scripts/report-lib.ts` の定数 `BASELINE_RATES` に置く（$/1M tokens、モデル別）。数値は本 Issue の初回計測（2026-08-06、14 ファイル / 87.3MB / 7,586 レコード、推定合計 $971.67）で確定した。

| model | 実効レート（$/1M tokens） | 総トークン |
|---|---:|---:|
| `claude-fable-5` | 2.1576 | 319.1M |
| `claude-opus-5` | 1.0479 | 219.2M |
| `claude-sonnet-4-6` | 0.8336 | 13.8M |
| `claude-sonnet-5` | 0.3476 | 120.4M |

- 許容幅は ±10%（`RATE_TOLERANCE = 0.1`）
- `claude-haiku-4-5`（総トークン約 0.1M）は基準に含めない。少量利用のモデルはキャッシュ比率の変動で実効レートが大きく振れ、誤検出の温床になるため、基準は総トークンが十分大きいモデルに限る
- 単価改定や pricing.json 編集でレートが正当に変わった場合は、基準値を再計測して定数と本表を同時に更新する
- 事前調査（Issue #2/#3）の 15 ファイル / 131.9MB から 14 ファイル / 87.3MB へ減少していた。Claude Code の古いログ自動削除によるもので、件数照合ではなく比率照合を選んだ根拠が実測でも裏付けられた

## 参考: 実測されたレコード型

`~/.claude/projects` 配下 15 ファイル・11,378 行に対する実測（2026-07-30）。

| type | 主なフィールド |
|---|---|
| `assistant` | `message.model`, `message.usage`, `message.content[]`, `requestId`, `isSidechain`, `effort`, `attributionSkill` |
| `user` | `message.content`（string または `tool_result` / `text` / `image` の配列）, `toolUseResult`, `promptSource`, `permissionMode` |
| `system` | `subtype`: `turn_duration` / `compact_boundary` / `local_command` / `away_summary` / `api_error` / `stop_hook_summary` / `informational` |
| `attachment` | `attachment.type`: `task_reminder` / `hook_success` / `skill_listing` / `diagnostics` 等 25 種 |
| `pr-link` | `prNumber`, `prUrl`, `prRepository` |
| `mode` / `permission-mode` | `mode` / `permissionMode` |
| `ai-title` / `custom-title` | `aiTitle` / `customTitle` |
| `last-prompt` | `lastPrompt`, `leafUuid` |
| `file-history-snapshot` / `queue-operation` | （初期スコープ外・スキップ） |

- `message.usage` は `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` に加え、`cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` と `server_tool_use.{web_search,web_fetch}_requests` を持つ。
- assistant の content ブロックは `thinking` / `text` / `tool_use` / `server_tool_use` / `advisor_tool_result`。
- **1 行の最大サイズは実測 1.3MB**（Read / Bash の tool_result）。行単位のバッファリングはこの規模を前提にする。
- サブエージェントは `<session>/subagents/agent-*.jsonl` に分離保存され、同名 `.meta.json`（`agentType` / `description` / `toolUseId`）の `toolUseId` で親セッションの `tool_use` と結合できる。
