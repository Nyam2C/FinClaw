// packages/server/src/gateway/rpc/methods/trace.ts
import type { DatabaseSync } from 'node:sqlite';
import { getSpanTree, listSpansByTrace } from '@finclaw/storage';
import { z } from 'zod/v4';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

/**
 * trace.* RPC 메서드 의존성 (Phase 30 A9).
 * deps.db 미주입 시 모든 호출이 provider_unavailable.
 */
export interface TraceRpcDeps {
  readonly db?: DatabaseSync;
}

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

interface TraceSummaryRow {
  trace_id: string;
  first_ns: number;
  last_ns: number | null;
  root_name: string;
}

export function registerTraceMethods(deps: TraceRpcDeps): void {
  // ── trace.get ──
  // traceId 로 묶인 모든 span + tree + agent_runs 동반 반환.
  const getHandler: RpcMethodHandler<{ traceId: string }, unknown> = {
    method: 'trace.get',
    description: 'Trace 의 모든 span (flat + tree) 과 동반 agent_runs 를 조회합니다',
    authLevel: 'token',
    schema: z.object({
      traceId: z.string().length(32),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const spans = listSpansByTrace(deps.db, params.traceId);
      const tree = getSpanTree(deps.db, params.traceId);
      const agentRuns = deps.db
        .prepare('SELECT * FROM agent_runs WHERE trace_id = ? ORDER BY created_at ASC')
        .all(params.traceId);
      return { traceId: params.traceId, spans, tree, agentRuns };
    },
  };

  // ── trace.list ──
  // 최근 trace 들 — span 의 trace_id GROUP BY 로 distinct list, root span name + 시간 범위.
  const listHandler: RpcMethodHandler<{ since?: number; limit?: number }, unknown> = {
    method: 'trace.list',
    description: '최근 trace 의 요약 (root name, first_ns, last_ns) 을 반환합니다',
    authLevel: 'token',
    schema: z.object({
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const limit = params.limit ?? LIST_LIMIT_DEFAULT;
      // since 는 ms 단위. start_ns 와 비교하려면 ns 로 환산 (1ms = 1_000_000 ns).
      const sinceNs = (params.since ?? 0) * 1_000_000;
      const rows = deps.db
        .prepare(
          `SELECT trace_id,
                  MIN(start_ns) AS first_ns,
                  MAX(end_ns)   AS last_ns,
                  MIN(name)     AS root_name
             FROM spans
             WHERE start_ns >= ?
             GROUP BY trace_id
             ORDER BY first_ns DESC
             LIMIT ?`,
        )
        .all(sinceNs, limit) as unknown as TraceSummaryRow[];
      return { traces: rows };
    },
  };

  registerMethod(getHandler);
  registerMethod(listHandler);
}
