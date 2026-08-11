# SPEC-CODEX — Codex ログ対応（詳細設計書）

担当 Issue: #17（スキーマ調査・フィクスチャ）・#29（会話正規化）。人間向けの基本仕様書は [docs/spec/CODEX.md](../spec/CODEX.md)。後続: #30（usage 会計）→ #31（UI 統合）。#28（ソース抽象化）は CORE.md 側。

rollout JSONL には公開された安定スキーマ契約が無い。この文書の契約はすべて**下記の観測条件における実測**であり、「確定」は観測範囲で反例が無かったことを、「未観測・仮説」は観測に現れなかったことを意味する。後続 Issue は「確定」のみを前提にでき、「未観測・仮説」は使う前に再検証する。

## 観測条件

| 項目 | 値 |
|---|---|
| 観測日 | 2026-08-08 |
| 観測した cli_version | 0.128.0 / 0.146.0-alpha.3 / 0.146.0-alpha.3.1 / 0.146.0-alpha.9.2 / 0.147.0-alpha.1.2 / 0.147.0 |
| 対象 | 19 ファイル / 28 MB / 4,100 行 |
| 最大行 | 2,543,311 bytes（約 2.5 MB） |
| 壊れた JSON 行 | 0（耐性検証は合成フィクスチャでのみ可能） |
| session_meta.source | cli 1 / exec 5 / vscode 59 |
| 観測モデル（turn_context.model） | gpt-5.5 / gpt-5.4-mini / gpt-5.3-codex / gpt-5-codex / gpt-5.1-codex / o3 / gpt-5.6-sol / gpt-5.6-terra |

## 保存領域（セッション発見に必要な範囲のみ調査）

