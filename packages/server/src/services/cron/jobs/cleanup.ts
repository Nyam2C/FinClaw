// packages/server/src/services/cron/jobs/cleanup.ts
import type { DatabaseSync } from 'node:sqlite';
import { purgeExpiredCache } from '@finclaw/storage';

/**
 * 정리 작업.
 * - 만료된 시장 데이터 캐시 삭제
 * - 30일 이상 비활성 + 트리거된 알림 삭제
 */
export function createCleanupJob(db: DatabaseSync) {
  return {
    name: 'cleanup',
    schedule: { kind: 'cron' as const, expr: '0 3 * * *' }, // 매일 03:00
    enabled: true,
    handler: async (_signal?: AbortSignal) => {
      const now = Date.now();

      // 1. 만료된 캐시 삭제
      purgeExpiredCache(db);

      // 2. 30일 이상 비활성 + 트리거된 알림 삭제
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      db.prepare(
        'DELETE FROM alerts WHERE enabled = 0 AND last_triggered_at IS NOT NULL AND last_triggered_at < ?',
      ).run(thirtyDaysAgo);
    },
  };
}
