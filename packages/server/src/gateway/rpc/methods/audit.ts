// packages/server/src/gateway/rpc/methods/audit.ts
// Phase 30 C5: 감사 로그 조회 RPC. token 인증 필요 (1차 — AUDIT_READ permission 별도 확장은 후속).

import type { DatabaseSync } from 'node:sqlite';
import { listAccessLog } from '@finclaw/storage';
import { z } from 'zod/v4';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

export interface AuditRpcDeps {
  readonly db?: DatabaseSync;
}

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

export function registerAuditMethods(deps: AuditRpcDeps): void {
  const listHandler: RpcMethodHandler<
    {
      since?: number;
      limit?: number;
      method?: string;
      actor?: string;
      status?: string;
    },
    unknown
  > = {
    method: 'audit.list',
    description: 'access_log 행을 시간 desc + 필터로 조회합니다 (감사 가능성)',
    authLevel: 'token',
    schema: z.object({
      since: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
      method: z.string().min(1).optional(),
      actor: z.string().min(1).optional(),
      status: z.string().min(1).optional(),
    }),
    async execute(params) {
      if (!deps.db) {
        throw new Error('provider_unavailable: storage db not initialized');
      }
      const limit = params.limit ?? LIST_LIMIT_DEFAULT;
      return listAccessLog(deps.db, {
        since: params.since,
        limit,
        method: params.method,
        actor: params.actor,
        status: params.status,
      });
    },
  };

  registerMethod(listHandler);
}
