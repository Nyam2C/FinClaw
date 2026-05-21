import type { ProviderAdapter, ProviderRequestParams } from '@finclaw/agent';
import { createLlmRouter } from '@finclaw/agent';
import { describe, it, expect } from 'vitest';

function mockProvider(responses: Array<{ json: unknown; usage?: { i: number; o: number } }>): {
  provider: ProviderAdapter;
  calls: ProviderRequestParams[];
} {
  const calls: ProviderRequestParams[] = [];
  let idx = 0;
  const provider = {
    providerId: 'anthropic' as const,
    async chatCompletion(params: ProviderRequestParams) {
      calls.push(params);
      const r = responses[Math.min(idx++, responses.length - 1)];
      return {
        content: [
          { type: 'text', text: typeof r.json === 'string' ? r.json : JSON.stringify(r.json) },
        ],
        usage: { input_tokens: r.usage?.i ?? 50, output_tokens: r.usage?.o ?? 10 },
      };
    },
    async *streamCompletion() {},
  } as unknown as ProviderAdapter;
  return { provider, calls };
}

describe('createLlmRouter', () => {
  it('greeting → 도구 미전달 (allowedToolNames 빈 배열)', async () => {
    const { provider } = mockProvider([{ json: { intent: 'greeting', reason: '인사' } }]);
    const router = createLlmRouter(provider);
    const d = await router({ message: '안녕', availableToolNames: ['get_stock_price'] });
    expect(d.intent).toBe('greeting');
    expect(d.modelTier).toBe('haiku');
    expect(d.allowedToolNames).toEqual([]);
    expect(d.fallback).toBe(false);
  });

  it('analysis → sonnet + 모든 도구 노출', async () => {
    const { provider } = mockProvider([{ json: { intent: 'analysis', reason: '분석 요청' } }]);
    const router = createLlmRouter(provider);
    const d = await router({
      message: '삼성전자 어때?',
      availableToolNames: ['get_stock_price', 'analyze_market', 'search_news'],
    });
    expect(d.modelTier).toBe('sonnet');
    expect(d.allowedToolNames).toEqual(['get_stock_price', 'analyze_market', 'search_news']);
  });

  it('환각 도구명은 availableToolNames 교집합으로 제거', async () => {
    const { provider } = mockProvider([{ json: { intent: 'fetch', reason: '시세' } }]);
    const router = createLlmRouter(provider);
    const d = await router({
      message: '환율',
      availableToolNames: ['get_exchange_rate'], // patterns 매칭됨
    });
    expect(d.allowedToolNames).toEqual(['get_exchange_rate']);
  });

  it('JSON 코드펜스/잡텍스트 둘러싸여도 파싱', async () => {
    const { provider } = mockProvider([
      { json: '```json\n{"intent":"fetch","reason":"시세"}\n```' },
    ]);
    const router = createLlmRouter(provider);
    const d = await router({ message: '가격', availableToolNames: [] });
    expect(d.intent).toBe('fetch');
  });

  it('zod 검증 실패 시 1회 재시도 (2번째 성공)', async () => {
    const { provider, calls } = mockProvider([
      { json: { intent: 'INVALID', reason: 'x' } }, // 1회차 실패
      { json: { intent: 'other', reason: 'ok' } }, // 2회차 성공
    ]);
    const router = createLlmRouter(provider);
    const d = await router({ message: 'x', availableToolNames: [] });
    expect(calls).toHaveLength(2);
    expect(d.intent).toBe('other');
  });

  it('2회 모두 실패 시 throw (호출자 폴백용)', async () => {
    const { provider } = mockProvider([{ json: { bad: true } }, { json: { bad: true } }]);
    const router = createLlmRouter(provider);
    await expect(router({ message: 'x', availableToolNames: [] })).rejects.toThrow();
  });

  it('routerUsage 토큰 누적 (비용 별도 추적용 — D-0)', async () => {
    const { provider } = mockProvider([
      { json: { intent: 'greeting', reason: 'hi' }, usage: { i: 120, o: 8 } },
    ]);
    const router = createLlmRouter(provider);
    const d = await router({ message: '안녕', availableToolNames: [] });
    expect(d.routerUsage).toEqual({ inputTokens: 120, outputTokens: 8 });
  });
});
