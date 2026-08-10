/**
 * ファイル監視とライブ差分配信のハブ。仕様は docs/design/LIVE.md。
 *
 * chokidar の変更検知 → SPEC-CORE の増分解析（buildIndex）→ 購読者ごとの既知件数
 * `have` からの差分送信、を一箇所で束ねる。SSE の書式化は routes/live.ts が担い、
 * ここは「何をいつ誰に送るか」だけを決める（テストが transport 抜きで検証できる形）。
 */
import { watch } from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { buildIndex } from './core/indexer.js';
import type { LogSource } from './sources/types.js';
import { estimateRecordsCost } from './cost.js';
import type { PriceTable } from './cost.js';
import type { CostSummary } from './cost.js';
import { toMessageMetas } from './messages.js';
import type { MessageMetaDto } from './messages.js';
import type { SessionSummary } from './core/types.js';

export interface LiveAppendPayload {
  /** この番号のレコードから messages を追記する（クライアント既知件数と一致）。 */
  start: number;
  messages: MessageMetaDto[];
  /** 更新後の全量（差分ではない）。/api/sessions/:id の同名フィールドと同形。 */
  summary: SessionSummary;
  cost: CostSummary;
}

/** hub が sink へ渡すイベント。id は配信後の総レコード件数（SSE の id: になる）。 */
export type LiveSentEvent =
  | { event: 'append'; id: number; data: LiveAppendPayload }
  | { event: 'reset'; id: number };

export interface LiveSink {
  send(event: LiveSentEvent): void;
}

/** 監視ルート 1 件（ソースとそのログディレクトリ）。 */
export interface LiveWatchRoot {
  source: LogSource;
  dir: string;
}

export interface LiveHubOptions {
  /** 監視するソースとルートの組（Issue #31 で logDir 単独から複数ソースへ拡張）。 */
  roots: LiveWatchRoot[];
  cacheDir: string;
  loadTable: () => Promise<PriceTable>;
  /** 同一ファイルの連続変更をまとめる待ち時間。既定 150ms。 */
  debounceMs?: number | undefined;
  /**
   * 購読中ファイルの stat ポーリング間隔。既定 1000ms。
   * macOS の fsevents は新規ディレクトリ連鎖直後の配下イベントを取りこぼすことがある
   * （#31 実測: 追記でも回復しない）ため、watcher の速報性を補う保証層として置く。
   * 対象は購読中のファイルだけなので stat のコストしか掛からない（SPEC-LIVE-005 と両立）。
   */
  pollMs?: number | undefined;
  /** テスト用の差し替え口。既定は SPEC-CORE の buildIndex。 */
  buildIndexFn?: typeof buildIndex | undefined;
}

export interface LiveHub {
  /**
   * セッションの差分購読を開始する。have はクライアントが既に持つレコード件数で、
   * それより新しいレコードがあれば購読直後に追い付き分を配信する。戻り値で解除する。
   */
  subscribe(sessionId: string, filePath: string, have: number, sink: LiveSink): () => void;
  /** ファイル変更の通知（watcher から。テストはこれと直接呼んで決定的に検証する）。 */
  notifyChange(filePath: string): void;
  /** watcher の初期走査完了を待つ（テストの追記が確実に検知されるように）。 */
  whenReady(): Promise<void>;
  subscriberCount(sessionId: string): number;
  close(): Promise<void>;
}

interface Subscriber {
  sessionId: string;
  filePath: string;
  have: number;
  sink: LiveSink;
}

