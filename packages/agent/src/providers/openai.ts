// packages/agent/src/providers/openai.ts
import OpenAI from 'openai';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';
import { FailoverError } from '../errors.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  // TODO(L3): params.tools를 SDK 호출에 전달해야 함 (Phase 9+ 도구 사용 기능)
  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    try {
      return await this.client.chat.completions.create(
        {
          model: params.model,
          messages: params.messages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        },
        { signal: params.abortSignal },
      );
    } catch (error) {
      throw wrapOpenAIError(error);
    }
  }
}

/** OpenAI SDK 에러 → FailoverError 변환 */
function wrapOpenAIError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  if (error.name === 'AbortError') {
    return error;
  }

  const status = (error as { status?: number }).status;
  if (status === 429) {
    return new FailoverError(`OpenAI rate limit: ${error.message}`, 'rate-limit', {
      statusCode: 429,
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new FailoverError(`OpenAI server error: ${error.message}`, 'server-error', {
      statusCode: status,
      cause: error,
    });
  }
  return error;
}
