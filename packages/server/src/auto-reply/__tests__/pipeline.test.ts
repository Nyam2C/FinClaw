import type { FinClawLogger } from '@finclaw/infra';
import type { MsgContext, ChannelPlugin } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId, createAgentId } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import type { BindingMatch } from '../../process/binding-matcher.js';
import { registerBuiltInCommands } from '../commands/built-in.js';
import { InMemoryCommandRegistry } from '../commands/registry.js';
import { CONTROL_TOKENS } from '../control-tokens.js';
import { MockExecutionAdapter, type ExecutionAdapter } from '../execution-adapter.js';
import type { PipelineObserver } from '../observer.js';
import type { FinanceContextProvider, PipelineMsgContext } from '../pipeline-context.js';
import { AutoReplyPipeline, type PipelineConfig, type PipelineDependencies } from '../pipeline.js';
import type { MemoryRetrievalService, RetrievalResult } from '../stages/memory-retrieval.js';

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

// ─── Phase 26 C: MemoryRetrieval wiring ───

function makeRetrievalResult(): RetrievalResult {
  return {
    snippets: [
      {
        id: 'm1',
        content: '나는 장기 가치투자를 한다',
        type: 'preference',
        createdAt: Date.now() - 86_400_000,
        rawScore: 0.81,
        adjustedScore: 0.78,
        daysOld: 1,
      },
    ],
    transactions: [],
    mode: 'fts-only',
    auditLog: {
      event: 'memory.injected',
      sessionKey: 'test-session',
      userQuery: 'hello finclaw',
      memoryIds: ['m1'],
      rawScores: [0.81],
      adjustedScores: [0.78],
      mode: 'fts-only',
      transactionSymbols: [],
      timestamp: Date.now(),
    },
  };
}

describe('AutoReplyPipeline + MemoryRetrieval (Phase 26 C)', () => {
  it('retrieval 결과를 enrichedCtx 에 주입해 execute 로 전달한다', async () => {
    const expected = makeRetrievalResult();
    const retrievalService: MemoryRetrievalService = {
      searchRelevant: vi.fn().mockResolvedValue(expected),
    };
    const captured: PipelineMsgContext[] = [];
    const adapter: ExecutionAdapter = {
      async execute(ctx) {
        captured.push(ctx);
        return { content: 'ok', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const observer: PipelineObserver = {
      onStageStart: vi.fn(),
      onStageComplete: vi.fn(),
      onPipelineComplete: vi.fn(),
    };
    const deps = makeDeps({
      executionAdapter: adapter,
      memoryRetrievalService: retrievalService,
      observer,
    });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    expect(retrievalService.searchRelevant).toHaveBeenCalledOnce();
    expect(retrievalService.searchRelevant).toHaveBeenCalledWith({
      userQuery: 'hello finclaw',
      sessionKey: 'test-session',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].retrievalResult).toBe(expected);

    const completeCall = vi.mocked(
      observer.onPipelineComplete as NonNullable<typeof observer.onPipelineComplete>,
    ).mock.calls[0];
    expect(completeCall[1].stagesExecuted).toContain('memory-retrieval');
  });

  it('retrieval 실패해도 파이프라인이 계속 진행한다 (best-effort)', async () => {
    const retrievalService: MemoryRetrievalService = {
      searchRelevant: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const captured: PipelineMsgContext[] = [];
    const adapter: ExecutionAdapter = {
      async execute(ctx) {
        captured.push(ctx);
        return { content: 'ok', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const observer: PipelineObserver = {
      onPipelineComplete: vi.fn(),
    };
    const logger = makeLogger();
    const deps = makeDeps({
      executionAdapter: adapter,
      memoryRetrievalService: retrievalService,
      observer,
      logger,
    });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    // execute 까지 도달하되 retrievalResult 미주입
    expect(captured).toHaveLength(1);
    expect(captured[0].retrievalResult).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory retrieval failed'),
      expect.objectContaining({ event: 'memory.retrieval.stage_error' }),
    );

    // 파이프라인은 deliver 까지 정상 완료
    const completeCall = vi.mocked(
      observer.onPipelineComplete as NonNullable<typeof observer.onPipelineComplete>,
    ).mock.calls[0];
    expect(completeCall[1].success).toBe(true);
    expect(completeCall[1].stagesExecuted).toContain('memory-retrieval');
    expect(completeCall[1].stagesExecuted).toContain('deliver');
  });

  it('memoryRetrievalService 미주입 시 retrieval 단계 자체가 생략된다', async () => {
    const captured: PipelineMsgContext[] = [];
    const adapter: ExecutionAdapter = {
      async execute(ctx) {
        captured.push(ctx);
        return { content: 'ok', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const observer: PipelineObserver = {
      onPipelineComplete: vi.fn(),
    };
    const deps = makeDeps({ executionAdapter: adapter, observer });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx(), makeMatch(), AbortSignal.timeout(10_000));

    expect(captured).toHaveLength(1);
    expect(captured[0].retrievalResult).toBeUndefined();
    const completeCall = vi.mocked(
      observer.onPipelineComplete as NonNullable<typeof observer.onPipelineComplete>,
    ).mock.calls[0];
    expect(completeCall[1].stagesExecuted).not.toContain('memory-retrieval');
  });
});
