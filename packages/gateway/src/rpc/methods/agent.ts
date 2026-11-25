// packages/server/src/gateway/rpc/methods/agent.ts
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProfileHealthMonitor, RunnerFactory, ToolRegistry } from '@finclaw/agent';
import { extractAssistantText } from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import { addAgentRun, type AddAgentRunInput } from '@finclaw/storage';
import type { AttachMemoryPort, ModelRef, SessionKey, TracerPort } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { MethodRegistry } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

/** agent.* RPC 메서드 의존성 (main.ts 에서 주입) */
export interface AgentRpcDeps {
  readonly toolRegistry: ToolRegistry;
  /** main.ts 가 finclaw.system.ko.md frontmatter (id/name/description) 로부터 로드해 주입. */
  readonly agents: readonly AgentInfo[];
  readonly runnerFactory: RunnerFactory;
  /** agent.run 전용 큐잉 lane (main.ts 에서 maxConcurrent:1 로 주입) */
  readonly agentRunLane: ConcurrencyLane;
  readonly profileHealth: ProfileHealthMonitor;
  readonly systemPrompt: string;
  readonly defaultModel: ModelRef;
  readonly logger: FinClawLogger;
  readonly profileId?: string;
  /**
   * Phase 26 D: agent.run 종료 후 output 을 memory 로 저장하는 훅.
   * 미주입 시 저장 단계 자체 생략. 호출 위치는 rpc-engineer 가 결정.
   */
  readonly attachMemoryService?: AttachMemoryPort;
  /**
   * Phase 26 D: agent_runs 영속화용 sqlite 핸들.
   * 미주입 시 agent_runs 저장 + attachMemoryService 호출 모두 skip (best-effort).
   */
  readonly db?: DatabaseSync;
  /**
   * Phase 30 hotfix P0-1: agent.run RPC 진입을 span 으로 감싸 active trace context
   * 를 강제. 미주입 시 traceId 부착 skip (기존 동작).
   */
  readonly tracer?: TracerPort;
}

export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/**
 * agent.run 결과를 agent_runs 에 영속화하고, 조건 충족 시 attachMemoryService 호출.
 *
 * Best-effort: db 미주입 / 저장 실패 / attach 실패 모두 swallow + warn 로그. RPC 응답엔 영향 X.
 * attach 호출 조건: error 없고, output 비어있지 않고, sessionKey 주어졌고, attachMemoryService 주입됐을 때.
 */
async function persistAgentRunAndAttach(
  deps: Pick<AgentRpcDeps, 'db' | 'logger' | 'attachMemoryService'>,
  input: AddAgentRunInput & { sessionKey?: SessionKey },
): Promise<{ runId?: string }> {
  if (!deps.db) {
    return {};
  }
  let runId: string | undefined;
  try {
    const run = addAgentRun(deps.db, input);
    runId = run.id;
    if (deps.attachMemoryService && !input.error && input.output && input.sessionKey) {
      try {
        await deps.attachMemoryService.attach({
          agentRunId: run.id,
          agentId: input.agentId as string,
          prompt: input.prompt,
          output: input.output,
          sessionKey: input.sessionKey,
          createdAt: run.createdAt as number,
        });
      } catch (attachErr) {
        deps.logger.warn('agent.run.memory.attach_failed', {
          event: 'agent.run.memory.attach_failed',
          agentRunId: run.id,
          error: (attachErr as Error).message,
        });
      }
    }
  } catch (storeErr) {
    deps.logger.warn('agent.run.store_failed', {
      event: 'agent.run.store_failed',
      agentId: input.agentId as string,
      error: (storeErr as Error).message,
    });
  }
  return { runId };
}

// 프로세스 내 상태 — agent.status 응답에 사용
const activeRuns = new Map<string, number>();
const totalCalls = new Map<string, number>();
const lastCallAt = new Map<string, number>();
const lastError = new Map<string, string>();

/** 테스트용: 통계 초기화 */
export function resetAgentStats(): void {
  activeRuns.clear();
  totalCalls.clear();
  lastCallAt.clear();
  lastError.clear();
}

/**
 * agent.* RPC 메서드 일괄 등록.
 */
