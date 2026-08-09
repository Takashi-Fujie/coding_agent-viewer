# SPEC-CODEX — Codex ログのスキーマ調査と合成フィクスチャ（基本仕様書）

担当 Issue: #17（スキーマ調査・フィクスチャ）。後続: #28（ソース抽象化）→ #29（会話正規化）→ #30（usage 会計・コスト）→ #31（UI 統合・ライブ更新）

## ゴール

Codex CLI のセッションログ（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`）には公開された安定スキーマ契約が無い。後続の実装が推測ではなく**実測で確定した契約**に依存できるよう、スキーマを調査して文書化し、テストの土台になる匿名化合成フィクスチャを整備する。

この Issue は**調査・仕様書・フィクスチャまで**。ログを読み取る production コードは書かない。

## できること（この Issue の成果物）

- **行の分類表**: rollout JSONL に現れる行の種類（top-level type / payload.type）を実測で列挙し、それぞれを「会話の正本 / イベント通知 / usage / メタ情報 / 無視してよい」に分類した表が詳細設計書にある。セッション境界・ターン境界（`task_started` / `task_complete`・`turn_id` の対応範囲・completeの無い途中終了）と、並び順の正本（ファイル順か timestamp か）・相関キー（`id` / `call_id` / `turn_id`）の契約も含む
- **重複の対応表**: 同じ発言が `event_msg`（UI 通知）と `response_item`（会話の正本候補）の両方に記録される。どちらを正本として採用し、どちらを捨てるかの対応表がある。観測範囲では assistant 発言は件数が完全一致したが、件数一致だけで 1:1 を断定せず、**対応キー・本文一致・片側欠落時の優先規則**を調査項目として契約化する。user 側は AGENTS.md や環境情報の**自動注入**が混ざるため 1:1 にならない — この非対称と、role（user / assistant / developer）・content 種別（テキスト / 画像）の分類も表に含める
- **ツール呼び出しの対応表**: `function_call` / `custom_tool_call` / `tool_search_call` とそれぞれの output の `call_id` 対応、通知側イベント（`exec_command_end` / `patch_apply_end` / `mcp_tool_call_end` / `web_search_end`）との対応、output の無い途中終了・失敗の扱いを契約化する（後続 UI で同じ操作を二重表示しないための土台）
- **トークン集計の契約**: `token_count` 行の累積仕様を実測で確認した結果が、**確定した項目と未観測の項目を区別して**記録されている。cached input / reasoning が各総数の内数か、`token_count` が 1 ターンに複数回出ること、同一累積値の重複記録があり**隣接差分の単純合算では二重計上する**こと、直近値（last）の意味と usage を確定させるタイミング、`rate_limits` を usage 会計から分離すること、resume・モデル切替でのリセット有無を含む。未観測の項目（例: compaction 時の挙動、cache write 系フィールドの有無）は仮説のまま後続 Issue の検証項目として残す
- **匿名化合成フィクスチャ**: 実測で確認した形を再現した合成 JSONL が `tests/fixtures/` にある。モデル切替・途中終了（complete の無いターン）・resume（同一セッション ID の `session_meta` 複数追記・累積 usage の継続）・壊れた JSON 行・未知 type・既知 type への未知フィールド追加・未知モデル・巨大行・usage 欠落行（`info: null`）・1 ターン複数 `token_count`・同一累積値の重複記録・自動注入 user メッセージ・developer メッセージ・画像 content・改行前の不完全な末尾行を含む。常設フィクスチャの巨大行は 50KB+ とし、実測最大（2.5MB）級はテスト内生成で検証する。実ログのパス・本文・設定値は一切含めない
- **観測条件の記録**: 観測した Codex CLI バージョン・観測日・セッション発見に必要な保存領域（`sessions` 外の履歴・インデックス類・圧縮の有無。認証情報など機微な領域は調査対象にしない）が詳細設計書に記録されており、将来スキーマが変わったときに「いつ時点の契約か」を辿れる

## やらないこと

- normalize（正規化 DTO への変換）の production 実装 — #29 以降。この Issue の成果物は文書とフィクスチャとその検証テストのみ
- Codex ログの画面表示・コスト計算 — #30 / #31

## オーナー確認方法

- 詳細設計書 [docs/design/CODEX.md](../design/CODEX.md) の分類表・対応表・トークン契約・観測条件を読み、後続実装の前提として妥当か確認する
- フィクスチャが実測スキーマと整合していることを検証する vitest が green であることを確認する（`npm run verify`）
- フィクスチャに個人情報（実パス・プロンプト本文・実プロジェクト名）が含まれていないことを確認する

実測値・分類表・受け入れ基準は [docs/design/CODEX.md](../design/CODEX.md)。
