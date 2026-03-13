// packages/server/src/services/cron/jobs/market-refresh.ts
import type { DatabaseSync } from 'node:sqlite';

/**
 * 시장 데이터 갱신 작업.
 * 활성 알림의 symbol 목록을 조회하고 시세 갱신을 트리거한다.
 * (실제 시세 조회는 Phase 16 market provider에서 구현)
 */
export function createMarketRefreshJob(db: DatabaseSync) {
  return {
    name: 'market-refresh',
    schedule: { kind: 'every' as const, intervalMs: 5 * 60 * 1000 }, // 5분마다
    enabled: true,
    handler: async (_signal?: AbortSignal) => {
      // 활성 알림의 고유 symbol 목록 조회
      const stmt = db.prepare('SELECT DISTINCT symbol FROM alerts WHERE enabled = 1');
      const symbols = (stmt.all() as Array<{ symbol: string }>).map((r) => r.symbol);

      if (symbols.length === 0) {
        return;
      }

      // TODO(phase-16): market provider를 통해 각 symbol 시세 조회 및 캐시 갱신
      // 현재는 symbol 목록만 수집 — provider 연동 시 여기서 setCachedData 호출
    },
  };
}
