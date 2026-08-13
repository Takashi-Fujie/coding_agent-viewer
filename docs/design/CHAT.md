# SPEC-CHAT — セッション分析・チャットビューア（詳細設計書）

担当 Issue: #6・#40。人間向けの基本仕様書は [docs/spec/CHAT.md](../spec/CHAT.md)。

## 技術スタック（#6 で確定。以降の画面 Issue #7〜#9 の土台）

- **React + Vite + TypeScript**、仮想スクロールは `@tanstack/react-virtual`
- ルーティングは**ハッシュベース**（`#/` → `#/projects/:id` → `#/projects/:id/sessions/:id`）。
  Express 側に SPA fallback を足さずに URL 直アクセス・リロードが成立するため
- チャートは手書き SVG（モックと同じ方式・`dataviz` skill 準拠）。チャートライブラリは入れない
- スタイルはモック `docs/mockups/viewer-mock.html` の CSS トークンを移植した単一グローバル CSS

### 構成

```
web/
  index.html
  vite.config.ts     # dev proxy: /api → http://127.0.0.1:4517
  src/
    main.tsx / App.tsx / router.ts   # ハッシュルーティング
    api.ts                           # 型付き fetch クライアント（DTO は server/core/types.ts と同形）
    lib/                             # view-model 純関数層（テストの主対象）
      chips.ts       # ツール名の種別分類・mcp__<server>__<tool> 分解
      thread.ts      # メイン列/sidechain 分離・tool_use ↔ tool_result 対応付け・表示行への平坦化
      exchanges.ts   # やりとり分割・コスト合算・compact 済みフラグ
      format.ts      # トークン数・金額の表示整形
    views/           # ProjectList（仮）/ SessionList（仮）/ Session
    components/      # MessageRow / ToolCall / SidechainGroup / TurnCostChart など
```

- **ロジックは lib/ の純関数に置き、コンポーネントは薄く保つ**。受け入れ基準の大半は lib/ を
  node 環境の Vitest で検証し、描画の要所だけ jsdom + `@testing-library/react` で検証する
- テストは `tests/unit/web/` に置く（`spec:check` の走査対象が `tests/` のため）
- tsconfig はルート 1 枚のまま `web/src` を include に足す（既に `lib: DOM`・`jsx: react-jsx` を
  持っているため分割の必要がない）。`npm run typecheck` は従来どおり `tsc --noEmit` 1 回
- 本番配信: `vite build` の成果物 `web/dist` が存在するとき Express が静的配信する。
  ハッシュルーティングなので fallback ミドルウェアは不要（`index.html` 1 枚で足りる）

## データの流れ

1. `GET /api/sessions/:id` で全レコードの軽量メタ（`IndexRecord`）+ 集計を取得し、画面骨格・
   やりとり別コスト・利用状況を組み立てる（最大セッションでも数 MB 程度のメタで収まる）
2. 本文（`MessageBody`）は `GET /api/sessions/:id/messages?start&limit` のページングで
   **表示範囲の分だけ遅延取得**する。取得済みページはメモリにキャッシュし再取得しない
3. メッセージ単位の推定コストは**サーバ側**で付与する（`estimateCost` の単一実装を使い、
   クライアントに単価計算を複製しない）。`/api/sessions/:id` の assistant メタに
   `cost: { total, unknownModel }` を足す（エンドポイント追加ではないため apiDrift 対象外）

## view-model の定義

- **やりとり（exchange）**: `kind === 'user' && !isToolResult && !isSidechain` のレコードで開始し、
  次の開始レコードの直前まで。やりとりのコストは範囲内の assistant（sidechain 含む）の合算
- **compact 済みやりとり**: `subtype === 'compact_boundary'` の system レコードより前に開始した
  やりとり。棒グラフでグレー表示・クリック不可とするが、コスト合計には含める（整合を崩さない）
- **sidechain 分岐**: `isSidechain === true` のレコードを `parentUuid` で連結して 1 分岐とし、
  メイン列から分離する。分岐はファイル内の出現位置でメイン列に挿入し、折りたたみで展開する
- **表示行**: メイン列レコード + 区切り（compact / turn_duration）+ sidechain グループを
  1 次元の行配列に平坦化し、仮想スクロールはこの行配列に対して行う
- **仮想スクロールの監視対象**: レイアウト上の実スクローラは `.appmain`（`overflow: auto`）で
  window はスクロールしない。そのため `useWindowVirtualizer` ではなく `useVirtualizer` +
  `getScrollElement`（`.appmain` を返す）を使う（Issue #40。window 監視だと描画範囲が
  先頭のまま更新されず、下へスクロールすると空白になる）。`scrollMargin` は offsetTop
  ではなく `.appmain` とリスト要素の getBoundingClientRect 差分 + scrollTop で明示計算する

