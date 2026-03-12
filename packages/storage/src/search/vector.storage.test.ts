import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { openDatabase, type Database } from '../database.js';
import { addMemory } from '../tables/memories.js';
import { cosineSimilarity, searchVector } from './vector.js';

const DIMS = 1024;

function makeVector(seed: number): number[] {
  const v = Array.from<number>({ length: DIMS }).fill(0);
  v[seed % DIMS] = 1.0;
  return v;
}

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function mockProvider(queryVec: number[]): EmbeddingProvider {
  return {
    id: 'mock',
    model: 'mock-1024',
    dimensions: DIMS,
    async embedQuery() {
      return queryVec;
    },
    async embedBatch(texts) {
      return texts.map((_, i) => makeVector(i));
    },
  };
}

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    const v = makeVector(0);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it('orthogonal vectors → 0', () => {
    const a = makeVector(0);
    const b = makeVector(1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0);
  });

  it('zero vector → 0', () => {
    const zero = Array.from<number>({ length: DIMS }).fill(0);
    const v = makeVector(0);
    expect(cosineSimilarity(zero, v)).toBe(0);
  });
});

describe('searchVector (storage)', () => {
  let database: Database;
  const sessionKey = 'test-session' as SessionKey;
  const now = Date.now() as Timestamp;

  function mem(id: string, content: string): MemoryEntry {
    return { id, sessionKey, content, type: 'fact', createdAt: now };
  }

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  function insertWithVec(memoryId: string, content: string, vec: number[]): void {
    addMemory(database.db, mem(memoryId, content));

    // Get chunk IDs
    const chunks = database.db
      .prepare('SELECT id FROM memory_chunks WHERE memory_id = ?')
      .all(memoryId) as unknown as Array<{ id: string }>;

    for (const chunk of chunks) {
      const f32 = new Float32Array(vec);
      const buf = float32ToBuffer(f32);
      database.db
        .prepare('INSERT INTO memory_chunks_vec (chunk_id, embedding) VALUES (?, ?)')
        .run(chunk.id, buf);
      // Update model
      database.db
        .prepare('UPDATE memory_chunks SET model = ? WHERE id = ?')
        .run('mock-1024', chunk.id);
    }
  }

  it('KNN returns closest vector first', async () => {
    const v0 = makeVector(0);
    const v1 = makeVector(1);
    insertWithVec('m1', 'close match', v0);
    insertWithVec('m2', 'far match', v1);

    const provider = mockProvider(v0); // query matches m1
    const results = await searchVector(database.db, 'test', provider);

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].memoryId).toBe('m1');
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].source).toBe('vector');
  });

  it('limit parameter', async () => {
    insertWithVec('m3', 'content a', makeVector(0));
    insertWithVec('m4', 'content b', makeVector(1));
    insertWithVec('m5', 'content c', makeVector(2));

    const provider = mockProvider(makeVector(0));
    const results = await searchVector(database.db, 'test', provider, 2);
    expect(results).toHaveLength(2);
  });
});
