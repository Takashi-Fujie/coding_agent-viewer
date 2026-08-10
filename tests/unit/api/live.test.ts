/**
 * SPEC-LIVE SSE 配信（GET /api/live）。仕様は docs/design/LIVE.md。
 *
 * SSE は長寿命ストリームなので supertest ではなく実 HTTP サーバ + fetch で検証する。
 * ブラウザの EventSource が自動で行う挙動（Last-Event-ID 送信）はヘッダで模す。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../server/app.js';
import { createLiveHub } from '../../../server/live.js';
import { createClaudeSource } from '../../../server/sources/claude.js';
import type { LiveHub } from '../../../server/live.js';
import { loadPriceTable } from '../../../server/cost.js';
import { appendJsonl, assistantLine, writeJsonl } from '../../helpers/fixtures.js';

const PROJECT = '-home-dev-live-api';
const SESSION_A = 'live-api-sess-a';
const SESSION_B = 'live-api-sess-b';

interface SseEvent {
  event: string;
  id: string | undefined;
  data: {
    start?: number;
    messages?: Array<{ uuid?: string; kind: string; cost?: { total: number } }>;
    summary?: { recordCount: number };
    cost?: { total: number };
  };
}

interface SseClient {
  status: number;
  contentType: string | null;
  events: SseEvent[];
  close: () => void;
}

const clients: SseClient[] = [];

/** SSE ストリームへ接続し、受信イベントを配列へ積み続けるクライアント。 */
async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const events: SseEvent[] = [];
  const client: SseClient = {
    status: res.status,
    contentType: res.headers.get('content-type'),
    events,
    close: () => controller.abort(),
  };
  clients.push(client);
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const lines = chunk.split('\n');
            const field = (name: string): string | undefined =>
              lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
            const data = field('data');
            const event = field('event');
            if (event === undefined || data === undefined) continue; // コメント行（ping）は捨てる
            events.push({ event, id: field('id'), data: JSON.parse(data) as SseEvent['data'] });
          }
        }
      } catch {
        // abort による切断は正常系
      }
    })();
  }
  return client;
}

