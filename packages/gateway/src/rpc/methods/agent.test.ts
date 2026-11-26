// packages/server/src/gateway/rpc/methods/agent.test.ts
import type { AgentEvent, AgentRunPort, AgentRunRequest } from '@finclaw/agent';
import { ConcurrencyLane, resetEventBus } from '@finclaw/infra';
import type { AttachMemoryPort, RpcMethod } from '@finclaw/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayServerContext } from '../../context.js';
import { RpcErrors } from '../errors.js';
import { dispatchRpc, MethodRegistry } from '../index.js';
import type { GatewayServerConfig } from '../types.js';
import { registerAgentMethods, resetAgentStats, type AgentRpcDeps } from './agent.js';

let methods: MethodRegistry; // Phase 35: 인스턴스 레지스트리 (테스트 격리)

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
    methods, // Phase 35
    broadcaster: {} as GatewayServerContext['broadcaster'],
    isDraining: false,
  };
}

const tokenCtx = {
  auth: { level: 'token' as const },
  remoteAddress: '127.0.0.1',
};

function call(method: string, params: unknown) {
  return dispatchRpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: method as RpcMethod,
      params: params as Record<string, unknown>,
    },
    tokenCtx,
    makeServerCtx(),
  );
}

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

function fakeRuntime(outcome: 'done' | 'error' = 'done', gate?: Promise<void>) {
  const calls: AgentRunRequest[] = [];
  const runtime: AgentRunPort = {
    async *run(req) {
      calls.push(req);
      if (gate && calls.length === 1) {
        await gate;
      }
      const runId = `run-${calls.length}`;
      const ev: AgentEvent =
        outcome === 'done'
          ? {
              type: 'done',
              runId,
              text: 'hello world',
              usage: USAGE,
              durationMs: 1,
              numTurns: 1,
            }
          : { type: 'error', runId, reason: 'unknown', message: 'runner exploded' };
      yield ev;
    },
    reset: async () => false,
  };
  return { runtime, calls };
}

function makeDeps(overrides: Partial<AgentRpcDeps> = {}): AgentRpcDeps {
  return {
    toolRegistry: { list: () => [] } as never,
    agents: [
      {
        id: 'finclaw-partner',
        name: 'FinClaw Personal Finance Partner',
        description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
      },
    ],
    runtime: fakeRuntime().runtime,
    agentRunLane: new ConcurrencyLane({ maxConcurrent: 1, maxQueueSize: 10, waitTimeoutMs: 5_000 }),
    profileHealth: {
      getHealth: vi.fn().mockReturnValue('healthy'),
      recordResult: vi.fn(),
    } as never,
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
      flush: vi.fn(),
    } as never,
    profileId: 'default',
    ...overrides,
  };
}

