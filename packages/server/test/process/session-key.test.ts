import type { AgentId } from '@finclaw/types';
import { createChannelId } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import { deriveRoutingSessionKey } from '../../src/process/session-key.js';

describe('deriveRoutingSessionKey', () => {
  it('DM 세션 키 형식: agent:{agentId}:{channelId}:direct', () => {
    const key = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct',
    });
    expect(key as string).toBe('agent:main:discord:direct');
  });

  it('그룹 세션 키에 chatId 포함', () => {
    const key = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'group',
      chatId: 'channel456',
    });
    expect(key as string).toBe('agent:main:discord:group:channel456');
  });

  it('스레드 세션 키에 threadId 포함', () => {
    const key = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'group',
      chatId: 'channel456',
      threadId: 'thread789',
    });
    expect(key as string).toBe('agent:main:discord:group:channel456:thread789');
  });

  it('커스텀 agentId 사용', () => {
    const key = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct',
      agentId: 'finance' as AgentId,
    });
    expect(key as string).toBe('agent:finance:discord:direct');
  });

  it('동일 입력 → 동일 출력 (결정성)', () => {
    const params = {
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct' as const,
    };
    const key1 = deriveRoutingSessionKey(params);
    const key2 = deriveRoutingSessionKey(params);
    expect(key1).toBe(key2);
  });

  it('channelId 대소문자 무시 (normalizeChannelId)', () => {
    const key1 = deriveRoutingSessionKey({
      channelId: createChannelId('Discord'),
      accountId: 'user1',
      chatType: 'direct',
    });
    const key2 = deriveRoutingSessionKey({
      channelId: createChannelId('discord'),
      accountId: 'user1',
      chatType: 'direct',
    });
    expect(key1).toBe(key2);
  });
});
