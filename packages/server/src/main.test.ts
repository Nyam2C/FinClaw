import { resetEventBus } from '@finclaw/infra';
import type { ConversationRecord, MemoryEntry, ModelRef, SearchResult } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerExecutionAdapter } from './auto-reply/execution-adapter.js';
import { clearMethods } from './gateway/rpc/index.js';
import type { GatewayServerConfig } from './gateway/rpc/types.js';
import { createGatewayServer, type GatewayServer } from './gateway/server.js';
import { MissingEnvError, requireEnv } from './main.js';

describe('requireEnv', () => {
  it('env에 값이 있으면 반환한다', () => {
    const env = { FOO: 'bar' };
    expect(requireEnv('FOO', env)).toBe('bar');
  });

  it('값이 없으면 MissingEnvError throw', () => {
    const env = {};
    expect(() => requireEnv('ANTHROPIC_API_KEY', env)).toThrow(MissingEnvError);
    try {
      requireEnv('ANTHROPIC_API_KEY', env);
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      expect((err as MissingEnvError).envName).toBe('ANTHROPIC_API_KEY');
    }
  });

  it('값이 빈 문자열이어도 throw', () => {
    const env = { DISCORD_BOT_TOKEN: '' };
    expect(() => requireEnv('DISCORD_BOT_TOKEN', env)).toThrow(MissingEnvError);
  });
});

// Phase 29 E8: 부트 시퀀스 e2e — gateway ctx 에 운영성 인스턴스가 자동 주입된다.
const TEST_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-test',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

function makeStubAdapter(): RunnerExecutionAdapter {
  return {
    execute: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0 } }),
    executeForTui: async () => ({
      messageId: 'stub',
      content: '',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  } as unknown as RunnerExecutionAdapter;
}

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
    clearMethods();
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
      adapter: makeStubAdapter(),
      storage: {
        saveConversation: async () => undefined,
        upsertConversation: async () => undefined,
        getConversation: async () => null as ConversationRecord | null,
        deleteConversation: async () => false,
        searchConversations: async () => [] as SearchResult[],
        saveMemory: async () => undefined,
        searchMemory: async () => [] as MemoryEntry[],
        initialize: async () => undefined,
        close: async () => undefined,
      },
    });
    expect(server.ctx.rateLimiter).toBeDefined();
    expect(server.ctx.accessLogger).toBeDefined();
    expect(server.ctx.authRateLimiter).toBeDefined();
  });
});
