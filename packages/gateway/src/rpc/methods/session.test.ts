import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/methods/session.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { GatewayBroadcaster } from '../../broadcaster.js';
import type { GatewayServerContext } from '../../context.js';
import { ChatRegistry } from '../../registry.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, MethodRegistry } from '../index.js';
import type { GatewayServerConfig } from '../types.js';
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
    registry: new ChatRegistry(60_000),
    methods: new MethodRegistry(), // Phase 35
    broadcaster: new GatewayBroadcaster(),
    isDraining: false,
  };
}

const tokenCtx = {
  auth: { level: 'token' as const },
  remoteAddress: '127.0.0.1',
};

describe('session.* RPC methods', () => {
  let ctx: GatewayServerContext;

  beforeEach(() => {
    resetEventBus();
    ctx = makeServerCtx();
    registerSessionMethods({ registry: ctx.registry }, ctx.methods);
  });

  describe('schema validation', () => {
    it('session.get rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.get', params: {} },
        tokenCtx,
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });
  });

  describe('auth requirements', () => {
    it('session.get requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.get', params: { sessionId: 's1' } },
        { auth: { level: 'none' }, remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });
});