export function registerAgentMethods(deps: AgentRpcDeps, registry: MethodRegistry): void {
  const profileId = deps.profileId ?? 'default';

  // ── agent.list ──
  const listHandler: RpcMethodHandler<Record<string, never>, unknown> = {
    method: 'agent.list',
    description: '등록된 에이전트 목록을 조회합니다',
    authLevel: 'token',
    schema: z.object({}),
    async execute() {
      const toolCount = deps.toolRegistry.list().length;
      return {
        agents: deps.agents.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          toolCount,
        })),
      };
    },
  };

  // ── agent.status ──
  const statusHandler: RpcMethodHandler<{ agentId: string }, unknown> = {
    method: 'agent.status',
    description: '에이전트 상태를 조회합니다',
    authLevel: 'token',
    schema: z.object({ agentId: z.string() }),
    async execute(params) {
      const info = deps.agents.find((a) => a.id === params.agentId);
      if (!info) {
        throw new Error(`unknown_agent: ${params.agentId}`);
      }
      const active = activeRuns.get(params.agentId) ?? 0;
      return {
        agentId: params.agentId,
        name: info.name,
        status: active > 0 ? 'busy' : 'idle',
        activeRuns: active,
        totalCalls: totalCalls.get(params.agentId) ?? 0,
        lastCallAt: lastCallAt.get(params.agentId) ?? null,
        lastError: lastError.get(params.agentId) ?? null,
        health: deps.profileHealth.getHealth(profileId),
      };
    },
  };

  // ── agent.run ──
  const runHandler: RpcMethodHandler<
    {
      agentId: string;
      prompt: string;
      timeoutMs?: number;
      stream?: boolean;
    },
    unknown
  > = {
    method: 'agent.run',
    description: '에이전트를 1회 실행합니다. 동일 agentId 는 순차 처리(큐잉)됩니다.',
    authLevel: 'token',
    schema: z.object({
      agentId: z.string(),
      prompt: z.string().min(1).max(10_000),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      stream: z.boolean().optional(),
    }),
    async execute(params) {
      if (!deps.agents.find((a) => a.id === params.agentId)) {
        throw new Error(`unknown_agent: ${params.agentId}`);
      }
      if (params.stream) {
        throw new Error('stream_unsupported: use chat.* for streaming responses');
      }

      const startedAt = Date.now();
      deps.logger.info('agent.run.started', {
        agentId: params.agentId,
        promptLength: params.prompt.length,
      });

      // Phase 30 hotfix P0-1: tracer 주입 시 agent.run RPC 진입을 span 으로 감싸 active
      // trace context 를 강제 → 하위 runner.execute / persistAgentRunAndAttach 가 traceId 사용.
      // tracer 미주입 시 fn 을 그대로 실행 (의미적 동등).
      const runWithSpan = <T>(
        fn: (traceCtx?: { traceId: string; parentSpanId?: string }) => Promise<T>,
      ): Promise<T> => {
        if (!deps.tracer) {
          return fn(undefined);
        }
        return deps.tracer.withSpan('rpc.agent.run', { agentId: params.agentId }, async (ctx) =>
          fn({ traceId: ctx.traceId, parentSpanId: ctx.spanId }),
        );
      };

      return runWithSpan(async (traceCtx) => {
        const handle = await deps.agentRunLane.acquire(params.agentId);
        activeRuns.set(params.agentId, (activeRuns.get(params.agentId) ?? 0) + 1);

        const sessionKey = createSessionKey(`agent-run-${randomUUID()}`);

        try {
          const agentIdBrand = createAgentId(params.agentId);

          const abortController = new AbortController();
          const timeoutMs = params.timeoutMs ?? 60_000;
          const timer = setTimeout(() => abortController.abort(), timeoutMs);

          try {
            const result = await deps.runnerFactory().execute({
              agentId: agentIdBrand,
              sessionKey,
              model: deps.defaultModel,
              systemPrompt: deps.systemPrompt,
              messages: [{ role: 'user', content: params.prompt }],
              abortSignal: abortController.signal,
            });

            const output = extractAssistantText(result.messages);
            const durationMs = Date.now() - startedAt;

            totalCalls.set(params.agentId, (totalCalls.get(params.agentId) ?? 0) + 1);
            lastCallAt.set(params.agentId, Date.now());
            lastError.delete(params.agentId);
            deps.profileHealth.recordResult(profileId, {
              success: true,
              modelId: deps.defaultModel.model,
            });

            deps.logger.info('agent.run.completed', {
              agentId: params.agentId,
              durationMs,
              tokensInput: result.usage.inputTokens,
              tokensOutput: result.usage.outputTokens,
              status: result.status,
            });

            // Phase 26 D: agent_runs 영속화 + memory attach (best-effort).
            // Phase 30 hotfix P0-1: traceId / parentSpanId 부착.
            const { runId } = await persistAgentRunAndAttach(deps, {
              agentId: agentIdBrand,
              prompt: params.prompt,
              output,
              tokensInput: result.usage.inputTokens,
              tokensOutput: result.usage.outputTokens,
              durationMs,
              modelUsed: deps.defaultModel.model,
              sessionKey,
              traceId: traceCtx?.traceId,
              parentSpanId: traceCtx?.parentSpanId,
            });

            return {
              agentId: params.agentId,
              output,
              tokenUsage: {
                input: result.usage.inputTokens,
                output: result.usage.outputTokens,
              },
              durationMs,
              stopReason: result.status,
              runId,
            };
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          const msg = (err as Error).message;
          lastError.set(params.agentId, msg);
          deps.profileHealth.recordResult(profileId, false);
          deps.logger.warn('agent.run.failed', {
            agentId: params.agentId,
            error: msg,
            durationMs: Date.now() - startedAt,
          });
          // Phase 26 D: 실패도 agent_runs 에 기록 (감사용). attach 는 호출 X (output 없음 → helper 가 자동 skip).
          // Phase 30 hotfix P0-1: traceId / parentSpanId 부착.
          await persistAgentRunAndAttach(deps, {
            agentId: createAgentId(params.agentId),
            prompt: params.prompt,
            output: '',
            durationMs: Date.now() - startedAt,
            modelUsed: deps.defaultModel.model,
            error: msg,
            traceId: traceCtx?.traceId,
            parentSpanId: traceCtx?.parentSpanId,
          });
          throw err;
        } finally {
          activeRuns.set(params.agentId, Math.max(0, (activeRuns.get(params.agentId) ?? 1) - 1));
          handle.release();
        }
      });
    },
  };

  registry.register(listHandler);
  registry.register(statusHandler);
  registry.register(runHandler);
}
