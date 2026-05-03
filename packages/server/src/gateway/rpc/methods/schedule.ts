// packages/server/src/gateway/rpc/methods/schedule.ts
// Phase 28 C: schedule.* RPC.

import type { DatabaseSync } from 'node:sqlite';
import {
  addSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
} from '@finclaw/storage';
import type { AgentId, Schedule, Timestamp } from '@finclaw/types';
import { createAgentId } from '@finclaw/types';
import { z } from 'zod/v4';
import {
  CronParseError,
  nextRunAt as computeNextRunAt,
  parseCron,
} from '../../../automation/cron.js';
import type { SchedulerService } from '../../../automation/scheduler.js';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

export interface ScheduleRpcDeps {
  readonly db?: DatabaseSync;
  readonly scheduler?: SchedulerService;
}

const MAX_LIMIT = 200;
const MAX_TEST_SAMPLES = 20;

const cronField = z.string().min(1).max(120);
const promptField = z.string().min(1).max(2000);
const nameField = z.string().min(1).max(120);

function requireDb(deps: ScheduleRpcDeps): DatabaseSync {
  if (!deps.db) {
    throw new Error('provider_unavailable: storage db not initialized');
  }
  return deps.db;
}

function requireScheduler(deps: ScheduleRpcDeps): SchedulerService {
  if (!deps.scheduler) {
    throw new Error('provider_unavailable: scheduler not initialized');
  }
  return deps.scheduler;
}