- 正本: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO日時（ハイフン区切り）>-<UUIDv7>.jsonl`。拡張子は `.jsonl` のみで**圧縮ファイルは無い**。`archived_sessions` ディレクトリは存在しない
- `~/.codex/session_index.jsonl`: `{id, thread_name, updated_at}` の追記型インデックス。thread_name は個人データを含むためフィクスチャ・文書には転記しない
- `~/.codex/history.jsonl`: `{session_id, ts, text}`。ユーザー入力履歴であり本 PJ の解析対象にしない
- 認証情報・設定など機微な領域は調査対象外（基本仕様書の約束）

## 行の分類表

top-level は全行 `{timestamp, type, payload}`。timestamp は ISO 8601 UTC（ミリ秒）。

### top-level type（観測 5 種）

| type | 件数 | 分類 | 要点 |
|---|---|---|---|
| `session_meta` | 65 | メタ | `payload`: id / timestamp / cwd / originator / cli_version / source / model_provider / base_instructions。**resume のたびに同一 id で再追記される**（1 ファイル最大 25 回を観測）。「ファイル先頭に 1 回だけ」を前提にしない |
| `turn_context` | 132 | メタ | ターンごとに 1 行。model / cwd / approval_policy / sandbox_policy / collaboration_mode / truncation_policy 等。**モデル名はこの行から採る** |
| `response_item` | 2,038 | 会話の正本 | payload.type: message / reasoning / function_call / function_call_output / custom_tool_call / custom_tool_call_output / tool_search_call / tool_search_output |
| `event_msg` | 1,833 | イベント通知 + usage | payload.type: token_count / agent_message / user_message / task_started / task_complete / agent_reasoning / 各種 `*_end` / thread_settings_applied / error |
| `world_state` | 32 | メタ（無視候補） | AGENTS.md 本文・環境情報のスナップショット。会話・usage には関与しない |

### payload.type の分類（観測 20 種）

| payload.type（top-level） | 件数 | 分類 |
|---|---|---|
| `token_count`（event_msg） | 613 | **usage**（`info` に累積値、`rate_limits` は usage 会計から分離） |
| `message`（response_item） | 536 | **会話の正本**（role: user 175 / assistant 298 / developer 63） |
| `reasoning`（response_item） | 472 | 会話の正本（summary + encrypted_content。encrypted_content は表示不可） |
| `function_call` / `function_call_output`（response_item） | 283 / 283 | 会話の正本（ツール呼び出し） |
| `custom_tool_call` / `custom_tool_call_output`（response_item） | 229 / 229 | 会話の正本（ツール呼び出し） |
| `tool_search_call` / `tool_search_output`（response_item） | 3 / 3 | 会話の正本（ツール検索） |
| `agent_message`（event_msg） | 298 | 通知（assistant message の複製 → 捨てる） |
| `user_message`（event_msg） | 138 | 通知（実ユーザー入力のみ。注入は含まれない） |
| `task_started` / `task_complete`（event_msg） | 132 / 132 | ターン境界 |
| `agent_reasoning`（event_msg） | 87 | 通知（reasoning と 1:1 でない → 捨てる） |
| `exec_command_end` / `patch_apply_end` / `mcp_tool_call_end` / `web_search_end`（event_msg） | 113 / 66 / 131 / 48 | 通知（実行結果詳細。call_id 対応は下記） |
| `thread_settings_applied`（event_msg） | 73 | メタ（設定変更。適用開始位置の契約は #29 で検証） |
| `error`（event_msg） | 2 | イベント（エラー表示に使う） |

**未知 type の扱い**: 上記に無い top-level type / payload.type / 既知 type への未知フィールドは、捨てずに unknown 分類で保持する（SPEC-CORE-023 と同じ方針。前方互換）。

## ターン境界・順序・相関キー

- ターンは `task_started`（turn_id 付き）〜 `task_complete`。**complete の無い途中終了があり得る**前提で扱う
- `turn_context` はターンごとに 1 行（観測: task_started と同数の 132）。モデル・実行設定の有効期間は次の turn_context まで
- **並び順の正本はファイル順（追記順）とする。** top-level timestamp は補助情報（resume 時に payload 内 timestamp と食い違う例を観測）
- 相関キー: ツール呼び出しは `call_id`、ターンは `turn_id`、response_item の `id` は OpenAI レスポンス ID（欠落あり）

## 重複の対応表（event_msg ↔ response_item）

| 論理メッセージ | 正本として採用 | 捨てる側 | 実測 |
|---|---|---|---|
| assistant 発言 | `response_item` message（role=assistant、phase: commentary 170 / final_answer 128） | `event_msg` agent_message | 全 19 ファイルで件数完全一致（298:298）。ただし件数一致のみの確認であり、**対応キー・本文一致・片側欠落時の優先規則は #29 で検証**（仮説: 出現順で 1:1） |
| ユーザー発言 | `response_item` message（role=user） | `event_msg` user_message | **1:1 でない**（175 vs 138）。差分は自動注入: `<environment_context>` / `<recommended_plugins>` / `<skill>` / `<realtime_delegation>` のタグ付き注入と、`# AGENTS.md instructions for <パス>` 形式のタグ無し注入。注入判定は「event_msg 側に対応が無い user message」+ 既知パターンで行う（#29） |
| developer 指示 | `response_item` message（role=developer、63 件） | （event_msg 側に無し） | 表示上は注入扱い（実ユーザー入力と区別する） |
| reasoning | `response_item` reasoning | `event_msg` agent_reasoning | **1:1 でない**（472 vs 87）。agent_reasoning は summary 単位の通知に過ぎない |

user content はテキストのみでなく画像（`input_image` 等の content part）があり得る。content は配列で複数 part を持つ。

## ツール呼び出しの対応表

| 対応 | 実測 | 契約 |
|---|---|---|
| `function_call` ↔ `function_call_output`（call_id） | 283 件全件で一致・孤児 0 | call_id で結合。**output の無い call（途中終了）はあり得る**前提で扱う（観測 0 だがフィクスチャで担保） |
| `custom_tool_call` ↔ `custom_tool_call_output`（call_id） | 全件一致・孤児 0 | 同上 |
| `exec_command_end` → response_item 側 call | 113/113 が call_id 一致 | 実行詳細（stdout/exit_code/duration）の付加情報として結合 |
| `mcp_tool_call_end` → response_item 側 call | **101/131**（30 件はイベント専用） | call_id で結合**できない行がある**。結合失敗は独立イベントとして扱い、二重表示も欠落もさせない |
| `patch_apply_end` → response_item 側 call | **29/66** | 同上 |
| `web_search_end` → response_item 側 call | **34/48** | 同上 |
| `function_call` と `custom_tool_call` の統合 | — | 正規化では同一の「ツール呼び出し」として統合し、種別をフィールドで保持する（#29） |

