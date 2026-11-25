import type { FinClawLogger } from '@finclaw/infra';
import type { MsgContext, ChannelPlugin, StorageAdapter } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import { registerBuiltInCommands } from '../commands/built-in.js';
import { InMemoryCommandRegistry } from '../commands/registry.js';
import { CONTROL_TOKENS } from '../control-tokens.js';
import type { ExecutionAdapter } from '../execution-adapter.js';
import type { PipelineMsgContext } from '../pipeline-context.js';
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

function mockAdapter(content: string): ExecutionAdapter & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn().mockResolvedValue({ content, usage: { inputTokens: 0, outputTokens: 0 } }),
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
    executionAdapter: mockAdapter('AI response'),
    commandRegistry: registry,
    logger: makeLogger(),
    getChannel: () => channel,
    ...overrides,
  };
}

describe('AutoReplyPipeline', () => {
  it('전체 단계를 실행해 응답을 채널로 전송한다', async () => {
    const channel = makeChannel();
    const adapter = mockAdapter('AI response');
    const pipeline = new AutoReplyPipeline(
      makeConfig(),
      makeDeps({ executionAdapter: adapter, getChannel: () => channel }),
    );

    await pipeline.process(makeCtx());

    expect(channel.sendTyping).toHaveBeenCalled();
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ payloads: [expect.objectContaining({ text: 'AI response' })] }),
    );
  });

  it('명령어 메시지 시 command 스테이지에서 끝나고 AI 를 호출하지 않는다', async () => {
    const adapter = mockAdapter('AI response');
    const pipeline = new AutoReplyPipeline(makeConfig(), makeDeps({ executionAdapter: adapter }));

    await pipeline.process(makeCtx({ body: '/help' }));

    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('NO_REPLY 토큰 시 deliver 하지 않는다', async () => {
    const channel = makeChannel();
    const adapter = mockAdapter(CONTROL_TOKENS.NO_REPLY);
    const deps = makeDeps({ executionAdapter: adapter, getChannel: () => channel });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx());

    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('SILENT_REPLY 토큰 시 deliver 스테이지에서 skip한다', async () => {
    const channel = makeChannel();
    const adapter = mockAdapter(`response${CONTROL_TOKENS.SILENT_REPLY}`);
    const deps = makeDeps({ executionAdapter: adapter, getChannel: () => channel });
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
    const adapter: ExecutionAdapter = {
      async execute() {
        await new Promise((r) => setTimeout(r, 30));
        return { content: 'late', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const logger = makeLogger();
    const deps = makeDeps({ executionAdapter: adapter, getChannel: () => channel, logger });
    const pipeline = new AutoReplyPipeline(makeConfig({ timeoutMs: 5 }), deps);

    await pipeline.process(makeCtx());

    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Pipeline aborted', { stage: 'deliver' });
  });

  it('ExecutionAdapter 에러 시 예외를 전파한다', async () => {
    const adapter = {
      execute: vi.fn().mockRejectedValue(new Error('AI error')),
    };
    const deps = makeDeps({ executionAdapter: adapter });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await expect(pipeline.process(makeCtx())).rejects.toThrow('AI error');
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
    const deps = makeDeps({
      executionAdapter: adapter,
      memoryRetrievalService: retrievalService,
    });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx());

    expect(retrievalService.searchRelevant).toHaveBeenCalledOnce();
    expect(retrievalService.searchRelevant).toHaveBeenCalledWith({
      userQuery: 'hello finclaw',
      sessionKey: 'test-session',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].retrievalResult).toBe(expected);
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
    const logger = makeLogger();
    const deps = makeDeps({
      executionAdapter: adapter,
      memoryRetrievalService: retrievalService,
      logger,
    });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx());

    // execute 까지 도달하되 retrievalResult 미주입
    expect(captured).toHaveLength(1);
    expect(captured[0].retrievalResult).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory retrieval failed'),
      expect.objectContaining({ event: 'memory.retrieval.stage_error' }),
    );
  });

  it('memoryRetrievalService 미주입 시 retrieval 단계 자체가 생략된다', async () => {
    const captured: PipelineMsgContext[] = [];
    const adapter: ExecutionAdapter = {
      async execute(ctx) {
        captured.push(ctx);
        return { content: 'ok', usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const deps = makeDeps({ executionAdapter: adapter });
    const pipeline = new AutoReplyPipeline(makeConfig(), deps);

    await pipeline.process(makeCtx());

    expect(captured).toHaveLength(1);
    expect(captured[0].retrievalResult).toBeUndefined();
  });
});
