// packages/server/src/gateway/rpc/methods/agent-runs.ts
import type { DatabaseSync } from 'node:sqlite';
import { getAgentRun, listAgentRuns } from '@finclaw/storage';
import type { AgentId } from '@finclaw/types';
import { z } from 'zod/v4';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

/**
 * agent.runs.* RPC 메서드 의존성 (main.ts 에서 주입).
 *
 * - `db` 가 없으면 모든 메서드는 `provider_unavailable` 에러.
 */
export interface AgentRunsRpcDeps {
  readonly db?: DatabaseSync;
}

// ─── 상수 ───

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
/** 목록 응답에 prompt 를 자르는 상한 (UI 가 전체는 get 으로 조회). */
const PROMPT_TRUNCATE = 200;
/** 목록 응답에 output 을 자르는 상한. */
const OUTPUT_TRUNCATE = 500;

// ─── 등록 ───

/**
 * agent.runs.* RPC 메서드 일괄 등록.
 * deps.db 미주입 시 모든 호출이 provider_unavailable.
 */
export function registerAgentRunsMethods(deps: AgentRunsRpcDeps): void {
  // ── agent.runs.list ──
  // 목록은 본문 truncate. 전체 조회는 agent.runs.get.
  const listHandler: RpcMethodHandler<
    {
      agentId?: string;
      from?: number;
      to?: number;
      limit?: number;
    },
    unknown
  > = {
    method: 'agent.runs.list',
    description: '저장된 agent_runs 를 조회합니다 (created_at DESC, 최신순)',
    authLevel: 'token',
    schema: z.object({
      agentId: z.string().min(1).optional(),
      from: z.number().int().nonnegative().optional(),
      to: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const limit = params.limit ?? LIST_LIMIT_DEFAULT;
      const runs = listAgentRuns(deps.db, {
        agentId: params.agentId as AgentId | undefined,
        from: params.from as never,
        to: params.to as never,
        limit,
      });
      return {
        runs: runs.map((r) => ({
          id: r.id,
          agentId: r.agentId,
          prompt: r.prompt.length > PROMPT_TRUNCATE ? r.prompt.slice(0, PROMPT_TRUNCATE) : r.prompt,
          output: r.output.length > OUTPUT_TRUNCATE ? r.output.slice(0, OUTPUT_TRUNCATE) : r.output,
          durationMs: r.durationMs,
          modelUsed: r.modelUsed,
          role: r.role,
          memoryId: r.memoryId,
          error: r.error,
          createdAt: r.createdAt,
        })),
      };
    },
  };

  // ── agent.runs.get ──
  // 단건 전체 조회. tool_calls_json 은 storage 가 raw 문자열로 반환 →
  // 본 RPC 가 파싱해서 toolCalls 배열로 노출 (UI 친화적).
  const getHandler: RpcMethodHandler<{ runId: string }, unknown> = {
    method: 'agent.runs.get',
    description: 'agent_runs 단건의 전체 상세를 조회합니다 (toolCalls 파싱 포함)',
    authLevel: 'token',
    schema: z.object({
      runId: z.string().min(1),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const run = getAgentRun(deps.db, params.runId);
      if (!run) {
        return { run: null };
      }

      // toolCalls 는 storage 에서 JSON 문자열. UI 친화적으로 파싱해서 배열로 반환.
      // 파싱 실패 시 빈 배열 (잘못된 데이터를 응답에 노출하지 않음).
      let toolCalls: unknown[] = [];
      if (run.toolCalls) {
        try {
          const parsed = JSON.parse(run.toolCalls);
          if (Array.isArray(parsed)) {
            toolCalls = parsed;
          }
        } catch {
          toolCalls = [];
        }
      }

      return {
        run: {
          id: run.id,
          agentId: run.agentId,
          prompt: run.prompt,
          output: run.output,
          toolCalls,
          tokensInput: run.tokensInput,
          tokensOutput: run.tokensOutput,
          durationMs: run.durationMs,
          modelUsed: run.modelUsed,
          role: run.role,
          memoryId: run.memoryId,
          error: run.error,
          createdAt: run.createdAt,
        },
      };
    },
  };

  registerMethod(listHandler);
  registerMethod(getHandler);
}
