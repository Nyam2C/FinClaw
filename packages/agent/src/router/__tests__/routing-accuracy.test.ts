import {
  BUILT_IN_MODELS,
  calculateEstimatedCost,
  createLlmRouter,
  ROUTER_MODEL_ID,
} from '@finclaw/agent';
import { describe, it, expect } from 'vitest';
import { ROUTING_CASES } from './fixtures/routing-cases.js';

const AVAILABLE = [
  'get_stock_price',
  'get_forex_rate',
  'analyze_market',
  'get_financial_news',
  'get_portfolio_summary',
];

describe('라우터 정확도 fixture (mock intent)', () => {
  it.each(ROUTING_CASES)('$message → expectsTools=$expectsTools', async (c) => {
    // mock: LLM 이 expectedIntent 를 정확히 분류했다고 가정.
    const provider = {
      providerId: 'anthropic' as const,
      async chatCompletion() {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ intent: c.expectedIntent, reason: 'fixture' }) },
          ],
          usage: { input_tokens: 180, output_tokens: 12 },
        };
      },
      async *streamCompletion() {},
    } as unknown as import('@finclaw/agent').ProviderAdapter;
    const router = createLlmRouter(provider);
    const d = await router({ message: c.message, availableToolNames: AVAILABLE });
    expect(d.intent).toBe(c.expectedIntent);
    expect(d.allowedToolNames.length > 0).toBe(c.expectsTools);
  });

  it('라우터 추가 비용 ≤ $0.0005/메시지 (Haiku, 200in/20out 기준)', () => {
    const pricing = BUILT_IN_MODELS.find((m) => m.id === ROUTER_MODEL_ID)?.pricing;
    expect(pricing).toBeDefined();
    if (!pricing) {
      throw new Error('ROUTER_MODEL_ID pricing missing from BUILT_IN_MODELS');
    }
    // intent+reason 출력은 짧음 (~20out). 200in/20out → 0.00016 + 0.00008 = 0.00024.
    const cost = calculateEstimatedCost(200, 20, pricing);
    expect(cost).toBeLessThanOrEqual(0.0005);
  });
});
