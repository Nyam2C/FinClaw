import type { AliasIndex, ModelCatalog, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import type { AgentRunParams, ConversationMessage, ModelRef } from '@finclaw/types';
import {
  DEFAULT_FALLBACK_TRIGGERS,
  ModelFloorExhaustedError,
  resolveModel,
  runWithModelFallback,
} from '@finclaw/agent';
import { createAgentId, createSessionKey } from '@finclaw/types';
// packages/server/src/gateway/rpc/methods/agent.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { RouterHelper } from '../../../auto-reply/router-helper.js';
import type { RpcMethodHandler } from '../types.js';
import {
  collectToolCalls,
  extractAssistantText,
  type RunnerFactory,
} from '../../../auto-reply/execution-adapter.js';
import { buildDispatcher } from '../../../auto-reply/tool-dispatcher-adapter.js';
import { registerMethod } from '../index.js';

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
}

interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

const AGENTS: readonly AgentInfo[] = [
  {
    id: 'finclaw-partner',
    name: 'FinClaw Personal Finance Partner',
    description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
  },
];

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
      return {
        agents: AGENTS.map((a) => ({
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
      const info = AGENTS.find((a) => a.id === params.agentId);
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
      if (!AGENTS.find((a) => a.id === params.agentId)) {
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

      const handle = await deps.agentRunLane.acquire(params.agentId);
      activeRuns.set(params.agentId, (activeRuns.get(params.agentId) ?? 0) + 1);

      try {
        const sessionKey = createSessionKey(`agent-run-${randomUUID()}`);
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
          });
        }

        try {
          const buildRunParams = (model: ModelRef): AgentRunParams => ({
            agentId: agentIdBrand,
            sessionKey,
            model,
            systemPrompt: deps.systemPrompt,
            messages: [userMessage],
            tools: toolDefinitions.length > 0 ? [...toolDefinitions] : undefined,
            abortSignal: abortController.signal,
          });

          // 라우터 + catalog 모두 활성: runWithModelFallback 으로 floor 보호.
          // 그 외: defaultModel 단일 실행 (밀스톤 D 이전 동작).
          let result;
          const catalog = deps.modelCatalog;
          const aliasIndex = deps.modelAliasIndex;
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
          deps.profileHealth.recordResult(profileId, true);

          deps.logger.info('agent.run.completed', {
            agentId: params.agentId,
            durationMs,
            tokensInput: result.usage.inputTokens,
            tokensOutput: result.usage.outputTokens,
            turns: result.turns,
            toolCallCount: toolCallRecords.length,
            status: result.status,
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
    },
  };

  registerMethod(listHandler);
  registerMethod(statusHandler);
  registerMethod(runHandler);
}
