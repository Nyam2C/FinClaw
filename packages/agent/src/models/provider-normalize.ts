// packages/agent/src/models/provider-normalize.ts
import type { ModelPricing } from './catalog.js';

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

/** 스트리밍 청크 — discriminated union (6 variant) */
export type StreamChunk =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_use_start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_input_delta'; readonly delta: string }
  | { readonly type: 'tool_use_end' }
  | { readonly type: 'usage'; readonly usage: Partial<NormalizedUsage> }
  | { readonly type: 'done' };

/**
 * 비용 계산 헬퍼 (캐시 비용 포함)
 *
 * cacheReadTokens는 캐시 히트된 입력 토큰 (할인 적용).
 * cacheWriteTokens는 캐시에 쓰여진 입력 토큰 (할증 적용).
 * pricing.cacheReadPerMillion / cacheWritePerMillion이 없으면 0으로 처리.
 */
export function calculateEstimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerMillion ?? 0) +
    (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMillion ?? 0)
  );
}
