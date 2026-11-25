// packages/server/src/gateway/rpc/methods/agent.ts
import { randomUUID } from 'node:crypto';
import type {
  AgentRunPort,
  ProfileHealthMonitor,
  TerminalEvent,
  ToolRegistry,
} from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import type { AttachMemoryInput, AttachMemoryPort, TracerPort } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import { z } from 'zod/v4';
import type { MethodRegistry } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

/** agent.* RPC 메서드 의존성 (main.ts 에서 주입) */
export interface AgentRpcDeps {
  readonly toolRegistry: ToolRegistry;
  /** main.ts 가 finclaw.system.ko.md frontmatter (id/name/description) 로부터 로드해 주입. */
  readonly agents: readonly AgentInfo[];
  /** Phase 46: agent.run = runtime oneShot. agent_runs 1행·profileHealth 기록은 runtime 소관 (D10). */
  readonly runtime: AgentRunPort;
  /** agent.run 전용 큐잉 lane (main.ts 에서 maxConcurrent:1 로 주입) — 현 동작 유지 (D6) */
  readonly agentRunLane: ConcurrencyLane;
  /** agent.status 의 health 표시용. */
  readonly profileHealth: ProfileHealthMonitor;
  readonly logger: FinClawLogger;
  readonly profileId?: string;
  /** Phase 26 D: agent.run 종료 후 output → memory 저장 훅. 현 동작 유지 (S2·R6 — phase47 존폐 결정). */
  readonly attachMemoryService?: AttachMemoryPort;
  /** Phase 30 hotfix P0-1: agent.run 진입 span — runtime 이 그 traceId 를 agent_runs 에 부착. */
  readonly tracer?: TracerPort;
}

export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Best-effort: attach 실패는 swallow + warn. RPC 응답엔 영향 X. */
async function attachMemory(
  deps: Pick<AgentRpcDeps, 'attachMemoryService' | 'logger'>,
  input: AttachMemoryInput,
): Promise<void> {
  if (!deps.attachMemoryService || !input.output) {
    return;
  }
  try {
    await deps.attachMemoryService.attach(input);
  } catch (attachErr) {
    deps.logger.warn('agent.run.memory.attach_failed', {
      event: 'agent.run.memory.attach_failed',
      agentRunId: input.agentRunId,
      error: (attachErr as Error).message,
    });
  }
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

      // tracer 주입 시 span 으로 감싸 active trace context 강제 → runtime 이 traceId 를 agent_runs 에 부착.
      const runWithSpan = <T>(fn: () => Promise<T>): Promise<T> =>
        deps.tracer
          ? deps.tracer.withSpan('rpc.agent.run', { agentId: params.agentId }, async () => fn())
          : fn();

      return runWithSpan(async () => {
        const handle = await deps.agentRunLane.acquire(params.agentId);
        activeRuns.set(params.agentId, (activeRuns.get(params.agentId) ?? 0) + 1);
        const sessionKey = createSessionKey(`agent-run-${randomUUID()}`);
        try {
          let terminal: TerminalEvent | undefined;
          for await (const ev of deps.runtime.run({
            sessionKey,
            agentId: createAgentId(params.agentId),
            input: params.prompt,
            mode: 'oneShot',
            // [TQ5] timeoutMs 를 주면 그 시각에 abort, 없으면 runtime 무출력 120s / overall 300s 만
            signal: params.timeoutMs
              ? AbortSignal.timeout(params.timeoutMs)
              : new AbortController().signal,
          })) {
            if (ev.type === 'done' || ev.type === 'error') {
              terminal = ev;
            }
          }
          if (terminal?.type !== 'done') {
            throw new Error(
              terminal
                ? `${terminal.reason}: ${terminal.message}`
                : 'agent run ended without result',
            );
          }

          const durationMs = Date.now() - startedAt;
          totalCalls.set(params.agentId, (totalCalls.get(params.agentId) ?? 0) + 1);
          lastCallAt.set(params.agentId, Date.now());
          lastError.delete(params.agentId);
          deps.logger.info('agent.run.completed', {
            agentId: params.agentId,
            runId: terminal.runId,
            durationMs,
            tokensInput: terminal.usage.input,
            tokensOutput: terminal.usage.output,
          });

          // Phase 26 D: output → memory (현 동작 유지). agent_runs 행은 runtime 이 이미 기록 → link 가능.
          await attachMemory(deps, {
            agentRunId: terminal.runId,
            agentId: params.agentId,
            prompt: params.prompt,
            output: terminal.text,
            sessionKey,
            createdAt: Date.now(),
          });

          return {
            agentId: params.agentId,
            output: terminal.text,
            tokenUsage: { input: terminal.usage.input, output: terminal.usage.output },
            durationMs,
            stopReason: 'completed',
            runId: terminal.runId,
          };
        } catch (err) {
          const msg = (err as Error).message;
          lastError.set(params.agentId, msg);
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
      });
    },
  };

  registry.register(listHandler);
  registry.register(statusHandler);
  registry.register(runHandler);
}
