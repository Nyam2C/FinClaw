// packages/storage/src/rerank/mock.ts
// Phase 30 D2: deterministic mock — 입력 순서를 점수로 반환.
// 외부 모델 다운로드 실패 / 테스트용 fallback.

import type { Reranker } from './index.js';

/** 입력 순서를 점수로 보존 — 첫 번째 후보가 가장 높은 점수. */
export class MockReranker implements Reranker {
  readonly id = 'mock-reranker';
  async rerank(_query: string, candidates: readonly string[]): Promise<number[]> {
    return candidates.map((_, i) => candidates.length - i);
  }
}

/**
 * Phase 30 D2: LocalReranker 가 모델 로드 실패 시 mock fallback.
 * id 는 local 의 modelId 를 보존 (사용자/감사 로그에서 의도 파악 가능).
 */
export function createRerankerWithFallback(local: Reranker): Reranker {
  return {
    id: local.id,
    async rerank(query, candidates) {
      try {
        return await local.rerank(query, candidates);
      } catch (err) {
        console.warn(`[reranker] ${local.id} failed, falling back to mock:`, err);
        return new MockReranker().rerank(query, candidates);
      }
    },
  };
}
