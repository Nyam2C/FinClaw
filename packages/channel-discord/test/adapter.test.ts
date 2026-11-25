import type { ChannelId } from '@finclaw/types';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAdapter } from '../src/adapter.js';

// discord.js mock
vi.mock('discord.js', () => {
  const _login = vi.fn().mockResolvedValue('token');
  const _destroy = vi.fn().mockResolvedValue(undefined);
  const _removeAllListeners = vi.fn();
  const _on = vi.fn();
  const _off = vi.fn();
  const _once = vi.fn();
  const _channelsFetch = vi.fn().mockResolvedValue({
    send: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  });

  class MockClient {
    login = _login;
    destroy = _destroy;
    removeAllListeners = _removeAllListeners;
    on = _on;
    off = _off;
    once = _once;
    channels = { fetch: _channelsFetch };
    user = { id: 'bot-1', tag: 'FinClaw#1234', setActivity: vi.fn() };
    guilds = { cache: { size: 2 } };
  }

  return {
    Client: MockClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 },
    Partials: { Channel: 0, Message: 1 },
    ActivityType: { Playing: 0 },
    MessageFlags: { Ephemeral: 64 },
  };
});

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

function makeConfig() {
  return {
    botToken: 'test-token',
  };
}

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter();
  });

  it('id가 "discord"이다', () => {
    expect(adapter.id).toBe('discord');
  });

  it('meta.name이 "discord"이다', () => {
    expect(adapter.meta.name).toBe('discord');
    expect(adapter.meta.displayName).toBe('Discord');
  });

  it('capabilities에 올바른 값을 설정한다', () => {
    expect(adapter.capabilities.supportsMarkdown).toBe(true);
    expect(adapter.capabilities.supportsButtons).toBe(true);
    expect(adapter.capabilities.supportsAudio).toBe(false);
    expect(adapter.capabilities.maxMessageLength).toBe(2000);
  });

  it('setup()이 CleanupFn을 반환한다', async () => {
    const cleanup = await adapter.setup(makeConfig());
    expect(typeof cleanup).toBe('function');
  });

  it('setup() 후 client.login이 호출된다', async () => {
    await adapter.setup(makeConfig());
    const { Client } = await import('discord.js');
    const mockClient = new Client({} as unknown as import('discord.js').ClientOptions);
    expect(mockClient.login).toHaveBeenCalledWith('test-token');
  });

  it('CleanupFn 호출 시 client.destroy가 호출된다', async () => {
    const cleanup = await adapter.setup(makeConfig());
    await cleanup();
    const { Client } = await import('discord.js');
    const mockClient = new Client({} as unknown as import('discord.js').ClientOptions);
    expect(mockClient.destroy).toHaveBeenCalled();
  });

  it('setup() 전에 onMessage를 호출하면 에러를 던진다', () => {
    expect(() => adapter.onMessage(async () => {})).toThrow('Client not initialized');
  });

  it('setup() 전에 send를 호출하면 에러를 던진다', async () => {
    await expect(
      adapter.send({
        channelId: 'discord' as unknown as ChannelId,
        targetId: 'ch-1',
        payloads: [],
      }),
    ).rejects.toThrow('Client not initialized');
  });

  it('sendTyping은 setup() 전에는 조용히 반환한다', async () => {
    await expect(adapter.sendTyping('discord', 'ch-1')).resolves.toBeUndefined();
  });

  it('ChannelPlugin 인터페이스를 준수한다 (타입 검증)', () => {
    // 이 테스트는 컴파일 타임에 검증됨 — 런타임에서는 인터페이스 존재만 확인
    expect(adapter.id).toBeDefined();
    expect(adapter.meta).toBeDefined();
    expect(adapter.capabilities).toBeDefined();
    expect(adapter.setup).toBeDefined();
    expect(adapter.onMessage).toBeDefined();
    expect(adapter.send).toBeDefined();
    expect(adapter.sendTyping).toBeDefined();
  });
});
