// packages/server/src/gateway/openai-compat/adapter.ts
import { randomUUID } from 'node:crypto';
import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIStreamChunk } from '../rpc/types.js';

/** OpenAI 모델 ID → FinClaw 내부 모델 ID 매핑 */
const MODEL_MAP: Record<string, string> = {
  'gpt-4o': 'claude-sonnet-4-20250514',
  'gpt-4o-mini': 'claude-haiku-4-20250414',
  'gpt-4-turbo': 'claude-sonnet-4-20250514',
  'gpt-3.5-turbo': 'claude-haiku-4-20250414',
};

export function mapModelId(openaiModel: string): string | undefined {
  if (MODEL_MAP[openaiModel]) {
    return MODEL_MAP[openaiModel];
  }
  if (openaiModel.startsWith('claude-')) {
    return openaiModel;
  }
  return undefined;
}

/** OpenAI 요청 → FinClaw 내부 요청 변환 */
export function adaptRequest(openai: OpenAIChatRequest, internalModel: string) {
  const systemMessages = openai.messages.filter((m) => m.role === 'system');
  const otherMessages = openai.messages.filter((m) => m.role !== 'system');

  return {
    agentId: 'openai-compat',
    conversationId: randomUUID(),
    messages: otherMessages,
    tools: openai.tools ?? [],
    model: {
      modelId: internalModel,
      maxTokens: openai.max_tokens ?? 4096,
      temperature: openai.temperature,
    },
    systemPrompt: systemMessages.map((m) => m.content).join('\n'),
  };
}

/** FinClaw 실행 결과 → OpenAI 응답 변환 */
export function adaptResponse(
  result: { text: string; usage?: { inputTokens: number; outputTokens: number } },
  model: string,
): OpenAIChatResponse {
  return {
    id: `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: result.usage?.inputTokens ?? 0,
      completion_tokens: result.usage?.outputTokens ?? 0,
      total_tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    },
  };
}

/** 스트리밍 이벤트 → OpenAI SSE 청크 변환 */
export function adaptStreamChunk(
  event: { type: string; delta?: string },
  model: string,
): OpenAIStreamChunk | null {
  if (event.type === 'text_delta') {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
    };
  }
  if (event.type === 'done') {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
  }
  return null;
}
