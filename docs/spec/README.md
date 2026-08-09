# Spec 運用規約

`docs/spec/`（基本仕様書）と `docs/design/`（詳細設計書）が**仕様の正本**である。GitHub Issue には SPEC-ID と受け入れ基準の要約のみを書き、詳細はここを参照する。

## 基本仕様書と詳細設計書

読者ごとにディレクトリを分ける。ファイル名は両方 `<領域>.md` で揃え、置き場所が読者を表す。

| ディレクトリ | 読者 | 内容 |
|---|---|---|
| `docs/spec/` | **人間** | ゴール・できること・表示上の約束・オーナー確認方法。要件合意ゲートのレビュー対象 |
| `docs/design/` | **AI** | データモデル・実装方針・**受け入れ基準チェックボックス**・実測値 |

- **受け入れ基準チェックボックスは詳細設計書（`docs/design/`）にのみ書く。** 両方に書くと `spec:check` の duplicate 検出に掛かる
- 基本仕様書は要件の合意に使うため、実装の言葉ではなく挙動の言葉で書く
- API エンドポイント表（`METHOD /api/...`）は `docs/design/API.md` に書く（`spec:check` の apiDrift 突き合わせ対象）
- 両ファイルは相互リンクする（基本 → 詳細、詳細 → 基本）

## 領域一覧

| 領域 | 内容 |
|---|---|
| `SPEC-FLOW` | spec:check 自体の仕様（**詳細設計書のみ**。開発フローの正本は AGENTS.md とスキルのため基本仕様書を持たない） |
| `SPEC-CORE` | JSONL パーサ・インデクサ・キャッシュ・増分更新 |
| `SPEC-COST` | 価格表とコスト計算 |
| `SPEC-API` | HTTP API |
| `SPEC-CHAT` | セッション分析・チャットビューア |
| `SPEC-DASH` | ダッシュボード（Overview / プロジェクト / Tools & Agents） |
| `SPEC-LIVE` | ファイル監視とライブ更新 |
| `SPEC-CONFIG` | agents / skills / plugins / settings の可視化 |
| `SPEC-CODEX` | Codex CLI ログ対応（スキーマ調査・正規化・usage 会計・UI 統合） |

## 受け入れ基準の書き方

**1 行 1 基準・一意 ID・検証可能な断定文**で書く。`- [ ]` が未実装、`- [x]` が実装＋テスト済み。

```markdown
- [ ] `SPEC-COST-003` cache_creation.ephemeral_1h_input_tokens を input 単価 × 2.0 で課金計算する
```

ID 形式は `SPEC-<領域>-<3桁連番>`。**ID は再利用・振り直しをしない**（消した仕様の ID は欠番のまま残す）。

`scripts/spec-check.ts` が定義として認識するのは上記のチェックボックス行だけである。本文中で ID に言及しても定義とはみなされない。

## 開発フロー

**このファイルには書かない。** 開発フロー（サイクル・オーナーゲート・テスト名規約）の正本は `AGENTS.md` と `issue-create` / `dev-cycle` スキルに集約している。ここは Spec 文書の書き方の規約のみを扱う。

## 禁止事項

このリポジトリは **public** である。Spec・Issue・PR・テストフィクスチャに以下を書いてはならない。

- 実ログのプロジェクトパス、プロンプト本文、PR URL
- `~/.claude/settings.json` の permissions 実値
- 実ログファイルそのもの（`tests/fixtures/` は匿名化した合成データのみ）
