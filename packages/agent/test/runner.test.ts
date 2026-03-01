import type { AgentRunParams } from '@finclaw/types';
import { ConcurrencyLaneManager } from '@finclaw/infra';
import { describe, it, expect, beforeEach } from 'vitest';
import type { RunnerOptions } from '../src/execution/runner.js';
import type { StreamEvent } from '../src/execution/streaming.js';
import type { StreamChunk } from '../src/models/provider-normalize.js';
import type { ProviderAdapter, ProviderRequestParams } from '../src/providers/adapter.js';
import { Runner } from '../src/execution/runner.js';
import { ExecutionToolDispatcher } from '../src/execution/tool-executor.js';

/** mock provider: 미리 정해진 StreamChunk 시퀀스를 반환 */
function createMockProvider(sequences: StreamChunk[][]): ProviderAdapter {
  let callIndex = 0;
  return {
    providerId: 'anthropic',
    chatCompletion: async () => ({}),
    async *streamCompletion(_params: ProviderRequestParams): AsyncIterable<StreamChunk> {
      const seq = sequences[callIndex++] ?? [];
      for (const chunk of seq) {
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
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    },
    systemPrompt: '테스트 시스템 프롬프트',
    messages: [{ role: 'user', content: '안녕하세요' }],
    ...overrides,
  };
}

describe('Runner', () => {
  let toolExecutor: ExecutionToolDispatcher;
  let laneManager: ConcurrencyLaneManager;

  beforeEach(() => {
    toolExecutor = new ExecutionToolDispatcher();
    laneManager = new ConcurrencyLaneManager();
  });

  function createRunner(provider: ProviderAdapter, opts?: Partial<RunnerOptions>): Runner {
    return new Runner({
      provider,
      toolExecutor,
      laneManager,
      ...opts,
    });
  }

  describe('단일 턴 실행', () => {
    it('도구 호출 없는 간단한 질의 — completed 반환', async () => {
      const provider = createMockProvider([
        [
          { type: 'text_delta', text: '안녕하세요!' },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
          { type: 'done' },
        ],
      ]);

      const runner = createRunner(provider);
      const result = await runner.execute(createBaseParams());

      expect(result.status).toBe('completed');
      expect(result.turns).toBe(1);
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
      // 마지막 메시지가 assistant 응답
      const lastMsg = result.messages.at(-1);
      expect(lastMsg?.role).toBe('assistant');
      expect(lastMsg?.content).toBe('안녕하세요!');
    });
  });

  describe('멀티 턴 실행 (도구 호출)', () => {
    it('LLM → tool_use → LLM 2턴 실행', async () => {
      const provider = createMockProvider([
        // 턴 1: LLM이 도구 호출
        [
          { type: 'tool_use_start', id: 'call_1', name: 'get_price' },
          { type: 'tool_input_delta', delta: '{"ticker":"AAPL"}' },
          { type: 'tool_use_end' },
          { type: 'usage', usage: { inputTokens: 50, outputTokens: 20 } },
          { type: 'done' },
        ],
        // 턴 2: LLM이 텍스트 응답
        [
          { type: 'text_delta', text: 'AAPL 가격은 150입니다.' },
          { type: 'usage', usage: { inputTokens: 80, outputTokens: 15 } },
          { type: 'done' },
        ],
      ]);

      toolExecutor.register('get_price', {
        execute: async (input) => {
          const { ticker } = input as { ticker: string };
          return `${ticker}: $150.00`;
        },
      });

      const runner = createRunner(provider);
      const result = await runner.execute(createBaseParams());

      expect(result.status).toBe('completed');
      expect(result.turns).toBe(2);
      expect(result.usage.inputTokens).toBe(130); // 50 + 80
      expect(result.usage.outputTokens).toBe(35); // 20 + 15

      // 메시지 구조: user → assistant(tool_use) → tool(result) → assistant(text)
      const msgs = result.messages;
      expect(msgs).toHaveLength(4);
      expect(msgs[1]?.role).toBe('assistant');
      expect(msgs[2]?.role).toBe('tool');
      expect(msgs[3]?.role).toBe('assistant');
      expect(msgs[3]?.content).toBe('AAPL 가격은 150입니다.');
    });
  });

  describe('maxTurns 제한', () => {
    it('maxTurns 도달 시 max_turns 상태를 반환한다', async () => {
      const sequences = Array.from({ length: 5 }, () => [
        { type: 'tool_use_start' as const, id: 'call_x', name: 'loop_tool' },
        { type: 'tool_input_delta' as const, delta: '{}' },
        { type: 'tool_use_end' as const },
        { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'done' as const },
      ]);
      const provider = createMockProvider(sequences);

      toolExecutor.register('loop_tool', { execute: async () => 'ok' });

      const runner = createRunner(provider, { maxTurns: 3 });
      const result = await runner.execute(createBaseParams());

      expect(result.status).toBe('max_turns');
      expect(result.turns).toBe(3);
    });
  });

  describe('abort 처리', () => {
    it('abortSignal이 이미 aborted이면 즉시 aborted를 반환한다', async () => {
      const provider = createMockProvider([]);
      const runner = createRunner(provider);

      const controller = new AbortController();
      controller.abort();

      const result = await runner.execute(createBaseParams({ abortSignal: controller.signal }));
      expect(result.status).toBe('aborted');
      expect(result.turns).toBe(0);
    });
  });

  describe('이벤트 리스너', () => {
    it('text_delta 이벤트를 리스너에 전달한다', async () => {
      const provider = createMockProvider([
        [
          { type: 'text_delta', text: '안녕' },
          { type: 'text_delta', text: '하세요' },
          { type: 'done' },
        ],
      ]);

      const events: StreamEvent[] = [];
      const runner = createRunner(provider);
      await runner.execute(createBaseParams(), (e) => events.push(e));

      const textDeltas = events.filter((e) => e.type === 'text_delta');
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0]).toEqual({ type: 'text_delta', delta: '안녕' });
      expect(textDeltas[1]).toEqual({ type: 'text_delta', delta: '하세요' });
    });
  });

  describe('Lane 핸들 release', () => {
    it('정상 완료 시 핸들이 release된다', async () => {
      const provider = createMockProvider([[{ type: 'text_delta', text: 'ok' }, { type: 'done' }]]);

      const runner = createRunner(provider);
      await runner.execute(createBaseParams());

      // release 확인: 같은 키로 다시 acquire 가능해야 함
      const handle = await laneManager.acquire('main', 'test-session');
      handle.release();
    });

    it('에러 시에도 핸들이 release된다 (try/finally)', async () => {
      const provider: ProviderAdapter = {
        providerId: 'anthropic',
        chatCompletion: async () => ({}),
        // eslint-disable-next-line require-yield
        async *streamCompletion() {
          throw new Error('Provider exploded');
        },
      };

      const runner = createRunner(provider);
      await expect(runner.execute(createBaseParams())).rejects.toThrow('Provider exploded');

      // release 확인
      const handle = await laneManager.acquire('main', 'test-session');
      handle.release();
    });
  });
});
