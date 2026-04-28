// packages/server/src/gateway/rpc/methods/memory.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FinClawLogger, resetEventBus } from '@finclaw/infra';
import {
  addMemory,
  addMemoryWithEmbedding,
  type Database,
  type EmbeddingProvider,
  openDatabase,
} from '@finclaw/storage';
import type { MemoryEntry, RpcMethod, SessionKey, Timestamp } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultMemoryCaptureService } from '../../../auto-reply/stages/memory-capture.js';
import type { GatewayServerContext } from '../../context.js';
import { RpcErrors } from '../errors.js';
import { clearMethods, dispatchRpc } from '../index.js';
import type { GatewayServerConfig } from '../types.js';
import { registerMemoryMethods } from './memory.js';

const DIMS = 1024;
const sessionA = 'session-a' as SessionKey;
const sessionB = 'session-b' as SessionKey;
const baseTime = 1_700_000_000_000 as Timestamp;

function makeServerCtx(): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: { activeCount: () => 0 } as GatewayServerContext['registry'],
    broadcaster: {} as GatewayServerContext['broadcaster'],
    isDraining: false,
  };
}

const tokenCtx = {
  auth: { level: 'token' as const, permissions: [] },
  remoteAddress: '127.0.0.1',
};

function call(method: string, params: unknown) {
  return dispatchRpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: method as RpcMethod,
      params: params as Record<string, unknown>,
    },
    tokenCtx,
    makeServerCtx(),
  );
}

function makeEntry(
  id: string,
  content: string,
  options?: { type?: MemoryEntry['type']; sessionKey?: SessionKey; createdAt?: Timestamp },
): MemoryEntry {
  return {
    id,
    sessionKey: options?.sessionKey ?? sessionA,
    content,
    type: options?.type ?? 'fact',
    createdAt: options?.createdAt ?? baseTime,
  };
}

/** 결정론적 mock embedding provider — query 길이를 시드로 1-hot vector. */
function mockProvider(): EmbeddingProvider {
  return {
    id: 'mock',
    model: 'mock-1024',
    dimensions: DIMS,
    async embedQuery(text: string): Promise<number[]> {
      const v = Array.from<number>({ length: DIMS }).fill(0);
      v[text.length % DIMS] = 1.0;
      return v;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const v = Array.from<number>({ length: DIMS }).fill(0);
        v[t.length % DIMS] = 1.0;
        return v;
      });
    },
  };
}