export function createLiveHub(options: LiveHubOptions): LiveHub {
  const debounceMs = options.debounceMs ?? 150;
  const build = options.buildIndexFn ?? buildIndex;
  const subscribers = new Set<Subscriber>();
  const timers = new Map<string, NodeJS.Timeout>();
  /** セッションごとの解析・配信の直列化（購読直後と watcher の同時 refresh で二重配信しない）。 */
  const queues = new Map<string, Promise<void>>();
  const pollMs = options.pollMs ?? 1000;
  /** 購読中ファイルの最終観測（null = 不存在）。undefined（未観測）→ 初回は通知しない。 */
  const polled = new Map<string, { size: number; mtimeMs: number } | null>();
  let pollTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  let ready = Promise.resolve();
  let closed = false;

  /** パスがどのルート配下かで所属ソースを解決する（どのルートにも属さなければ undefined）。 */
  function sourceFor(filePath: string): LogSource | undefined {
    return options.roots.find((r) => filePath.startsWith(r.dir + sep) || filePath === r.dir)?.source;
  }

  /** 公開セッション id はソースの ID 規約に委ねる（claude = basename、codex = `codex:<basename>`）。 */
  function sessionIdOf(filePath: string): string | null {
    return sourceFor(filePath)?.sessionIdFor(filePath) ?? null;
  }

  function ensureWatcher(): void {
    if (watcher || closed) return;
    watcher = watch(
      options.roots.map((r) => r.dir),
      { ignoreInitial: true },
    );
    ready = new Promise((resolve) => watcher?.once('ready', () => resolve()));
    const onFile = (path: string): void => {
      if (path.endsWith('.jsonl')) notifyChange(path);
    };
    watcher.on('add', onFile);
    watcher.on('change', onFile);
    // 監視エラーで hub を落とさない（SPEC-LIVE-003）。対象は次の変更で再試行される
    watcher.on('error', () => undefined);
  }

  /**
   * ポーリングの基準値を購読時点で記録する。基準が初回 tick（ファイル作成後になり得る）だと
   * 「作成そのもの」を変化として検知できないため、購読と同時に現在の状態を観測しておく。
   */
  async function primeBaseline(filePath: string): Promise<void> {
    if (polled.has(filePath)) return;
    try {
      const stats = await stat(filePath);
      if (!polled.has(filePath)) polled.set(filePath, { size: stats.size, mtimeMs: stats.mtimeMs });
    } catch {
      if (!polled.has(filePath)) polled.set(filePath, null);
    }
  }

  /** watcher の取りこぼしを補う保証層。購読中ファイルの stat 変化だけを見る。 */
  async function pollOnce(): Promise<void> {
    const paths = new Set([...subscribers].map((s) => s.filePath));
    for (const known of [...polled.keys()]) if (!paths.has(known)) polled.delete(known);
    for (const filePath of paths) {
      let current: { size: number; mtimeMs: number } | null = null;
      try {
        const stats = await stat(filePath);
        current = { size: stats.size, mtimeMs: stats.mtimeMs };
      } catch {
        current = null; // 不存在・一時的に読めない状態も観測として扱う
      }
      const previous = polled.get(filePath);
      polled.set(filePath, current);
      if (previous === undefined) continue; // 初回観測は基準の記録のみ
      const changed =
        (previous === null) !== (current === null) ||
        (previous !== null &&
          current !== null &&
          (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs));
      if (changed) notifyChange(filePath);
    }
  }

  function ensurePolling(): void {
    if (pollTimer || closed) return;
    pollTimer = setInterval(() => void pollOnce().catch(() => undefined), pollMs);
    pollTimer.unref?.();
  }

  async function refresh(sessionId: string): Promise<void> {
    const subs = [...subscribers].filter((s) => s.sessionId === sessionId);
    const filePath = subs[0]?.filePath;
    if (filePath === undefined) return;

    try {
      // 再解析は所属ソースの正規化で行う（SPEC-LIVE-042。Claude パーサでの汚染を防ぐ）
      const [{ index }, table] = await Promise.all([
        build(filePath, { cacheDir: options.cacheDir, source: sourceFor(filePath) }),
        options.loadTable(),
      ]);
      // 配信済み状態をポーリング基準に反映する（watcher が拾った成長を二重解析しない）
      polled.set(filePath, { size: index.fileSize, mtimeMs: index.mtimeMs });
      const records = index.records;
      const cost = estimateRecordsCost(records, table);
      for (const sub of subs) {
        if (!subscribers.has(sub)) continue; // 配信待ちの間に切断されていたら送らない
        if (records.length < sub.have) {
          // 縮小 → 全再構築が起きた。クライアントは詳細を取得し直す（SPEC-LIVE-014）
          sub.have = records.length;
          sub.sink.send({ event: 'reset', id: records.length });
        } else if (records.length > sub.have) {
          const start = sub.have;
          sub.have = records.length;
          sub.sink.send({
            event: 'append',
            id: records.length,
            data: { start, messages: toMessageMetas(records, table, start), summary: index.summary, cost },
          });
        }
      }
    } catch {
      // 読めない・解析できない状態は一時的とみなし、この回の配信だけを諦める（SPEC-LIVE-003）
    }
  }

  function enqueueRefresh(sessionId: string): void {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => refresh(sessionId));
    queues.set(sessionId, next);
    void next.finally(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
  }

  function notifyChange(filePath: string): void {
    if (closed) return;
    const sessionId = sessionIdOf(filePath);
    // セッションでないファイル（ルート外・rollout 命名に合わない等）は扱わない
    if (sessionId === null) return;
    // 購読者がいないセッションは解析しない（SPEC-LIVE-005）
    if ([...subscribers].every((s) => s.sessionId !== sessionId)) return;
    const pending = timers.get(filePath);
    if (pending) clearTimeout(pending);
    timers.set(
      filePath,
      setTimeout(() => {
        timers.delete(filePath);
        enqueueRefresh(sessionId);
      }, debounceMs),
    );
  }

  return {
    subscribe(sessionId, filePath, have, sink) {
      ensureWatcher();
      ensurePolling();
      void primeBaseline(filePath);
      const sub: Subscriber = { sessionId, filePath, have, sink };
      subscribers.add(sub);
      enqueueRefresh(sessionId); // 追い付き配信（SPEC-LIVE-012）
      return () => subscribers.delete(sub);
    },
    notifyChange,
    whenReady: () => ready,
    subscriberCount(sessionId) {
      return [...subscribers].filter((s) => s.sessionId === sessionId).length;
    },
    async close() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      polled.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      subscribers.clear();
      await watcher?.close();
      watcher = undefined;
    },
  };
}
