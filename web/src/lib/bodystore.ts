/**
 * 本文ページの遅延取得とキャッシュ（SPEC-CHAT-026 / SPEC-LIVE-024）。仕様は docs/design/CHAT.md・LIVE.md。
 *
 * 本文はメタと違い重い（最大 50KB/行）ので、表示範囲のページだけを取得し、
 * 取得済みページは再取得しない。ライブ追記で総件数が増えても取得済み本文は
 * 破棄せず、部分ページの不足分だけを取得して合流する。
 */
import type { MessageBody } from './types';

export interface BodyStoreOptions {
  pageSize: number;
  /** セッションの総レコード数。末尾ページの limit 計算に使う。 */
  total: number;
  fetchPage: (start: number, limit: number) => Promise<MessageBody[]>;
}

export interface BodyStore {
  /** index 番目の本文を返す。未取得なら不足分を取得する。 */
  ensure: (index: number) => Promise<MessageBody | undefined>;
  /** 取得済みなら同期で返す（仮想スクロールの描画用）。 */
  peek: (index: number) => MessageBody | undefined;
  /**
   * ライブ追記で総件数が増えたときに呼ぶ（SPEC-LIVE-024）。
   * 取得済み本文は破棄しない。以後の ensure が新しい total に基づいて不足分を取得する。
   */
  grow: (newTotal: number) => void;
}

interface PageState {
  /** ページ先頭からの取得済み本文（先頭から隙間なく埋まる）。 */
  items: MessageBody[];
  /** 不足分取得の in-flight。二重取得を防ぐ。 */
  inflight?: Promise<void>;
}

export function createBodyStore(options: BodyStoreOptions): BodyStore {
  const { pageSize, fetchPage } = options;
  let total = options.total;
  const states = new Map<number, PageState>();

  function stateOf(page: number): PageState {
    let state = states.get(page);
    if (!state) {
      state = { items: [] };
      states.set(page, state);
    }
    return state;
  }

  return {
    async ensure(index) {
      const page = Math.floor(index / pageSize);
      const offset = index - page * pageSize;
      const state = stateOf(page);
      // 不足分の取得を、対象 index が埋まるまで繰り返す（取得中に total が伸びても追随できる）
      while (state.items.length <= offset) {
        if (!state.inflight) {
          const start = page * pageSize + state.items.length;
          const limit = Math.min(pageSize - state.items.length, total - start);
          if (limit <= 0) return undefined;
          state.inflight = fetchPage(start, limit)
            .then((fetched) => {
              state.items.push(...fetched);
            })
            .finally(() => {
              delete state.inflight;
            });
        }
        const before = state.items.length;
        try {
          await state.inflight;
        } catch {
          // 失敗はこの回だけ諦める。キャッシュには残さないので次の ensure が再試行する
        }
        if (state.items.length === before) break;
      }
      return state.items[offset];
    },
    peek(index) {
      const page = Math.floor(index / pageSize);
      return states.get(page)?.items[index - page * pageSize];
    },
    grow(newTotal) {
      if (newTotal > total) total = newTotal;
    },
  };
}
