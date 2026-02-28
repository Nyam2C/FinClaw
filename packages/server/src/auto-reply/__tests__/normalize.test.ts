import type { MsgContext } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import { normalizeMessage } from '../stages/normalize.js';

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    body: 'hello world',
    bodyForAgent: 'hello world',
    rawBody: 'hello world',
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

describe('normalizeMessage', () => {
  it('공백을 정규화한다', () => {
    const ctx = makeCtx({ body: '  hello   world  ' });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') {
      return;
    }
    expect(result.data.normalizedBody).toBe('hello world');
  });

  it('멘션을 추출한다', () => {
    const ctx = makeCtx({ body: '<@123456> hello <@!789>' });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') {
      return;
    }
    expect(result.data.mentions).toEqual(['123456', '789']);
  });

  it('URL을 추출한다', () => {
    const ctx = makeCtx({
      body: 'Check https://example.com and http://test.org/path',
    });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') {
      return;
    }
    expect(result.data.urls).toEqual(['https://example.com', 'http://test.org/path']);
  });

  it('멘션도 URL도 없는 메시지를 처리한다', () => {
    const ctx = makeCtx({ body: '일반 메시지' });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') {
      return;
    }
    expect(result.data.mentions).toEqual([]);
    expect(result.data.urls).toEqual([]);
    expect(result.data.normalizedBody).toBe('일반 메시지');
  });

  it('원본 ctx를 보존한다', () => {
    const ctx = makeCtx({ body: 'test' });
    const result = normalizeMessage(ctx);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') {
      return;
    }
    expect(result.data.ctx).toBe(ctx);
  });
});
