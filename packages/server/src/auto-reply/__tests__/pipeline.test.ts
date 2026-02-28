import type { FinClawLogger } from '@finclaw/infra';
import type { MsgContext, ChannelPlugin } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId, createAgentId } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import type { BindingMatch } from '../../process/binding-matcher.js';
import type { PipelineObserver } from '../observer.js';
import type { FinanceContextProvider } from '../pipeline-context.js';
import { registerBuiltInCommands } from '../commands/built-in.js';
import { InMemoryCommandRegistry } from '../commands/registry.js';
import { CONTROL_TOKENS } from '../control-tokens.js';
import { MockExecutionAdapter } from '../execution-adapter.js';
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

function makeMatch(): BindingMatch {
  return {
    agentId: createAgentId('default'),
    rule: {
      agentId: createAgentId('default'),
      priority: 0,
    },
    matchTier: 'default',
  };
}

function makeChannel(): Pick<ChannelPlugin, 'send' | 'addReaction' | 'sendTyping'> {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProvider(): FinanceContextProvider {
  return {
    getActiveAlerts: vi.fn().mockResolvedValue([]),
    getPortfolio: vi.fn().mockResolvedValue(null),
    getRecentNews: vi.fn().mockResolvedValue([]),
    getMarketSession: vi.fn().mockReturnValue({
      isOpen: true,
      market: 'NYSE',
      nextOpenAt: null,
      timezone: 'America/New_York',
    }),
    getWatchlist: vi.fn().mockResolvedValue([]),
  };
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    enableAck: true,
    commandPrefix: '/',
    maxResponseLength: 2000,
    timeoutMs: 30_000,
    respectMarketHours: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PipelineDependencies> = {}): PipelineDependencies {
  const channel = makeChannel();
  const registry = new InMemoryCommandRegistry();
  registerBuiltInCommands(registry);

  return {
    executionAdapter: new MockExecutionAdapter('AI response'),
    financeContextProvider: makeProvider(),
    commandRegistry: registry,
    logger: makeLogger(),
    getChannel: () => channel,
    ...overrides,
  };
}

describe('AutoReplyPipeline', () => {
  it('전체 6단계를 정상 실행한다', async () => {
    const observer: PipelineObserver = {
      onPipelineStart: vi.fn(),
      onPipelineComplete: vi.fn(),
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
    };
    const deps = makeDeps({ observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    expect(observer.onPipelineStart).toHaveBeenCalledTimes(1);
    expect(observer.onPipelineComplete).toHaveBeenCalledTimes(1);

    const completeCall = vi.mocked(
      observer.onPipelineComplete as NonNullable<typeof observer.onPipelineComplete>,
    ).mock.calls[0];
    expect(completeCall[1].success).toBe(true);
    expect(completeCall[1].stagesExecuted).toEqual([
      'normalize',
      'command',
      'ack',
      'context',
      'execute',
      'deliver',
    ]);
  });

  it('명령어 메시지 시 command 스테이지에서 skip한다', async () => {
    const observer: PipelineObserver = {
      onPipelineStart: vi.fn(),
      onPipelineComplete: vi.fn(),
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
    };
    const deps = makeDeps({ observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx({ body: '/help' }), makeMatch(), AbortSignal.timeout(10_000));

    const completeCall = vi.mocked(
      observer.onPipelineComplete as NonNullable<typeof observer.onPipelineComplete>,
    ).mock.calls[0];
    expect(completeCall[1].stagesExecuted).toEqual(['normalize', 'command']);
  });

  it('NO_REPLY 토큰 시 execute 스테이지에서 skip한다', async () => {
    const observer: PipelineObserver = {
      onPipelineStart: vi.fn(),
      onPipelineComplete: vi.fn(),
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
    };
    const adapter = new MockExecutionAdapter(CONTROL_TOKENS.NO_REPLY);
    const deps = makeDeps({ executionAdapter: adapter, observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    const completeCall = vi.mocked(
      observer.onPipelineComplete as NonNullable<typeof observer.onPipelineComplete>,
    ).mock.calls[0];
    expect(completeCall[1].stagesExecuted).toContain('execute');
    expect(completeCall[1].stagesExecuted).not.toContain('deliver');
  });

  it('SILENT_REPLY 토큰 시 deliver 스테이지에서 skip한다', async () => {
    const channel = makeChannel();
    const adapter = new MockExecutionAdapter(`response${CONTROL_TOKENS.SILENT_REPLY}`);
    const deps = makeDeps({ executionAdapter: adapter, getChannel: () => channel });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('채널이 없어도 정상 동작한다', async () => {
    const deps = makeDeps({ getChannel: () => undefined });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    // 에러 없이 완료
    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));
  });

  it('ACK 비활성화 시 addReaction을 호출하지 않는다', async () => {
    const channel = makeChannel();
    const deps = makeDeps({ getChannel: () => channel });
    const pipeline = new AutoReplyPipeline(makeConfig({ enableAck: false }), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    expect(channel.addReaction).not.toHaveBeenCalled();
  });

  it('이미 abort된 signal로 호출 시 즉시 종료한다', async () => {
    const observer: PipelineObserver = {
      onPipelineStart: vi.fn(),
      onPipelineComplete: vi.fn(),
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
    };
    const deps = makeDeps({ observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    const controller = new AbortController();
    controller.abort();

    await pipeline.process(makeCtx(), makeMatch(), controller.signal);

    const completeCall = vi.mocked(
      observer.onPipelineComplete as NonNullable<typeof observer.onPipelineComplete>,
    ).mock.calls[0];
    expect(completeCall[1].success).toBe(false);
    expect(completeCall[1].abortReason).toBe('Signal aborted');
  });

  it('ExecutionAdapter 에러 시 예외를 전파한다', async () => {
    const adapter = {
      execute: vi.fn().mockRejectedValue(new Error('AI error')),
    };
    const observer: PipelineObserver = {
      onPipelineError: vi.fn(),
    };
    const deps = makeDeps({ executionAdapter: adapter, observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await expect(
      pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000)),
    ).rejects.toThrow('AI error');

    expect(observer.onPipelineError).toHaveBeenCalledTimes(1);
  });
});
