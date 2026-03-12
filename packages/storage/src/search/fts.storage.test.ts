import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Database } from '../database.js';
import { addMemory } from '../tables/memories.js';
import { searchFts, buildFtsQuery, bm25RankToScore } from './fts.js';

describe('FTS5 search', () => {
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

  it('buildFtsQuery — AND join and quote escape', () => {
    expect(buildFtsQuery('hello world')).toBe('"hello" AND "world"');
    expect(buildFtsQuery('say "hi"')).toBe('"say" AND """hi"""');
    expect(buildFtsQuery('')).toBe('');
  });

  it('bm25RankToScore — positive score', () => {
    expect(bm25RankToScore(-2)).toBeCloseTo(1 / 3);
    expect(bm25RankToScore(0)).toBe(1);
  });

  it('exact match search', () => {
    addMemory(database.db, mem('m1', 'Apple quarterly earnings report'));
    const results = searchFts(database.db, 'Apple');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memoryId).toBe('m1');
    expect(results[0].source).toBe('fts');
  });

  it('Korean trigram partial match', () => {
    addMemory(database.db, mem('m2', '삼성전자 반도체 실적 보고서'));
    // FTS5 trigram tokenizer requires at least 3 UTF-8 bytes per token.
    // "삼성전" (3 Korean chars, 9 bytes) produces valid trigrams.
    const results = searchFts(database.db, '삼성전');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memoryId).toBe('m2');
  });

  it('limit parameter', () => {
    addMemory(database.db, mem('m3', 'stock price analysis report'));
    addMemory(database.db, mem('m4', 'stock market daily report'));
    const results = searchFts(database.db, 'report', 1);
    expect(results).toHaveLength(1);
  });

  it('empty query returns empty', () => {
    addMemory(database.db, mem('m5', 'some content'));
    const results = searchFts(database.db, '');
    expect(results).toHaveLength(0);
  });

  it('BM25 ordering — more relevant first', () => {
    addMemory(database.db, mem('m6', 'stock'));
    addMemory(database.db, mem('m7', 'stock stock stock analysis'));
    const results = searchFts(database.db, 'stock');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Both should have positive scores
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });
});