describe('memory.* RPC methods', () => {
  let tmpDir: string;
  let database: Database;

  beforeEach(() => {
    clearMethods();
    resetEventBus();
    tmpDir = mkdtempSync(join(tmpdir(), 'finclaw-rpc-mem-'));
    database = openDatabase({ path: join(tmpDir, 'rpc.db') });
  });

  afterEach(() => {
    database.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── provider availability ──
  describe('provider availability', () => {
    it('memory.list errors with provider_unavailable when db missing', async () => {
      registerMemoryMethods({});
      const result = await call('memory.list', {});
      expect((result as { error: { message: string } }).error.message).toContain(
        'provider_unavailable',
      );
    });

    it('memory.delete errors with provider_unavailable when db missing', async () => {
      registerMemoryMethods({});
      const result = await call('memory.delete', { memoryId: 'm1' });
      expect((result as { error: { message: string } }).error.message).toContain(
        'provider_unavailable',
      );
    });

    it('memory.search errors with provider_unavailable when db missing', async () => {
      registerMemoryMethods({});
      const result = await call('memory.search', { query: 'hello' });
      expect((result as { error: { message: string } }).error.message).toContain(
        'provider_unavailable',
      );
    });
  });

  // ── schema validation ──
  describe('schema validation', () => {
    it('memory.list rejects limit > 500', async () => {
      registerMemoryMethods({ db: database.db });
      const result = await call('memory.list', { limit: 9999 });
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('memory.delete rejects empty memoryId', async () => {
      registerMemoryMethods({ db: database.db });
      const result = await call('memory.delete', { memoryId: '' });
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('memory.search rejects empty query', async () => {
      registerMemoryMethods({ db: database.db });
      const result = await call('memory.search', { query: '' });
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('memory.list requires token auth', async () => {
      registerMemoryMethods({ db: database.db });
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'memory.list', params: {} },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });

  // ── memory.list ──
  describe('memory.list', () => {
    it('returns empty array on empty DB', async () => {
      registerMemoryMethods({ db: database.db });
      const result = await call('memory.list', {});
      const r = (result as { result: { memories: unknown[] } }).result;
      expect(r.memories).toEqual([]);
    });

    it('returns all memories across sessions in created_at DESC order', async () => {
      addMemory(
        database.db,
        makeEntry('m1', 'older fact alpha', {
          sessionKey: sessionA,
          createdAt: 1_000 as Timestamp,
        }),
      );
      addMemory(
        database.db,
        makeEntry('m2', 'newer fact bravo', {
          sessionKey: sessionB,
          createdAt: 2_000 as Timestamp,
        }),
      );

      registerMemoryMethods({ db: database.db });
      const result = await call('memory.list', {});
      const r = (
        result as {
          result: { memories: Array<{ id: string; createdAt: number; sessionKey: string }> };
        }
      ).result;

      expect(r.memories).toHaveLength(2);
      expect(r.memories[0].id).toBe('m2');
      expect(r.memories[0].sessionKey).toBe(sessionB as string);
      expect(r.memories[1].id).toBe('m1');
    });

    it('filters by type', async () => {
      addMemory(database.db, makeEntry('m1', 'fact one', { type: 'fact' }));
      addMemory(database.db, makeEntry('m2', 'pref one', { type: 'preference' }));
      addMemory(database.db, makeEntry('m3', 'fin one', { type: 'financial' }));

      registerMemoryMethods({ db: database.db });
      const result = await call('memory.list', { type: 'preference' });
      const r = (result as { result: { memories: Array<{ id: string; type: string }> } }).result;

      expect(r.memories).toHaveLength(1);
      expect(r.memories[0].id).toBe('m2');
      expect(r.memories[0].type).toBe('preference');
    });

    it('filters by sessionKey', async () => {
      addMemory(database.db, makeEntry('m1', 'session a one', { sessionKey: sessionA }));
      addMemory(database.db, makeEntry('m2', 'session b one', { sessionKey: sessionB }));

      registerMemoryMethods({ db: database.db });
      const result = await call('memory.list', { sessionKey: sessionA as string });
      const r = (result as { result: { memories: Array<{ id: string }> } }).result;

      expect(r.memories).toHaveLength(1);
      expect(r.memories[0].id).toBe('m1');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        addMemory(
          database.db,
          makeEntry(`m${i}`, `content ${i} body`, { createdAt: (i * 1_000) as Timestamp }),
        );
      }
      registerMemoryMethods({ db: database.db });
      const result = await call('memory.list', { limit: 2 });
      const r = (result as { result: { memories: unknown[] } }).result;
      expect(r.memories).toHaveLength(2);
    });
  });

  // ── memory.delete ──
  describe('memory.delete', () => {
    it('deletes existing memory and removes from FTS index', async () => {
      addMemory(database.db, makeEntry('m1', 'to be deleted body'));

      // 사전 조건: FTS 에 기록 존재
      const ftsBefore = database.db
        .prepare('SELECT COUNT(*) as c FROM memory_chunks_fts WHERE memory_id = ?')
        .get('m1') as unknown as { c: number };
      expect(ftsBefore.c).toBeGreaterThan(0);

      registerMemoryMethods({ db: database.db });
      const result = await call('memory.delete', { memoryId: 'm1' });
      const r = (result as { result: { deleted: boolean } }).result;

      expect(r.deleted).toBe(true);

      // memories 행 삭제 확인
      const memRow = database.db.prepare('SELECT id FROM memories WHERE id = ?').get('m1');
      expect(memRow).toBeUndefined();

      // FTS 인덱스에서도 제거 — 검색 결과 0건
      const ftsAfter = database.db
        .prepare('SELECT COUNT(*) as c FROM memory_chunks_fts WHERE memory_id = ?')
        .get('m1') as unknown as { c: number };
      expect(ftsAfter.c).toBe(0);

      // memory_chunks_vec 도 비어야 함 (CASCADE + manual delete)
      const vecAfter = database.db
        .prepare(
          'SELECT COUNT(*) as c FROM memory_chunks_vec WHERE chunk_id IN (SELECT id FROM memory_chunks WHERE memory_id = ?)',
        )
        .get('m1') as unknown as { c: number };
      expect(vecAfter.c).toBe(0);
    });

    it('returns deleted: false for unknown memoryId (idempotent — no NOT_FOUND)', async () => {
      registerMemoryMethods({ db: database.db });
      const result = await call('memory.delete', { memoryId: 'nonexistent-id' });
      // 에러가 아니라 정상 응답으로 deleted: false
      expect('error' in (result as object)).toBe(false);
      const r = (result as { result: { deleted: boolean } }).result;
      expect(r.deleted).toBe(false);
    });

    it('memory.delete after addMemoryWithEmbedding cleans vec0 too', async () => {
      const provider = mockProvider();
      await addMemoryWithEmbedding(database.db, makeEntry('m1', 'embedded content here'), provider);

      const vecBefore = database.db
        .prepare('SELECT COUNT(*) as c FROM memory_chunks_vec')
        .get() as unknown as { c: number };
      expect(vecBefore.c).toBeGreaterThan(0);

      registerMemoryMethods({ db: database.db });
      const result = await call('memory.delete', { memoryId: 'm1' });
      expect((result as { result: { deleted: boolean } }).result.deleted).toBe(true);

      const vecAfter = database.db
        .prepare('SELECT COUNT(*) as c FROM memory_chunks_vec')
        .get() as unknown as { c: number };
      expect(vecAfter.c).toBe(0);
    });
  });

  // ── memory.search ──
  describe('memory.search', () => {
    it('FTS-only fallback finds memory by substring when no embeddingProvider', async () => {
      addMemory(database.db, makeEntry('m1', 'finance market overview'));
      addMemory(database.db, makeEntry('m2', 'unrelated grocery list'));

      registerMemoryMethods({ db: database.db });
      const result = await call('memory.search', { query: 'finance' });
      const r = (
        result as {
          result: { results: Array<{ id: string; content: string; score: number }> };
        }
      ).result;

      expect(r.results.length).toBeGreaterThanOrEqual(1);
      expect(r.results.some((h) => h.id === 'm1')).toBe(true);
      expect(r.results.every((h) => typeof h.score === 'number')).toBe(true);
    });

    it('hybrid search (vector + FTS) returns results without error when provider given', async () => {
      // mock provider 의 1-hot 벡터는 query/chunk 길이가 같아야 cosine 1.0.
      // 매칭 보장을 위해 query 와 동일한 chunk 텍스트(7 chars 'finance')를 sequence 로 추가한 메모리 사용.
      const provider = mockProvider();
      await addMemoryWithEmbedding(database.db, makeEntry('m1', 'finance'), provider);

      registerMemoryMethods({ db: database.db, embeddingProvider: provider });
      const result = await call('memory.search', { query: 'finance' });

      // 에러 없이 result 반환되는 것이 핵심 검증. hybrid 가 vector+FTS 둘 다 호출하므로
      // 둘 중 하나라도 매칭되면 results 에 등장. 형태도 검증.
      expect('error' in (result as object)).toBe(false);
      const r = (result as { result: { results: Array<{ id: string; score: number }> } }).result;
      expect(Array.isArray(r.results)).toBe(true);
      // 'finance' 가 정확히 같은 chunk 텍스트라 vector cosine = 1.0 → m1 등장 보장
      expect(r.results.some((h) => h.id === 'm1')).toBe(true);
      // memory 단위 dedup: m1 정확히 1번
      expect(r.results.filter((h) => h.id === 'm1').length).toBe(1);
    });

    it('respects types filter', async () => {
      addMemory(database.db, makeEntry('m1', 'finance market alpha', { type: 'financial' }));
      addMemory(database.db, makeEntry('m2', 'finance market bravo', { type: 'fact' }));

      registerMemoryMethods({ db: database.db });
      const result = await call('memory.search', { query: 'finance', types: ['financial'] });
      const r = (result as { result: { results: Array<{ id: string; type: string }> } }).result;

      // financial 타입만 필터되어야 함
      expect(r.results.every((h) => h.type === 'financial')).toBe(true);
      expect(r.results.some((h) => h.id === 'm1')).toBe(true);
      expect(r.results.some((h) => h.id === 'm2')).toBe(false);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        addMemory(database.db, makeEntry(`m${i}`, `finance market item ${i}`));
      }
      registerMemoryMethods({ db: database.db });
      const result = await call('memory.search', { query: 'finance', limit: 2 });
      const r = (result as { result: { results: unknown[] } }).result;
      expect(r.results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty results for query with no matches', async () => {
      addMemory(database.db, makeEntry('m1', 'abcdef body content'));
      registerMemoryMethods({ db: database.db });
      const result = await call('memory.search', { query: 'zzznevermatch' });
      const r = (result as { result: { results: unknown[] } }).result;
      expect(r.results).toEqual([]);
    });
  });

  // ── 경계면 통합: search ↔ delete ──
  describe('integration: search after delete', () => {
    it('memory.search returns 0 results after memory.delete (FTS-only)', async () => {
      addMemory(database.db, makeEntry('m1', 'finance market deletable'));

      registerMemoryMethods({ db: database.db });

      // 사전: search 가 m1 을 찾음
      const before = await call('memory.search', { query: 'deletable' });
      const beforeR = (before as { result: { results: Array<{ id: string }> } }).result;
      expect(beforeR.results.some((h) => h.id === 'm1')).toBe(true);

      // 삭제
      const del = await call('memory.delete', { memoryId: 'm1' });
      expect((del as { result: { deleted: boolean } }).result.deleted).toBe(true);

      // 사후: search 결과 0건 (FTS 인덱스에서 제거됨)
      const after = await call('memory.search', { query: 'deletable' });
      const afterR = (after as { result: { results: unknown[] } }).result;
      expect(afterR.results).toEqual([]);
    });
  });

  // ── 경계면 통합: capture ↔ memory.list (Phase 26 B QA) ──
  describe('integration: capture followed by memory.list', () => {
    it('MemoryCaptureService capture followed by memory.list returns the captured entry', async () => {
      // 같은 db 를 capture service 와 RPC 가 공유 — production 와 동일한 boundary
      const logger: FinClawLogger = {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn().mockReturnThis(),
        flush: vi.fn().mockResolvedValue(undefined),
      } as unknown as FinClawLogger;
      const capture = new DefaultMemoryCaptureService({
        db: database.db,
        // 외부 API 키 없이 통과해야 하므로 embeddingProvider 미주입 (FTS-only).
        logger,
      });

      // 1) "!finclaw remember 분기 리밸런싱" 발화 → capture
      const result = await capture.capture('!finclaw remember 분기 리밸런싱', sessionA);
      expect(result).not.toBeNull();
      if (!result) {
        return;
      }
      expect(result.duplicate).toBe(false);
      expect(result.type).toBe('fact');
      expect(result.content).toBe('분기 리밸런싱');

      // 2) 같은 db 로 memory.list RPC 호출
      registerMemoryMethods({ db: database.db });
      const listResp = await call('memory.list', { limit: 50 });
      const list = (
        listResp as {
          result: {
            memories: Array<{
              id: string;
              content: string;
              type: string;
              sessionKey: string;
            }>;
          };
        }
      ).result;

      // 3) capture 한 항목이 그대로 보임 (id / content / type='fact' / sessionKey 일치)
      const found = list.memories.find((m) => m.id === result.memoryId);
      expect(found).toBeDefined();
      expect(found?.content).toBe('분기 리밸런싱');
      expect(found?.type).toBe('fact');
      expect(found?.sessionKey).toBe(sessionA);
    });
  });
});
