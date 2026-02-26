import type { AgentId } from '@finclaw/types';
import { createSessionKey, createChannelId } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import {
  deriveRoutingSessionKey,
  deriveGlobalSessionKey,
  classifySessionKey,
  parseRoutingSessionKey,
} from '../../src/process/session-key.js';

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

describe('deriveGlobalSessionKey', () => {
  it('글로벌 키 형식: agent:{agentId}:global', () => {
    const key = deriveGlobalSessionKey('main');
    expect(key as string).toBe('agent:main:global');
  });
});

describe('classifySessionKey', () => {
  it('agent-scoped 키 분류', () => {
    expect(classifySessionKey(createSessionKey('agent:main:discord:direct'))).toBe('agent');
  });

  it('agent: 접두사이나 parts < 4이면 malformed', () => {
    expect(classifySessionKey(createSessionKey('agent:main'))).toBe('malformed');
  });

  it('config 스타일 키는 legacy', () => {
    expect(classifySessionKey(createSessionKey('channel:discord_123'))).toBe('legacy');
  });

  it('콜론 없는 키는 malformed', () => {
    expect(classifySessionKey(createSessionKey('nocolon'))).toBe('malformed');
  });
});

describe('parseRoutingSessionKey', () => {
  it('agent-scoped 키 파싱', () => {
    const parsed = parseRoutingSessionKey(createSessionKey('agent:main:discord:group:ch1:t1'));
    expect(parsed).toEqual({
      agentId: 'main',
      channelId: 'discord',
      chatType: 'group',
      chatId: 'ch1',
      threadId: 't1',
    });
  });

  it('non-agent 키는 undefined 반환', () => {
    expect(parseRoutingSessionKey(createSessionKey('channel:foo'))).toBeUndefined();
  });
});
