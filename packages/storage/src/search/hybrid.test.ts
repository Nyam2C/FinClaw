import { describe, it, expect } from 'vitest';
import type { Reranker } from '../rerank/index.js';
import { mergeHybridResults, rerankResults, type ChunkSearchResult } from './hybrid.js';

function vec(id: string, memoryId: string, score: number): ChunkSearchResult {
  return { chunkId: id, memoryId, text: `text-${id}`, score, source: 'vector' };
}

function fts(id: string, memoryId: string, score: number): ChunkSearchResult {
  return { chunkId: id, memoryId, text: `text-${id}`, score, source: 'fts' };
}

describe('mergeHybridResults', () => {
  it('overlapping results — weighted sum', () => {
    const results = mergeHybridResults([vec('c1', 'm1', 0.9)], [fts('c1', 'm1', 0.8)]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.9 * 0.7 + 0.8 * 0.3);
    expect(results[0].source).toBe('hybrid');
  });

  it('vector-only results', () => {
    const results = mergeHybridResults([vec('c1', 'm1', 0.9)], []);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.9 * 0.7);
  });

  it('fts-only results', () => {
    const results = mergeHybridResults([], [fts('c1', 'm1', 0.8)]);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBeCloseTo(0.8 * 0.3);
  });

  it('minScore filter', () => {
    const results = mergeHybridResults([], [fts('c1', 'm1', 0.1)], { minScore: 0.5 });
    expect(results).toHaveLength(0);
  });

  it('limit', () => {
    const vecs = Array.from({ length: 5 }, (_, i) => vec(`c${i}`, `m${i}`, 0.9 - i * 0.1));
    const results = mergeHybridResults(vecs, [], { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('default weights (0.7 / 0.3)', () => {
    const results = mergeHybridResults([vec('c1', 'm1', 1.0)], [fts('c1', 'm1', 1.0)]);
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it('custom weights', () => {
    const results = mergeHybridResults([vec('c1', 'm1', 1.0)], [fts('c1', 'm1', 1.0)], {
      vectorWeight: 0.5,
      textWeight: 0.5,
    });
    expect(results[0].score).toBeCloseTo(1.0);
  });

  it('empty input', () => {
    const results = mergeHybridResults([], []);
    expect(results).toHaveLength(0);
  });
});

// ─── Phase 30 D8: rerankResults ───

const fakeChunks = (n: number): ChunkSearchResult[] =>
  Array.from({ length: n }, (_, i) => ({
    chunkId: `c${i}`,
    memoryId: `m${i}`,
    text: `text-${i}`,
    score: (n - i) / n,
    source: 'hybrid' as const,
  }));

describe('Phase 30 D8 — rerankResults', () => {
  it('returns top-K-final without reranker (slice only)', async () => {
    const initial = fakeChunks(10);
    const result = await rerankResults('q', initial, { topKFinal: 3 });
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks.map((c) => c.chunkId)).toEqual(['c0', 'c1', 'c2']);
    expect(result.rerankMeta).toBeUndefined();
  });

  it('returns empty when initial is empty (no reranker call)', async () => {
    const reranker: Reranker = {
      id: 'never-called',
      async rerank() {
        throw new Error('should not be called');
      },
    };
    const result = await rerankResults('q', [], { reranker, topKFinal: 3 });
    expect(result.chunks).toHaveLength(0);
    expect(result.rerankMeta).toBeUndefined();
  });

  it('reorders with reverse reranker (mock-reverse) and reports swaps > 0', async () => {
    const initial = fakeChunks(5);
    const reverseReranker: Reranker = {
      id: 'mock-reverse',
      // 첫 번째에 가장 낮은 점수 → 마지막에 가장 높은 점수
      async rerank(_q, candidates) {
        return candidates.map((_, i) => i);
      },
    };
    const result = await rerankResults('q', initial, {
      reranker: reverseReranker,
      topKFinal: 3,
    });
    expect(result.chunks.map((c) => c.chunkId)).toEqual(['c4', 'c3', 'c2']);
    expect(result.rerankMeta?.model).toBe('mock-reverse');
    expect(result.rerankMeta?.swaps).toBeGreaterThan(0);
    expect(result.rerankMeta?.scoresAfter).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps order when reranker mirrors the initial order (swaps = 0)', async () => {
    const initial = fakeChunks(5);
    const sameOrder: Reranker = {
      id: 'same',
      async rerank(_q, candidates) {
        return candidates.map((_, i) => candidates.length - i);
      },
    };
    const result = await rerankResults('q', initial, {
      reranker: sameOrder,
      topKFinal: 3,
    });
    expect(result.chunks.map((c) => c.chunkId)).toEqual(['c0', 'c1', 'c2']);
    expect(result.rerankMeta?.swaps).toBe(0);
  });
});
