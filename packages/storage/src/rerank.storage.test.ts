// packages/storage/src/rerank.storage.test.ts
// Phase 30 D7: Reranker fallback / mock 동작 — 외부 모델 다운로드 없이.

import { describe, expect, it } from 'vitest';
import { createRerankerWithFallback, LocalReranker, MockReranker, type Reranker } from './index.js';

describe('Phase 30 D7 — Reranker fallback', () => {
  it('MockReranker preserves input order via descending scores', async () => {
    const m = new MockReranker();
    const scores = await m.rerank('q', ['a', 'b', 'c']);
    expect(scores).toEqual([3, 2, 1]);
  });

  it('LocalReranker has the configured modelId as id', () => {
    const local = new LocalReranker({ modelId: 'Xenova/bge-reranker-v2-m3' });
    expect(local.id).toBe('Xenova/bge-reranker-v2-m3');
  });

  it('LocalReranker default modelId', () => {
    const local = new LocalReranker();
    expect(local.id).toBe('Xenova/bge-reranker-v2-m3');
  });

  it('createRerankerWithFallback falls back to mock on local failure', async () => {
    const broken: Reranker = {
      id: 'broken-x',
      async rerank() {
        throw new Error('no model');
      },
    };
    const r = createRerankerWithFallback(broken);
    const scores = await r.rerank('q', ['a', 'b']);
    expect(scores).toEqual([2, 1]); // mock fallback
    expect(r.id).toBe('broken-x'); // id 는 보존
  });

  it('createRerankerWithFallback uses local result when local succeeds', async () => {
    const local: Reranker = {
      id: 'local-ok',
      async rerank(_q, candidates) {
        return candidates.map((_, i) => 0.5 + i * 0.1);
      },
    };
    const r = createRerankerWithFallback(local);
    const scores = await r.rerank('q', ['a', 'b', 'c']);
    expect(scores).toEqual([0.5, 0.6, 0.7]);
  });
});
