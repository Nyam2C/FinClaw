import type { RpcMethod } from '@finclaw/types';
// packages/server/src/gateway/rpc/methods/agent.test.ts
import { ConcurrencyLane, resetEventBus } from '@finclaw/infra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
import { RpcErrors } from '../errors.js';
import { clearMethods, dispatchRpc } from '../index.js';
import { registerAgentMethods, resetAgentStats, type AgentRpcDeps } from './agent.js';

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
    isDraining: false,
  };
}

const tokenCtx = {
  auth: { level: 'token' as const, permissions: [] },
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

function makeRunnerResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'completed' as const,
    messages: [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello world' },
    ],
    usage: { inputTokens: 10, outputTokens: 5 },
    turns: 1,
    durationMs: 123,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<AgentRpcDeps> = {}): AgentRpcDeps {
  const runnerMock = {
    execute: vi.fn().mockResolvedValue(makeRunnerResult()),
  };
  return {
    toolRegistry: {
      list: () => [],
    } as never,
    runnerFactory: vi.fn(() => runnerMock as never),
    agentRunLane: new ConcurrencyLane({
      maxConcurrent: 1,
      maxQueueSize: 10,
      waitTimeoutMs: 5_000,
    }),
    profileHealth: {
      getHealth: vi.fn().mockReturnValue('healthy'),
      recordResult: vi.fn(),
    } as never,
    systemPrompt: 'test system prompt',
    defaultModel: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    },
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
    clearMethods();
    resetEventBus();
    resetAgentStats();
  });

  describe('registration', () => {
    it('registers 3 methods', async () => {
      registerAgentMethods(makeDeps());
      const listResult = await call('agent.list', {});
      expect('result' in listResult).toBe(true);
    });
  });

  describe('agent.list', () => {
    it('returns finclaw-partner with tool count', async () => {
      const toolRegistry = {
        list: () => [{}, {}, {}],
      } as never;
      registerAgentMethods(makeDeps({ toolRegistry }));
      const result = await call('agent.list', {});
      const r = (result as { result: { agents: Array<{ id: string; toolCount: number }> } }).result;
      expect(r.agents).toHaveLength(1);
      expect(r.agents[0]?.id).toBe('finclaw-partner');
      expect(r.agents[0]?.toolCount).toBe(3);
    });
  });

  describe('agent.status', () => {
    it('rejects unknown agentId', async () => {
      registerAgentMethods(makeDeps());
      const result = await call('agent.status', { agentId: 'nobody' });
      expect((result as { error: { message: string } }).error.message).toContain('unknown_agent');
    });

    it('returns idle status for known agent with zero calls', async () => {
      registerAgentMethods(makeDeps());
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
      registerAgentMethods(makeDeps());
      const result = await call('agent.run', { agentId: 'nobody', prompt: 'hi' });
      expect((result as { error: { message: string } }).error.message).toContain('unknown_agent');
    });

    it('rejects stream=true', async () => {
      registerAgentMethods(makeDeps());
      const result = await call('agent.run', {
        agentId: 'finclaw-partner',
        prompt: 'hi',
        stream: true,
      });
      expect((result as { error: { message: string } }).error.message).toContain(
        'stream_unsupported',
      );
    });

    it('executes runner and returns output', async () => {
      const runner = { execute: vi.fn().mockResolvedValue(makeRunnerResult()) };
      const runnerFactory = vi.fn(() => runner as never);
      registerAgentMethods(makeDeps({ runnerFactory }));
      const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      const r = (
        result as {
          result: {
            output: string;
            tokenUsage: { input: number; output: number };
            stopReason: string;
            turns: number;
          };
        }
      ).result;
      expect(runnerFactory).toHaveBeenCalledTimes(1);
      expect(runner.execute).toHaveBeenCalledTimes(1);
      expect(r.output).toBe('hello world');
      expect(r.tokenUsage).toEqual({ input: 10, output: 5 });
      expect(r.stopReason).toBe('completed');
      expect(r.turns).toBe(1);
    });

    it('updates stats after successful run', async () => {
      const deps = makeDeps();
      registerAgentMethods(deps);
      await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      const status = await call('agent.status', { agentId: 'finclaw-partner' });
      const r = (
        status as {
          result: { totalCalls: number; lastCallAt: number | null; lastError: string | null };
        }
      ).result;
      expect(r.totalCalls).toBe(1);
      expect(r.lastCallAt).not.toBeNull();
      expect(r.lastError).toBeNull();
      expect(deps.profileHealth.recordResult).toHaveBeenCalledWith('default', true);
    });

    it('records lastError on runner failure', async () => {
      const runner = { execute: vi.fn().mockRejectedValue(new Error('runner exploded')) };
      const runnerFactory = vi.fn(() => runner as never);
      const deps = makeDeps({ runnerFactory });
      registerAgentMethods(deps);
      const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
      const status = await call('agent.status', { agentId: 'finclaw-partner' });
      const r = (status as { result: { lastError: string | null; totalCalls: number } }).result;
      expect(r.lastError).toContain('runner exploded');
      expect(r.totalCalls).toBe(0);
      expect(deps.profileHealth.recordResult).toHaveBeenCalledWith('default', false);
    });

    it('queues concurrent requests on agent-run lane (maxConcurrent=1)', async () => {
      // 2 concurrent calls — second must wait for first to complete
      let resolveFirst!: (v: ReturnType<typeof makeRunnerResult>) => void;
      const firstPromise = new Promise<ReturnType<typeof makeRunnerResult>>((resolve) => {
        resolveFirst = resolve;
      });
      const runner = {
        execute: vi
          .fn()
          .mockImplementationOnce(() => firstPromise)
          .mockImplementationOnce(() => Promise.resolve(makeRunnerResult({ durationMs: 50 }))),
      };
      const runnerFactory = vi.fn(() => runner as never);
      const deps = makeDeps({ runnerFactory });
      registerAgentMethods(deps);

      const p1 = call('agent.run', { agentId: 'finclaw-partner', prompt: 'first' });
      const p2 = call('agent.run', { agentId: 'finclaw-partner', prompt: 'second' });

      // yield so p2 reaches the lane.acquire (which should queue)
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.execute).toHaveBeenCalledTimes(1);

      // now release first
      resolveFirst(makeRunnerResult());
      await p1;
      await p2;

      expect(runner.execute).toHaveBeenCalledTimes(2);
      expect(runnerFactory).toHaveBeenCalledTimes(2);
    });
  });
});
