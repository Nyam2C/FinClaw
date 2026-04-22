import type { Runner } from '@finclaw/agent';
import {
  createTimestamp,
  createSessionKey,
  createChannelId,
  type ConversationMessage,
  type ModelRef,
} from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import type { PipelineMsgContext, FinanceContextProvider } from '../pipeline-context.js';
import {
  MockExecutionAdapter,
  RunnerExecutionAdapter,
  extractAssistantText,
} from '../execution-adapter.js';
import { StubFinanceContextProvider } from '../pipeline-context.js';

function makePipelineCtx(): PipelineMsgContext {
  return {
    body: 'test',
    bodyForAgent: 'test',
    rawBody: 'test',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    normalizedBody: 'test',
    mentions: [],
    urls: [],
    channelCapabilities: {
      supportsMarkdown: true,
      supportsImages: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsButtons: false,
      supportsThreads: false,
      supportsReactions: false,
      supportsEditing: false,
      maxMessageLength: 2000,
    },
    userRoles: [],
    isAdmin: false,
  };
}

describe('MockExecutionAdapter', () => {
  it('기본 응답을 반환한다', async () => {
    const adapter = new MockExecutionAdapter();
    const result = await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    expect(result.content).toBe('Mock response');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('커스텀 응답을 반환한다', async () => {
    const adapter = new MockExecutionAdapter('Custom answer');
    const result = await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    expect(result.content).toBe('Custom answer');
  });
});

const DEFAULT_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

function makeFakeRunnerFactory(
  finalMessages: ConversationMessage[],
  usage = { inputTokens: 10, outputTokens: 20 },
): {
  runnerFactory: (dispatcher: unknown) => Runner;
  calls: Array<Parameters<Runner['execute']>[0]>;
} {
  const calls: Array<Parameters<Runner['execute']>[0]> = [];
  const runner = {
    async execute(params: Parameters<Runner['execute']>[0]) {
      calls.push(params);
      return {
        status: 'completed' as const,
        messages: finalMessages,
        usage,
        turns: 1,
        durationMs: 5,
      };
    },
  } as unknown as Runner;
  return { runnerFactory: () => runner, calls };
}

describe('RunnerExecutionAdapter', () => {
  it('ctx.normalizedBody를 user 메시지로 Runner에 전달한다', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([
      { role: 'assistant', content: 'hi there' },
    ]);
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'you are finclaw',
    });

    const result = await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    expect(calls).toHaveLength(1);
    const params = calls[0];
    if (!params) {
      throw new Error('expected runner call');
    }
    expect(params.systemPrompt).toBe('you are finclaw');
    expect(params.model).toBe(DEFAULT_MODEL);
    expect(params.sessionKey).toBe('test');
    expect(params.messages).toEqual([{ role: 'user', content: 'test' }]);
    expect(params.abortSignal).toBeDefined();
    expect(result.content).toBe('hi there');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('마지막 assistant 메시지의 텍스트 블록만 추출한다', async () => {
    const { runnerFactory } = makeFakeRunnerFactory([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'tool_use', id: 't1', name: 'noop', input: {} },
          { type: 'text', text: 'world' },
        ],
      },
    ]);
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
    });

    const result = await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));
    expect(result.content).toBe('hello world');
  });

  it('assistant 메시지가 없으면 빈 문자열을 반환한다', async () => {
    const { runnerFactory } = makeFakeRunnerFactory([{ role: 'user', content: 'x' }]);
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
    });

    const result = await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));
    expect(result.content).toBe('');
  });

  it('커스텀 agentId를 사용한다', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
    const customAgentId = 'custom-agent' as Parameters<Runner['execute']>[0]['agentId'];
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
      defaultAgentId: customAgentId,
    });

    await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));
    expect(calls[0]?.agentId).toBe(customAgentId);
  });
});

