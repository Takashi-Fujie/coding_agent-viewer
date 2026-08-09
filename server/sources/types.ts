/**
 * ログソース抽象。仕様は docs/design/CORE.md（Issue #28）。
 *
 * 「配下のセッションを発見し、グループと公開 ID を与える」責務をソースごとに分離する。
 * 発見はパスと命名だけで成立させ、ファイルの中身は読まない（解析は store 側の buildIndex）。
 *
 * 返り値はグループ単位。セッションを 1 件も持たないグループ（.jsonl の無いプロジェクト
 * ディレクトリ）も表現できるようにする（旧 loadSnapshot は空プロジェクトを返していた）。
 */

export interface DiscoveredSession {
  /** API に露出する公開 ID。既定ソース（claude）は basename のまま、それ以外は `<source>:<basename>`。 */
  sessionId: string;
  filePath: string;
}

export interface DiscoveredGroup {
  /** グループ（プロジェクト相当）の ID。claude はディレクトリ名、codex は日付 `YYYY-MM-DD`。 */
  groupId: string;
  sessions: DiscoveredSession[];
}

export interface LogSource {
  /** ソース識別子（'claude' / 'codex'）。ID 接頭辞の名前空間に使う。 */
  id: string;
  /** ルート配下を走査してグループとセッションの一覧を返す。ルートが無ければ空配列（エラーにしない）。 */
  discoverGroups(): Promise<DiscoveredGroup[]>;
}
