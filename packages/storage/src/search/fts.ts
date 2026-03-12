import { DatabaseSync } from 'node:sqlite';
import type { ChunkSearchResult } from './hybrid.js';

// ─── FTS5 helpers ───

interface FtsRow {
  id: string;
  memory_id: string;
  text: string;
  rank: number;
}

/**
 * Build FTS5 MATCH query for trigram tokenizer.
 * Trigram tokenizer matches substrings — each term is quoted as a phrase.
 * Multiple terms are AND-joined so all must appear.
 */
export function buildFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return '';
  }
  // For trigram tokenizer, each term must be >= 3 chars to produce trigrams.
  // Quote each term as a substring match.
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

/** Convert FTS5 BM25 rank (negative) to 0-1 score. */
export function bm25RankToScore(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}

/** Full-text search via FTS5 BM25 ranking. */
export function searchFts(db: DatabaseSync, query: string, limit = 20): ChunkSearchResult[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT id, memory_id, text, rank
       FROM memory_chunks_fts
       WHERE memory_chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, limit) as unknown as FtsRow[];

  return rows.map((row) => ({
    chunkId: row.id,
    memoryId: row.memory_id,
    text: row.text,
    score: bm25RankToScore(row.rank),
    source: 'fts' as const,
  }));
}
