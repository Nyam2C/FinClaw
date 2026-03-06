import type { ChannelId } from '@finclaw/types';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAdapter } from '../src/adapter.js';

// discord.js mock
vi.mock('discord.js', () => {
  // Proxy-based chain: any method call returns the same proxy
  function makeChain(): unknown {
    return new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) => {
            const fn = args.find((a: unknown) => typeof a === 'function');
            if (fn) {
              fn(makeChain());
            }
            return makeChain();
          },
      },
    );
  }

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

  const _restPut = vi.fn().mockResolvedValue(undefined);
  class MockREST {
    setToken() {
      return this;
    }
    put = _restPut;
  }

  return {
    Client: MockClient,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 },
    Partials: { Channel: 0, Message: 1 },
    ActivityType: { Playing: 0 },
    REST: MockREST,
    Routes: {
      applicationGuildCommands: vi.fn().mockReturnValue('/commands'),
      applicationCommands: vi.fn().mockReturnValue('/commands'),
    },
    MessageFlags: { Ephemeral: 64 },
    SlashCommandBuilder: class {
      name = 'mock';
      setName(n: string) {
        this.name = n;
        return this;
      }
      setDescription() {
        return this;
      }
      addStringOption(fn: (opt: unknown) => unknown) {
        fn(makeChain());
        return this;
      }
      addIntegerOption(fn: (opt: unknown) => unknown) {
        fn(makeChain());
        return this;
      }
      addNumberOption(fn: (opt: unknown) => unknown) {
        fn(makeChain());
        return this;
      }
      addSubcommand(fn: (opt: unknown) => unknown) {
        fn(makeChain());
        return this;
      }
      toJSON() {
        return { name: this.name };
      }
    },
    EmbedBuilder: class {
      data: Record<string, unknown> = {};
      setTitle(t: string) {
        this.data.title = t;
        return this;
      }
      setColor(c: number) {
        this.data.color = c;
        return this;
      }
      setFooter(f: Record<string, string>) {
        this.data.footer = f;
        return this;
      }
      setTimestamp() {
        return this;
      }
      setURL(u: string) {
        this.data.url = u;
        return this;
      }
      setDescription(d: string) {
        this.data.description = d;
        return this;
      }
      addFields(...fields: unknown[]) {
        this.data.fields = [...((this.data.fields as unknown[]) ?? []), ...fields];
        return this;
      }
    },
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
  retry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}));

function makeConfig() {
  return {
    botToken: 'test-token',
    applicationId: 'app-123',
    guildIds: ['guild-1'],
    allowDMs: true,
    typingIntervalMs: 5000,
    maxChunkLength: 2000,
    maxChunkLines: 17,
    approvalRequired: false,
    approvalTimeoutMs: 300_000,
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

  it('addReaction은 에러 없이 실행된다 (TODO stub)', async () => {
    await expect(adapter.addReaction('msg-1', '👍')).resolves.toBeUndefined();
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
    expect(adapter.addReaction).toBeDefined();
  });
});