let root: string;
let hub: LiveHub;
let server: Server;
let base: string;
let sessionAPath: string;
let sessionBPath: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ccv-live-api-'));
  const logDir = join(root, 'projects');
  const cacheDir = join(root, 'cache');
  await mkdir(join(logDir, PROJECT), { recursive: true });
  sessionAPath = join(logDir, PROJECT, `${SESSION_A}.jsonl`);
  sessionBPath = join(logDir, PROJECT, `${SESSION_B}.jsonl`);
  await writeJsonl(sessionAPath, [
    assistantLine({ uuid: 'a-1', timestamp: '2026-01-01T00:00:00.000Z' }),
    assistantLine({ uuid: 'a-2', timestamp: '2026-01-01T00:00:01.000Z' }),
    assistantLine({ uuid: 'a-3', timestamp: '2026-01-01T00:00:02.000Z' }),
  ]);
  await writeJsonl(sessionBPath, [assistantLine({ uuid: 'b-1' })]);

  hub = createLiveHub({ roots: [{ source: createClaudeSource({ logDir }), dir: logDir }], cacheDir, loadTable: () => loadPriceTable(), debounceMs: 10 });
  const app = createApp({ logDir, cacheDir, claudeDir: join(root, 'claude'), hub });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await hub.close();
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/live', () => {
  it('SPEC-LIVE-010: text/event-stream で応答し、session で指定したセッションの変更だけを配信する', async () => {
    const client = await openSse(`${base}/api/live?session=${SESSION_A}&have=3`);
    expect(client.status).toBe(200);
    expect(client.contentType).toContain('text/event-stream');

    // 購読していない B へ追記 → 配信されない
    await appendJsonl(sessionBPath, [assistantLine({ uuid: 'b-2' })]);
    hub.notifyChange(sessionBPath);
    // 購読している A へ追記 → これだけが届く
    await appendJsonl(sessionAPath, [assistantLine({ uuid: 'a-4', timestamp: '2026-01-01T00:00:03.000Z' })]);
    hub.notifyChange(sessionAPath);

    await vi.waitFor(() => expect(client.events.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(client.events.length).toBe(1);
    expect(client.events[0]?.event).toBe('append');
    expect(client.events[0]?.data.messages?.map((m) => m.uuid)).toEqual(['a-4']);
  });

  it('SPEC-LIVE-011: append は追加メッセージ（コスト付き）と更新後の summary / cost を含み、id は総レコード件数になる', async () => {
    const client = await openSse(`${base}/api/live?session=${SESSION_A}&have=4`);
    await appendJsonl(sessionAPath, [assistantLine({ uuid: 'a-5', timestamp: '2026-01-01T00:00:04.000Z' })]);
    hub.notifyChange(sessionAPath);

    await vi.waitFor(() => expect(client.events.length).toBe(1), { timeout: 5000 });
    const event = client.events[0];
    expect(event?.id).toBe('5');
    expect(event?.data.start).toBe(4);
    const message = event?.data.messages?.[0];
    expect(message?.kind).toBe('assistant');
    // assistant にはメッセージ単位の推定コストが付く（/api/sessions/:id の messages と同形）
    expect(message?.cost?.total).toBeGreaterThan(0);
    expect(event?.data.summary?.recordCount).toBe(5);
    expect(event?.data.cost?.total).toBeGreaterThan(0);
  });

  it('SPEC-LIVE-012: 接続時に have より新しいレコードがあれば直ちに追い付き分を配信する', async () => {
    const client = await openSse(`${base}/api/live?session=${SESSION_A}&have=1`);
    await vi.waitFor(() => expect(client.events.length).toBe(1), { timeout: 5000 });
    const event = client.events[0];
    expect(event?.event).toBe('append');
    expect(event?.data.start).toBe(1);
    expect(event?.data.messages?.[0]?.uuid).toBe('a-2');
  });

  it('SPEC-LIVE-013: Last-Event-ID ヘッダは have クエリより優先され、再接続時の追い付き起点になる', async () => {
    const client = await openSse(`${base}/api/live?session=${SESSION_A}&have=0`, { 'Last-Event-ID': '4' });
    await vi.waitFor(() => expect(client.events.length).toBe(1), { timeout: 5000 });
    const event = client.events[0];
    // have=0 なら a-1 からになるところ、Last-Event-ID=4 が優先されて 5 件目からになる
    expect(event?.data.start).toBe(4);
    expect(event?.data.messages?.[0]?.uuid).toBe('a-5');
  });

  it('SPEC-LIVE-014: 全再構築でレコード件数が減ったら reset イベントを配信する', async () => {
    const client = await openSse(`${base}/api/live?session=${SESSION_B}&have=2`);
    // B を 1 行へ縮小 → 全再構築 → 件数減
    await writeJsonl(sessionBPath, [assistantLine({ uuid: 'b-rebuilt' })]);
    hub.notifyChange(sessionBPath);

    await vi.waitFor(() => expect(client.events.length).toBe(1), { timeout: 5000 });
    expect(client.events[0]?.event).toBe('reset');
  });

  it('SPEC-LIVE-015: 存在しない session id には SSE を開始せず 404 と JSON エラーを返す', async () => {
    const res = await fetch(`${base}/api/live?session=no-such-session`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('no-such-session');
  });

  it('SPEC-LIVE-016: クライアントの切断で購読が解除され、以後の変更が残った接続にだけ配信される', async () => {
    const staying = await openSse(`${base}/api/live?session=${SESSION_A}&have=5`);
    const leaving = await openSse(`${base}/api/live?session=${SESSION_A}&have=5`);
    await vi.waitFor(() => expect(hub.subscriberCount(SESSION_A)).toBe(2), { timeout: 5000 });

    leaving.close();
    await vi.waitFor(() => expect(hub.subscriberCount(SESSION_A)).toBe(1), { timeout: 5000 });

    await appendJsonl(sessionAPath, [assistantLine({ uuid: 'a-6', timestamp: '2026-01-01T00:00:05.000Z' })]);
    hub.notifyChange(sessionAPath);
    await vi.waitFor(() => expect(staying.events.length).toBe(1), { timeout: 5000 });
    expect(staying.events[0]?.data.messages?.map((m) => m.uuid)).toEqual(['a-6']);
    expect(leaving.events.length).toBe(0);
  });
});