describe('extractAssistantText', () => {
  it('string content를 그대로 반환', () => {
    expect(extractAssistantText([{ role: 'assistant', content: 'plain' }])).toBe('plain');
  });

  it('여러 assistant 중 마지막을 선택', () => {
    const text = extractAssistantText([
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'second' },
    ]);
    expect(text).toBe('second');
  });

  it('빈 배열은 빈 문자열', () => {
    expect(extractAssistantText([])).toBe('');
  });
});

describe('StubFinanceContextProvider', () => {
  const provider: FinanceContextProvider = new StubFinanceContextProvider();

  it('모든 조회 메서드는 빈 값 반환', async () => {
    expect(await provider.getActiveAlerts('u', AbortSignal.timeout(100))).toEqual([]);
    expect(await provider.getPortfolio('u', AbortSignal.timeout(100))).toBeNull();
    expect(await provider.getRecentNews(AbortSignal.timeout(100))).toEqual([]);
    expect(await provider.getWatchlist('u')).toEqual([]);
  });

  it('getMarketSession은 닫힌 세션을 반환', () => {
    const session = provider.getMarketSession();
    expect(session.isOpen).toBe(false);
    expect(session.market).toBe('NONE');
    expect(session.nextOpenAt).toBeNull();
    expect(session.timezone).toBe('Asia/Seoul');
  });
});

describe('RunnerExecutionAdapter + storage', () => {
  function makeInMemoryStorage(): {
    storage: import('@finclaw/types').StorageAdapter;
    records: Map<string, import('@finclaw/types').ConversationRecord>;
  } {
    const records = new Map<string, import('@finclaw/types').ConversationRecord>();
    const storage: import('@finclaw/types').StorageAdapter = {
      async initialize() {},
      async close() {},
      async saveConversation(record) {
        records.set(record.sessionKey as string, record);
      },
      async upsertConversation(record) {
        records.set(record.sessionKey as string, record);
      },
      async getConversation(key) {
        return records.get(key as string) ?? null;
      },
      async deleteConversation(key) {
        return records.delete(key as string);
      },
      async searchConversations() {
        return [];
      },
      async saveMemory() {},
      async searchMemory() {
        return [];
      },
    };
    return { storage, records };
  }

  it('storage가 있으면 이전 이력을 Runner에 prepend한다', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
    const { storage } = makeInMemoryStorage();
    await storage.upsertConversation({
      sessionKey: createSessionKey('test'),
      agentId: 'default' as Parameters<Runner['execute']>[0]['agentId'],
      messages: [
        { role: 'user', content: '이전 질문' },
        { role: 'assistant', content: '이전 답변' },
      ],
      createdAt: createTimestamp(1000),
      updatedAt: createTimestamp(1000),
    });

    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
      storage,
    });

    await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    expect(calls[0]?.messages).toEqual([
      { role: 'user', content: '이전 질문' },
      { role: 'assistant', content: '이전 답변' },
      { role: 'user', content: 'test' },
    ]);
  });

  it('실행 후 전체 이력을 upsertConversation으로 저장한다', async () => {
    const { runnerFactory } = makeFakeRunnerFactory([
      { role: 'user', content: 'test' },
      { role: 'assistant', content: 'reply' },
    ]);
    const { storage, records } = makeInMemoryStorage();

    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
      storage,
    });

    await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    const saved = records.get('test');
    expect(saved).toBeDefined();
    expect(saved?.messages).toHaveLength(2);
    expect(saved?.messages[1].content).toBe('reply');
  });

  it('historyLimit을 초과한 prior 메시지는 잘라낸다', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
    const { storage } = makeInMemoryStorage();
    const priorMessages: ConversationMessage[] = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));
    await storage.upsertConversation({
      sessionKey: createSessionKey('test'),
      agentId: 'default' as Parameters<Runner['execute']>[0]['agentId'],
      messages: priorMessages,
      createdAt: createTimestamp(1000),
      updatedAt: createTimestamp(1000),
    });

    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sp',
      storage,
      historyLimit: 5,
    });

    await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    // 최근 5개 + 새 user 메시지
    expect(calls[0]?.messages).toHaveLength(6);
    expect(calls[0]?.messages[0].content).toBe('m20');
  });
});
