import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/methods/finance.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, clearMethods } from '../index.js';
import { registerFinanceMethods } from './finance.js';

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

describe('finance.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
    registerFinanceMethods();
  });

  describe('schema validation', () => {
    it('finance.quote rejects missing symbol', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.quote', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('finance.alert.create validates required fields', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.alert.create', params: { symbol: 'AAPL' } },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });
  });

  describe('auth requirements', () => {
    it('finance.quote requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.quote', params: { symbol: 'AAPL' } },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });

  describe('stub behavior', () => {
    it('finance.quote throws Not implemented', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.quote', params: { symbol: 'AAPL' } },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
      expect((result as { error: { message: string } }).error.message).toContain('Not implemented');
    });

    it('finance.news throws Not implemented', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.news', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
    });

    it('finance.portfolio.get throws Not implemented', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.portfolio.get', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
    });
  });
});
