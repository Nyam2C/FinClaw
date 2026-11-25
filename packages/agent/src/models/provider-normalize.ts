// packages/agent/src/models/provider-normalize.ts

/** 정규화된 토큰 사용량 */
export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  /** 금융 특화: 예상 비용 (USD) */
  readonly estimatedCostUsd: number;
}

/** 스트리밍 청크 — CLI 어댑터는 text_delta(전체 1회) → usage → done 만 낸다 */
export type StreamChunk =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'usage'; readonly usage: Partial<NormalizedUsage> }
  | { readonly type: 'done' };
