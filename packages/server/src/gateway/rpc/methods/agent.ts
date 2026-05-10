// packages/server/src/gateway/rpc/methods/agent.ts
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AliasIndex, ModelCatalog, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import {
  calculateEstimatedCost,
  DEFAULT_FALLBACK_TRIGGERS,
  ModelFloorExhaustedError,
  resolveModel,
  runWithModelFallback,
} from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import { addAgentRun, type AddAgentRunInput } from '@finclaw/storage';
import type { AgentRunParams, ConversationMessage, ModelRef, SessionKey } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { AttachMemoryService } from '../../../auto-reply/agent-memory-hook.js';
import {
  collectToolCalls,
  extractAssistantText,
  type RunnerFactory,
} from '../../../auto-reply/execution-adapter.js';
import type { RouterHelper } from '../../../auto-reply/router-helper.js';
import { buildDispatcher } from '../../../auto-reply/tool-dispatcher-adapter.js';
import type { FinclawTracer } from '../../../observability/tracer.js';
import { loadPrompt, requireFrontmatterKeys } from '../../../prompts/loader.js';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

/** agent.* RPC 메서드 의존성 (main.ts 에서 주입) */
export interface AgentRpcDeps {
  readonly toolRegistry: ToolRegistry;
  readonly runnerFactory: RunnerFactory;
  /** agent.run 전용 큐잉 lane (main.ts 에서 maxConcurrent:1 로 주입) */
  readonly agentRunLane: ConcurrencyLane;
  readonly profileHealth: ProfileHealthMonitor;
  readonly systemPrompt: string;
  readonly defaultModel: ModelRef;
  readonly logger: FinClawLogger;
  readonly profileId?: string;
  /**
   * Phase 24: 모델 라우터. 주입 시 매 agent.run 마다 role 기반 모델 결정,
   * 미주입 시 defaultModel 그대로 사용.
   */
  readonly router?: RouterHelper;
  /** Phase 24 D: router 활성 시 runWithModelFallback 가 사용 (catalog + aliasIndex + chain) */
  readonly modelCatalog?: ModelCatalog;
  readonly modelAliasIndex?: AliasIndex;
  readonly fallbackChain?: readonly string[];
  /**
   * Phase 26 D: agent.run 종료 후 output 을 memory 로 저장하는 훅.
   * 미주입 시 저장 단계 자체 생략. 호출 위치는 rpc-engineer 가 결정.
   */
  readonly attachMemoryService?: AttachMemoryService;
  /**
   * Phase 26 D: agent_runs 영속화용 sqlite 핸들.
   * 미주입 시 agent_runs 저장 + attachMemoryService 호출 모두 skip (best-effort).
   */
  readonly db?: DatabaseSync;
  /**
   * Phase 30 hotfix P0-1: agent.run RPC 진입을 span 으로 감싸 active trace context
   * 를 강제. 미주입 시 traceId 부착 skip (기존 동작).
   */
  readonly tracer?: FinclawTracer;
}

interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

let cachedAgents: readonly AgentInfo[] | null = null;

async function loadAgents(): Promise<readonly AgentInfo[]> {
  if (cachedAgents) {
    return cachedAgents;
  }
  const doc = await loadPrompt('finclaw.identity.md', 'agent.ts:loadAgents');
  requireFrontmatterKeys(
    doc,
    'finclaw.identity.md',
    ['id', 'name', 'description'],
    'agent.ts:loadAgents',
  );
  cachedAgents = [
    {
      id: doc.frontmatter.id,
      name: doc.frontmatter.name,
      description: doc.frontmatter.description,
    },
  ];
  return cachedAgents;
}

