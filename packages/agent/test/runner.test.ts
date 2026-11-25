import { ConcurrencyLaneManager } from '@finclaw/infra';
import type { AgentRunParams } from '@finclaw/types';
import { describe, it, expect, beforeEach } from 'vitest';
import type { RunnerOptions } from '../src/execution/runner.js';
import { Runner } from '../src/execution/runner.js';
import type { StreamEvent } from '../src/execution/streaming.js';
import type { StreamChunk } from '../src/models/provider-normalize.js';
import type { ProviderAdapter, ProviderRequestParams } from '../src/providers/adapter.js';

/** mock provider: 미리 정해진 StreamChunk 시퀀스를 반환 */
function createMockProvider(chunks: StreamChunk[]): ProviderAdapter {
  return {
    providerId: 'claude-cli',
    async *streamCompletion(_params: ProviderRequestParams): AsyncIterable<StreamChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function createBaseParams(overrides?: Partial<AgentRunParams>): AgentRunParams {
  return {
    agentId: 'test-agent' as AgentRunParams['agentId'],
    sessionKey: 'test-session' as AgentRunParams['sessionKey'],
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    systemPrompt: '테스트 시스템 프롬프트',
    messages: [{ role: 'user', content: '안녕하세요' }],
    ...overrides,
  };
}

describe('Runner', () => {
  let laneManager: ConcurrencyLaneManager;

  beforeEach(() => {
    laneManager = new ConcurrencyLaneManager();
  });

  function createRunner(provider: ProviderAdapter, opts?: Partial<RunnerOptions>): Runner {
    return new Runner({ provider, laneManager, ...opts });
  }

  it('provider 1회 호출 → assistant 텍스트 메시지 + usage', async () => {
    const provider = createMockProvider([
      { type: 'text_delta', text: '안녕하세요!' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'done' },
    ]);

    const result = await createRunner(provider).execute(createBaseParams());

    expect(result.status).toBe('completed');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: '안녕하세요!' });
  });

  it('abortSignal이 이미 aborted이면 provider 호출 없이 aborted를 반환한다', async () => {
    const provider: ProviderAdapter = {
      providerId: 'claude-cli',
      // eslint-disable-next-line require-yield
      async *streamCompletion() {
        throw new Error('should not be called');
      },
    };
    const controller = new AbortController();
    controller.abort();

    const result = await createRunner(provider).execute(
      createBaseParams({ abortSignal: controller.signal }),
    );
    expect(result.status).toBe('aborted');
  });

  it('text_delta 이벤트를 리스너에 전달한다', async () => {
    const provider = createMockProvider([
      { type: 'text_delta', text: '안녕' },
      { type: 'text_delta', text: '하세요' },
      { type: 'done' },
    ]);

    const events: StreamEvent[] = [];
    await createRunner(provider).execute(createBaseParams(), (e) => events.push(e));

    expect(events).toEqual([
      { type: 'text_delta', delta: '안녕' },
      { type: 'text_delta', delta: '하세요' },
    ]);
  });

  it('tracer 주입 시 agent.turn → provider.stream span 으로 감싼다', async () => {
    const spans: string[] = [];
    const provider = createMockProvider([{ type: 'text_delta', text: 'ok' }, { type: 'done' }]);
    const runner = createRunner(provider, {
      tracer: {
        withSpan: (name, _attrs, fn) => {
          spans.push(name);
          return fn();
        },
      },
    });

    await runner.execute(createBaseParams());
    expect(spans).toEqual(['agent.turn', 'provider.stream']);
  });

  it('정상 완료 시 lane 핸들이 release된다', async () => {
    const provider = createMockProvider([{ type: 'text_delta', text: 'ok' }, { type: 'done' }]);
    await createRunner(provider).execute(createBaseParams());

    const handle = await laneManager.acquire('main', 'test-session');
    handle.release();
  });

  it('에러 시에도 lane 핸들이 release된다 (try/finally)', async () => {
    const provider: ProviderAdapter = {
      providerId: 'claude-cli',
      // eslint-disable-next-line require-yield
      async *streamCompletion() {
        throw new Error('Provider exploded');
      },
    };

    await expect(createRunner(provider).execute(createBaseParams())).rejects.toThrow(
      'Provider exploded',
    );

    const handle = await laneManager.acquire('main', 'test-session');
    handle.release();
  });
});