## token_count（usage）の契約

`event_msg:token_count` の `payload.info` が usage。`info: null` の行が存在する（観測 1 件）。`payload.rate_limits` は usage ではなく**会計から分離**する。

### 確定（観測範囲で反例 0）

| 契約 | 実測根拠 |
|---|---|
| `cached_input_tokens` は `input_tokens` の**内数** | 612 検査で反例 0 |
| `reasoning_output_tokens` は `output_tokens` の**内数** | 同上 |
| `total_tokens = input_tokens + output_tokens` | 同上 |
| `total_token_usage` はセッション累積・単調増加 | ファイル内リセット 0 |
| 累積が増加する遷移では増分 = `last_token_usage.total_tokens` | 581/581 遷移で一致 |
| **同一累積値の重複記録がある**（last は非 0 のまま） | 25 遷移。**行ごとの last 合算は二重計上になる** → usage は「累積値の増分」で確定させる |
| `token_count` は 1 ターンに複数回出る | 1 ターン 0〜86 回（0 回のターンも 4 件） |
| resume（session_meta 再追記）後も累積は継続 | multi-meta 2 ファイルでリセット 0 |
| モデル切替でもリセットしない | 切替 1 ファイルでリセット 0。**モデル別会計は「増分発生時点の turn_context.model」に帰属させる必要がある**（#30） |

### 未観測・仮説（後続 Issue で使う前に再検証）

- compaction 時の累積リセット有無（compaction 系の payload.type 自体が未観測）
- cache **write** 系フィールドの有無（観測フィールドは input / cached_input / output / reasoning_output / total のみ。Anthropic の cache_creation に相当する概念は現れていない）
  - **#30 追記（2026-08-10）**: 旧ログ（2026-07-24・07-31）に `cache_write_input_tokens` フィールドの存在を確認。ただし**観測値は全行 0**。非 0 の意味論（input の内数か・課金対象か）が未確定のため、#30 では計上しない契約を維持する
- `last_token_usage` の厳密な意味（「直近 API 応答」説が濃厚だが、ストリーミング中の途中値かは未確定）
- 途中終了ターンの usage が累積に反映されるか

## 合成フィクスチャ設計

`tests/fixtures/codex/` に置く。実ログの切り貼りは禁止。パスは `/home/user/synthetic-project`、本文は `<synthetic>` を含む定型文、UUID は `00000000-` 始まりの合成値を使う。

| ファイル | 含めるケース |
|---|---|
| `rollout-basic.jsonl` | 通常セッション: session_meta / world_state / turn_context / 注入 user message（タグ付き + AGENTS.md 形タグ無し）/ 実 user message / developer message / 画像 content / reasoning / function_call+output / custom_tool_call+output / 各種 `*_end`（call_id 一致とイベント専用の両方）/ 1 ターン複数 token_count / 同一累積値の重複記録 / task_started・task_complete |
| `rollout-resume-switch.jsonl` | 同一 id の session_meta 複数追記（resume）/ resume 後の累積継続 / モデル切替（切替後もリセットなし）/ info: null の token_count / complete の無い途中終了ターン |
| `rollout-edge.jsonl` | 壊れた JSON 行 / 未知 top-level type / 未知 payload.type / 既知 type への未知フィールド / 未知モデル / 巨大行（50KB+）/ output の無い function_call / 改行の無い不完全な末尾行 |

MB 級の巨大行は常設フィクスチャに置かず、テスト内で生成して検証する（リポジトリ肥大の回避）。

フィクスチャのファイル名は簡略形（`rollout-basic.jsonl` 等）であり、実ログの `rollout-<ISO日時>-<UUIDv7>.jsonl` 命名には従っていない。#28 でファイル名から timestamp / uuid を抽出する場合は、実命名規約に従うフィクスチャを追加すること。

