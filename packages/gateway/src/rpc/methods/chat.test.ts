import type { ChatExecutionPort } from '@finclaw/agent';
import { resetEventBus } from '@finclaw/infra';
import type { ConversationRecord, MemoryEntry, ModelRef, SearchResult } from '@finclaw/types';
// packages/server/src/gateway/rpc/methods/chat.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { GatewayBroadcaster } from '../../broadcaster.js';
import type { GatewayServerContext } from '../../context.js';
import { ChatRegistry } from '../../registry.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, MethodRegistry } from '../index.js';
import type { GatewayServerConfig } from '../types.js';
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

function makeStubAdapter(): ChatExecutionPort {
  return {
    execute: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0 } }),
    executeForTui: async () => ({
      messageId: 'test-msg-id',
      content: '',
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  } as unknown as ChatExecutionPort;
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
    methods: new MethodRegistry(), // Phase 35
    broadcaster: new GatewayBroadcaster(),
    isDraining: false,
  };
}

describe('chat.* RPC methods', () => {
  let ctx: GatewayServerContext;

  beforeEach(() => {
    resetEventBus();
    ctx = makeServerCtx();
    registerChatMethods(
      {
        registry: ctx.registry,
        connections: ctx.connections,
        broadcaster: ctx.broadcaster,
        storage: makeStorage(),
        defaultModel: TEST_MODEL,
        adapter: makeStubAdapter(),
      },
      ctx.methods,
    );
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
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' }, // ← 'session' → 'token'
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing message', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId: 's1' } },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' }, // ← 'session' → 'token'
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

    it('chat.send accepts token level (rejects below token)', async () => {
      // token 미만(api_key)은 거부
      const denied = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'chat.send',
          params: { sessionId: 's1', message: 'hi' },
        },
        { auth: { level: 'api_key', permissions: [] }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((denied as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);

      // token 은 auth 게이트 통과 → UNAUTHORIZED 가 아님.
      // 세션 미존재로 INTERNAL_ERROR('session not found') 이 나지만, 그건 auth 통과 후의 핸들러 에러.
      const passed = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'chat.send',
          params: { sessionId: 's1', message: 'hi' },
        },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((passed as { error?: { code: number } }).error?.code).not.toBe(RpcErrors.UNAUTHORIZED);
    });
  });
});
