import type { ConversationMessage, ToolDefinition } from '@finclaw/types';
// packages/agent/src/providers/openai.ts
import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions.js';
import { FailoverError } from '../errors.js';
import type { StreamChunk } from '../models/provider-normalize.js';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';

/**
 * 내부 ConversationMessage → OpenAI ChatCompletionMessageParam 변환.
 *
 * - role 'tool' → 'tool' (OpenAI 도 tool message 별도 role)
 * - assistant 의 tool_use 블록 → assistant.tool_calls[]
 * - tool_result 블록 → role='tool', tool_call_id=<toolUseId>
 */
function toOpenAIMessages(messages: ConversationMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      result.push({ role: 'system', content: typeof m.content === 'string' ? m.content : '' });
      continue;
    }
    if (m.role === 'tool') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const toolMsg: ChatCompletionToolMessageParam = {
            role: 'tool',
            tool_call_id: b.toolUseId,
            content: b.content,
          };
          result.push(toolMsg);
        }
      }
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content
        .filter(
          (b): b is Extract<(typeof m.content)[number], { type: 'text' }> => b.type === 'text',
        )
        .map((b) => b.text)
        .join('');
      const toolCalls = m.content
        .filter(
          (b): b is Extract<(typeof m.content)[number], { type: 'tool_use' }> =>
            b.type === 'tool_use',
        )
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      result.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    result.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    });
  }
  return result;
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    try {
      const sys = params.systemPrompt
        ? [{ role: 'system' as const, content: params.systemPrompt }]
        : [];
      return await this.client.chat.completions.create(
        {
          model: params.model,
          max_completion_tokens: params.maxTokens ?? 4096,
          messages: [
            ...sys,
            ...toOpenAIMessages(params.messages.filter((m) => m.role !== 'system')),
          ],
          ...(params.tools?.length ? { tools: toOpenAITools(params.tools) } : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        },
        { signal: params.abortSignal },
      );
    } catch (error) {
      throw wrapOpenAIError(error);
    }
  }

  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    const sys = params.systemPrompt
      ? [{ role: 'system' as const, content: params.systemPrompt }]
      : [];
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: params.model,
          max_completion_tokens: params.maxTokens ?? 4096,
          messages: [
            ...sys,
            ...toOpenAIMessages(params.messages.filter((m) => m.role !== 'system')),
          ],
          ...(params.tools?.length ? { tools: toOpenAITools(params.tools) } : {}),
          ...(params.forceToolChoice
            ? {
                tool_choice: {
                  type: 'function' as const,
                  function: { name: params.forceToolChoice.name },
                },
              }
            : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: params.abortSignal },
      );

      // OpenAI 는 tool_use 가 chunk delta.tool_calls[index].function.{name,arguments} 로 분할 도착.
      // index 별로 첫 등장 시 tool_use_start, 이후 arguments delta 마다 tool_input_delta, finish_reason 시 tool_use_end.
      const startedToolIndices = new Set<number>();
      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          yield { type: 'text_delta', text: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!startedToolIndices.has(idx)) {
              startedToolIndices.add(idx);
              if (tc.id && tc.function?.name) {
                yield { type: 'tool_use_start', id: tc.id, name: tc.function.name };
              }
            }
            if (tc.function?.arguments) {
              yield { type: 'tool_input_delta', delta: tc.function.arguments };
            }
          }
        }
        if (choice?.finish_reason) {
          // tool_use_end 는 OpenAI 에 직접 대응 이벤트 없음 — finish_reason 시 모든 활성 도구 종료.
          for (const _ of startedToolIndices) {
            yield { type: 'tool_use_end' };
          }
          startedToolIndices.clear();
        }
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        }
      }
      yield { type: 'done' };
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
