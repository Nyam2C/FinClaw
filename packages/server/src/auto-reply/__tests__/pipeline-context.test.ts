import type { MsgContext, ChannelCapabilities } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import { enrichContext, type FinanceContextProvider } from '../pipeline-context.js';

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    body: 'test message',
    bodyForAgent: 'test message',
    rawBody: 'test message',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User One',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test-session'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const defaultCaps: ChannelCapabilities = {
  supportsMarkdown: true,
  supportsImages: true,
  supportsAudio: false,
  supportsVideo: false,
  supportsButtons: false,
  supportsThreads: true,
  supportsReactions: true,
  supportsEditing: true,
  maxMessageLength: 2000,
};

function makeProvider(overrides: Partial<FinanceContextProvider> = {}): FinanceContextProvider {
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
    ...overrides,
  };
}

describe('enrichContext', () => {
  it('MsgContext를 PipelineMsgContext로 확장한다', async () => {
    const ctx = makeCtx();
    const provider = makeProvider();
    const result = await enrichContext(
      ctx,
      { financeContextProvider: provider, channelCapabilities: defaultCaps },
      AbortSignal.timeout(5000),
    );

    expect(result.body).toBe(ctx.body);
    expect(result.senderId).toBe(ctx.senderId);
    expect(result.channelCapabilities).toBe(defaultCaps);
    expect(result.marketSession?.isOpen).toBe(true);
    expect(result.activeAlerts).toEqual([]);
    expect(result.portfolioSnapshot).toBeNull();
    expect(result.newsContext).toEqual([]);
  });

  it('금융 데이터 개별 실패 시 undefined로 degraded된다', async () => {
    const provider = makeProvider({
      getActiveAlerts: vi.fn().mockRejectedValue(new Error('alerts failed')),
      getPortfolio: vi.fn().mockRejectedValue(new Error('portfolio failed')),
    });

    const result = await enrichContext(
      makeCtx(),
      { financeContextProvider: provider, channelCapabilities: defaultCaps },
      AbortSignal.timeout(5000),
    );

    // 개별 실패 시 undefined
    expect(result.activeAlerts).toBeUndefined();
    expect(result.portfolioSnapshot).toBeUndefined();
    // 성공한 것은 정상 반환
    expect(result.newsContext).toEqual([]);
    expect(result.marketSession).toBeDefined();
  });

  it('모든 금융 프로바이더를 병렬 호출한다', async () => {
    const provider = makeProvider();
    await enrichContext(
      makeCtx(),
      { financeContextProvider: provider, channelCapabilities: defaultCaps },
      AbortSignal.timeout(5000),
    );

    expect(provider.getActiveAlerts).toHaveBeenCalledTimes(1);
    expect(provider.getPortfolio).toHaveBeenCalledTimes(1);
    expect(provider.getRecentNews).toHaveBeenCalledTimes(1);
    expect(provider.getWatchlist).toHaveBeenCalledTimes(1);
    expect(provider.getMarketSession).toHaveBeenCalledTimes(1);
  });
});
