// packages/server/src/__tests__/gateway-integration/agent-runs.integration.test.ts
import type { AgentRunPort } from '@finclaw/agent';
import {
  dispatchRpc,
  MethodRegistry,
  registerAgentMethods,
  registerAgentRunsMethods,
  resetAgentStats,
  type AgentRpcDeps,
  type GatewayServerConfig,
  type GatewayServerContext,
} from '@finclaw/gateway';
import { ConcurrencyLane, resetEventBus } from '@finclaw/infra';
import { addAgentRun, openDatabase, type Database, type EmbeddingProvider } from '@finclaw/storage';
import type { AgentId, RpcMethod, Timestamp } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultAttachMemoryService } from '../../auto-reply/agent-memory-hook.js';

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

const AGENT_A = 'agent-a' as AgentId;
const AGENT_B = 'agent-b' as AgentId;

describe('agent.runs.* RPC methods', () => {
  let database: Database;

  beforeEach(() => {
    methods = new MethodRegistry();
    resetEventBus();
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  describe('agent.runs.list', () => {
    it('returns provider_unavailable when db is not injected', async () => {
      registerAgentRunsMethods({}, methods);
      const result = await call('agent.runs.list', {});
      expect((result as { error: { message: string } }).error.message).toContain(
        'provider_unavailable',
      );
    });

    it('returns runs in created_at DESC order', async () => {
      addAgentRun(database.db, { agentId: AGENT_A, prompt: 'first', output: 'output 1' });
      // 시간 차이 보장
      const t2 = Date.now() + 10;
      database.db
        .prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('manual-2', AGENT_A as string, 'second', 'output 2', t2);

      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.list', {});
      const r = (result as { result: { runs: Array<{ prompt: string }> } }).result;
      expect(r.runs).toHaveLength(2);
      expect(r.runs[0]?.prompt).toBe('second');
      expect(r.runs[1]?.prompt).toBe('first');
    });

    it('filters by agentId', async () => {
      addAgentRun(database.db, { agentId: AGENT_A, prompt: 'a-prompt', output: 'a-output' });
      addAgentRun(database.db, { agentId: AGENT_B, prompt: 'b-prompt', output: 'b-output' });

      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.list', { agentId: AGENT_A });
      const r = (result as { result: { runs: Array<{ agentId: string; prompt: string }> } }).result;
      expect(r.runs).toHaveLength(1);
      expect(r.runs[0]?.agentId).toBe(AGENT_A);
      expect(r.runs[0]?.prompt).toBe('a-prompt');
    });

    it('filters by from/to timestamps', async () => {
      const t = 1_700_000_000_000 as Timestamp;
      database.db
        .prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('r-old', AGENT_A as string, 'old', 'old-out', (t as number) - 1000);
      database.db
        .prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('r-mid', AGENT_A as string, 'mid', 'mid-out', t as number);
      database.db
        .prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run('r-new', AGENT_A as string, 'new', 'new-out', (t as number) + 1000);

      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.list', {
        from: t,
        to: (t as number) + 500,
      });
      const r = (result as { result: { runs: Array<{ prompt: string }> } }).result;
      expect(r.runs).toHaveLength(1);
      expect(r.runs[0]?.prompt).toBe('mid');
    });

    it('respects limit param', async () => {
      for (let i = 0; i < 5; i++) {
        addAgentRun(database.db, {
          agentId: AGENT_A,
          prompt: `p-${i}`,
          output: `out-${i}`,
        });
      }

      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.list', { limit: 2 });
      const r = (result as { result: { runs: unknown[] } }).result;
      expect(r.runs).toHaveLength(2);
    });

    it('truncates long prompt/output in list response', async () => {
      const longPrompt = 'P'.repeat(1000);
      const longOutput = 'O'.repeat(2000);
      addAgentRun(database.db, {
        agentId: AGENT_A,
        prompt: longPrompt,
        output: longOutput,
      });

      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.list', {});
      const r = (result as { result: { runs: Array<{ prompt: string; output: string }> } }).result;
      // 200자 / 500자 truncate
      expect(r.runs[0]?.prompt.length).toBe(200);
      expect(r.runs[0]?.output.length).toBe(500);
    });
  });

  describe('agent.runs.get', () => {
    it('returns provider_unavailable when db is not injected', async () => {
      registerAgentRunsMethods({}, methods);
      const result = await call('agent.runs.get', { runId: 'whatever' });
      expect((result as { error: { message: string } }).error.message).toContain(
        'provider_unavailable',
      );
    });

    it('returns null run for non-existent runId', async () => {
      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.get', { runId: 'does-not-exist' });
      const r = (result as { result: { run: unknown } }).result;
      expect(r.run).toBeNull();
    });

    it('returns full run with parsed toolCalls array', async () => {
      const toolCallsJson = JSON.stringify([
        { id: 't1', name: 'finance.quote', input: { symbol: 'AAPL' } },
        { id: 't2', name: 'finance.news', input: { symbol: 'AAPL' } },
      ]);
      const stored = addAgentRun(database.db, {
        agentId: AGENT_A,
        prompt: 'analyze AAPL',
        output: 'AAPL is up',
        toolCalls: toolCallsJson,
        tokensInput: 100,
        tokensOutput: 200,
        durationMs: 1234,
        modelUsed: 'claude-sonnet-4-6',
        role: 'analysis',
      });

      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.get', { runId: stored.id });
      const r = (
        result as {
          result: {
            run: {
              id: string;
              prompt: string;
              output: string;
              toolCalls: Array<{ name: string }>;
              tokensInput?: number;
              modelUsed?: string;
              role?: string;
            };
          };
        }
      ).result;
      expect(r.run.id).toBe(stored.id);
      expect(r.run.prompt).toBe('analyze AAPL');
      expect(r.run.output).toBe('AAPL is up');
      expect(r.run.toolCalls).toHaveLength(2);
      expect(r.run.toolCalls[0]?.name).toBe('finance.quote');
      expect(r.run.tokensInput).toBe(100);
      expect(r.run.modelUsed).toBe('claude-sonnet-4-6');
      expect(r.run.role).toBe('analysis');
    });

    it('returns empty toolCalls array when stored toolCalls is malformed JSON', async () => {
      // 직접 INSERT — addAgentRun 은 호출자 제공 문자열을 그대로 저장하므로 OK
      const id = 'malformed-1';
      database.db
        .prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, tool_calls_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, AGENT_A as string, 'p', 'o', 'not valid json {{', Date.now());

      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.get', { runId: id });
      const r = (result as { result: { run: { toolCalls: unknown[] } } }).result;
      expect(r.run.toolCalls).toEqual([]);
    });

    it('round-trips toolCalls JSON: addAgentRun(string) → agent.runs.get returns array', async () => {
      // tool_calls_json 직렬화/역직렬화 검증 — addAgentRun 은 호출자 제공 문자열 그대로 저장,
      // agent.runs.get 이 JSON.parse 해서 배열로 노출.
      const calls = [
        { id: 't1', name: 'finance.quote', input: { symbol: 'AAPL' } },
        { id: 't2', name: 'finance.news', input: { symbol: 'AAPL' } },
      ];
      const stored = addAgentRun(database.db, {
        agentId: AGENT_A,
        prompt: 'roundtrip',
        output: 'ok',
        toolCalls: JSON.stringify(calls),
      });

      registerAgentRunsMethods({ db: database.db }, methods);
      const result = await call('agent.runs.get', { runId: stored.id });
      const r = (
        result as {
          result: { run: { toolCalls: Array<{ id: string; name: string }> } };
        }
      ).result;
      expect(r.run.toolCalls).toHaveLength(2);
      expect(r.run.toolCalls[0]?.id).toBe('t1');
      expect(r.run.toolCalls[1]?.name).toBe('finance.news');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 경계면 통합 테스트 (qa_milestone_D)
// agent.run RPC ↔ DefaultAttachMemoryService ↔ storage(addAgentRun + memories)
//   ↔ agent.runs.get RPC 의 4계층 shape 일치를 한 흐름에서 검증.
// 외부 API 키 없이 in-memory DB + mock embedding provider 만 사용.
// ─────────────────────────────────────────────────────────────────────────────

const DIMS = 1024;

function makeMockEmbeddingProvider(): EmbeddingProvider {
  return {
    id: 'mock',
    model: 'mock-1024',
    dimensions: DIMS,
    async embedQuery() {
      return Array.from({ length: DIMS }, () => 0.01);
    },
    async embedBatch(texts) {
      return texts.map(() => Array.from({ length: DIMS }, () => 0.01));
    },
  };
}

/** runtime 계약(D1): 종료 이벤트 yield 전에 agent_runs 1행 → attach 가 link 할 수 있다. */
function runtimeWriting(db: Database['db'], output: string): AgentRunPort {
  return {
    async *run(req) {
      const runId = `run-${Math.random().toString(36).slice(2)}`;
      addAgentRun(db, { id: runId, agentId: req.agentId, prompt: req.input, output });
      yield {
        type: 'done',
        runId,
        cliSessionId: 'c',
        text: output,
        usage: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 },
        durationMs: 400,
        numTurns: 1,
      };
    },
    reset: async () => false,
  };
}

function makeAgentDeps(overrides: Partial<AgentRpcDeps>): AgentRpcDeps {
  return {
    toolRegistry: { list: () => [] } as never,
    agents: [
      {
        id: 'finclaw-partner',
        name: 'FinClaw Personal Finance Partner',
        description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
      },
    ],
    runtime: { run: vi.fn(), reset: vi.fn() } as never,
    agentRunLane: new ConcurrencyLane({
      maxConcurrent: 1,
      maxQueueSize: 10,
      waitTimeoutMs: 5_000,
    }),
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

describe('boundary: agent.run → agent_runs + memories → agent.runs.get (mock-only)', () => {
  let database: Database;

  beforeEach(() => {
    methods = new MethodRegistry();
    resetEventBus();
    resetAgentStats();
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('agent.run with long output persists to agent_runs and links memory, then agent.runs.get returns full record with memoryId', async () => {
    // output > 100자 → too-short skip 미발동
    const longOutput = `AAPL 분석 결과: ${'가'.repeat(150)}`;

    // 실제 DefaultAttachMemoryService 인스턴스 + mock embedding provider
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
      flush: vi.fn(),
    } as never;
    const attachService = new DefaultAttachMemoryService({
      db: database.db,
      embeddingProvider: makeMockEmbeddingProvider(),
      logger,
    });

    // 두 RPC 모듈 모두 같은 db 로 등록
    registerAgentMethods(
      makeAgentDeps({
        runtime: runtimeWriting(database.db, longOutput),
        attachMemoryService: attachService,
        logger,
      }),
      methods,
    );
    registerAgentRunsMethods({ db: database.db }, methods);

    // 1) agent.run 호출
    const runResult = await call('agent.run', {
      agentId: 'finclaw-partner',
      prompt: 'analyze AAPL',
      role: 'analysis',
    });
    const runOk = (runResult as { result: { runId?: string; output: string } }).result;
    expect(runOk.runId).toBeTruthy();
    expect(runOk.output).toBe(longOutput);

    const runId = runOk.runId as string;

    // 2) agent_runs 행 + memories 행 양쪽 기록 — 직접 DB 조회로 확인
    const memCount = (
      database.db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }
    ).c;
    expect(memCount).toBe(1);

    const memRow = database.db.prepare('SELECT id, type, content FROM memories LIMIT 1').get() as {
      id: string;
      type: string;
      content: string;
    };
    expect(memRow.type).toBe('financial');
    expect(memRow.content).toBe(longOutput);

    // 3) agent.runs.get 응답이 memoryId 를 노출
    const getResult = await call('agent.runs.get', { runId });
    const got = (
      getResult as {
        result: {
          run: {
            id: string;
            agentId: string;
            prompt: string;
            output: string;
            memoryId?: string;
            toolCalls: unknown[];
            error?: string | null;
            role?: string;
          };
        };
      }
    ).result;
    expect(got.run.id).toBe(runId);
    expect(got.run.prompt).toBe('analyze AAPL');
    expect(got.run.output).toBe(longOutput);
    expect(got.run.memoryId).toBe(memRow.id);
    expect(Array.isArray(got.run.toolCalls)).toBe(true);
    // 정상 경로 → error 없음
    expect(got.run.error == null).toBe(true);
  });
});
