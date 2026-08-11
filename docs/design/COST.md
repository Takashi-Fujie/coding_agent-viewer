# SPEC-COST — 価格表とコスト計算（詳細設計書）

担当 Issue: #3（Claude）・#30（Codex モデル対応）。人間向けの基本仕様書は [docs/spec/COST.md](../spec/COST.md)。

## ゴール

`assistant` レコードの `usage` から**推定**コストを算出する。キャッシュ書き込みは TTL（5分 / 1時間）で単価が異なるため、`usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` を区別して計算する。

## 単価

$/1M tokens。キャッシュ単価は input 単価に対する倍率（read = 0.1x、write 5m = 1.25x、write 1h = 2.0x）で導出する。

| model | input | output |
|---|---|---|
| `claude-fable-5` / `claude-mythos-5` | 10.00 | 50.00 |
| `claude-opus-5` | 5.00（fast mode 10.00） | 25.00（同 50.00） |
| `claude-opus-4-8` / `claude-opus-4-7` / `claude-opus-4-6` | 5.00 | 25.00 |
| `claude-sonnet-5` | 3.00（2026-08-31 まで導入価格 2.00） | 15.00（同 10.00） |
| `claude-sonnet-4-6` | 3.00 | 15.00 |
| `claude-haiku-4-5` | 1.00 | 5.00 |

出典は `claude-api` skill（2026-06-24 時点のキャッシュ）。単価は変動するため `server/pricing.json` に切り出してユーザーが編集できるようにし、UI には「推定コスト」と明示する。

**価格表に載せるのは出典で単価が確認できたモデルだけとする。** 確認できないモデル（旧世代の一部など）を推測で埋めない。未掲載モデルは未知モデルとして警告に回す。

## 方針

- 価格表に無いモデル（`<synthetic>` を含む）は cost 0 とし、`unknownModel: true` を立てて UI に警告を出す。**サイレントに 0 円扱いしない。**
- 導入価格は `introUntil` フィールドで期間判定し、レコードの `timestamp` が期間内なら導入価格を適用する。
- **fast mode は単価が異なる**（Opus 5 で通常の 2 倍）。`usage.speed` が `fast` のとき通常単価を使うと 2 倍の undercount になるため、必ず区別する。
- **モデル ID の日付サフィックスを正規化する。** 実ログには `claude-haiku-4-5-20251001` のような dated ID が現れる（実測 13 件）。正規化しないと既知モデルを未知と誤判定する。

## 受け入れ基準

### 価格表

- [x] `SPEC-COST-001` 単価を `server/pricing.json` に外出しし、実行時に読み込む
- [x] `SPEC-COST-002` 単価は $/1M tokens として扱い、トークン数 ÷ 1,000,000 × 単価 で金額を求める
- [x] `SPEC-COST-003` モデル ID 末尾の `-YYYYMMDD` 日付サフィックスを除去して価格表と突き合わせる

### キャッシュ

- [x] `SPEC-COST-010` cache read を input 単価 x0.1 で計算する
- [x] `SPEC-COST-011` cache write 5m を input 単価 x1.25 で計算する
- [x] `SPEC-COST-012` cache write 1h を input 単価 x2.0 で計算する
- [x] `SPEC-COST-013` cacheCreation の 5m / 1h 内訳が欠けて合計だけがある場合は 5m 単価を適用し `cacheSplitAssumed` を立てる

### 導入価格

- [x] `SPEC-COST-020` レコードの timestamp が `introUntil` 以前なら導入価格を適用する
- [x] `SPEC-COST-021` timestamp が `introUntil` を過ぎていれば通常価格を適用する
- [x] `SPEC-COST-022` timestamp が無いレコードには導入価格を適用せず通常価格で計算する

### 未知モデルと fast mode

- [x] `SPEC-COST-030` 価格表に無いモデルは cost 0・`unknownModel` を立て、サイレントに 0 円扱いしない
- [x] `SPEC-COST-031` `<synthetic>` は価格表に無いモデルとして `unknownModel` を立てる
- [x] `SPEC-COST-032` speed が `fast` のモデルには fast 単価を適用する
- [x] `SPEC-COST-033` fast 単価が未定義のモデルで speed が `fast` のときは `unknownRate` を立てて警告する

### 集計と表示

- [x] `SPEC-COST-040` レコード群からモデル別コストと合計を集計する
- [x] `SPEC-COST-041` 集計結果に未知モデル名の一覧を含める
- [x] `SPEC-COST-042` 集計結果に推定値である旨のフラグと単価の出典を含める

## Codex（OpenAI）モデル対応（Issue #30）

- `ModelPrice` に省略可能な **`cacheRead`（$/1M・cached input の明示単価）** を追加する。指定があれば `input × cacheMultipliers.read` の導出より**優先**する。OpenAI は cached input の割引率がモデルごとに異なる（一律倍率で表せない）ため
- pricing.json に載せる Codex モデルは **OpenAI 公式価格ページを WebSearch で確認できたものだけ**（観測モデル: gpt-5.5 / gpt-5.4-mini / gpt-5.3-codex / gpt-5-codex / gpt-5.1-codex / o3 / gpt-5.6-sol / gpt-5.6-terra）。確認できないモデルは追加せず unknownModel 警告のままにする
- `source` は Anthropic / OpenAI の 2 出典を 1 文字列で併記する（例: `claude-api skill（2026-06-24）+ OpenAI pricing（確認日）`）
- Codex usage は cache write が常に 0 なので write 系単価は適用されない（会計側の契約は design/CODEX.md）

### 受け入れ基準（#30）

- [x] `SPEC-COST-050` モデル単位の cacheRead 明示単価が倍率導出より優先して適用される
- [x] `SPEC-COST-051` cacheRead 明示単価の無いモデルは従来どおり input 単価 × read 倍率で計算される（既存結果不変）
- [x] `SPEC-COST-052` 価格表に出典確認済みの Codex モデルが載り、未確認の観測モデルは unknownModel 警告になる

## 実測（Issue #3 時点）

15 ファイル / 131.9MB のログに対する推定合計は **$1,071.00**。

| model | msgs | cost | 備考 |
|---|---:|---:|---|
| `claude-fable-5` | 1719 | $805.57 | |
| `claude-sonnet-4-6` | 1551 | $113.71 | |
| `claude-opus-5` | 394 | $108.66 | |
| `claude-sonnet-5` | 483 | $41.86 | 導入価格が適用された |
| `claude-opus-4-7` | 22 | $0.94 | |
| `claude-haiku-4-5` | 13 | $0.26 | dated ID からの正規化で一致 |
| `<synthetic>` | 12 | $0.00 | unknownModel として警告 |

`claude-sonnet-5` の内訳は input $0.14 / output $4.13 / cache read $23.27 / cache write 1h $14.31。
**コストの約 94% がキャッシュ由来**であり、input / output だけを表示すると実態を大きく取り違える。
ダッシュボード（SPEC-DASH）はキャッシュ内訳を必ず出すこと。

実測時点で `usage.speed` は全件 `standard` だった（fast mode の実データは無い）。それでも区別するのは、
fast mode の単価が通常の 2 倍であり、取りこぼすと警告なしに 2 倍の undercount になるためである。
