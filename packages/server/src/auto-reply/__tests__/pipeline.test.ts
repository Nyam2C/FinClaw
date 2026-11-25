import type { AgentEvent, AgentRunPort, AgentRunRequest } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import type { MsgContext, ChannelPlugin, StorageAdapter } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import { registerBuiltInCommands } from '../commands/built-in.js';
import { InMemoryCommandRegistry } from '../commands/registry.js';
import { CONTROL_TOKENS } from '../control-tokens.js';
import { AutoReplyPipeline, type PipelineConfig, type PipelineDependencies } from '../pipeline.js';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    body: 'hello finclaw',
    bodyForAgent: 'hello finclaw',
    rawBody: 'hello finclaw',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test-session'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function fakeRuntime(
  text: string,
  extra: Partial<Extract<AgentEvent, { type: 'done' }>> = {},
): AgentRunPort & { calls: AgentRunRequest[] } {
  const calls: AgentRunRequest[] = [];
  return {
    calls,
    async *run(req) {
      calls.push(req);
      yield {
        type: 'done',
        runId: 'r1',
        cliSessionId: 'c1',
        text,
        usage: ZERO,
        durationMs: 1,
        numTurns: 1,
        ...extra,
      };
    },
    reset: async () => false,
  };
}

function errorRuntime(
  reason: 'auth' | 'rate_limit' | 'timeout' | 'aborted' | 'unknown',
  message = 'raw stderr: token=secret',
): AgentRunPort {
  return {
    async *run(req) {
      yield { type: 'error', runId: req.runId ?? 'r1', reason, message };
    },
    reset: async () => false,
  };
}

function makeChannel(): Pick<ChannelPlugin, 'send' | 'sendTyping'> {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    commandPrefix: '/',
    timeoutMs: 30_000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PipelineDependencies> = {}): PipelineDependencies {
  const channel = makeChannel();
  const registry = new InMemoryCommandRegistry();
  registerBuiltInCommands(registry, { storage: {} as StorageAdapter });

  return {
    runtime: fakeRuntime('AI response'),
    commandRegistry: registry,
    logger: makeLogger(),
    getChannel: () => channel,
    ...overrides,
  };
}

describe('AutoReplyPipeline', () => {
  it('전체 단계를 실행해 응답을 채널로 전송한다', async () => {
    const channel = makeChannel();
    const runtime = fakeRuntime('AI response');
    const pipeline = new AutoReplyPipeline(
      makeConfig(),
      makeDeps({ runtime, getChannel: () => channel }),
    );

    await pipeline.process(makeCtx());

    expect(channel.sendTyping).toHaveBeenCalled();
    expect(runtime.calls.length).toBe(1);
    expect(runtime.calls[0]).toMatchObject({
      mode: 'chat',
      input: 'hello finclaw',
      sessionKey: 'test-session',
    });
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [expect.objectContaining({ text: 'AI response' })] }),
    );
  });

  it('B4: 명령 결과를 채널로 보내고 AI 는 호출하지 않는다', async () => {
    const channel = makeChannel();
    const runtime = fakeRuntime('AI response');
    const pipeline = new AutoReplyPipeline(
      makeConfig(),
      makeDeps({ runtime, getChannel: () => channel }),
    );
    await pipeline.process(makeCtx({ body: '/help' }));
    expect(runtime.calls).toHaveLength(0);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [
          expect.objectContaining({ text: expect.stringContaining('사용 가능한 명령어') }),
        ],
      }),
    );
  });

  it('NO_REPLY 토큰 시 deliver 하지 않는다', async () => {
    const channel = makeChannel();
    const runtime = fakeRuntime(CONTROL_TOKENS.NO_REPLY);
    const deps = makeDeps({ runtime, getChannel: () => channel });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx());

    expect(runtime.calls.length).toBe(1);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('SILENT_REPLY 토큰 시 deliver 스테이지에서 skip한다', async () => {
    const channel = makeChannel();
    const runtime = fakeRuntime(`response${CONTROL_TOKENS.SILENT_REPLY}`);
    const deps = makeDeps({ runtime, getChannel: () => channel });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx());

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('채널이 없어도 정상 동작한다', async () => {
    const deps = makeDeps({ getChannel: () => undefined });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    // 에러 없이 완료
    await pipeline.process(makeCtx());
  });

  it('타임아웃 시 deliver 전에 중단한다', async () => {
    const channel = makeChannel();
    const runtime: AgentRunPort = {
      async *run() {
        await new Promise((r) => setTimeout(r, 30));
        yield {
          type: 'done',
          runId: 'r',
          cliSessionId: 'c',
          text: 'late',
          usage: ZERO,
          durationMs: 1,
          numTurns: 1,
        };
      },
      reset: async () => false,
    };
    const logger = makeLogger();
    const deps = makeDeps({ runtime, getChannel: () => channel, logger });
    const pipeline = new AutoReplyPipeline(makeConfig({ timeoutMs: 5 }), deps);

    await pipeline.process(makeCtx());

    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Pipeline aborted', { stage: 'deliver' });
  });

  it.each([
    ['auth', 'Claude 로그인이 필요합니다'],
    ['rate_limit', 'Claude 사용 한도에 도달했습니다'],
    ['timeout', '응답 시간이 초과되었습니다'],
    ['unknown', '응답 생성 중 오류가 발생했습니다'],
  ] as const)('Q10: %s → 고정 문구, raw message 미포함', async (reason, phrase) => {
    const channel = makeChannel();
    const pipeline = new AutoReplyPipeline(
      makeConfig(),
      makeDeps({ runtime: errorRuntime(reason), getChannel: () => channel }),
    );
    await pipeline.process(makeCtx());
    const text = vi.mocked(channel.send)?.mock.calls[0]?.[0].payloads[0]?.text ?? '';
    expect(text).toContain(phrase);
    expect(text).not.toContain('token=secret');
  });

  it('Q10: aborted 는 무응답', async () => {
    const channel = makeChannel();
    const pipeline = new AutoReplyPipeline(
      makeConfig(),
      makeDeps({ runtime: errorRuntime('aborted'), getChannel: () => channel }),
    );
    await pipeline.process(makeCtx());
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('done.captured 가 있으면 deliver 가 기억 꼬리표를 붙인다', async () => {
    const channel = makeChannel();
    const runtime = fakeRuntime('네', {
      captured: { memoryId: 'abcdef1234', type: 'fact', content: '나는 자두', duplicate: false },
    });
    const pipeline = new AutoReplyPipeline(
      makeConfig(),
      makeDeps({ runtime, getChannel: () => channel }),
    );
    await pipeline.process(makeCtx({ body: '기억해: 나는 자두' }));
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [
          expect.objectContaining({
            text: expect.stringContaining('_기억했습니다 (fact, #abcdef12)_'),
          }),
        ],
      }),
    );
  });
});