interface ScheduleResponse {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly agentId: AgentId;
  readonly prompt: string;
  readonly deliveryChannel: 'discord' | 'web';
  readonly deliveryTarget: string;
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  readonly status: 'active' | 'failing' | 'disabled';
  readonly consecutiveFailures: number;
  readonly lastRunAt?: Timestamp;
  readonly lastRunId?: string;
  readonly nextRunAt?: Timestamp;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

function toResponseSchedule(s: Schedule | null): ScheduleResponse | null {
  if (!s) {
    return null;
  }
  return {
    id: s.id,
    name: s.name,
    cron: s.cron,
    agentId: s.agentId,
    prompt: s.prompt,
    deliveryChannel: s.deliveryChannel,
    deliveryTarget: s.deliveryTarget,
    enabled: s.enabled,
    timeoutMs: s.timeoutMs,
    status: s.status,
    consecutiveFailures: s.consecutiveFailures,
    lastRunAt: s.lastRunAt,
    lastRunId: s.lastRunId,
    nextRunAt: s.nextRunAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function registerScheduleMethods(deps: ScheduleRpcDeps): void {
  // ── schedule.create ──
  const createHandler: RpcMethodHandler<
    {
      name: string;
      cron: string;
      agentId: string;
      prompt: string;
      deliveryChannel: 'discord' | 'web';
      deliveryTarget: string;
      timeoutMs?: number;
      enabled?: boolean;
    },
    unknown
  > = {
    method: 'schedule.create',
    description: '시간 기반 자동 트리거를 등록합니다',
    authLevel: 'token',
    schema: z.object({
      name: nameField,
      cron: cronField,
      agentId: z.string().min(1),
      prompt: promptField,
      deliveryChannel: z.enum(['discord', 'web']),
      deliveryTarget: z.string().min(1).max(120),
      timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
      enabled: z.boolean().optional(),
    }),
    async execute(params) {
      const db = requireDb(deps);
      try {
        const cron = parseCron(params.cron);
        const next = computeNextRunAt(cron, Date.now());
        const created = addSchedule(db, {
          name: params.name,
          cron: params.cron,
          agentId: createAgentId(params.agentId),
          prompt: params.prompt,
          deliveryChannel: params.deliveryChannel,
          deliveryTarget: params.deliveryTarget,
          enabled: params.enabled,
          timeoutMs: params.timeoutMs,
          nextRunAt: next === null ? undefined : (next as Timestamp),
        });
        return { scheduleId: created.id, nextRunAt: created.nextRunAt ?? null };
      } catch (err) {
        if (err instanceof CronParseError) {
          throw new Error(`invalid_params: ${err.message}`, { cause: err });
        }
        throw err;
      }
    },
  };

  // ── schedule.list ──
  const listHandler: RpcMethodHandler<{ enabled?: boolean; limit?: number }, unknown> = {
    method: 'schedule.list',
    description: '등록된 자동화 schedule 목록을 조회합니다',
    authLevel: 'token',
    schema: z.object({
      enabled: z.boolean().optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
    async execute(params) {
      const db = requireDb(deps);
      const items = listSchedules(db, { enabled: params.enabled, limit: params.limit });
      return { schedules: items.map(toResponseSchedule) };
    },
  };

  // ── schedule.update ──
  const updateHandler: RpcMethodHandler<
    {
      scheduleId: string;
      name?: string;
      cron?: string;
      prompt?: string;
      deliveryChannel?: 'discord' | 'web';
      deliveryTarget?: string;
      enabled?: boolean;
      timeoutMs?: number | null;
    },
    unknown
  > = {
    method: 'schedule.update',
    description: 'schedule 의 일부 필드를 갱신합니다 (cron 변경 시 next_run_at 재계산)',
    authLevel: 'token',
    schema: z.object({
      scheduleId: z.string().min(1),
      name: nameField.optional(),
      cron: cronField.optional(),
      prompt: promptField.optional(),
      deliveryChannel: z.enum(['discord', 'web']).optional(),
      deliveryTarget: z.string().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      timeoutMs: z.number().int().min(1_000).max(300_000).nullable().optional(),
    }),
    async execute(params) {
      const db = requireDb(deps);
      const patch: Parameters<typeof updateSchedule>[2] = {};
      if (params.name !== undefined) {
        patch.name = params.name;
      }
      if (params.prompt !== undefined) {
        patch.prompt = params.prompt;
      }
      if (params.deliveryChannel !== undefined) {
        patch.deliveryChannel = params.deliveryChannel;
      }
      if (params.deliveryTarget !== undefined) {
        patch.deliveryTarget = params.deliveryTarget;
      }
      if (params.enabled !== undefined) {
        patch.enabled = params.enabled;
      }
      if (params.timeoutMs !== undefined) {
        patch.timeoutMs = params.timeoutMs;
      }
      if (params.cron !== undefined) {
        try {
          const cron = parseCron(params.cron);
          patch.cron = params.cron;
          const next = computeNextRunAt(cron, Date.now());
          patch.nextRunAt = next === null ? null : (next as Timestamp);
        } catch (err) {
          if (err instanceof CronParseError) {
            throw new Error(`invalid_params: ${err.message}`, { cause: err });
          }
          throw err;
        }
      }
      // re-enable: status/실패 카운터 정리.
      if (params.enabled === true) {
        patch.status = 'active';
        patch.consecutiveFailures = 0;
      }
      const updated = updateSchedule(db, params.scheduleId, patch);
      if (!updated) {
        throw new Error(`not_found: schedule ${params.scheduleId}`);
      }
      return { schedule: toResponseSchedule(updated) };
    },
  };

  // ── schedule.delete ──
  const deleteHandler: RpcMethodHandler<{ scheduleId: string }, unknown> = {
    method: 'schedule.delete',
    description: 'schedule 을 삭제합니다 (agent_runs.schedule_id 는 NULL)',
    authLevel: 'token',
    schema: z.object({ scheduleId: z.string().min(1) }),
    async execute(params) {
      const db = requireDb(deps);
      const deleted = deleteSchedule(db, params.scheduleId);
      return { deleted };
    },
  };

  // ── schedule.runNow ──
  const runNowHandler: RpcMethodHandler<{ scheduleId: string }, unknown> = {
    method: 'schedule.runNow',
    description: 'schedule 을 즉시 실행합니다 (수동 트리거)',
    authLevel: 'token',
    schema: z.object({ scheduleId: z.string().min(1) }),
    async execute(params) {
      const sched = requireScheduler(deps);
      const { runId } = await sched.triggerNow(params.scheduleId);
      return { runId };
    },
  };

  // ── schedule.history ──
  const historyHandler: RpcMethodHandler<{ scheduleId: string; limit?: number }, unknown> = {
    method: 'schedule.history',
    description: '특정 schedule 의 실행 이력 (agent_runs.schedule_id 필터)',
    authLevel: 'token',
    schema: z.object({
      scheduleId: z.string().min(1),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
    async execute(params) {
      const db = requireDb(deps);
      // agent.runs.list 는 schedule_id 필터를 모르므로 직접 SQL.
      const rows = db
        .prepare(
          `SELECT id, agent_id, prompt, output, duration_ms, model_used, role, error, created_at
           FROM agent_runs
           WHERE schedule_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(params.scheduleId, Math.min(params.limit ?? 50, MAX_LIMIT)) as Array<{
        id: string;
        agent_id: string;
        prompt: string;
        output: string;
        duration_ms: number | null;
        model_used: string | null;
        role: string | null;
        error: string | null;
        created_at: number;
      }>;
      return {
        runs: rows.map((r) => ({
          id: r.id,
          agentId: r.agent_id as AgentId,
          prompt: r.prompt.length > 200 ? r.prompt.slice(0, 200) : r.prompt,
          output: r.output.length > 500 ? r.output.slice(0, 500) : r.output,
          durationMs: r.duration_ms,
          modelUsed: r.model_used,
          role: r.role,
          error: r.error,
          createdAt: r.created_at,
        })),
      };
    },
  };

  // ── schedule.disable / schedule.enable ──
  const disableHandler: RpcMethodHandler<{ scheduleId: string }, unknown> = {
    method: 'schedule.disable',
    description: 'schedule 을 일시 비활성화합니다',
    authLevel: 'token',
    schema: z.object({ scheduleId: z.string().min(1) }),
    async execute(params) {
      const db = requireDb(deps);
      const updated = updateSchedule(db, params.scheduleId, { enabled: false });
      if (!updated) {
        throw new Error(`not_found: schedule ${params.scheduleId}`);
      }
      return { schedule: toResponseSchedule(updated) };
    },
  };

  const enableHandler: RpcMethodHandler<{ scheduleId: string }, unknown> = {
    method: 'schedule.enable',
    description: 'schedule 을 다시 활성화합니다 (status=active, consecutiveFailures=0)',
    authLevel: 'token',
    schema: z.object({ scheduleId: z.string().min(1) }),
    async execute(params) {
      const db = requireDb(deps);
      const existing = getSchedule(db, params.scheduleId);
      if (!existing) {
        throw new Error(`not_found: schedule ${params.scheduleId}`);
      }
      let nextMs: number | null = null;
      try {
        nextMs = computeNextRunAt(parseCron(existing.cron), Date.now());
      } catch {
        /* swallow — invalid cron 은 update 에서 별도 처리 */
      }
      const updated = updateSchedule(db, params.scheduleId, {
        enabled: true,
        status: 'active',
        consecutiveFailures: 0,
        nextRunAt: nextMs === null ? null : (nextMs as Timestamp),
      });
      return { schedule: toResponseSchedule(updated) };
    },
  };

  // ── schedule.testCron ──
  const testCronHandler: RpcMethodHandler<{ expr: string; sampleCount?: number }, unknown> = {
    method: 'schedule.testCron',
    description: 'cron 표현식의 다음 N회 실행 시각을 미리 계산합니다 (등록 전 검증)',
    authLevel: 'token',
    schema: z.object({
      expr: cronField,
      sampleCount: z.number().int().min(1).max(MAX_TEST_SAMPLES).optional(),
    }),
    async execute(params) {
      try {
        const cron = parseCron(params.expr);
        const samples: number[] = [];
        const count = params.sampleCount ?? 5;
        let cursor = Date.now();
        for (let i = 0; i < count; i++) {
          const next = computeNextRunAt(cron, cursor);
          if (next === null) {
            break;
          }
          samples.push(next);
          cursor = next;
        }
        return { nextRunsAt: samples };
      } catch (err) {
        if (err instanceof CronParseError) {
          throw new Error(`invalid_params: ${err.message}`, { cause: err });
        }
        throw err;
      }
    },
  };

  registerMethod(createHandler);
  registerMethod(listHandler);
  registerMethod(updateHandler);
  registerMethod(deleteHandler);
  registerMethod(runNowHandler);
  registerMethod(historyHandler);
  registerMethod(disableHandler);
  registerMethod(enableHandler);
  registerMethod(testCronHandler);
}