/** 테스트용: AGENTS 캐시 초기화 */
export function resetAgentsCache(): void {
  cachedAgents = null;
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
export function registerAgentMethods(deps: AgentRpcDeps): void {
  const profileId = deps.profileId ?? 'default';

  // ── agent.list ──
  const listHandler: RpcMethodHandler<Record<string, never>, unknown> = {
    method: 'agent.list',
    description: '등록된 에이전트 목록을 조회합니다',
    authLevel: 'token',
    schema: z.object({}),
    async execute() {
      const toolCount = deps.toolRegistry.list().length;
      const agents = await loadAgents();
      return {
        agents: agents.map((a) => ({
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
      const agents = await loadAgents();
      const info = agents.find((a) => a.id === params.agentId);
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
      role?: 'fetch' | 'chat' | 'analysis' | 'summarize';
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
      // Phase 24: agent.run 은 보통 분석 성격이라 default 'analysis'.
      role: z.enum(['fetch', 'chat', 'analysis', 'summarize']).default('analysis'),
    }),
    async execute(params) {
      const agents = await loadAgents();
      if (!agents.find((a) => a.id === params.agentId)) {
        throw new Error(`unknown_agent: ${params.agentId}`);
      }
      if (params.stream) {
        throw new Error('stream_unsupported: use chat.* for streaming responses');
      }

      const startedAt = Date.now();
      deps.logger.info('agent.run.started', {
        agentId: params.agentId,
        promptLength: params.prompt.length,
        role: params.role ?? 'analysis',
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
        return deps.tracer.withSpan(
          'rpc.agent.run',
          { agentId: params.agentId, role: params.role ?? 'analysis' },
          async (ctx) => fn({ traceId: ctx.traceId, parentSpanId: ctx.spanId }),
        );
      };

      return runWithSpan(async (traceCtx) => {
        const handle = await deps.agentRunLane.acquire(params.agentId);
        activeRuns.set(params.agentId, (activeRuns.get(params.agentId) ?? 0) + 1);

        const sessionKey = createSessionKey(`agent-run-${randomUUID()}`);

        try {
          const agentIdBrand = createAgentId(params.agentId);

          const { dispatcher, toolDefinitions } = buildDispatcher(deps.toolRegistry, {
            sessionId: sessionKey as string,
            userId: 'agent-run',
            channelId: 'agent-run',
          });

          const runner = deps.runnerFactory(dispatcher);
          const userMessage: ConversationMessage = { role: 'user', content: params.prompt };
          const abortController = new AbortController();
          const timeoutMs = params.timeoutMs ?? 60_000;
          const timer = setTimeout(() => abortController.abort(), timeoutMs);

          // Phase 24: 라우터 주입 시 role 기반 모델 결정.
          // Zod schema 의 default('analysis') 가 채우지만 generic 타입상 optional 이므로 ?? 로 보강.
          const role = params.role ?? 'analysis';
          const decision = deps.router
            ? deps.router({ role, toolNames: toolDefinitions.map((t) => t.name) })
            : undefined;
          if (decision) {
            deps.logger.info('agent.run.routed', {
              event: 'agent.run.routed',
              agentId: params.agentId,
              role,
              chosenModel: decision.modelId,
              floor: decision.decision.floor,
              reason: decision.decision.reason,
              filteredCount: toolDefinitions.length - decision.allowedToolNames.length,
            });
          }

          // Phase 24 보정: 라우터 결정 allowedToolNames 만 LLM 노출.
          const exposedTools = decision
            ? toolDefinitions.filter((t) => decision.allowedToolNames.includes(t.name))
            : toolDefinitions;

          try {
            const buildRunParams = (model: ModelRef): AgentRunParams => ({
              agentId: agentIdBrand,
              sessionKey,
              model,
              systemPrompt: deps.systemPrompt,
              messages: [userMessage],
              tools: exposedTools.length > 0 ? [...exposedTools] : undefined,
              abortSignal: abortController.signal,
            });

            // 라우터 + catalog 모두 활성: runWithModelFallback 으로 floor 보호.
            // 그 외: defaultModel 단일 실행 (밀스톤 D 이전 동작).
            let result;
            const catalog = deps.modelCatalog;
            const aliasIndex = deps.modelAliasIndex;
            // Phase 24 E: byModel 집계용 — fallback path 에서만 정확한 modelId/pricing.
            let usedModelId: string | undefined;
            let usedPricing: import('@finclaw/agent').ModelPricing | undefined;
            let usedIsFallback = false;
            if (decision && catalog && aliasIndex) {
              const others = (deps.fallbackChain ?? []).filter((m) => m !== decision.modelId);
              const chain = [decision.modelId, ...others];
              const fallback = await runWithModelFallback(
                {
                  models: chain.map((raw) => ({ raw })),
                  maxRetriesPerModel: 1,
                  retryBaseDelayMs: 500,
                  fallbackOn: DEFAULT_FALLBACK_TRIGGERS,
                  abortSignal: abortController.signal,
                  floor: decision.decision.floor,
                },
                async (resolved) => {
                  const model: ModelRef = {
                    ...deps.defaultModel,
                    provider: resolved.provider,
                    model: resolved.modelId,
                    contextWindow: resolved.entry.contextWindow,
                    maxOutputTokens: Math.min(
                      resolved.entry.maxOutputTokens,
                      deps.defaultModel.maxOutputTokens,
                    ),
                  };
                  return runner.execute(buildRunParams(model));
                },
                (ref) => resolveModel(ref, catalog, aliasIndex),
              );
              result = fallback.result;
              usedModelId = fallback.modelUsed.modelId;
              usedPricing = fallback.modelUsed.entry.pricing;
              usedIsFallback = fallback.modelUsed.modelId !== chain[0];
            } else {
              const modelRef: ModelRef = decision
                ? { ...deps.defaultModel, model: decision.modelId }
                : deps.defaultModel;
              result = await runner.execute(buildRunParams(modelRef));
            }

            const output = extractAssistantText(result.messages);
            const toolCallRecords = collectToolCalls(result.messages, startedAt);
            const durationMs = Date.now() - startedAt;

            totalCalls.set(params.agentId, (totalCalls.get(params.agentId) ?? 0) + 1);
            lastCallAt.set(params.agentId, Date.now());
            lastError.delete(params.agentId);
            if (usedModelId && usedPricing) {
              deps.profileHealth.recordResult(profileId, {
                success: true,
                modelId: usedModelId,
                tokens: { input: result.usage.inputTokens, output: result.usage.outputTokens },
                costUsd: calculateEstimatedCost(
                  result.usage.inputTokens,
                  result.usage.outputTokens,
                  usedPricing,
                ),
                isFallback: usedIsFallback,
              });
            } else {
              deps.profileHealth.recordResult(profileId, true);
            }

            deps.logger.info('agent.run.completed', {
              agentId: params.agentId,
              durationMs,
              tokensInput: result.usage.inputTokens,
              tokensOutput: result.usage.outputTokens,
              turns: result.turns,
              toolCallCount: toolCallRecords.length,
              status: result.status,
            });

            // Phase 26 D: agent_runs 영속화 + memory attach (best-effort).
            // Phase 30 hotfix P0-1: traceId / parentSpanId 부착.
            const { runId } = await persistAgentRunAndAttach(deps, {
              agentId: agentIdBrand,
              prompt: params.prompt,
              output,
              toolCalls: JSON.stringify(toolCallRecords),
              tokensInput: result.usage.inputTokens,
              tokensOutput: result.usage.outputTokens,
              durationMs,
              modelUsed: usedModelId ?? deps.defaultModel.model,
              role,
              sessionKey,
              traceId: traceCtx?.traceId,
              parentSpanId: traceCtx?.parentSpanId,
            });

            return {
              agentId: params.agentId,
              output,
              toolCalls: toolCallRecords,
              tokenUsage: {
                input: result.usage.inputTokens,
                output: result.usage.outputTokens,
              },
              durationMs,
              stopReason: result.status,
              turns: result.turns,
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
            role: params.role ?? 'analysis',
            error: msg,
            traceId: traceCtx?.traceId,
            parentSpanId: traceCtx?.parentSpanId,
          });
          // Phase 24 D: floor 차단은 사용자에게 한국어 안내 (chat.send 와 동일 정책).
          if (err instanceof ModelFloorExhaustedError) {
            deps.logger.warn('agent.run.floor_exhausted', {
              event: 'agent.run.floor_exhausted',
              agentId: params.agentId,
              floor: err.floor,
              attempted: err.chainAttempted,
            });
            throw new Error(
              `요청에 필요한 모델(${err.floor} 이상)이 일시적으로 사용 불가합니다. 약 60초 후 다시 시도해 주세요.`,
              { cause: err },
            );
          }
          throw err;
        } finally {
          activeRuns.set(params.agentId, Math.max(0, (activeRuns.get(params.agentId) ?? 1) - 1));
          handle.release();
        }
      });
    },
  };

  registerMethod(listHandler);
  registerMethod(statusHandler);
  registerMethod(runHandler);
}
