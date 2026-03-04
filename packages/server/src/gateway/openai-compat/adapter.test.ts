// packages/server/src/gateway/openai-compat/adapter.test.ts
import { describe, it, expect } from 'vitest';
import { mapModelId, adaptRequest, adaptResponse, adaptStreamChunk } from './adapter.js';

describe('mapModelId', () => {
  it('gpt-4o → claude-sonnet-4', () => {
    expect(mapModelId('gpt-4o')).toBe('claude-sonnet-4-20250514');
  });

  it('gpt-4o-mini → claude-haiku-4', () => {
    expect(mapModelId('gpt-4o-mini')).toBe('claude-haiku-4-20250414');
  });

  it('gpt-3.5-turbo → claude-haiku-4', () => {
    expect(mapModelId('gpt-3.5-turbo')).toBe('claude-haiku-4-20250414');
  });

  it('claude-* passthrough', () => {
    expect(mapModelId('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514');
    expect(mapModelId('claude-haiku-4-20250414')).toBe('claude-haiku-4-20250414');
  });

  it('미지원 모델 → undefined', () => {
    expect(mapModelId('unknown-model')).toBeUndefined();
    expect(mapModelId('llama-3')).toBeUndefined();
  });
});

describe('adaptRequest', () => {
  it('system 메시지 분리', () => {
    const result = adaptRequest(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
  });

  it('기본 max_tokens 4096', () => {
    const result = adaptRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.model.maxTokens).toBe(4096);
  });

  it('사용자 지정 max_tokens', () => {
    const result = adaptRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1024,
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.model.maxTokens).toBe(1024);
  });

  it('temperature 전달', () => {
    const result = adaptRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.7,
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.model.temperature).toBe(0.7);
  });
});

describe('adaptResponse', () => {
  it('OpenAI 응답 포맷 생성', () => {
    const result = adaptResponse(
      { text: 'Hello!', usage: { inputTokens: 10, outputTokens: 5 } },
      'gpt-4o',
    );

    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('gpt-4o');
    expect(result.choices[0].message.content).toBe('Hello!');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
  });

  it('usage 없으면 0', () => {
    const result = adaptResponse({ text: 'Hi' }, 'gpt-4o');
    expect(result.usage.total_tokens).toBe(0);
  });
});

describe('adaptStreamChunk', () => {
  it('text_delta → chunk with content', () => {
    const chunk = adaptStreamChunk({ type: 'text_delta', delta: 'Hello' }, 'gpt-4o');

    expect(chunk).not.toBeNull();
    expect(chunk?.object).toBe('chat.completion.chunk');
    expect(chunk?.choices[0].delta.content).toBe('Hello');
    expect(chunk?.choices[0].finish_reason).toBeNull();
  });

  it('done → chunk with finish_reason stop', () => {
    const chunk = adaptStreamChunk({ type: 'done' }, 'gpt-4o');

    expect(chunk).not.toBeNull();
    expect(chunk?.choices[0].finish_reason).toBe('stop');
  });

  it('기타 이벤트 → null', () => {
    expect(adaptStreamChunk({ type: 'tool_use_start' }, 'gpt-4o')).toBeNull();
    expect(adaptStreamChunk({ type: 'state_change' }, 'gpt-4o')).toBeNull();
  });
});
