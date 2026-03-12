import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EmbeddingProvider } from '../embeddings/provider.js';

// ─── Internal utilities ───

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloat32(buf: Buffer): Float32Array {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(ab);
}

// ─── CRUD ───

export function getCachedEmbedding(
  db: DatabaseSync,
  provider: string,
  model: string,
  hash: string,
): number[] | null {
  const row = db
    .prepare('SELECT embedding FROM embedding_cache WHERE provider = ? AND model = ? AND hash = ?')
    .get(provider, model, hash) as unknown as { embedding: Buffer } | undefined;

  if (!row) {
    return null;
  }
  return Array.from(bufferToFloat32(Buffer.from(row.embedding)));
}

export function setCachedEmbedding(
  db: DatabaseSync,
  provider: string,
  model: string,
  hash: string,
  embedding: number[],
): void {
  const f32 = new Float32Array(embedding);
  const buf = float32ToBuffer(f32);

  db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (provider, model, hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(provider, model, hash, buf, embedding.length, Date.now());
}

export function deleteCachedEmbeddings(db: DatabaseSync, provider: string, model?: string): number {
  if (model) {
    const result = db
      .prepare('DELETE FROM embedding_cache WHERE provider = ? AND model = ?')
      .run(provider, model);
    return Number(result.changes);
  }
  const result = db.prepare('DELETE FROM embedding_cache WHERE provider = ?').run(provider);
  return Number(result.changes);
}

// ─── Batch embed with cache ───

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Embed texts with cache: look up cached embeddings first, batch-embed misses,
 * store new results, return in original order.
 */
export async function embedBatchWithCache(
  db: DatabaseSync,
  texts: string[],
  provider: EmbeddingProvider,
): Promise<number[][]> {
  const hashes = texts.map(sha256);
  const results: Array<number[] | null> = Array.from({ length: texts.length }, () => null);
  const misses: Array<{ index: number; text: string }> = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = getCachedEmbedding(db, provider.id, provider.model, hashes[i]);
    if (cached) {
      results[i] = cached;
    } else {
      misses.push({ index: i, text: texts[i] });
    }
  }

  if (misses.length > 0) {
    const embeddings = await provider.embedBatch(misses.map((m) => m.text));
    for (let j = 0; j < misses.length; j++) {
      const { index } = misses[j];
      results[index] = embeddings[j];
      setCachedEmbedding(db, provider.id, provider.model, hashes[index], embeddings[j]);
    }
  }

  return results as number[][];
}