## 受け入れ基準

### 画面骨格・簡易入口（#7 で本実装に置き換え）

- [x] `SPEC-CHAT-001` ハッシュルーティングでプロジェクト一覧 → セッション一覧 → セッション分析画面と遷移でき、パンくずで戻れる
- [x] `SPEC-CHAT-002` セッション分析画面のヘッダにモデル・総トークン・推定コスト・破損スキップ行数を表示し、コストには「推定」を明示する
- [x] `SPEC-CHAT-003` skippedLineCount が 1 以上のときだけ破損行スキップの注意を表示する
- [x] `SPEC-CHAT-004` プロジェクト一覧・プロジェクト詳細はセッションの cwd 由来の実パス（path）を返し、画面はディレクトリ名ではなく実パスを表示する（cwd が取れないときはディレクトリ名で代替）
- [x] `SPEC-CHAT-005` セッション数 0 のプロジェクトは既定で一覧に表示せず、チェックボックスを入れると表示される

### 種別チップ

- [x] `SPEC-CHAT-010` `mcp__<server>__<tool>` 形式のツール名を MCP としてサーバ名・ツール名に分解する
- [x] `SPEC-CHAT-011` Agent ツールは agent（subagentType 付き）、Skill ツールは skill（skill 名付き）、それ以外は tool に分類する
- [x] `SPEC-CHAT-012` 会話の冒頭に種別チップの凡例（tool / MCP / agent / skill / model）を表示する

### 会話表示

- [x] `SPEC-CHAT-020` tool_use と tool_result を tool_use_id で対応付け、既定で閉じた折りたたみとして表示する
- [x] `SPEC-CHAT-021` tool_result の is_error を失敗として明示する
- [x] `SPEC-CHAT-022` assistant メッセージに使用モデルのチップを表示し、thinking を含む場合はバッジを表示する
- [x] `SPEC-CHAT-023` compact_boundary の system レコードを compact 区切りとして表示する
- [x] `SPEC-CHAT-024` turn_duration の system レコードを「ターン完了 · 所要時間」区切りとして表示する
- [x] `SPEC-CHAT-025` メイン列レコード・区切り・sidechain グループを表示行の 1 次元配列へ平坦化する（仮想スクロールの入力）
- [x] `SPEC-CHAT-026` 本文はページング API で遅延取得し、取得済み範囲を再取得しない

### sidechain / subagent

- [x] `SPEC-CHAT-030` isSidechain のレコードを parentUuid で連結して分岐にまとめ、メイン列から分離する
- [x] `SPEC-CHAT-031` sidechain 分岐は折りたたみで展開でき、使用モデルと推定コストを表示する

### コスト

- [x] `SPEC-CHAT-040` GET /api/sessions/:id は assistant メタに推定コスト（total・unknownModel）を含める
- [x] `SPEC-CHAT-041` メッセージ単位でトークン内訳（input / output / cache read / cache write 5m・1h）と推定コストを表示する
- [x] `SPEC-CHAT-042` やりとりは sidechain と tool_result を除く user レコードごとに開始する
- [x] `SPEC-CHAT-043` 全やりとりのコスト合計（sidechain 含む）はセッションのコスト合計と一致する
- [x] `SPEC-CHAT-044` やりとり別コスト棒の帯クリックで会話をそのやりとりだけに絞り込み、解除できる
- [x] `SPEC-CHAT-045` compact_boundary より前に開始したやりとりは compacted とし、クリック対象から除外してもコスト合計に含める

### このセッションの利用状況

- [x] `SPEC-CHAT-050` ツール別ランキングを呼び出し回数の降順で表示する
- [x] `SPEC-CHAT-051` MCP サーバ / subagent / Skill の一覧を回数付きで表示する

### 配信

- [x] `SPEC-CHAT-060` web/dist が存在するとき Express はルートで index.html と静的アセットを配信する

### E2E（Issue #10・tests/e2e）

- [x] `SPEC-CHAT-070` Overview → プロジェクト → セッション分析へドリルダウンでき、パンくずで戻れる
- [x] `SPEC-CHAT-071` セッションヘッダにモデル・総トークン・推定コスト・破損スキップ行数が表示される
- [x] `SPEC-CHAT-072` ツール呼び出しは折りたたまれ、開くと入出力が読め、失敗（is_error）が明示される
- [x] `SPEC-CHAT-073` やりとり別コスト棒グラフの帯クリックで会話が絞り込まれ、解除できる
- [x] `SPEC-CHAT-074` 巨大行（50KB 超）を含むセッションの分析画面が表示される
- [x] `SPEC-CHAT-075` 画面に収まらない行数のセッションで、`.appmain` を末尾までスクロールすると最後の行が描画される

