import type { Timestamp } from '@finclaw/types';
// packages/server/src/services/cron/jobs/alert-check.ts
import type { DatabaseSync } from 'node:sqlite';
import { updateAlertTrigger } from '@finclaw/storage';
import type { HookRegistry } from '../../hooks/registry.js';

/**
 * 가격 알림 체크 작업.
 * 활성 알림을 market_cache와 JOIN하여 현재가를 조회하고,
 * 조건 충족 시 훅 이벤트를 발행한다.
 */
export function createAlertCheckJob(db: DatabaseSync, hooks: HookRegistry) {
  return {
    name: 'alert-check',
    schedule: { kind: 'every' as const, intervalMs: 60 * 1000 }, // 1분마다
    enabled: true,
    handler: async (signal?: AbortSignal) => {
      const now = Date.now();

      const stmt = db.prepare(`
        SELECT a.id, a.symbol, a.condition_type, a.condition_value,
               a.cooldown_ms, a.last_triggered_at,
               json_extract(mc.data, '$.price') AS current_price
        FROM alerts a
        JOIN market_cache mc ON mc.key = a.symbol
        WHERE a.enabled = 1
          AND mc.expires_at > ?
      `);
      const alerts = stmt.all(now) as Array<{
        id: string;
        symbol: string;
        condition_type: string;
        condition_value: number;
        cooldown_ms: number;
        last_triggered_at: number | null;
        current_price: number | null;
      }>;

      for (const alert of alerts) {
        if (signal?.aborted) {
          break;
        }
        if (alert.current_price == null) {
          continue;
        }

        // 쿨다운 체크
        if (
          alert.cooldown_ms > 0 &&
          alert.last_triggered_at != null &&
          now - alert.last_triggered_at < alert.cooldown_ms
        ) {
          continue;
        }

        const shouldTrigger =
          (alert.condition_type === 'above' && alert.current_price >= alert.condition_value) ||
          (alert.condition_type === 'below' && alert.current_price <= alert.condition_value);

        if (shouldTrigger) {
          updateAlertTrigger(db, alert.id, now as Timestamp);

          hooks.trigger({
            type: 'market',
            action: 'alert-triggered',
            timestamp: now,
            context: {
              alertId: alert.id,
              symbol: alert.symbol,
              conditionType: alert.condition_type,
              conditionValue: alert.condition_value,
              currentPrice: alert.current_price,
            },
          });
        }
      }
    },
  };
}
