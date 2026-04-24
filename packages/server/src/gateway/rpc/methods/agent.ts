import type { ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import type { AgentRunParams, ConversationMessage, ModelRef } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
// packages/server/src/gateway/rpc/methods/agent.ts
import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
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

        try {
          const runParams: AgentRunParams = {
            agentId: agentIdBrand,
            sessionKey,
            model: deps.defaultModel,
            systemPrompt: deps.systemPrompt,
            messages: [userMessage],
            tools: toolDefinitions.length > 0 ? [...toolDefinitions] : undefined,
            abortSignal: abortController.signal,
          };
          const result = await runner.execute(runParams);

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
