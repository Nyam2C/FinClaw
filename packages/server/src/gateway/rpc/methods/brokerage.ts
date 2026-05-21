// packages/server/src/gateway/rpc/methods/brokerage.ts
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod/v4';
import type { BrokerageSyncService } from '../../../services/brokerage-sync-service.js';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

/**
 * brokerage.* RPC 메서드 의존성 (main.ts 에서 주입).
 *
 * - `syncService` 미주입(KIS 키 미설정) 시 brokerage.sync.run 은 not_configured 에러.
 * - 1인 사용자 전제 — input 은 모두 `{}`.
 */
export interface BrokerageRpcDeps {
  readonly db?: DatabaseSync;
  readonly syncService?: BrokerageSyncService;
  /** health 표시용 KIS 환경(prod/vts). */
  readonly env?: 'prod' | 'vts';
}

/** brokerage.* RPC 메서드 일괄 등록 (web settings 의 수동 sync 버튼용, 최소). */
export function registerBrokerageMethods(deps: BrokerageRpcDeps): void {
  // ── brokerage.sync.run ──
  const syncRunHandler: RpcMethodHandler<Record<string, never>, unknown> = {
    method: 'brokerage.sync.run',
    description: '한국투자증권(KIS) 잔고를 수동으로 동기화합니다 (read-only).',
    authLevel: 'token',
    schema: z.object({}),
    async execute() {
      if (!deps.syncService) {
        throw new Error('not_configured: KIS not configured');
      }
      const result = await deps.syncService.run();
      return {
        syncedAt: result.syncedAt,
        holdingsCount: result.holdingsCount,
        marketsScanned: result.marketsScanned,
      };
    },
  };

  // ── brokerage.health.get ──
  const healthGetHandler: RpcMethodHandler<Record<string, never>, unknown> = {
    method: 'brokerage.health.get',
    description: 'KIS 연동 상태(설정 여부, 환경, 마지막 동기화 시각)를 조회합니다.',
    authLevel: 'token',
    schema: z.object({}),
    async execute() {
      const configured = Boolean(deps.syncService);
      // 마지막 sync 추정 — source='kis' holdings 가 존재하면 동기화된 것으로 본다.
      const kisHoldingsCount = deps.db
        ? (
            deps.db
              .prepare(`SELECT COUNT(*) c FROM portfolio_holdings WHERE source = 'kis'`)
              .get() as { c: number }
          ).c
        : 0;
      return {
        configured,
        env: deps.env ?? null,
        kisHoldingsCount,
      };
    },
  };

  registerMethod(syncRunHandler);
  registerMethod(healthGetHandler);
}
