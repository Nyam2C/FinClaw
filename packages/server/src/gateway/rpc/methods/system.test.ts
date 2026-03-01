import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/methods/system.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
import { dispatchRpc, clearMethods } from '../index.js';
import { registerSystemMethods } from './system.js';

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

const baseCtx = {
  auth: { level: 'none' as const, permissions: [] as const },
  remoteAddress: '127.0.0.1',
};

describe('system.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
    registerSystemMethods();
  });

  describe('system.health', () => {
    it('returns ok status with uptime and memory', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'system.health', params: {} },
        baseCtx,
        makeServerCtx(),
      );
      const r = result as { result: { status: string; uptime: number; memoryMB: number } };
      expect(r.result.status).toBe('ok');
      expect(r.result.uptime).toBeGreaterThan(0);
      expect(r.result.memoryMB).toBeGreaterThan(0);
    });
  });

  describe('system.info', () => {
    it('returns server name and registered methods', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 2, method: 'system.info', params: {} },
        baseCtx,
        makeServerCtx(),
      );
      const r = result as { result: { name: string; methods: string[]; capabilities: string[] } };
      expect(r.result.name).toBe('finclaw-gateway');
      expect(r.result.methods).toContain('system.health');
      expect(r.result.methods).toContain('system.info');
      expect(r.result.methods).toContain('system.ping');
      expect(r.result.capabilities).toContain('streaming');
    });
  });

  describe('system.ping', () => {
    it('returns pong with timestamp', async () => {
      const before = Date.now();
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 3, method: 'system.ping', params: {} },
        baseCtx,
        makeServerCtx(),
      );
      const after = Date.now();
      const r = result as { result: { pong: boolean; timestamp: number } };
      expect(r.result.pong).toBe(true);
      expect(r.result.timestamp).toBeGreaterThanOrEqual(before);
      expect(r.result.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