## 受け入れ基準

検証はフィクスチャ検証テスト（vitest）で行う。この Issue に production コードは無いため、テストは「フィクスチャが本文書の契約どおりの形をしている」ことを機械的に担保する（後続 Issue の TDD がこのフィクスチャに依存する）。

### スキーマ契約の文書化

- [x] `SPEC-CODEX-001` 行の分類表・重複対応表・ツール対応表・token_count 契約が本文書に実測値付きで記録されている（確定と未観測・仮説を区別する）

### フィクスチャ: 基本形

- [x] `SPEC-CODEX-010` 全行が `{timestamp, type, payload}` 形式で、観測 5 種の top-level type をすべて含む
- [x] `SPEC-CODEX-011` token_count が確定契約（cached ⊆ input・reasoning ⊆ output・total = input + output・累積単調増加・増加遷移の増分 = last）を満たす
- [x] `SPEC-CODEX-012` 1 ターンに複数の token_count を含むターンと、同一累積値の重複記録を含む
- [x] `SPEC-CODEX-013` `info: null` の token_count 行を含む
- [x] `SPEC-CODEX-014` タグ付き注入・AGENTS.md 形タグ無し注入・developer message・画像 content を含み、event_msg:user_message と response_item の user message が 1:1 にならない
- [x] `SPEC-CODEX-015` assistant 発言は event_msg:agent_message と response_item(assistant message) の件数が一致し、phase（commentary / final_answer）の両方を含む
- [x] `SPEC-CODEX-016` call_id で結合できるツール呼び出し（function_call / custom_tool_call）と、response_item 側に対応の無いイベント専用 `*_end` の両方を含む

### フィクスチャ: resume・切替・途中終了

- [x] `SPEC-CODEX-020` 同一セッション id の session_meta が複数回追記され、resume 後も token_count の累積が継続する
- [x] `SPEC-CODEX-021` turn_context のモデルが途中で切り替わり、切替後も累積がリセットされない
- [x] `SPEC-CODEX-022` task_started に対応する task_complete の無い途中終了ターンを含む

### フィクスチャ: 耐性

- [x] `SPEC-CODEX-030` 壊れた JSON 行・未知 top-level type・未知 payload.type・既知 type への未知フィールド・未知モデルを含む
- [x] `SPEC-CODEX-031` 50KB を超える巨大行と、改行の無い不完全な末尾行を含む
- [x] `SPEC-CODEX-032` output の無い function_call（途中終了）を含む

### 匿名化

- [x] `SPEC-CODEX-040` フィクスチャに実ユーザー名・実プロジェクト名・ホームディレクトリ実パスを含む文字列が無い（機械検査）

---

# 会話正規化（Issue #29）

Codex rollout を既存 DTO（`IndexRecord` / `MessageBody`）へ正規化し、viewer 無変更でチャット表示を成立させる。usage（`token_count`）は #30 まで読み捨てる。

## #29 での追加実測（2026-08-09・21 ファイル）

#17 で「#29 で検証」と先送りした契約を実ログで確定した。

| 検証項目 | 実測 | 確定した契約 |
|---|---|---|
| assistant の event↔item 対応 | 330:330・出現順 1:1・本文完全一致 330/330・event が常に先行 | `response_item` を正本とし `event_msg:agent_message` を捨てる |
| user の event↔item 順序 | 本文一致 150 組すべてで event が item の**後** | ペアリング判定はストリーミングで先読みが必要になるため**採用しない** |
| `<realtime_delegation>` | event 側にも 33/33 で出現（他タグは event 側に 0） | 「event に対応が無い＝注入」は成立しない。注入判定は**本文先頭パターンのみ** |
| 先頭パターン判定の網羅性 | 注入 77 件中 73 件を判別（タグ 71 + AGENTS.md 2）。残り 4 件はパターン無し | 判別できないものは**実ユーザー入力として表示**（安全側。実入力を隠さない） |
| turn_context の位置 | モデルが要る item（assistant message / reasoning / tool call）の前に必ず先行。142/142・反例 0 | model は「直近の turn_context.model」を採用。turn_context 前は undefined |

