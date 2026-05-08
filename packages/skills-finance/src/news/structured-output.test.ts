// packages/skills-finance/src/news/structured-output.test.ts
// Phase 30 B9: analyze_market 의 outputSchema 가 valid/invalid 를 정확히 분류.

import { describe, expect, it } from 'vitest';
import { AnalyzeMarketOutputSchema } from './tools.js';

describe('AnalyzeMarketOutputSchema (Phase 30 B9)', () => {
  it('passes valid output (minimal required)', () => {
    const result = AnalyzeMarketOutputSchema.safeParse({
      trend: 'up',
      volatility: 0.42,
      drivers: ['rate cut', 'AI demand'],
    });
    expect(result.success).toBe(true);
  });

  it('passes valid output with optional summary', () => {
    const result = AnalyzeMarketOutputSchema.safeParse({
      trend: 'flat',
      volatility: 0,
      drivers: [],
      summary: '전반적 횡보, 거래량 평이.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid trend enum', () => {
    const result = AnalyzeMarketOutputSchema.safeParse({
      trend: 'sideways',
      volatility: 0.1,
      drivers: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative volatility', () => {
    const result = AnalyzeMarketOutputSchema.safeParse({
      trend: 'up',
      volatility: -0.1,
      drivers: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects drivers > 10 items', () => {
    const result = AnalyzeMarketOutputSchema.safeParse({
      trend: 'up',
      volatility: 0,
      drivers: Array.from({ length: 11 }, () => 'x'),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required field', () => {
    const result = AnalyzeMarketOutputSchema.safeParse({
      trend: 'up',
      // volatility missing
      drivers: [],
    });
    expect(result.success).toBe(false);
  });
});
