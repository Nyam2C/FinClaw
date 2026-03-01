import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/methods/session.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, clearMethods } from '../index.js';
import { registerSessionMethods } from './session.js';

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

const tokenCtx = {
  auth: { level: 'token' as const, permissions: [] },
  remoteAddress: '127.0.0.1',
};

describe('session.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
    registerSessionMethods();
  });

  describe('schema validation', () => {
    it('session.get rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.get', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('session.reset rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.reset', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('session.list accepts empty params', async () => {
      // session.list는 params 없이 호출 가능하나 stub이므로 INTERNAL_ERROR
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.list', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
    });
  });

  describe('auth requirements', () => {
    it('session.get requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.get', params: { sessionId: 's1' } },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });
});