注入判定の先頭パターン（`INJECTION_PATTERNS`）: `<environment_context>` / `<recommended_plugins>` / `<skill>` / `<realtime_delegation>` の先頭タグ、および `# AGENTS.md instructions for ` 前置。

## アーキテクチャ（正規化フックの差し込み）

CORE.md（#28）で予告した「ソースごとの normalize の差し込み」を実装する。

- `server/sources/types.ts` の `LogSource` に 2 フックを追加する:
  - `createNormalizer(state?: unknown): RecordNormalizer` — 1 走査分のステートフルな正規化器。`RecordNormalizer` は `normalize(raw, location): IndexRecord | null` と `serialize(): unknown`（増分再開用の直列化可能な走査文脈）を持つ
  - `normalizeBody(raw: unknown): MessageBody` — 本文表示の正規化（sessions ルートがソース別に呼ぶ）
- Claude ソースは既存 `normalizeRecord` / `normalizeBody` の薄いラッパ（ステートレス・`serialize()` は undefined）。**レコード列・キャッシュ内容は従来と一致**させる
- `buildIndex` / `scanFile` は normalizer を受け取る（省略時は Claude 相当で後方互換）。キャッシュ（`IndexCacheFile`）に `scanState` を追加し、増分時は `createNormalizer(cache.scanState)` で文脈を復元する。`INDEX_SCHEMA_VERSION` を 4 へ繰り上げる（scanState の無い旧キャッシュを全再構築させる）
- `Snapshot` に `sourcesById: Map<string, LogSource>` を追加し、sessions ルートは `SessionEntry.sourceId` から本文正規化をディスパッチする
- `server/app.ts` の `AppOptions` に `codexSessionsDir?: string` を追加し、**指定されたときだけ** Codex ソースを登録する（既存テストが実 `~/.codex` に触れないため）。`server/index.ts` は `~/.codex/sessions` を渡す
- Codex 固有の解釈は `server/sources/codex-normalize.ts` に閉じ込める（DTO へソース固有フィールドを生やさない）

## 走査文脈（CodexScanState・直列化してキャッシュへ保存）

| フィールド | 由来 | 用途 |
|---|---|---|
| `sessionId` | `session_meta.payload.id` | 後続レコードの sessionId |
| `cwd` | `session_meta.payload.cwd` / `turn_context.cwd` | 後続レコードの cwd |
| `version` | `session_meta.payload.cli_version` | 後続レコードの version |
| `model` | `turn_context.model` | assistant 系レコードの model |
| `turnStartedAt` | `task_started` 行の timestamp | task_complete の durationMs 算出 |
| `toolCallIds` | `function_call` 等の call_id 蓄積 | `*_end` の重複判定（結ばれるものを捨てる） |

## 正規化対応表（rollout 行 → IndexRecord）

全レコード共通: `timestamp` は top-level timestamp、`sessionId` / `cwd` / `version` は走査文脈から埋める。usage は付けない（#30）。

| 入力（type / payload.type） | 出力 |
|---|---|
| `session_meta` / `turn_context` / `world_state` / `thread_settings_applied` | レコード無し（文脈更新のみ） |
| `response_item` message（assistant） | kind `assistant`・model=文脈・preview=本文冒頭 |
| `response_item` message（user・実入力） | kind `user`・preview=本文冒頭 |
| `response_item` message（user・先頭が注入パターン） | kind `attachment`・attachmentType=`injected` |
| `response_item` message（developer） | kind `attachment`・attachmentType=`developer` |
| `response_item` reasoning | kind `assistant`・hasThinking=true・model=文脈・preview=summary 冒頭 |
| `response_item` function_call / custom_tool_call / tool_search_call | kind `assistant`・model=文脈・toolUses=[{id: call_id, name}]・preview=名前と引数冒頭 |
| `response_item` function_call_output / custom_tool_call_output / tool_search_output | kind `user`・isToolResult=true・toolResultFor=call_id・preview=出力冒頭 |
| `event_msg` agent_message / agent_reasoning / user_message | レコード無し（response_item の複製・注入通知） |
| `event_msg` token_count | #29 ではレコード無し → **#30 で usage 増分レコード**（下記「usage 会計・コスト」） |
| `event_msg` task_started | レコード無し（文脈更新のみ） |
| `event_msg` task_complete | kind `system`・subtype=`task_complete`・durationMs=task_started との差（欠損時は undefined） |
| `event_msg` error | kind `system`・subtype=`error`・preview=メッセージ |
| `event_msg` `*_end`（call_id が toolCallIds に有る） | レコード無し（正本の output と重複） |
| `event_msg` `*_end`（call_id が結ばれない） | kind `user`・isToolResult=true・toolResultFor=call_id（独立ツール結果として表示） |
| 未知 top-level type / 未知 payload.type | kind `unknown`（捨てない。前方互換） |

