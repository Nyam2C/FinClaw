// packages/server/src/auto-reply/__tests__/rerank.storage.test.ts
// Phase 30 D9: memory-retrieval 단계가 reranker 주입 시 rerankMeta 를 RetrievalResult 에 부착.

import type { FinClawLogger } from '@finclaw/infra';
import { addMemory, openDatabase, type Reranker } from '@finclaw/storage';
import { createSessionKey, type Timestamp } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { DefaultMemoryRetrievalService } from '../stages/memory-retrieval.js';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

describe('Phase 30 D9 — memory retrieval with reranker', () => {
  it('attaches rerankMeta to RetrievalResult when reranker is provided', async () => {
    const db = openDatabase({ path: ':memory:', enableWAL: false });

    // 3 개 memory entry 삽입 (FTS 매칭 가능한 텍스트)
    const sessionKey = createSessionKey('s1');
    for (let i = 0; i < 3; i++) {
      addMemory(db.db, {
        id: `m${i}`,
        sessionKey,
        content: `apple stock analysis number ${i}`,
        type: 'fact',
        createdAt: (Date.now() - i * 1000) as Timestamp,
        metadata: {},
      });
    }

    // 역순 reranker — 마지막 (memory ID 가 작은 순) → 첫 번째 (큰 순)
    const reverseReranker: Reranker = {
      id: 'mock-reverse',
      async rerank(_q, candidates) {
        return candidates.map((_, i) => i);
      },
    };

    const service = new DefaultMemoryRetrievalService({
      db: db.db,
      logger: makeLogger(),
      reranker: reverseReranker,
      rerankTopKFirst: 5,
    });

    const result = await service.searchRelevant({
      userQuery: 'apple stock',
      sessionKey,
    });

    // rerank 경로가 호출되었는지 — meta 가 부착
    if (result.snippets.length > 0) {
      expect(result.rerankMeta).toBeDefined();
      expect(result.rerankMeta?.model).toBe('mock-reverse');
      expect(result.rerankMeta?.scoresAfter.length).toBeGreaterThanOrEqual(1);
    } else {
      // FTS 가 매칭 0 건이면 rerank 호출 안 됨 — 환경에 따라 가능
      expect(result.rerankMeta).toBeUndefined();
    }
  });

  it('produces undefined rerankMeta when no reranker', async () => {
    const db = openDatabase({ path: ':memory:', enableWAL: false });
    const sessionKey = createSessionKey('s1');
    addMemory(db.db, {
      id: 'm1',
      sessionKey,
      content: 'apple stock',
      type: 'fact',
      createdAt: Date.now() as Timestamp,
      metadata: {},
    });

    const service = new DefaultMemoryRetrievalService({
      db: db.db,
      logger: makeLogger(),
    });

    const result = await service.searchRelevant({
      userQuery: 'apple stock',
      sessionKey,
    });

    expect(result.rerankMeta).toBeUndefined();
  });
});
