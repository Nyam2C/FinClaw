import { describe, it, expect } from 'vitest';
import type { ModelPricing } from '../src/models/catalog.js';
import { calculateEstimatedCost } from '../src/models/provider-normalize.js';

const pricing: ModelPricing = { inputPerMillion: 15, outputPerMillion: 75 };

describe('calculateEstimatedCost', () => {
  it('정확한 비용을 계산한다', () => {
    // 1000 input * $15/1M + 500 output * $75/1M
    // = 0.015 + 0.0375 = 0.0525
    expect(calculateEstimatedCost(1000, 500, pricing)).toBeCloseTo(0.0525, 4);
  });

  it('0 토큰이면 비용 0', () => {
    expect(calculateEstimatedCost(0, 0, pricing)).toBe(0);
  });

  it('캐시 비용을 포함하여 계산한다', () => {
    const cachePricing: ModelPricing = {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    };
    // 1000 input * $3/1M + 500 output * $15/1M + 200 cacheRead * $0.3/1M + 100 cacheWrite * $3.75/1M
    // = 0.003 + 0.0075 + 0.00006 + 0.000375 = 0.010935
    const cost = calculateEstimatedCost(1000, 500, cachePricing, 200, 100);
    expect(cost).toBeCloseTo(0.010935, 5);
  });

  it('캐시 가격이 없으면 캐시 비용은 0이다', () => {
    const noCachePricing: ModelPricing = { inputPerMillion: 3, outputPerMillion: 15 };
    const cost = calculateEstimatedCost(1000, 500, noCachePricing, 200, 100);
    // 캐시 비용 0 → 기존과 동일
    expect(cost).toBeCloseTo(0.0105, 4);
  });
});
