// ─── Hybrid search types & merge ───

export interface ChunkSearchResult {
  readonly chunkId: string;
  readonly memoryId: string;
  readonly text: string;
  readonly score: number;
  readonly source: 'vector' | 'fts' | 'hybrid';
}

export interface HybridSearchOptions {
  readonly vectorWeight?: number;
  readonly textWeight?: number;
  readonly limit?: number;
  readonly minScore?: number;
}

/**
 * Weighted Score Fusion: merge vector and FTS results by combined score.
 * Pure function — no DB access.
 */
export function mergeHybridResults(
  vectorResults: readonly ChunkSearchResult[],
  ftsResults: readonly ChunkSearchResult[],
  options?: HybridSearchOptions,
): ChunkSearchResult[] {
  const vectorWeight = options?.vectorWeight ?? 0.7;
  const textWeight = options?.textWeight ?? 0.3;
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0.1;

  const merged = new Map<
    string,
    { chunkId: string; memoryId: string; text: string; combinedScore: number }
  >();

  for (const r of vectorResults) {
    merged.set(r.chunkId, {
      chunkId: r.chunkId,
      memoryId: r.memoryId,
      text: r.text,
      combinedScore: r.score * vectorWeight,
    });
  }

  for (const r of ftsResults) {
    const existing = merged.get(r.chunkId);
    if (existing) {
      existing.combinedScore += r.score * textWeight;
    } else {
      merged.set(r.chunkId, {
        chunkId: r.chunkId,
        memoryId: r.memoryId,
        text: r.text,
        combinedScore: r.score * textWeight,
      });
    }
  }

  return Array.from(merged.values())
    .filter((r) => r.combinedScore >= minScore)
    .toSorted((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit)
    .map((r) => ({
      chunkId: r.chunkId,
      memoryId: r.memoryId,
      text: r.text,
      score: r.combinedScore,
      source: 'hybrid' as const,
    }));
}
