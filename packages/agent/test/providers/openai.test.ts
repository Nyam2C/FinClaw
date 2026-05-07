// packages/agent/test/providers/openai.test.ts
import type { ConversationMessage } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: async (params: { stream?: boolean; model: string }) => {
          if (params.stream) {
            return (async function* () {
              yield {
                choices: [{ delta: { content: 'hello' }, finish_reason: null }],
              };
              yield {
                choices: [{ delta: {}, finish_reason: 'stop' }],
              };
              yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } };
            })();
          }
          return { id: 'cmpl-1', model: params.model, choices: [], usage: {} };
        },
      },
    };
  }
  return { default: MockOpenAI };
});

describe('OpenAIAdapter', () => {
  const adapter = new OpenAIAdapter('test-key');
  const userMsg: ConversationMessage = { role: 'user', content: 'hi' };

  it('streamCompletion: text_delta + done + usage', async () => {
    const chunks: Array<{ type: string }> = [];
    for await (const c of adapter.streamCompletion({
      model: 'gpt-4o-mini',
      messages: [userMsg],
    })) {
      chunks.push(c);
    }
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
  });

  it('chatCompletion: returns model id', async () => {
    const result = (await adapter.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [userMsg],
    })) as { model: string };
    expect(result.model).toBe('gpt-4o-mini');
  });
});
