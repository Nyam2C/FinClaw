// ─── Hybrid search types & merge ───

import type { Reranker } from '../rerank/index.js';

export interface ChunkSearchResult {
  // NOTE(review-2 I-1): plan uses 'id' — 'chunkId' is clearer, intentional
  readonly chunkId: string;
  readonly memoryId: string;
  readonly text: string;
  readonly score: number;
  readonly source: 'vector' | 'fts' | 'hybrid';
}

// NOTE(review-2 I-2): 'query' omitted — mergeHybridResults is a pure merge, doesn't need it
export interface HybridSearchOptions {
  readonly vectorWeight?: number;
  readonly textWeight?: number;
  readonly limit?: number;
  readonly minScore?: number;
}

/** Phase 30 D3: re-rank 후 메타 (호출자가 trace 부착 / agent_runs 기록에 사용). */
export interface RerankMeta {
  readonly model: string;
  readonly scoresBefore: readonly number[];
  readonly scoresAfter: readonly number[];
  /** 1차 순서 vs 최종 topKFinal 순서 사이의 inversion 횟수 (정확한 인접 swap 카운트). */
  readonly swaps: number;
}

export interface RerankOptions {
  readonly reranker?: Reranker;
  /** 1차 검색 (hybrid merge) topK. 기본 10. */
  readonly topKFirst?: number;
  /** rerank 후 최종 반환 topK. 기본 3. */
  readonly topKFinal?: number;
}

/** 인접 inversion 카운트 (bubble-sort swap 수와 같음). */
function countInversions(items: readonly number[]): number {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a !== undefined && b !== undefined && a > b) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Phase 30 D3: 1차 hybrid 결과를 reranker 로 재정렬하고 topKFinal 만 반환.
 *
 * - reranker 미주입 → 1차 결과 상위 topKFinal 만 잘라서 반환 (rerankMeta 없음).
 * - reranker 주입 → reranker 점수로 desc 정렬 후 topKFinal 반환 + meta.
 */
export async function rerankResults(
  query: string,
  initial: readonly ChunkSearchResult[],
  options: RerankOptions = {},
): Promise<{ chunks: ChunkSearchResult[]; rerankMeta?: RerankMeta }> {
  const topKFinal = options.topKFinal ?? 3;
  if (!options.reranker || initial.length === 0) {
    return { chunks: initial.slice(0, topKFinal) };
  }

  const candidates = initial.map((r) => r.text);
  const scoresAfter = await options.reranker.rerank(query, candidates);
  const scoresBefore = initial.map((r) => r.score);

  // 점수 desc 정렬 (originalIndex 보존).
  const indexed = scoresAfter.map((score, originalIndex) => ({ score, originalIndex }));
  indexed.sort((a, b) => b.score - a.score);
  const finalSlice = indexed.slice(0, topKFinal);
  const reordered = finalSlice
    .map((entry) => initial[entry.originalIndex])
    .filter((c): c is ChunkSearchResult => c !== undefined);

  // swaps: topKFinal 안에서 originalIndex 가 ascending 이 아닌 정도.
  const swaps = countInversions(finalSlice.map((e) => e.originalIndex));

  return {
    chunks: reordered,
    rerankMeta: {
      model: options.reranker.id,
      scoresBefore,
      scoresAfter,
      swaps,
    },
  };
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
