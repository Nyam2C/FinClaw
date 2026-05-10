// packages/agent/src/providers/structured-output.test.ts
// Phase 30 B8: forceToolChoice 가 어댑터 → SDK 호출 body 에 반영되는지.
//
// 외부 API 호출 없이 SDK 의 stream/create 메서드를 vi.spyOn 으로 가로채 호출 인자 검증.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';

describe('Phase 30 B8 — forceToolChoice in providers', () => {
  it('AnthropicAdapter passes tool_choice: { type: "tool", name }', async () => {
    const adapter = new AnthropicAdapter('sk-test');
    const fakeStream = (async function* () {
      // 빈 stream (mapAnthropicStreamEvent 가 처리할 게 없음)
    })() as never;
    const spy = vi.spyOn(Anthropic.Messages.prototype, 'stream').mockReturnValue(fakeStream);

    try {
      const iter = adapter.streamCompletion({
        model: 'claude-3-haiku',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'analyze_market',
            description: 'd',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
        ],
        forceToolChoice: { name: 'analyze_market' },
      });
      // stream 1회 끌어서 SDK stream 호출 발생
      const it2 = iter[Symbol.asyncIterator]();
      await it2.next();

      expect(spy).toHaveBeenCalledTimes(1);
      const body = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body['tool_choice']).toEqual({ type: 'tool', name: 'analyze_market' });
    } finally {
      spy.mockRestore();
    }
  });

  it('AnthropicAdapter omits tool_choice when forceToolChoice missing', async () => {
    const adapter = new AnthropicAdapter('sk-test');
    const fakeStream = (async function* () {})() as never;
    const spy = vi.spyOn(Anthropic.Messages.prototype, 'stream').mockReturnValue(fakeStream);

    try {
      const iter = adapter.streamCompletion({
        model: 'claude-3-haiku',
        messages: [{ role: 'user', content: 'hi' }],
      });
      const it2 = iter[Symbol.asyncIterator]();
      await it2.next();

      const body = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body['tool_choice']).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('OpenAIAdapter passes tool_choice: { type: "function", function: { name } }', async () => {
    const adapter = new OpenAIAdapter('sk-test');
    const fakeStream = (async function* () {})() as never;
    const spy = vi
      .spyOn(OpenAI.Chat.Completions.prototype, 'create')
      // OpenAI 의 create 는 stream 옵션에 따라 stream 또는 response — 우리는 stream: true 호출이라 AsyncIterable 반환.
      .mockResolvedValue(fakeStream);

    try {
      const iter = adapter.streamCompletion({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'analyze_market',
            description: 'd',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
        ],
        forceToolChoice: { name: 'analyze_market' },
      });
      const it2 = iter[Symbol.asyncIterator]();
      await it2.next();

      const body = spy.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect(body['tool_choice']).toEqual({
        type: 'function',
        function: { name: 'analyze_market' },
      });
    } finally {
      spy.mockRestore();
    }
  });
});
