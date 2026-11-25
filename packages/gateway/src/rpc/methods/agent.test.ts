// packages/server/src/gateway/rpc/methods/agent.test.ts
import { ConcurrencyLane, resetEventBus } from '@finclaw/infra';
import { getAgentRun, openDatabase, type Database } from '@finclaw/storage';
import type { AttachMemoryPort, RpcMethod } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    agents: [
      {
        id: 'finclaw-partner',
        name: 'FinClaw Personal Finance Partner',
        description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
      },
    ],
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

    it('executes runner and returns output', async () => {
      const runner = { execute: vi.fn().mockResolvedValue(makeRunnerResult()) };
      const runnerFactory = vi.fn(() => runner as never);
      registerAgentMethods(makeDeps({ runnerFactory }), methods);
      const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      const r = (
        result as {
          result: {
            output: string;
            tokenUsage: { input: number; output: number };
            stopReason: string;
          };
        }
      ).result;
      expect(runnerFactory).toHaveBeenCalledTimes(1);
      expect(runner.execute).toHaveBeenCalledTimes(1);
      expect(r.output).toBe('hello world');
      expect(r.tokenUsage).toEqual({ input: 10, output: 5 });
      expect(r.stopReason).toBe('completed');
    });

    it('updates stats after successful run', async () => {
      const deps = makeDeps();
      registerAgentMethods(deps, methods);
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
      expect(deps.profileHealth.recordResult).toHaveBeenCalledWith('default', {
        success: true,
        modelId: 'claude-sonnet-4-6',
      });
    });

    it('records lastError on runner failure', async () => {
      const runner = { execute: vi.fn().mockRejectedValue(new Error('runner exploded')) };
      const runnerFactory = vi.fn(() => runner as never);
      const deps = makeDeps({ runnerFactory });
      registerAgentMethods(deps, methods);
      const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
      const status = await call('agent.status', { agentId: 'finclaw-partner' });
      const r = (status as { result: { lastError: string | null; totalCalls: number } }).result;
      expect(r.lastError).toContain('runner exploded');
      expect(r.totalCalls).toBe(0);
      expect(deps.profileHealth.recordResult).toHaveBeenCalledWith('default', false);
    });

    describe('persistence (Phase 26 D)', () => {
      let database: Database;

      beforeEach(() => {
        database = openDatabase({ path: ':memory:' });
      });

      afterEach(() => {
        database.close();
      });

      it('persists agent_runs row with prompt/output on success', async () => {
        const longOutput = 'A'.repeat(150); // > 100자 → attach 도 호출됨
        const runner = {
          execute: vi.fn().mockResolvedValue(
            makeRunnerResult({
              messages: [
                { role: 'user' as const, content: 'analyze AAPL' },
                { role: 'assistant' as const, content: longOutput },
              ],
            }),
          ),
        };
        const runnerFactory = vi.fn(() => runner as never);
        const deps = makeDeps({ runnerFactory, db: database.db });
        registerAgentMethods(deps, methods);

        const result = await call('agent.run', {
          agentId: 'finclaw-partner',
          prompt: 'analyze AAPL',
        });
        const r = (result as { result: { runId?: string; output: string } }).result;
        expect(r.runId).toBeTruthy();
        expect(r.output).toBe(longOutput);

        const stored = getAgentRun(database.db, r.runId as string);
        expect(stored).not.toBeNull();
        expect(stored?.prompt).toBe('analyze AAPL');
        expect(stored?.output).toBe(longOutput);
        expect(stored?.error).toBeUndefined();
        expect(stored?.tokensInput).toBe(10);
        expect(stored?.tokensOutput).toBe(5);
        // 도구 호출은 CLI 내부에서 일어나므로 tool_calls 는 기록하지 않음
        expect(stored?.toolCalls).toBeUndefined();
      });

      it('calls attachMemoryService.attach with run.id + sessionKey on success', async () => {
        const longOutput = 'B'.repeat(150);
        const runner = {
          execute: vi.fn().mockResolvedValue(
            makeRunnerResult({
              messages: [
                { role: 'user' as const, content: 'hi' },
                { role: 'assistant' as const, content: longOutput },
              ],
            }),
          ),
        };
        const attach = vi.fn().mockResolvedValue({ memoryId: 'mem-123' });
        const attachMemoryService: AttachMemoryPort = { attach };
        const runnerFactory = vi.fn(() => runner as never);
        const deps = makeDeps({
          runnerFactory,
          db: database.db,
          attachMemoryService,
        });
        registerAgentMethods(deps, methods);

        const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
        const r = (result as { result: { runId?: string } }).result;
        expect(r.runId).toBeTruthy();

        expect(attach).toHaveBeenCalledTimes(1);
        const arg = attach.mock.calls[0]?.[0] as {
          agentRunId: string;
          agentId: string;
          prompt: string;
          output: string;
          sessionKey: string;
          createdAt: number;
        };
        expect(arg.agentRunId).toBe(r.runId);
        expect(arg.agentId).toBe('finclaw-partner');
        expect(arg.prompt).toBe('hi');
        expect(arg.output).toBe(longOutput);
        expect(arg.sessionKey).toContain('agent-run-');
        expect(typeof arg.createdAt).toBe('number');
      });

      it('persists agent_runs row with error on runner failure (no attach call)', async () => {
        const runner = { execute: vi.fn().mockRejectedValue(new Error('boom')) };
        const attach = vi.fn().mockResolvedValue({ memoryId: 'mem-x' });
        const attachMemoryService: AttachMemoryPort = { attach };
        const runnerFactory = vi.fn(() => runner as never);
        const deps = makeDeps({
          runnerFactory,
          db: database.db,
          attachMemoryService,
        });
        registerAgentMethods(deps, methods);

        const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
        expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);

        // attach 는 호출되지 않아야 함 (output 없음)
        expect(attach).not.toHaveBeenCalled();

        // agent_runs 에는 error 채운 row 가 있어야 함
        const all = database.db
          .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC')
          .all() as Array<{ error: string | null; output: string }>;
        expect(all).toHaveLength(1);
        expect(all[0]?.error).toContain('boom');
        expect(all[0]?.output).toBe('');
      });

      it('swallows attach failure — RPC still succeeds with runId', async () => {
        const longOutput = 'C'.repeat(150);
        const runner = {
          execute: vi.fn().mockResolvedValue(
            makeRunnerResult({
              messages: [
                { role: 'user' as const, content: 'hi' },
                { role: 'assistant' as const, content: longOutput },
              ],
            }),
          ),
        };
        const attach = vi.fn().mockRejectedValue(new Error('attach exploded'));
        const attachMemoryService: AttachMemoryPort = { attach };
        const runnerFactory = vi.fn(() => runner as never);
        const deps = makeDeps({
          runnerFactory,
          db: database.db,
          attachMemoryService,
        });
        registerAgentMethods(deps, methods);

        const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
        const r = (result as { result: { runId?: string; output: string } }).result;
        // attach 실패에도 RPC 응답은 정상
        expect(r.runId).toBeTruthy();
        expect(r.output).toBe(longOutput);

        // agent_runs 행은 저장되었음
        const stored = getAgentRun(database.db, r.runId as string);
        expect(stored).not.toBeNull();
        expect(stored?.error).toBeUndefined();

        // attach.attach_failed 경고 로그가 한 번 emit 됨
        expect(deps.logger.warn).toHaveBeenCalledWith(
          'agent.run.memory.attach_failed',
          expect.objectContaining({ error: 'attach exploded' }),
        );
      });

      it('skips persistence when db is undefined (still returns runId=undefined)', async () => {
        const longOutput = 'D'.repeat(150);
        const runner = {
          execute: vi.fn().mockResolvedValue(
            makeRunnerResult({
              messages: [
                { role: 'user' as const, content: 'hi' },
                { role: 'assistant' as const, content: longOutput },
              ],
            }),
          ),
        };
        const attach = vi.fn();
        const attachMemoryService: AttachMemoryPort = { attach };
        const runnerFactory = vi.fn(() => runner as never);
        // db 미주입 — attach 도 호출 안 됨
        const deps = makeDeps({ runnerFactory, attachMemoryService });
        registerAgentMethods(deps, methods);

        const result = await call('agent.run', { agentId: 'finclaw-partner', prompt: 'hi' });
        const r = (result as { result: { runId?: string; output: string } }).result;
        expect(r.output).toBe(longOutput);
        expect(r.runId).toBeUndefined();
        expect(attach).not.toHaveBeenCalled();
      });
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
      registerAgentMethods(deps, methods);

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
