import { DatabaseSync } from 'node:sqlite';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { ChunkSearchResult } from './hybrid.js';

// ─── Helpers ───

interface VecRow {
  chunk_id: string;
  memory_id: string;
  text: string;
  distance: number;
}

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Cosine similarity between two vectors. Returns 0 if either has zero norm. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }
  return dot / denom;
}

/** KNN vector search via sqlite-vec vec_distance_cosine. */
export async function searchVector(
  db: DatabaseSync,
  query: string,
  provider: EmbeddingProvider,
  limit = 20,
): Promise<ChunkSearchResult[]> {
  const embedding = await provider.embedQuery(query);
  const f32 = new Float32Array(embedding);
  const buf = float32ToBuffer(f32);

  const rows = db
    .prepare(
      `SELECT v.chunk_id, c.memory_id, c.text, v.distance
       FROM memory_chunks_vec v
       JOIN memory_chunks c ON c.id = v.chunk_id
       -- NOTE(review-2 I-5): MATCH + k = ? is correct sqlite-vec KNN syntax (plan's vec_distance_cosine was wrong)
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(buf, limit) as unknown as VecRow[];

  return rows.map((row) => ({
    chunkId: row.chunk_id,
    memoryId: row.memory_id,
    text: row.text,
    score: 1 - row.distance,
    source: 'vector' as const,
  }));
}