viewer 側は無変更で成立する（実装済みの規約に乗る）: attachment / unknown は `web/src/lib/thread.ts` の `HIDDEN_KINDS` でメイン列に出ず、tool_use と tool_result は `toolUses[].id` ↔ `toolResultFor` で取り付き、system は subtype=compact_boundary か durationMs 有りのみ表示される。やりとり分割（`exchanges.ts`）は kind user のみ開始点になるため、注入を attachment にすることで汚れない。

**カウント意味論（合意済み）**: Codex は reasoning・ツール呼び出しが独立行のため assistantCount / models[].messages は「行単位」で Claude より大きく出る。#31 で見直し可。

## 本文正規化（normalizeBody・Codex）

| 入力 | MessageBody |
|---|---|
| message | role をそのまま、content の input_text / output_text → text ブロック、input_image → other ブロック（`[画像]`）、未知 part → other |
| reasoning | summary[].text → thinking ブロック |
| function_call / custom_tool_call / tool_search_call | tool_use ブロック（id=call_id・name・input=arguments。JSON 文字列なら parse、失敗時は生文字列） |
| `*_output` | tool_result ブロック（toolUseId=call_id・text=output） |
| `*_end`（独立表示分） | tool_result ブロック（取れるフィールドだけ整形。exec は exit_code≠0 を isError） |
| error / その他 | text ブロック（取れるものだけ） |

## 受け入れ基準（#29）

### 正規化（レコード）

- [x] `SPEC-CODEX-050` response_item の assistant message は kind assistant になり直近の turn_context.model が付く
- [x] `SPEC-CODEX-051` turn_context 出現前の assistant 系レコードは model が undefined のまま例外を投げない
- [x] `SPEC-CODEX-052` response_item の実ユーザー入力は kind user になり isToolResult が付かない
- [x] `SPEC-CODEX-053` 本文先頭が既知注入パターンの user message と developer message は kind attachment になる
- [x] `SPEC-CODEX-054` 既知パターンに合わない user message は kind user のまま残る（安全側）
- [x] `SPEC-CODEX-055` reasoning は kind assistant・hasThinking=true になる
- [x] `SPEC-CODEX-056` function_call / custom_tool_call / tool_search_call は kind assistant になり toolUses に call_id と name を持つ
- [x] `SPEC-CODEX-057` function_call_output / custom_tool_call_output / tool_search_output は kind user・isToolResult=true・toolResultFor=call_id になる
- [x] `SPEC-CODEX-058` event_msg の agent_message / agent_reasoning / user_message はレコードを生成しない（token_count は #30 の usage 会計で扱う）
- [x] `SPEC-CODEX-059` call_id が正本と結ばれる *_end はレコードを生成せず、結ばれない *_end は kind user・isToolResult の独立レコードになる
- [x] `SPEC-CODEX-060` session_meta / turn_context / world_state / thread_settings_applied はレコードを生成せず、sessionId・cwd・version が後続レコードへ引き継がれる
- [x] `SPEC-CODEX-061` task_complete は kind system になり task_started からの durationMs を持つ（timestamp 欠損時は durationMs 無しで生成する）
- [x] `SPEC-CODEX-062` 壊れた JSON 行・未知 type・output の無い call・巨大行を含むファイルでも正規化は例外を投げず、未知 type は kind unknown で残る

### 本文（normalizeBody）

