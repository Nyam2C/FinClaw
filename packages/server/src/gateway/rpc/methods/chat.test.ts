import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/methods/chat.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, clearMethods } from '../index.js';
import { registerChatMethods } from './chat.js';

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
    registry: { activeCount: () => 0 } as GatewayServerContext['registry'],
    broadcaster: {} as GatewayServerContext['broadcaster'],
  };
}

describe('chat.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
    registerChatMethods();
  });

  describe('schema validation', () => {
    it('chat.start rejects missing agentId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.start', params: {} },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { message: 'hi' } },
        { auth: { level: 'session', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing message', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId: 's1' } },
        { auth: { level: 'session', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
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
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });
  });

  describe('auth requirements', () => {
    it('chat.start requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.start', params: { agentId: 'a' } },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
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
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });
});