## 実測値（2026-08-06・Issue #6 実装時）

実ログ最大セッション（69.1 MB / 1,350 レコード / 32 やりとり / 推定 $282.02）に対して:

- `GET /api/sessions/:id`（全メタ + メッセージ単位コスト付き）: 約 70〜90ms / 748KB
- `GET /api/sessions/:id/messages?limit=100`（1 ページ）: 約 44ms / 119KB
- 仮想スクロール: 総高さ約 63,000px に対し DOM 描画は常時 21 行前後。スクロール・
  やりとり絞り込み（63,367px → 3,171px）・解除とも引っかかりなし。コンソールエラー 0

## 実測値（2026-08-11・Issue #40 実装時）

実ログセッション（440 レコード → 表示行 198 行・総高さ約 19,700px）に対して:

- 末尾までスクロールすると末尾の行（〜index 197）まで描画される（修正前は先頭
  ビューポート分のみ描画され、スクロールで空白になっていた）
- 描画行数は中間位置 23 行・末尾 20 行（viewport 720px・overscan 8。仮想化は維持。
  最上部はリスト開始位置がファーストビュー外のため overscan 分の 9 行のみで正常）
- SPEC-LIVE-060〜068（差分追記描画）の E2E は全件 green（非破壊を確認）
- 注意: 非表示タブ・非表示ペインでは scroll イベントがディスパッチされないため、
  ヘッドレス検証は表示状態のブラウザ（Playwright / 実ブラウザ）で行うこと

### 実装時に判明した事項（今後の Issue 候補）

現行の実ログでは sidechain が同一 JSONL 内の `isSidechain: true` 行ではなく、
セッションと同名のディレクトリ配下 `subagents/agent-*.jsonl` の**別ファイル**として
保存されている（新形式）。現状これらは独立したセッションとして一覧・閲覧できるが、
親セッションの分岐としての紐付け表示（SPEC-CHAT-030/031 の分岐 UI が新形式でも
発火する形）にはインデクサ側（SPEC-CORE）での対応付けが必要。#6 では旧形式
（同一ファイル内 sidechain）のみ分岐表示の対象とする。

---

# compaction 発生の可視化（Issue #52）

基本仕様は [docs/spec/CHAT.md](../spec/CHAT.md)。セッション一覧の回数列（summary 集計・API・列表示）は [docs/design/DASH.md](DASH.md) の同名セクション。Codex 側の調査記録（未観測 → 非表示）は [docs/design/CODEX.md](CODEX.md)。

## 実装方針

- 判定は既存の compact 区切り表示と同一の述語 `kind === 'system' && subtype === 'compact_boundary'` を使う（`web/src/lib/thread.ts` と同じ）。Codex 正規化はこの subtype を生成しないため、ソース分岐なしで Codex には何も表示されない
- **棒グラフのマーカー**: `web/src/lib/exchanges.ts` に純関数 `compactionMarkers(records, exchanges): number[]` を追加する。各 compact_boundary について「境界より前に開始したやりとりの数」を返す（= マーカーはそのやりとり位置の直前の帯境界に立つ）。`TurnCostChart` は各位置の帯境界 x に ⚡ テキストと縦破線を描画する（手書き SVG・チャートライブラリなしの方針を維持）
- **区切り線の通し番号**: `thread.ts` の `DividerRow`（type 'compact'）に `seq`（1 始まり）を追加する。`RowBuilder` が compact 行の生成数を内部カウンタで保持し、ライブ追記（増分 append）でも通し番号が続く。`DividerLine` は「⚡ compaction #N — 以前の会話を要約」を強調スタイル（CSS クラス追加)で表示する

## 受け入れ基準

- [x] `SPEC-CHAT-080` compactionMarkers は compact_boundary ごとに「境界より前に開始したやりとり数」を位置として返し、境界の無いレコード列では空配列を返す
- [x] `SPEC-CHAT-081` TurnCostChart はマーカー位置ごとに ⚡ マーカーを描画し、マーカー数はセッション内の compact_boundary 数と一致する。マーカーは tooltip（CSS :hover の自前吹き出し・0.3 秒遅延・影付き）で「compaction #N 発生」を説明する
- [x] `SPEC-CHAT-082` compact 区切り行には 1 始まりの通し番号 seq が付き、DividerLine は「compaction #N」を表示する
- [x] `SPEC-CHAT-083` RowBuilder の増分 append をまたいでも compact 区切りの通し番号が連番で継続する
