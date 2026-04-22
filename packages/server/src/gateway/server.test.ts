import type { ConversationRecord, MemoryEntry, ModelRef, SearchResult } from '@finclaw/types';
import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/server.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { RunnerExecutionAdapter } from '../auto-reply/execution-adapter.js';
import type { GatewayServerConfig } from './rpc/types.js';
import { clearMethods } from './rpc/index.js';
import { createGatewayServer, type GatewayServer, type GatewayServerDeps } from './server.js';

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

function makeTestDeps(): GatewayServerDeps {
  return {
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
  };
}

/** 테스트용 설정 (포트 0 = OS 자동 할당) */
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

describe('createGatewayServer', { timeout: 15_000 }, () => {
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

  it('creates server with httpServer, wss, and ctx', () => {
    server = createGatewayServer(makeTestConfig(), makeTestDeps());
    expect(server.httpServer).toBeDefined();
    expect(server.wss).toBeDefined();
    expect(server.ctx).toBeDefined();
    expect(server.ctx.connections).toBeInstanceOf(Map);
  });

  it('starts and listens on assigned port', async () => {
    server = createGatewayServer(makeTestConfig(), makeTestDeps());
    await server.start();

    const addr = server.httpServer.address();
    expect(addr).not.toBeNull();
    if (typeof addr === 'object' && addr) {
      expect(addr.port).toBeGreaterThan(0);
    }
  });

  it('stops gracefully', async () => {
    server = createGatewayServer(makeTestConfig(), makeTestDeps());
    await server.start();
    await server.stop();

    expect(server.httpServer.listening).toBe(false);
    server = undefined; // 이미 stop됨
  });

  it('responds to GET /health after start', async () => {
    server = createGatewayServer(makeTestConfig(), makeTestDeps());
    await server.start();

    const addr = server.httpServer.address();
    if (typeof addr === 'object' && addr) {
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');
    }
  });

  it('responds to POST /rpc with system.ping', async () => {
    server = createGatewayServer(makeTestConfig(), makeTestDeps());
    await server.start();

    const addr = server.httpServer.address();
    if (typeof addr === 'object' && addr) {
      const res = await fetch(`http://127.0.0.1:${addr.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'system.ping',
          params: {},
        }),
      });
      const body = (await res.json()) as { result: { pong: boolean } };
      expect(body.result.pong).toBe(true);
    }
  });
});