- [x] `SPEC-CODEX-063` message の content が text ブロックへ、input_image が other ブロックへ変換される
- [x] `SPEC-CODEX-064` reasoning の summary が thinking ブロックへ変換される
- [x] `SPEC-CODEX-065` ツール呼び出しは tool_use ブロック（id=call_id・name・input）へ、output は tool_result ブロック（toolUseId=call_id）へ変換される

### 増分・キャッシュ

- [x] `SPEC-CODEX-066` 走査文脈がキャッシュへ保存され、増分再開でも全再構築と同一のレコード列になる
- [x] `SPEC-CODEX-067` INDEX_SCHEMA_VERSION の繰り上げにより scanState の無い旧キャッシュは全再構築される

### 統合（viewer 無変更でのチャット成立）

- [x] `SPEC-CODEX-068` codexSessionsDir 指定時のみ Codex ソースが登録され、GET /api/sessions/:id/messages で Codex セッションの本文が返る
- [x] `SPEC-CODEX-069` Codex 正規化レコードは既存の行構築（buildRows）で user / assistant / ツール呼び出し＋結果がメイン列に成立し、注入・developer はメイン列に出ない
- [x] `SPEC-CODEX-070` Claude ソースの正規化結果・API レスポンスは従来と一致する（既存テスト不変）

---

# usage 会計・コスト（Issue #30）

`event_msg:token_count` の累積値を差分化し、既存の加算可能な `NormalizedUsage` に落とす。基本仕様書の承認事項（2026-08-10 裁定）: **epoch 切替は案 B（減少行は計上せず基準更新）**・**集計対象は「usage を持つレコード（kind 不問）」へ拡張（messages カウントは assistant のみ）**。

## 会計状態機械（codex-normalize 内・CodexScanState 拡張）

`CodexScanState` に前回累積値を追加する（増分再開のためキャッシュへ直列化される）:

| フィールド | 内容 |
|---|---|
| `prevUsage` | 直近の `total_token_usage` の値 `{input, cachedInput, output, reasoningOutput, total}`。未観測なら undefined（基準 0） |

`token_count` 行の処理:

1. `payload.info` がオブジェクトでない（`info: null` 含む）→ 状態を変えずスキップ（レコード無し）
2. `info.total_token_usage` から累積値を読む（欠損フィールドは 0）
3. **減少検知**: いずれかの成分が前回値より小さい → epoch 切替。**この行は計上せず** `prevUsage` を現在値に更新して終わり（案 B）
4. 増分 = 現在値 − 前回値（成分ごと）。`prevUsage` を現在値に更新
5. 増分の total が 0（同一累積値の重複記録）→ レコード無し
6. usage 付きレコードを生成する（下記）

## usage レコード（token_count 増分 → IndexRecord）

| フィールド | 値 |
|---|---|
| `kind` / `type` / `subtype` | `system` / `token_count` / `token_count`（viewer の system 表示条件は subtype=compact_boundary か durationMs 有りのみ。実コード `web/src/lib/thread.ts` で確認済み → メイン列に出ない） |
| `model` | 増分発生時点の `ctx.model`（turn_context 前は undefined のまま） |
| `usage.input` | `max(0, Δinput − ΔcachedInput)`（cached は input の内数。負クランプ） |
| `usage.cacheRead` | `ΔcachedInput` |
| `usage.output` | `Δoutput`（reasoning は output の内数なので別掲しない。DTO に reasoning フィールドを生やさない） |
| `usage.cacheCreation*` / `webSearch` / `webFetch` | 0（Codex に cache write 相当は未観測。現れても計上しない） |
| `timestamp` / `sessionId` / `cwd` / `version` | 共通メタ（走査文脈から） |

`last_token_usage` / `rate_limits` は読まない（多重計上・会計無関係）。

## 集計対象の拡張（usage を持つレコード・kind 不問）

Claude 側は usage が assistant にしか付かない（`server/core/normalize.ts` の付与箇所は assistant メッセージのみ・確認済み）ため、以下の変更で Claude の数値は変わらない。

