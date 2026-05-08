// packages/storage/src/embeddings/registry.ts
import type { EmbeddingProvider } from './provider.js';

/**
 * Phase 29 C2: provider.dimensions 와 vec0 column 차원이 다를 때 throw.
 *
 * 잘못된 차원이 vec0 에 들어가면 silent corruption (cosine 유사도가 무의미한 값) 이
 * 발생하므로, main.ts 의 createEmbeddingProvider 직후 즉시 차단한다.
 */
export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly providerDim: number,
    public readonly expectedDim: number,
  ) {
    super(
      `Embedding provider "${providerId}" produces ${providerDim}-D vectors, ` +
        `but vec0 column expects ${expectedDim}-D. ` +
        `Either use OpenAIEmbeddingProvider({ dimensions: ${expectedDim} }) ` +
        `truncation, or recreate vec0 + reindex with the new dimension.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/**
 * provider.dimensions 가 expectedDim 과 일치하는지 검증. 불일치 시 throw.
 */
export function assertEmbeddingDimension(provider: EmbeddingProvider, expectedDim: number): void {
  if (provider.dimensions !== expectedDim) {
    throw new EmbeddingDimensionMismatchError(provider.id, provider.dimensions, expectedDim);
  }
}
