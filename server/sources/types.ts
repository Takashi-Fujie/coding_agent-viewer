/**
 * ログソース抽象。仕様は docs/design/CORE.md（Issue #28）と docs/design/CODEX.md（Issue #29）。
 *
 * 「配下のセッションを発見し、グループと公開 ID を与える」責務と、
 * 「ソース固有のログ行を正規化 DTO へ写す」責務をソースごとに分離する。
 * viewer・API・集計はこの抽象の向こうにあるソース固有構造を一切知らない。
 */
import type { IndexRecord, RecordLocation } from '../core/types.js';
import type { MessageBody } from '../core/normalize.js';

/**
 * 1 走査分の正規化器。Codex のように行単位で完結しない解釈（turn_context の model を
 * 後続行へ関連付ける等）を持つソースは、ここに走査文脈を閉じ込める。
 */
export interface RecordNormalizer {
  /** 1 行を正規化する。レコードにしない行（メタ・複製）は null を返す。 */
  normalize(raw: unknown, location: RecordLocation): IndexRecord | null;
  /**
   * 走査文脈を直列化可能な形で返す（キャッシュへ保存し、増分再開時に
   * createNormalizer(state) で復元する）。文脈を持たないソースは undefined。
   */
  serialize(): unknown;
}

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
  /**
   * ファイルパス → 公開セッション ID（claude は basename、それ以外は `<source>:<basename>`）。
   * ライブ監視がファイルイベントを購読者の ID と照合するのに使う（SPEC-LIVE-040）。
   * セッションでないファイル（Codex の rollout 命名に合わない等）は null。
   */
  sessionIdFor(filePath: string): string | null;
  /** 1 走査分の正規化器を作る。state は前回 serialize() が返した走査文脈（増分再開用）。 */
  createNormalizer(state?: unknown): RecordNormalizer;
  /** 生レコード 1 件を表示用の本文へ正規化する（sessions ルートがソース別に呼ぶ）。 */
  normalizeBody(raw: unknown): MessageBody;
}
