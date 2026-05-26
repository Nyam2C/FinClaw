import type { Runner } from '@finclaw/agent';
import {
  createTimestamp,
  createSessionKey,
  createChannelId,
  type ConversationMessage,
  type ModelRef,
} from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import {
  MockExecutionAdapter,
  RunnerExecutionAdapter,
  extractAssistantText,
  sliceHistoryRespectingToolPairs,
} from '../execution-adapter.js';
import type { PipelineMsgContext, FinanceContextProvider } from '../pipeline-context.js';
import { StubFinanceContextProvider } from '../pipeline-context.js';
import type { RetrievalResult } from '../stages/memory-retrieval.js';

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
  model: 'claude-sonnet-4-6',
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

// ─── Phase 26 C: retrievalResult → systemPrompt 합성 ───

function makeRetrievalResultWithSnippet(): RetrievalResult {
  return {
    snippets: [
      {
        id: 'm1',
        content: '나는 장기 가치투자를 한다',
        type: 'preference',
        createdAt: 1_700_000_000_000,
        rawScore: 0.81,
        adjustedScore: 0.78,
        daysOld: 1,
      },
    ],
    transactions: [],
    mode: 'fts-only',
    auditLog: {
      event: 'memory.injected',
      sessionKey: 'test',
      userQuery: 'q',
      memoryIds: ['m1'],
      rawScores: [0.81],
      adjustedScores: [0.78],
      mode: 'fts-only',
      transactionSymbols: [],
      timestamp: 1_700_000_000_000,
    },
  };
}

function makeEmptyRetrievalResult(): RetrievalResult {
  return {
    snippets: [],
    transactions: [],
    mode: 'fts-only',
    auditLog: {
      event: 'memory.injected',
      sessionKey: 'test',
      userQuery: 'q',
      memoryIds: [],
      rawScores: [],
      adjustedScores: [],
      mode: 'fts-only',
      transactionSymbols: [],
      timestamp: 1_700_000_000_000,
    },
  };
}

describe('RunnerExecutionAdapter + retrievalResult', () => {
  it('retrievalResult 가 있고 섹션이 비어있지 않으면 base system prompt + 섹션을 합성한다', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'BASE',
    });

    const ctx: PipelineMsgContext = {
      ...makePipelineCtx(),
      retrievalResult: makeRetrievalResultWithSnippet(),
    };
    await adapter.execute(ctx, AbortSignal.timeout(5000));

    const sp = calls[0]?.systemPrompt ?? '';
    expect(sp).toContain('BASE');
    expect(sp).toContain('## 사용자 배경지식 (자동 주입)');
    expect(sp).toContain('나는 장기 가치투자를 한다');
    // base 와 섹션 사이에 빈 줄
    expect(sp.startsWith('BASE\n\n')).toBe(true);
  });

  it('retrievalResult 가 없으면 base system prompt 그대로 사용한다', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'BASE',
    });

    await adapter.execute(makePipelineCtx(), AbortSignal.timeout(5000));

    expect(calls[0]?.systemPrompt).toBe('BASE');
  });

  it('retrievalResult 의 섹션이 빈 문자열이면 base 그대로 사용한다 (빈 헤더 노출 X)', async () => {
    const { runnerFactory, calls } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
    const adapter = new RunnerExecutionAdapter({
      runnerFactory,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'BASE',
    });

    const ctx: PipelineMsgContext = {
      ...makePipelineCtx(),
      retrievalResult: makeEmptyRetrievalResult(),
    };
    await adapter.execute(ctx, AbortSignal.timeout(5000));

    expect(calls[0]?.systemPrompt).toBe('BASE');
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

describe('sliceHistoryRespectingToolPairs', () => {
  it('limit 이하면 전부 반환', () => {
    const msgs: ConversationMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    expect(sliceHistoryRespectingToolPairs(msgs, 5)).toEqual(msgs);
  });

  it('slice 경계가 tool_result 직전에 떨어지면 고아 tool 메시지를 드롭한다', () => {
    // 실제 버그 재현: slice(-3)이 [tool(result), assistant, user]를 반환해 400 유발
    const msgs: ConversationMessage[] = [
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'get_stock_price', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '$187' }],
      },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'q2' },
    ];
    const result = sliceHistoryRespectingToolPairs(msgs, 3);
    // 고아 tool 드롭 후 assistant('done')부터 시작
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe('assistant');
    expect(result[0]?.content).toBe('done');
    expect(result[1]?.content).toBe('q2');
  });

  it('tool_result만으로 구성된 content를 가진 비-tool 역할 메시지도 고아 처리', () => {
    const msgs: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_orphan', content: 'x' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    const result = sliceHistoryRespectingToolPairs(msgs, 3);
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe('assistant');
  });

  it('선두가 assistant(tool_use)면 건드리지 않는다 (뒤따르는 tool_result가 짝)', () => {
    const msgs: ConversationMessage[] = [
      { role: 'user', content: 'pad' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'f', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'tu_2', content: 'r' }],
      },
      { role: 'assistant', content: 'final' },
    ];
    const result = sliceHistoryRespectingToolPairs(msgs, 3);
    expect(result).toHaveLength(3);
    expect(result[0]?.role).toBe('assistant');
    expect(Array.isArray(result[0]?.content)).toBe(true);
  });
});
