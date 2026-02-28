import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import type { PipelineMsgContext } from '../pipeline-context.js';
import { MockExecutionAdapter } from '../execution-adapter.js';

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
