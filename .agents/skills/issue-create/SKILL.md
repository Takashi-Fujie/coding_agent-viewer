---
name: issue-create
description: Issue の作成（GitHub 反映）までを定型化する。新しい Issue を起こすとき、backlog の Issue の内容を確定するとき、「次の Issue を始めたい」と言われたときに使う。main 更新 → 対象確定 → Issue 作成/確認 までを行い、仕様書の編集・ブランチ作成・実装には入らない。
---

# Issue 作成

1 Issue = 1 ブランチ = 1 PR。このスキルは **GitHub への Issue 反映まで**を担当する。仕様書の編集を含む実装サイクルは `dev-cycle` スキルを使う。

## 手順

### 1. main を最新化する

```bash
git switch main && git pull --ff-only
```

前の Issue のブランチに居たまま着手しない。マージ済みブランチは `git branch -d` で消してよい。

### 2. 対象 Issue を確定する

- **backlog にある場合**（`gh issue list` で確認）: その Issue を使う。内容が古ければ `gh issue edit` で更新する。
- **新規の場合**: 先にタイトルと本文の案を作成してユーザーに提示し、**確認の返答を得てから登録する**。確認前に `gh issue create` を実行しない:

```bash
gh issue create --title "SPEC-<領域>: <要約>" --body "$(cat <<'EOF'
## 対象
- 基本仕様書: docs/spec/<領域>.md
- 詳細設計書: docs/design/<領域>.md

## やりたいこと（要約）
- ...

仕様の詳細は上記ファイルを正とする。受け入れ基準は dev-cycle で詳細設計書に記入する。
EOF
)"
```

Issue 本文に書くのは **SPEC-ID・領域と要約のみ**。詳細仕様・実測値・ログ内容は書かない（public リポジトリ）。

エージェントが Issue にコメントする場合は、冒頭に `🤖 **Claude (agent)**` の行を付ける（gh はユーザー名義で書き込むため）。

### 3. 完了報告

Issue 番号と対象領域を報告して、このスキルは完了。以降（ブランチ作成 → 基本仕様書 → オーナー確認 → 詳細設計書 → TDD）は `dev-cycle` へ。