| 箇所 | 変更 |
|---|---|
| `server/core/summary.ts` | usage 合算を kind 不問にする（`models[model]` へ加算）。`messages` / `assistantCount` の加算は従来どおり kind assistant のみ |
| `server/aggregate.ts` `isBillable` | `record.usage !== undefined` へ変更。`tokensByModel` の `messages += 1` は kind assistant のみに限定 |
| `server/cost.ts` `estimateRecordsCost` | フィルタを `record.usage` 有りへ変更。`byModel[].messages += 1` は kind assistant のみに限定 |

model が undefined の usage レコードは、summary では `(unknown)` キー、コストでは unknownModel 警告（既存挙動）に乗る。

## キャッシュ互換

`INDEX_SCHEMA_VERSION` を **5** に繰り上げる。v4 キャッシュの scanState には `prevUsage` が無く、増分再開時に基準 0 とみなして**再開後の最初の増分を全額（累積値まるごと）計上する多重計上事故**になるため、全再構築させる。

## テスト・フィクスチャ

- 既存フィクスチャが会計ケースを網羅済み: 1 ターン複数 token_count・同一累積値の重複（rollout-basic）、resume 継続・モデル切替・`info: null`（rollout-resume-switch）、未知モデル（rollout-edge）
- **累積減少（epoch 切替）は確定契約（単調増加）と矛盾するため常設フィクスチャに置かず、テスト内生成の JSONL で検証する**
- 増分 == 全再構築の同一性は SPEC-CODEX-066 と同じ手法（途中 offset で分割して再開）で検証する

## 受け入れ基準（#30）

### 会計状態機械

- [x] `SPEC-CODEX-080` token_count の累積増分は usage 付き kind system（subtype token_count）レコードになり、増分 0 の行（同一累積値の重複記録）はレコードを生成しない
- [x] `SPEC-CODEX-081` usage は input=Δinput−Δcached・cacheRead=Δcached・output=Δoutput となり、reasoning の別掲と cache write の計上をしない
- [x] `SPEC-CODEX-082` Δcached が Δinput を上回る行でも input は負にならない（0 へクランプ）
- [x] `SPEC-CODEX-083` 1 ターンに複数の token_count がある場合も、合計は累積最終値と一致する
- [x] `SPEC-CODEX-084` resume（session_meta 再追記）後も基準が継続し、多重計上しない
- [x] `SPEC-CODEX-085` モデル切替後の増分は切替後の turn_context.model に帰属し、切替前の増分は前モデルに残る
- [x] `SPEC-CODEX-086` 最初の turn_context より前の増分は model undefined で計上され、コスト側で未知モデル警告になる
- [x] `SPEC-CODEX-087` 累積値の減少を検知したら epoch を切り替え、その行は計上せず新しい基準から以後の増分を数える（案 B）
- [x] `SPEC-CODEX-088` info が null・オブジェクトでない token_count は状態を変えずスキップする

### 増分・キャッシュ

- [x] `SPEC-CODEX-089` usage 会計を含む増分解析は全再構築と完全に同じ集計になる（prevUsage が scanState 経由で継続する）
- [x] `SPEC-CODEX-090` INDEX_SCHEMA_VERSION の繰り上げ（5）により prevUsage の無い旧キャッシュは全再構築される

### 集計統合

- [x] `SPEC-CODEX-091` summary / aggregate / cost は usage を持つ非 assistant レコードを合算し、messages・assistantCount のカウントは assistant のみのまま変わらない
- [x] `SPEC-CODEX-092` Claude ソースの集計値・コストは従来と一致する（既存テスト不変）

## 実測（#30・2026-08-10）

- 実ログ 2026-07-24 セッション: UI 表示 9.9M tokens / $7.38 — **token_count 最終累積値 9,949,790 と完全一致**（多重計上・取りこぼしなし）
- Codex ソース 90 日集計: 48.1M tokens / $38.20（gpt-5.6-sol 32.7M・gpt-5.6-terra 15.4M。モデル別内訳の合計 = 総トークンで一致）
- token_count が 1 行も無いセッション（2026-06-27 等）は仕様どおり「未集計」表示のまま
- Claude 側集計は変更前後で不変（verify 全 pass・report 照合 OK）