describe('agent.* RPC methods', () => {
  beforeEach(() => {
    methods = new MethodRegistry();
    resetEventBus();
    resetAgentStats();
  });

  describe('registration', () => {
    it('registers 3 methods', async () => {
      registerAgentMethods(makeDeps(), methods);
      const listResult = await call('agent.list', {});
      expect('result' in listResult).toBe(true);
    });
  });

  describe('agent.list', () => {
    it('returns finclaw-partner with tool count', async () => {
      const toolRegistry = {
        list: () => [{}, {}, {}],
      } as never;
      registerAgentMethods(makeDeps({ toolRegistry }), methods);
      const result = await call('agent.list', {});
      const r = (result as { result: { agents: Array<{ id: string; toolCount: number }> } }).result;
      expect(r.agents).toHaveLength(1);
      expect(r.agents[0]?.id).toBe('finclaw-partner');
      expect(r.agents[0]?.toolCount).toBe(3);
    });
  });

  describe('agent.status', () => {
    it('rejects unknown agentId', async () => {
      registerAgentMethods(makeDeps(), methods);
      const result = await call('agent.status', { agentId: 'nobody' });
      expect((result as { error: { message: string } }).error.message).toContain('unknown_agent');
    });

    it('returns idle status for known agent with zero calls', async () => {
      registerAgentMethods(makeDeps(), methods);
      const result = await call('agent.status', { agentId: 'finclaw-partner' });
      const r = (
        result as {
          result: { status: string; activeRuns: number; totalCalls: number; health: string };
        }
      ).result;
      expect(r.status).toBe('idle');
      expect(r.activeRuns).toBe(0);
      expect(r.totalCalls).toBe(0);
      expect(r.health).toBe('healthy');
    });
  });

  describe('agent.run', () => {
    it('rejects unknown agentId', async () => {
      registerAgentMethods(makeDeps(), methods);
      const result = await call('agent.run', { agentId: 'nobody', prompt: 'hi' });
      expect((result as { error: { message: string } }).error.message).toContain('unknown_agent');
    });

    it('rejects stream=true', async () => {
      registerAgentMethods(makeDeps(), methods);
      const result = await call('agent.run', {
        agentId: 'finclaw-partner',
        prompt: 'hi',
        stream: true,
      });
      expect((result as { error: { message: string } }).error.message).toContain(
        'stream_unsupported',
      );
    });

    it('fake done → output·runId·tokenUsage 반환 + oneShot 요청 + stats 갱신', async () => {
      const { runtime, calls } = fakeRuntime();
      registerAgentMethods(makeDeps({ runtime }), methods);
      const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      const r = (
        result as {
          result: { output: string; runId: string; tokenUsage: unknown; stopReason: string };
        }
      ).result;
      expect(r).toMatchObject({
        output: 'hello world',
        runId: 'run-1',
        tokenUsage: { input: 10, output: 5 },
        stopReason: 'completed',
      });
      expect(calls[0]).toMatchObject({ mode: 'oneShot', input: 'hi', agentId: 'finclaw-partner' });
      expect(String(calls[0]?.sessionKey)).toMatch(/^agent-run-/);
      const status = (await call('agent.status', { agentId: 'finclaw-partner' })) as {
        result: { totalCalls: number; lastError: string | null };
      };
      expect(status.result).toMatchObject({ totalCalls: 1, lastError: null });
    });

    it('fake error → lastError 기록 + RPC 에러', async () => {
      registerAgentMethods(makeDeps({ runtime: fakeRuntime('error').runtime }), methods);
      const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
      const status = (await call('agent.status', { agentId: 'finclaw-partner' })) as {
        result: { lastError: string | null; totalCalls: number };
      };
      expect(status.result.lastError).toContain('runner exploded');
      expect(status.result.totalCalls).toBe(0);
    });

    it('done 이면 attach({agentRunId: done.runId, sessionKey}) 호출, error 면 미호출', async () => {
      const attach = vi.fn().mockResolvedValue(undefined);
      registerAgentMethods(
        makeDeps({ attachMemoryService: { attach } as AttachMemoryPort }),
        methods,
      );
      await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      expect(attach).toHaveBeenCalledWith(
        expect.objectContaining({
          agentRunId: 'run-1',
          prompt: 'hi',
          output: 'hello world',
          agentId: 'finclaw-partner',
          sessionKey: expect.stringMatching(/^agent-run-/),
        }),
      );
      methods = new MethodRegistry();
      attach.mockClear();
      registerAgentMethods(
        makeDeps({
          runtime: fakeRuntime('error').runtime,
          attachMemoryService: { attach } as AttachMemoryPort,
        }),
        methods,
      );
      await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      expect(attach).not.toHaveBeenCalled();
    });

    it('attach 실패는 swallow — RPC 는 runId 와 함께 성공', async () => {
      const attach = vi.fn().mockRejectedValue(new Error('embed down'));
      const deps = makeDeps({ attachMemoryService: { attach } as AttachMemoryPort });
      registerAgentMethods(deps, methods);
      const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      expect((result as { result: { runId: string } }).result.runId).toBe('run-1');
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'agent.run.memory.attach_failed',
        expect.anything(),
      );
    });

    it('queues concurrent requests on agent-run lane (maxConcurrent=1)', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { runtime, calls } = fakeRuntime('done', gate);
      registerAgentMethods(makeDeps({ runtime }), methods);
      const p1 = call('agent.run', { agentId: 'finclaw-partner', prompt: 'first' });
      const p2 = call('agent.run', { agentId: 'finclaw-partner', prompt: 'second' });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toHaveLength(1);
      release();
      await Promise.all([p1, p2]);
      expect(calls).toHaveLength(2);
    });
  });
});
