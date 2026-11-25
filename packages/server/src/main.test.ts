import type { AgentRunPort } from '@finclaw/agent';
import {
  createGatewayServer,
  type GatewayServer,
  type GatewayServerConfig,
} from '@finclaw/gateway';
import { resetEventBus } from '@finclaw/infra';
import type { ModelRef } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupDiscord } from './main.js';

// vi.mock 은 import 보다 먼저 호이스팅된다 → 팩토리가 쓰는 값은 vi.hoisted 로.
const { setup } = vi.hoisted(() => ({ setup: vi.fn().mockResolvedValue(async () => {}) }));
vi.mock('@finclaw/channel-discord', () => ({
  DiscordAccountSchema: { parse: (v: unknown) => v },
  // new 로 호출되므로 화살표 함수가 아니라 function (vitest 4)
  DiscordAdapter: vi.fn(function () {
    return { setup, id: 'discord', getClient: () => null };
  }),
}));

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as never;

describe('setupDiscord (I8)', () => {
  it('토큰이 없으면 discord.disabled warn 후 undefined — 로그인·cleanup 등록 없음', async () => {
    const register = vi.fn();
    const adapter = await setupDiscord(undefined, { logger, lifecycle: { register } });
    expect(adapter).toBeUndefined();
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
      'discord.disabled',
      expect.objectContaining({ event: 'discord.disabled' }),
    );
    expect(setup).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('토큰이 있으면 기존처럼 로그인하고 cleanup 을 lifecycle 에 등록', async () => {
    const register = vi.fn();
    const adapter = await setupDiscord('bot-token', { logger, lifecycle: { register } });
    expect(adapter).toBeDefined();
    expect(setup).toHaveBeenCalledWith({ botToken: 'bot-token' });
    expect(register).toHaveBeenCalledOnce();
  });
});

// Phase 29 E8: 부트 시퀀스 e2e — gateway ctx 에 운영성 인스턴스가 자동 주입된다.
const TEST_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-test',
};

const stubRuntime: AgentRunPort = {
  async *run() {
    yield* [];
  },
  reset: async () => false,
};

function makeTestConfig(): GatewayServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    cors: { origins: ['*'], maxAge: 600 },
    auth: { apiKeys: ['test-key'], jwtSecret: 'test-secret', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
}

describe('main boot wiring (Phase 29 E)', () => {
  let server: GatewayServer | undefined;

  beforeEach(() => {
    resetEventBus();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('gateway ctx 에 rateLimiter / accessLogger / authRateLimiter 가 주입된다', () => {
    server = createGatewayServer(makeTestConfig(), {
      defaultModel: TEST_MODEL,
      runtime: stubRuntime,
    });
    expect(server.ctx.rateLimiter).toBeDefined();
    expect(server.ctx.accessLogger).toBeDefined();
    expect(server.ctx.authRateLimiter).toBeDefined();
  });
});
