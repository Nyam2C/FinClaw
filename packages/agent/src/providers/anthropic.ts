import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages.js';
// packages/agent/src/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { StreamChunk } from '../models/provider-normalize.js';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';
import { FailoverError } from '../errors.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl });
  }

  // TODO(L3): params.tools를 SDK 호출에 전달해야 함 (Phase 9+ 도구 사용 기능)
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

  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    const systemMessages = params.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = params.messages.filter((m) => m.role !== 'system');
    const system = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    const convertedTools = (params.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    }));

    // 마지막 도구에 cache_control 부착 (prompt caching)
    const toolsWithCache = convertedTools.map((tool, i) => {
      if (i === convertedTools.length - 1) {
        return Object.assign(tool, { cache_control: { type: 'ephemeral' as const } });
      }
      return tool;
    });

    try {
      const stream = this.client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        ...(system
          ? {
              system: [
                {
                  type: 'text' as const,
                  text: system,
                  cache_control: { type: 'ephemeral' as const },
                },
              ],
            }
          : {}),
        messages: nonSystemMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        ...(toolsWithCache.length ? { tools: toolsWithCache } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      });

      for await (const event of stream) {
        yield* this.mapAnthropicStreamEvent(event);
      }
    } catch (error) {
      throw wrapAnthropicError(error);
    }
  }

  private *mapAnthropicStreamEvent(event: MessageStreamEvent): Iterable<StreamChunk> {
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          yield {
            type: 'tool_use_start',
            id: event.content_block.id,
            name: event.content_block.name,
          };
        }
        break;

      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          yield { type: 'tool_input_delta', delta: event.delta.partial_json };
        }
        break;

      // TODO(L3): content_block_stop은 텍스트 블록에도 발생하지만 무조건 tool_use_end를
      //  발행한다. ToolInputBuffer가 pending 없으면 무시하므로 현재 기능 문제 없으나,
      //  블록 타입을 체크하여 tool_use 블록에서만 발행하도록 개선 필요.
      case 'content_block_stop':
        yield { type: 'tool_use_end' };
        break;

      case 'message_delta':
        if (event.usage) {
          yield {
            type: 'usage',
            usage: { outputTokens: event.usage.output_tokens ?? undefined },
          };
        }
        break;

      case 'message_start':
        if (event.message.usage) {
          const msgUsage = event.message.usage as {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          yield {
            type: 'usage',
            usage: {
              inputTokens: msgUsage.input_tokens,
              outputTokens: msgUsage.output_tokens,
              cacheReadTokens: msgUsage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: msgUsage.cache_creation_input_tokens ?? 0,
            },
          };
        }
        break;

      case 'message_stop':
        yield { type: 'done' };
        break;
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
