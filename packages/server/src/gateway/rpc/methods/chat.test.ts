import type { ConversationRecord, MemoryEntry, ModelRef, SearchResult } from '@finclaw/types';
import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/methods/chat.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
import { GatewayBroadcaster } from '../../broadcaster.js';
import { ChatRegistry } from '../../registry.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, clearMethods } from '../index.js';
import { registerChatMethods } from './chat.js';

const TEST_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-test',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

function makeStorage() {
  return {
    saveConversation: async () => undefined,
    upsertConversation: async () => undefined,
    getConversation: async () => null as ConversationRecord | null,
    deleteConversation: async () => false,
    searchConversations: async () => [] as SearchResult[],
    saveMemory: async () => undefined,
    searchMemory: async () => [] as MemoryEntry[],
    initialize: async () => undefined,
    close: async () => undefined,
  };
}

function makeServerCtx(): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: new ChatRegistry(60_000),
    broadcaster: new GatewayBroadcaster(),
    isDraining: false,
  };
}

describe('chat.* RPC methods', () => {
  let ctx: GatewayServerContext;

  beforeEach(() => {
    clearMethods();
    resetEventBus();
    ctx = makeServerCtx();
    registerChatMethods({
      registry: ctx.registry,
      connections: ctx.connections,
      broadcaster: ctx.broadcaster,
      storage: makeStorage(),
      defaultModel: TEST_MODEL,
    });
  });

  describe('schema validation', () => {
    it('chat.start rejects missing agentId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.start', params: {} },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { message: 'hi' } },
        { auth: { level: 'session', permissions: [] }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing message', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId: 's1' } },
        { auth: { level: 'session', permissions: [] }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.history validates limit range', async () => {
      const result = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'chat.history',
          params: { sessionId: 's1', limit: 0 },
        },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });
  });

  describe('auth requirements', () => {
    it('chat.start requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.start', params: { agentId: 'a' } },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });

    it('chat.send requires session level', async () => {
      const result = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'chat.send',
          params: { sessionId: 's1', message: 'hi' },
        },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });
});
