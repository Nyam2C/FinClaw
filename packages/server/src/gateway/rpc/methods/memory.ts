// packages/server/src/gateway/rpc/methods/memory.ts
import type { DatabaseSync } from 'node:sqlite';
import {
  deleteMemory,
  getMemory,
  mergeHybridResults,
  searchFts,
  searchVector,
  type EmbeddingProvider,
} from '@finclaw/storage';
import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { z } from 'zod/v4';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

/**
 * memory.* RPC 메서드 의존성 (main.ts 에서 주입).
 *
 * - `db` 가 없으면 모든 메서드는 `provider_unavailable` 에러.
 * - `embeddingProvider` 가 없으면 memory.search 는 FTS-only fallback (디버깅 용 raw 검색).
 *   임계값/신선도/상한 적용은 본 RPC 의 책임이 아님 (밀스톤 C 의 RAG 스테이지).
 */
export interface MemoryRpcDeps {
  readonly db?: DatabaseSync;
  readonly embeddingProvider?: EmbeddingProvider;
}

// ─── 타입 ───

type MemoryType = MemoryEntry['type']; // 'fact' | 'preference' | 'summary' | 'financial'

interface MemoryRow {
  id: string;
  session_key: string;
  content: string;
  type: string;
  created_at: number;
  metadata: string;
}

interface MemoryListItem {
  id: string;
  sessionKey: SessionKey;
  content: string;
  type: MemoryType;
  createdAt: Timestamp;
}

interface MemorySearchHit {
  id: string;
  content: string;
  type: MemoryType;
  score: number;
  createdAt: Timestamp;
}

// ─── 헬퍼 ───

const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 500;
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MAX = 50;

const MEMORY_TYPES = ['fact', 'preference', 'summary', 'financial'] as const;

function rowToListItem(row: MemoryRow): MemoryListItem {
  return {
    id: row.id,
    sessionKey: row.session_key as SessionKey,
    content: row.content,
    type: row.type as MemoryType,
    createdAt: row.created_at as Timestamp,
  };
}

/** 모든 세션을 가로지르는 memories 조회 (created_at DESC). storage 에 동등 함수가 없어 직접 SQL. */
function listMemoriesAcrossSessions(
  db: DatabaseSync,
  options: { type?: MemoryType; sessionKey?: string; limit: number },
): MemoryListItem[] {
  let sql = 'SELECT * FROM memories WHERE 1=1';
  const params: (string | number)[] = [];

  if (options.type) {
    sql += ' AND type = ?';
    params.push(options.type);
  }
  if (options.sessionKey) {
    sql += ' AND session_key = ?';
    params.push(options.sessionKey);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(options.limit);

  const rows = db.prepare(sql).all(...params) as unknown as MemoryRow[];
  return rows.map(rowToListItem);
}

// ─── 등록 ───

/**
 * memory.* RPC 메서드 일괄 등록.
 * deps.db 미주입 시 모든 메서드 호출이 provider_unavailable.
 */
export function registerMemoryMethods(deps: MemoryRpcDeps): void {
  // ── memory.list ──
  const memoryListHandler: RpcMethodHandler<
    {
      type?: MemoryType;
      sessionKey?: string;
      limit?: number;
    },
    unknown
  > = {
    method: 'memory.list',
    description: '저장된 기억 목록을 조회합니다 (created_at DESC, 최신순)',
    authLevel: 'token',
    schema: z.object({
      type: z.enum(MEMORY_TYPES).optional(),
      sessionKey: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const limit = params.limit ?? LIMIT_DEFAULT;
      const memories = listMemoriesAcrossSessions(deps.db, {
        type: params.type,
        sessionKey: params.sessionKey,
        limit,
      });
      return { memories };
    },
  };

  // ── memory.delete (멱등) ──
  const memoryDeleteHandler: RpcMethodHandler<{ memoryId: string }, unknown> = {
    method: 'memory.delete',
    description: '기억을 삭제합니다 (DB + memory_chunks_vec/fts 인덱스 동시 cleanup, 멱등)',
    authLevel: 'token',
    schema: z.object({
      memoryId: z.string().min(1),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      // storage.deleteMemory 는 vec0 + FTS5 + memories 를 한 트랜잭션에서 정리.
      // 미존재 시 false 반환 — 멱등하게 통과시킴 (NOT_FOUND 에러 X).
      const deleted = deleteMemory(deps.db, params.memoryId);
      return { deleted };
    },
  };

  // ── memory.search ──
  // 디버깅 용 raw 검색. embeddingProvider 가 있으면 vector + FTS hybrid,
  // 없으면 FTS-only. 임계값/신선도/상한 적용은 본 RPC 의 책임이 아님.
  const memorySearchHandler: RpcMethodHandler<
    {
      query: string;
      limit?: number;
      types?: MemoryType[];
    },
    unknown
  > = {
    method: 'memory.search',
    description: '기억을 검색합니다 (vector+FTS hybrid 또는 FTS-only fallback)',
    authLevel: 'token',
    schema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
      types: z.array(z.enum(MEMORY_TYPES)).min(1).optional(),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const limit = params.limit ?? SEARCH_LIMIT_DEFAULT;

      // 1) hybrid 검색 (provider 있을 때) 또는 FTS-only fallback
      let chunkResults;
      if (deps.embeddingProvider) {
        const provider = deps.embeddingProvider;
        const [vecResults, ftsResults] = await Promise.all([
          searchVector(deps.db, params.query, provider, limit * 2),
          Promise.resolve(searchFts(deps.db, params.query, limit * 2)),
        ]);
        chunkResults = mergeHybridResults(vecResults, ftsResults, { limit: limit * 2 });
      } else {
        chunkResults = searchFts(deps.db, params.query, limit * 2);
      }

      // 2) memoryId 단위로 dedupe + 본문/metadata 보강
      const seen = new Set<string>();
      const hits: MemorySearchHit[] = [];
      for (const r of chunkResults) {
        if (seen.has(r.memoryId)) {
          continue;
        }
        seen.add(r.memoryId);
        const entry = getMemory(deps.db, r.memoryId);
        if (!entry) {
          continue;
        }
        if (params.types && !params.types.includes(entry.type)) {
          continue;
        }
        hits.push({
          id: entry.id,
          content: entry.content,
          type: entry.type,
          score: r.score,
          createdAt: entry.createdAt,
        });
        if (hits.length >= limit) {
          break;
        }
      }

      return { results: hits };
    },
  };

  // ── memory.getById (Phase 29 B8) ──
  // settings-view 의 인용 점프용 단건 조회.
  const memoryGetByIdHandler: RpcMethodHandler<{ memoryId: string }, unknown> = {
    method: 'memory.getById',
    description: '메모리 1건을 ID 로 조회합니다 (settings-view 인용 점프용)',
    authLevel: 'token',
    schema: z.object({ memoryId: z.string().min(1) }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const entry = getMemory(deps.db, params.memoryId);
      if (!entry) {
        throw new Error(`not_found: ${params.memoryId}`);
      }
      return { memory: entry };
    },
  };

  registerMethod(memoryListHandler);
  registerMethod(memoryDeleteHandler);
  registerMethod(memorySearchHandler);
  registerMethod(memoryGetByIdHandler);
}
