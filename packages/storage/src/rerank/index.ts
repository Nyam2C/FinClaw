// packages/storage/src/rerank/index.ts
// Phase 30 D2: RAG re-ranking 인터페이스.
//
// 인터페이스 단일 — 점수 배열 (candidates 와 1:1, 높을수록 관련성↑).
// 호출자가 점수로 정렬 후 topK 추출 (storage/search/hybrid 가 처리).

export interface Reranker {
  readonly id: string;
  /** 점수 배열 (candidates 와 1:1 대응, 높을수록 관련성↑). */
  rerank(query: string, candidates: readonly string[]): Promise<number[]>;
}
