import { describe, it, expect } from 'vitest';
import type { ModelPricing } from '../src/models/catalog.js';
import {
  normalizeAnthropicResponse,
  normalizeOpenAIResponse,
  calculateEstimatedCost,
} from '../src/models/provider-normalize.js';

const pricing: ModelPricing = { inputPerMillion: 15, outputPerMillion: 75 };

describe('normalizeAnthropicResponse', () => {
  const mockResponse = {
    id: 'msg_123',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text: 'Hello world' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  };

  it('필드를 정확히 매핑한다', () => {
    const result = normalizeAnthropicResponse(mockResponse, pricing);
    expect(result.content).toBe('Hello world');
    expect(result.stopReason).toBe('end_turn');
    expect(result.modelId).toBe('claude-opus-4-6');
    expect(result.provider).toBe('anthropic');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cacheReadTokens).toBe(10);
    expect(result.usage.cacheWriteTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(150);
  });

  it('비용을 계산한다', () => {
    const result = normalizeAnthropicResponse(mockResponse, pricing);
    // (100/1M)*15 + (50/1M)*75 = 0.0015 + 0.00375 = 0.00525
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.00525, 5);
  });

  it('content가 여러 블록이면 text만 연결한다', () => {
    const multi = {
      ...mockResponse,
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tool_1' },
        { type: 'text', text: ' World' },
      ],
    };
    const result = normalizeAnthropicResponse(multi, pricing);
    expect(result.content).toBe('Hello World');
  });

  it('usage가 없으면 0으로 기본값', () => {
    const noUsage = { ...mockResponse, usage: undefined };
    const result = normalizeAnthropicResponse(noUsage, pricing);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it('raw를 보존한다', () => {
    const result = normalizeAnthropicResponse(mockResponse, pricing);
    expect(result.raw).toBe(mockResponse);
  });
});

describe('normalizeOpenAIResponse', () => {
  const mockResponse = {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [
      {
        message: { content: 'Hi there' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 80,
      completion_tokens: 30,
      total_tokens: 110,
    },
  };

  it('필드를 정확히 매핑한다', () => {
    const result = normalizeOpenAIResponse(mockResponse, pricing);
    expect(result.content).toBe('Hi there');
    expect(result.stopReason).toBe('end_turn'); // 'stop' → 'end_turn'
    expect(result.modelId).toBe('gpt-4o');
    expect(result.provider).toBe('openai');
    expect(result.usage.inputTokens).toBe(80);
    expect(result.usage.outputTokens).toBe(30);
    expect(result.usage.totalTokens).toBe(110);
  });

  it('캐시 토큰은 0이다 (OpenAI N/A)', () => {
    const result = normalizeOpenAIResponse(mockResponse, pricing);
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheWriteTokens).toBe(0);
  });

  it('finish_reason 매핑: length → max_tokens', () => {
    const r = { ...mockResponse, choices: [{ message: { content: '' }, finish_reason: 'length' }] };
    expect(normalizeOpenAIResponse(r, pricing).stopReason).toBe('max_tokens');
  });

  it('finish_reason 매핑: tool_calls → tool_use', () => {
    const r = {
      ...mockResponse,
      choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }],
    };
    expect(normalizeOpenAIResponse(r, pricing).stopReason).toBe('tool_use');
  });

  it('content가 null이면 빈 문자열', () => {
    const r = { ...mockResponse, choices: [{ message: { content: null }, finish_reason: 'stop' }] };
    expect(normalizeOpenAIResponse(r, pricing).content).toBe('');
  });
});

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
