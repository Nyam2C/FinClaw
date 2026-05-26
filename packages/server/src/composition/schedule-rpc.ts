// packages/server/src/composition/schedule-rpc.ts
// Phase 36: main.ts 305-353 에서 추출 (순수 이동). Phase 31 F 의 agent ScheduleRpc.

import { CronParseError, nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';
import { addSchedule, deleteSchedule, listSchedules, type createStorage } from '@finclaw/storage';
import type { ScheduleRpc, Timestamp } from '@finclaw/types';
import { createAgentId } from '@finclaw/types';

type Storage = ReturnType<typeof createStorage>;

/**
 * Phase 31 F: agent 가 호출할 ScheduleRpc — gateway schedule.* 핸들러와 동일 로직을 wrap.
 * 핸들러가 inline RpcMethodHandler 라 export 되지 않으므로 storage + cron 유틸을 직접 호출.
 * agent 발화는 web/broadcast 채널로 송출 (deliveryTarget 미지정 시 기본값).
 */
export function buildScheduleRpc(storage: Storage): ScheduleRpc {
  return {
    async create(req) {
      const cron = parseCron(req.cron);
      const next = computeNextRunAt(cron, Date.now());
      const created = addSchedule(storage.db, {
        name: req.name,
        cron: req.cron,
        agentId: createAgentId('default'),
        prompt: req.prompt,
        deliveryChannel: 'web',
        deliveryTarget: 'broadcast',
        enabled: req.enabled,
        nextRunAt: next === null ? undefined : (next as Timestamp),
      });
      return { id: created.id, nextRunAt: created.nextRunAt ?? null };
    },
    async list(req) {
      const items = listSchedules(storage.db, { limit: req.limit });
      return {
        schedules: items.map((s) => ({
          id: s.id,
          name: s.name,
          cron: s.cron,
          enabled: s.enabled,
          status: s.status,
          consecutiveFailures: s.consecutiveFailures,
          nextRunAt: s.nextRunAt,
        })),
      };
    },
    async delete(req) {
      deleteSchedule(storage.db, req.scheduleId);
    },
    async testCron(req) {
      try {
        const cron = parseCron(req.cron);
        const next = computeNextRunAt(cron, Date.now());
        return { valid: true, nextRunAt: next === null ? undefined : next };
      } catch (err) {
        if (err instanceof CronParseError) {
          return { valid: false, reason: err.message };
        }
        throw err;
      }
    },
  };
}
