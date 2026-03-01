import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.js';
// packages/agent/src/providers/openai.ts
import OpenAI from 'openai';
import type { StreamChunk } from '../models/provider-normalize.js';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';
import { FailoverError } from '../errors.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const;
  private readonly client: OpenAI;
  private hasActiveTool = false;

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

  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: params.model,
          messages: params.messages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          ...(params.tools?.length
            ? {
                tools: params.tools.map((t) => ({
                  type: 'function' as const,
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                  },
                })),
              }
            : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: params.abortSignal },
      );

      this.hasActiveTool = false;
      for await (const chunk of stream) {
        yield* this.mapOpenAIStreamChunk(chunk as ChatCompletionChunk);
      }
    } catch (error) {
      throw wrapOpenAIError(error);
    }
  }

  private *mapOpenAIStreamChunk(chunk: ChatCompletionChunk): Iterable<StreamChunk> {
    const choice = chunk.choices?.[0];

    if (choice?.delta?.content) {
      yield { type: 'text_delta', text: choice.delta.content };
    }

    if (choice?.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        if (tc.function?.name) {
          if (this.hasActiveTool) {
            yield { type: 'tool_use_end' };
          }
          this.hasActiveTool = true;
          yield {
            type: 'tool_use_start',
            id: tc.id ?? `tool_${tc.index}`,
            name: tc.function.name,
          };
        }
        if (tc.function?.arguments) {
          yield { type: 'tool_input_delta', delta: tc.function.arguments };
        }
      }
    }

    if (choice?.finish_reason === 'tool_calls') {
      yield { type: 'tool_use_end' };
      this.hasActiveTool = false;
    }

    if (chunk.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        },
      };
    }

    if (choice?.finish_reason === 'stop') {
      yield { type: 'done' };
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
