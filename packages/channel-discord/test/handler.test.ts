import type { InboundMessage } from '@finclaw/types';
import type { Client } from 'discord.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupMessageHandler } from '../src/handler.js';

// @finclaw/infra mock
vi.mock('@finclaw/infra', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  }),
}));

function makeClient(overrides: Record<string, unknown> = {}) {
  const listeners: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  return {
    user: { id: 'bot-123' },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    },
    off(event: string, handler: (...args: unknown[]) => unknown) {
      listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of listeners[event] ?? []) {
        void h(...args);
      }
    },
    _listeners: listeners,
    ...overrides,
  };
}

function makeDiscordMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    author: { bot: false, id: 'user-1', displayName: 'TestUser', username: 'testuser' },
    system: false,
    channel: {
      isDMBased: () => false,
      isThread: () => false,
    },
    mentions: {
      has: (id: string) => id === 'bot-123',
    },
    cleanContent: 'Hello FinClaw',
    content: '<@bot-123> Hello FinClaw',
    createdTimestamp: 1708700000000,
    channelId: 'ch-1',
    guildId: 'guild-1',
    ...overrides,
  };
}

describe('setupMessageHandler', () => {
  let client: ReturnType<typeof makeClient>;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = makeClient();
    handler = vi.fn().mockResolvedValue(undefined);
  });

  it('messageCreate 이벤트를 등록한다', () => {
    setupMessageHandler(client as unknown as Client, handler);
    expect(client._listeners['messageCreate']).toHaveLength(1);
  });

  it('CleanupFn 호출 시 리스너를 제거한다', async () => {
    const cleanup = setupMessageHandler(client as unknown as Client, handler);
    expect(client._listeners['messageCreate']).toHaveLength(1);
    await cleanup();
    expect(client._listeners['messageCreate']).toHaveLength(0);
  });

  it('일반 메시지를 InboundMessage로 변환한다', async () => {
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage();
    client.emit('messageCreate', msg);

    // await microtask
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledTimes(1);
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.id).toBe('msg-1');
    expect(inbound.senderId).toBe('user-1');
    expect(inbound.body).toBe('Hello FinClaw');
    expect(inbound.chatType).toBe('channel');
    expect(inbound.channelId).toBe('discord');
  });

  it('봇 메시지를 무시한다', async () => {
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage({
      author: { bot: true, id: 'bot-other', displayName: 'Bot', username: 'bot' },
    });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('시스템 메시지를 무시한다', async () => {
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage({ system: true });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('길드 메시지에서 봇 멘션이 없으면 무시한다', async () => {
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage({
      mentions: { has: () => false },
    });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('DM 메시지는 멘션 없이도 처리한다', async () => {
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage({
      channel: { isDMBased: () => true, isThread: () => false },
      mentions: { has: () => false },
    });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.chatType).toBe('direct');
  });

  it('스레드 메시지의 chatType은 group이다', async () => {
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage({
      channel: { isDMBased: () => false, isThread: () => true },
      channelId: 'thread-1',
    });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.chatType).toBe('group');
    expect(inbound.threadId).toBe('thread-1');
  });

  it('빈 cleanContent는 무시한다', async () => {
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage({ cleanContent: '   ' });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('핸들러 에러 시 로그만 남기고 throw하지 않는다', async () => {
    handler.mockRejectedValue(new Error('handler boom'));
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage();
    // 에러가 전파되지 않아야 한다
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('client.user가 null이면 무시한다', async () => {
    const noUserClient = makeClient({ user: null });
    setupMessageHandler(noUserClient as unknown as Client, handler);

    const msg = makeDiscordMessage();
    noUserClient.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('metadata에 discordChannelId와 discordGuildId를 포함한다', async () => {
    setupMessageHandler(client as unknown as Client, handler);

    const msg = makeDiscordMessage({ channelId: 'ch-42', guildId: 'guild-99' });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.metadata?.discordChannelId).toBe('ch-42');
    expect(inbound.metadata?.discordGuildId).toBe('guild-99');
  });
});
