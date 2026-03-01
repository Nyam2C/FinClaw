import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/index.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod/v4';
import type { GatewayServerContext } from '../context.js';
import type { RpcMethodHandler, AuthInfo, GatewayServerConfig } from './types.js';
import { RpcErrors } from './errors.js';
import {
  registerMethod,
  dispatchRpc,
  clearMethods,
  hasRequiredAuth,
  getRegisteredMethods,
} from './index.js';

/** 테스트용 최소 GatewayServerContext */
function makeServerCtx(overrides?: Partial<GatewayServerConfig>): GatewayServerContext {
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
    ...overrides,
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

function makeAuth(level: AuthInfo['level'] = 'none'): AuthInfo {
  return { level, permissions: [] };
}

describe('RPC Dispatcher', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
  });

  describe('registerMethod', () => {
    it('registers a method successfully', () => {
      const handler: RpcMethodHandler = {
        method: 'test.echo',
        description: 'echo',
        authLevel: 'none',
        schema: z.object({ msg: z.string() }),
        async execute(params) {
          return params;
        },
      };
      registerMethod(handler);
      expect(getRegisteredMethods()).toContain('test.echo');
    });

    it('throws on duplicate method registration', () => {
      const handler: RpcMethodHandler = {
        method: 'test.dup',
        description: 'dup',
        authLevel: 'none',
        schema: z.object({}),
        async execute() {
          return {};
        },
      };
      registerMethod(handler);
      expect(() => registerMethod(handler)).toThrow('already registered');
    });
  });

  describe('dispatchRpc — single request', () => {
    it('dispatches to registered handler and returns result', async () => {
      registerMethod({
        method: 'test.add',
        description: 'add',
        authLevel: 'none',
        schema: z.object({ a: z.number(), b: z.number() }),
        async execute(params: { a: number; b: number }) {
          return { sum: params.a + params.b };
        },
      });

      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'test.add', params: { a: 2, b: 3 } },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );

      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { sum: 5 },
      });
    });

    it('returns INVALID_REQUEST for wrong jsonrpc version', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '1.0' as '2.0', id: 1, method: 'x' },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_REQUEST);
    });

    it('returns METHOD_NOT_FOUND for unknown method', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'no.such' },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.METHOD_NOT_FOUND);
    });

    it('returns UNAUTHORIZED when auth level insufficient', async () => {
      registerMethod({
        method: 'test.secret',
        description: 'secret',
        authLevel: 'token',
        schema: z.object({}),
        async execute() {
          return {};
        },
      });

      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'test.secret' },
        { auth: makeAuth('none'), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });

    it('returns INVALID_PARAMS for schema validation failure', async () => {
      registerMethod({
        method: 'test.typed',
        description: 'typed',
        authLevel: 'none',
        schema: z.object({ name: z.string() }),
        async execute(params) {
          return params;
        },
      });

      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'test.typed', params: { name: 123 } },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('returns INTERNAL_ERROR when handler throws', async () => {
      registerMethod({
        method: 'test.fail',
        description: 'fail',
        authLevel: 'none',
        schema: z.object({}),
        async execute() {
          throw new Error('boom');
        },
      });

      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'test.fail' },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number; message: string } }).error.code).toBe(
        RpcErrors.INTERNAL_ERROR,
      );
      expect((result as { error: { message: string } }).error.message).toBe('boom');
    });
  });

  describe('dispatchRpc — batch', () => {
    it('processes batch requests in parallel', async () => {
      registerMethod({
        method: 'test.id',
        description: 'identity',
        authLevel: 'none',
        schema: z.object({ v: z.number() }),
        async execute(params: { v: number }) {
          return { v: params.v };
        },
      });

      const result = await dispatchRpc(
        [
          { jsonrpc: '2.0', id: 1, method: 'test.id', params: { v: 1 } },
          { jsonrpc: '2.0', id: 2, method: 'test.id', params: { v: 2 } },
        ],
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('rejects empty batch', async () => {
      const result = await dispatchRpc(
        [],
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_REQUEST);
    });

    it('rejects batch exceeding maxBatchSize', async () => {
      const ctx = makeServerCtx({ rpc: { maxBatchSize: 2, timeoutMs: 60_000 } });
      const batch = Array.from({ length: 3 }, (_, i) => ({
        jsonrpc: '2.0' as const,
        id: i,
        method: 'test.x',
      }));

      const result = await dispatchRpc(
        batch,
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_REQUEST);
    });
  });

  describe('hasRequiredAuth', () => {
    it('none >= none', () => {
      expect(hasRequiredAuth(makeAuth('none'), 'none')).toBe(true);
    });

    it('token >= api_key', () => {
      expect(hasRequiredAuth(makeAuth('token'), 'api_key')).toBe(true);
    });

    it('api_key < token', () => {
      expect(hasRequiredAuth(makeAuth('api_key'), 'token')).toBe(false);
    });

    it('session >= session', () => {
      expect(hasRequiredAuth(makeAuth('session'), 'session')).toBe(true);
    });
  });
});
