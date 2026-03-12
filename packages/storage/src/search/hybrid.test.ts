import { describe, it, expect } from 'vitest';
import { mergeHybridResults, type ChunkSearchResult } from './hybrid.js';

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
