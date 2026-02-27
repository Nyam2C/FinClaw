// packages/agent/src/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';
import { FailoverError } from '../errors.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl });
  }

  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    // system 메시지 분리 (Anthropic API는 system을 별도 파라미터로 받음)
    const systemMessages = params.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = params.messages.filter((m) => m.role !== 'system');

    const system = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    try {
      return await this.client.messages.create(
        {
          model: params.model,
          max_tokens: params.maxTokens ?? 4096,
          ...(system ? { system } : {}),
          messages: nonSystemMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        },
        { signal: params.abortSignal },
      );
    } catch (error) {
      throw wrapAnthropicError(error);
    }
  }
}

/** Anthropic SDK 에러 → FailoverError 변환 */
function wrapAnthropicError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  if (error.name === 'AbortError') {
    return error;
  }

  const status = (error as { status?: number }).status;
  if (status === 429) {
    return new FailoverError(`Anthropic rate limit: ${error.message}`, 'rate-limit', {
      statusCode: 429,
      cause: error,
    });
  }
  if (status === 529) {
    return new FailoverError(`Anthropic overloaded: ${error.message}`, 'model-unavailable', {
      statusCode: 529,
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new FailoverError(`Anthropic server error: ${error.message}`, 'server-error', {
      statusCode: status,
      cause: error,
    });
  }
  return error;
}
