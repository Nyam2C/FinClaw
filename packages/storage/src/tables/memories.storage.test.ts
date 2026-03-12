import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { openDatabase, type Database } from '../database.js';
import { searchVector } from '../search/vector.js';
import {
  addMemory,
  getMemory,
  getMemoriesBySession,
  deleteMemory,
  getMemoryChunks,
  chunkMarkdown,
  addMemoryWithEmbedding,
} from './memories.js';

const DIMS = 1024;
const sessionKey = 'test-session' as SessionKey;
const now = Date.now() as Timestamp;

function makeVector(seed: number): number[] {
  const v = Array.from<number>({ length: DIMS }).fill(0);
  v[seed % DIMS] = 1.0;
  return v;
}

function mem(id: string, content: string, type: MemoryEntry['type'] = 'fact'): MemoryEntry {
  return { id, sessionKey, content, type, createdAt: now };
}

function mockProvider(): EmbeddingProvider & { embedBatchCalls: number } {
  const p = {
    id: 'mock',
    model: 'mock-1024',
    dimensions: DIMS,
    embedBatchCalls: 0,
    async embedQuery(text: string) {
      return makeVector(text.length % DIMS);
    },
    async embedBatch(texts: string[]) {
      p.embedBatchCalls++;
      return texts.map((t) => makeVector(t.length % DIMS));
    },
  };
  return p;
}

describe('memories CRUD (storage)', () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('addMemory — insert and retrieve', () => {
    addMemory(database.db, mem('m1', 'hello world'));
    const entry = getMemory(database.db, 'm1');
    expect(entry).not.toBeNull();
    expect(entry?.content).toBe('hello world');
  });

  it('addMemory — duplicate skip (same content)', () => {
    addMemory(database.db, mem('m1', 'same content'));
    addMemory(database.db, mem('m2', 'same content'));
    // m2 should be skipped
    expect(getMemory(database.db, 'm2')).toBeNull();
  });

  it('getMemory — null for nonexistent', () => {
    expect(getMemory(database.db, 'nonexistent')).toBeNull();
  });

  it('getMemoriesBySession', () => {
    addMemory(database.db, mem('m1', 'content a'));
    addMemory(database.db, mem('m2', 'content b'));
    const results = getMemoriesBySession(database.db, sessionKey);
    expect(results).toHaveLength(2);
  });

  it('getMemoriesBySession — type filter', () => {
    addMemory(database.db, mem('m1', 'fact content', 'fact'));
    addMemory(database.db, mem('m2', 'pref content', 'preference'));
    const results = getMemoriesBySession(database.db, sessionKey, { type: 'fact' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('fact');
  });

  it('deleteMemory — removes vec0 + FTS entries', () => {
    addMemory(database.db, mem('m1', 'to delete content'));

    const chunks = getMemoryChunks(database.db, 'm1');
    expect(chunks.length).toBeGreaterThan(0);

    const deleted = deleteMemory(database.db, 'm1');
    expect(deleted).toBe(true);
    expect(getMemory(database.db, 'm1')).toBeNull();
    expect(getMemoryChunks(database.db, 'm1')).toHaveLength(0);

    // FTS should be empty
    const ftsCount = database.db
      .prepare('SELECT COUNT(*) as c FROM memory_chunks_fts WHERE memory_id = ?')
      .get('m1') as unknown as { c: number };
    expect(ftsCount.c).toBe(0);
  });

  it('deleteMemory — returns false for nonexistent', () => {
    expect(deleteMemory(database.db, 'nonexistent')).toBe(false);
  });

  it('chunkMarkdown — produces chunks', () => {
    const text = 'line1\nline2\nline3';
    const chunks = chunkMarkdown(text);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].startLine).toBe(0);
  });

  it('addMemory — creates FTS entries', () => {
    addMemory(database.db, mem('m1', 'searchable text'));
    const fts = database.db
      .prepare('SELECT COUNT(*) as c FROM memory_chunks_fts WHERE memory_id = ?')
      .get('m1') as unknown as { c: number };
    expect(fts.c).toBeGreaterThan(0);
  });
});

describe('addMemoryWithEmbedding (storage)', () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('inserts memory and embeds chunks', async () => {
    const provider = mockProvider();
    await addMemoryWithEmbedding(database.db, mem('m1', 'embedded content'), provider);

    const entry = getMemory(database.db, 'm1');
    expect(entry).not.toBeNull();

    const chunks = getMemoryChunks(database.db, 'm1');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].model).toBe('mock-1024');

    // vec0 should have entries
    const vecCount = database.db
      .prepare('SELECT COUNT(*) as c FROM memory_chunks_vec')
      .get() as unknown as { c: number };
    expect(vecCount.c).toBe(chunks.length);
  });

  it('duplicate skip — no embedding call', async () => {
    const provider = mockProvider();
    addMemory(database.db, mem('m1', 'dup content'));
    await addMemoryWithEmbedding(database.db, mem('m2', 'dup content'), provider);
    expect(provider.embedBatchCalls).toBe(0);
  });

  it('searchVector integration — finds embedded memory', async () => {
    const provider = mockProvider();
    await addMemoryWithEmbedding(database.db, mem('m1', 'finance data'), provider);

    const results = await searchVector(database.db, 'finance', provider);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memoryId).toBe('m1');
  });

  it('embedBatchWithCache — cache hit on second call skips API', async () => {
    const provider = mockProvider();
    await addMemoryWithEmbedding(database.db, mem('m1', 'cached text'), provider);
    expect(provider.embedBatchCalls).toBe(1);

    // Verify cache is populated
    const chunks = getMemoryChunks(database.db, 'm1');
    const cacheCount = database.db
      .prepare('SELECT COUNT(*) as c FROM embedding_cache')
      .get() as unknown as { c: number };
    expect(cacheCount.c).toBe(chunks.length);

    // Second call with same content (different ID) — addMemory deduplicates by hash,
    // so use addMemoryWithEmbedding with different content that shares chunk text.
    // Instead, directly call embedBatchWithCache to verify cache hit.
    const { embedBatchWithCache } = await import('./embeddings.js');
    const texts = chunks.map((c) => c.text);
    await embedBatchWithCache(database.db, texts, provider);

    // embedBatch should NOT have been called again — cache hit
    expect(provider.embedBatchCalls).toBe(1);
  });
});
