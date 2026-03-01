import type { ConversationMessage, ToolDefinition } from '@finclaw/types';
// packages/agent/src/providers/adapter.ts
import { createCircuitBreaker, type CircuitBreaker } from '@finclaw/infra';
import type { ProviderId } from '../models/catalog.js';
import type { StreamChunk } from '../models/provider-normalize.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';

/** 제공자 API 호출 파라미터 */
export interface ProviderRequestParams {
  readonly model: string;
  readonly messages: ConversationMessage[];
  readonly tools?: ToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly abortSignal?: AbortSignal;
}

/** 제공자 어댑터 인터페이스 */
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  chatCompletion(params: ProviderRequestParams): Promise<unknown>;
  /** 스트리밍 LLM 호출 — Phase 9 실행 엔진용 */
  streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk>;
}

/** 제공자 어댑터 생성 팩토리 */
export function createProviderAdapter(
  provider: ProviderId,
  apiKey: string,
  options?: { baseUrl?: string },
): ProviderAdapter {
  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter(apiKey, options?.baseUrl);
    case 'openai':
      return new OpenAIAdapter(apiKey, options?.baseUrl);
    default:
      throw new Error(`Unsupported provider: ${provider as string}`);
  }
}

/** 제공자별 CircuitBreaker 레지스트리 */
const breakers = new Map<ProviderId, CircuitBreaker>();

export function getBreakerForProvider(provider: ProviderId): CircuitBreaker {
  let cb = breakers.get(provider);
  if (!cb) {
    cb = createCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });
    breakers.set(provider, cb);
  }
  return cb;
}

/** 테스트용 초기화 */
export function resetBreakers(): void {
  for (const cb of breakers.values()) {
    cb.reset();
  }
  breakers.clear();
}
