// packages/server/src/automation/scheduler.ts
// Phase 28 B: 매 분 0초 폴러 → due schedules → agent.run 실행 → agent_runs 영속화.
// delivery 호출은 onRunComplete 콜백으로 외부 주입 (밀스톤 C).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRunPort } from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import { findDueSchedules, getSchedule, markScheduleRun, updateSchedule } from '@finclaw/storage';
import type { Schedule, SchedulerPort } from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import type { FinclawTracer } from '../observability/tracer.js';
import { nextStaggeredRunAt } from './stagger.js';

export interface SchedulerCallbacks {
  /**
   * agent.run 완료 직후 호출 (성공/실패 모두). delivery 모듈에서 이 시점에 송출.
   * 본 함수가 throw 해도 scheduler 는 계속 동작 (best-effort).
   */
  onRunComplete?(args: {
    schedule: Schedule;
    agentRunId: string | null;
    output: string;
    error?: string;
  }): Promise<void>;
}

export interface SchedulerDeps extends SchedulerCallbacks {
  readonly db: DatabaseSync;
  /** Phase 46: cron = runtime oneShot (비영속·recall 없음 — Q4). agent_runs 1행은 runtime 이 기록. */
  readonly runtime: AgentRunPort;
  /** schedule 동시 실행 1개로 제한하는 lane. main.ts 에서 maxConcurrent:1 로 주입. */
  readonly lane: ConcurrencyLane;
  readonly logger: FinClawLogger;
  /** 연속 실패 임계 (3 = AUTOMATION_MAX_CONSECUTIVE_FAILURES). 기본 3. */
  readonly maxConsecutiveFailures?: number;
  /** schedule.timeoutMs 가 없을 때의 상한(ms). 미지정 시 runtime 타임아웃만 [TQ4]. */
  readonly defaultTimeoutMs?: number;
  /**
   * Phase 30 hotfix P0-1: schedule 실행을 새 span 으로 감싸 active trace context 강제.
   * 미주입 시 기존 동작 (agent_runs.trace_id NULL).
   */
  readonly tracer?: FinclawTracer;
}

const POLL_INTERVAL_MS = 60_000;

/**
 * Exponential backoff delays (in ms) indexed by consecutive error count.
 * After the last entry the delay stays constant.
 * OpenClaw src/cron/service/timer.ts:107-119 이식.
 */
const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000, // 1st error  →  30 s
  60_000, // 2nd error  →   1 min
  5 * 60_000, // 3rd error  →   5 min
  15 * 60_000, // 4th error  →  15 min
  60 * 60_000, // 5th+ error →  60 min
];

export function errorBackoffMs(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_SCHEDULE_MS.length - 1);
  return ERROR_BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

export class SchedulerService implements SchedulerPort {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTickTimer: ReturnType<typeof setTimeout> | null = null;
  private active = new Set<string>();
  private stopping = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** 1분 폴러 시작. 다음 분 경계까지 대기 후 첫 tick. */
  start(): void {
    if (this.timer || this.firstTickTimer) {
      return;
    }
    const now = Date.now();
    const nextMinute = Math.ceil(now / POLL_INTERVAL_MS) * POLL_INTERVAL_MS;
    const firstDelay = nextMinute - now;
    this.firstTickTimer = setTimeout(() => {
      this.firstTickTimer = null;
      void this.tick();
      this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    }, firstDelay);
    this.deps.logger.info('scheduler.started', {
      event: 'scheduler.started',
      firstTickInMs: firstDelay,
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.firstTickTimer) {
      clearTimeout(this.firstTickTimer);
      this.firstTickTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 현재 진행 중 run 들 완료 대기 — 60초 강제 timeout.
    const deadline = Date.now() + 60_000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.deps.logger.info('scheduler.stopped', {
      event: 'scheduler.stopped',
      forcedExit: this.active.size > 0,
      remaining: this.active.size,
    });
  }

  /** UI 의 schedule.runNow RPC 가 호출. lane 통과 + agent.run 즉시 실행. */
  async triggerNow(scheduleId: string): Promise<{ runId: string | null }> {
    const s = getSchedule(this.deps.db, scheduleId);
    if (!s) {
      throw new Error(`not_found: schedule ${scheduleId}`);
    }
    return this.runOne(s, { manual: true });
  }

  private async tick(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const now = Date.now();
    let due: Schedule[];
    try {
      due = findDueSchedules(this.deps.db, now);
    } catch (err) {
      this.deps.logger.warn('scheduler.tick_failed', {
        event: 'scheduler.tick_failed',
        error: (err as Error).message,
      });
      return;
    }
    for (const s of due) {
      // 이미 진행 중인 schedule 은 lane 으로 직렬화되지만, 같은 schedule 이 다음 tick 까지 안 끝났으면 skip.
      if (this.active.has(s.id)) {
        this.deps.logger.info('scheduler.tick_skipped_active', {
          event: 'scheduler.tick_skipped_active',
          scheduleId: s.id,
          name: s.name,
        });
        try {
          const next = nextStaggeredRunAt(s, now);
          markScheduleRun(this.deps.db, s.id, s.lastRunId ?? null, s.lastRunAt ?? now, next);
        } catch {
          /* swallow */
        }
        continue;
      }
      void this.runOne(s, { manual: false });
    }
  }

  private async runOne(s: Schedule, opts: { manual: boolean }): Promise<{ runId: string | null }> {
    if (this.active.has(s.id)) {
      return { runId: null };
    }
    this.active.add(s.id);
    const handle = await this.deps.lane.acquire(s.id);
    const startedAt = Date.now();
    let runId: string | null = null;
    let output = '';
    let error: string | undefined;
    // Phase 30 hotfix P0-1: schedule 실행을 새 trace 로 감싸 trace_id 가 agent_runs 에 비어있지 않게.
    const tracer = this.deps.tracer;
    const withSchedSpan = <T>(fn: () => Promise<T>): Promise<T> =>
      tracer
        ? tracer.withSpan(
            'scheduler.run',
            { scheduleId: s.id, agentId: s.agentId as string, manual: opts.manual },
            async () => fn(),
          )
        : fn();
    return withSchedSpan(async () => {
      try {
        const sessionKey = createSessionKey(`schedule-${s.id}-${randomUUID()}`);
        const timeoutMs = s.timeoutMs ?? this.deps.defaultTimeoutMs;
        for await (const ev of this.deps.runtime.run({
          sessionKey,
          agentId: createAgentId(s.agentId as string),
          input: s.prompt,
          mode: 'oneShot',
          signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : new AbortController().signal,
        })) {
          if (ev.type === 'done') {
            runId = ev.runId;
            output = ev.text;
          } else if (ev.type === 'error') {
            runId = ev.runId;
            error = `${ev.reason}: ${ev.message}`;
          }
        }
        // D1: runtime 이 종료 이벤트 yield 전에 agent_runs 1행을 남김 → runId 로 schedule 연결
        if (runId) {
          this.deps.db
            .prepare('UPDATE agent_runs SET schedule_id = ? WHERE id = ?')
            .run(s.id, runId);
        }

        // schedule.last_run + next_run_at 갱신.
        let nextMs: number | null = null;
        try {
          nextMs = nextStaggeredRunAt(s, Date.now());
        } catch (cronErr) {
          this.deps.logger.warn('scheduler.cron_invalid', {
            event: 'scheduler.cron_invalid',
            scheduleId: s.id,
            cron: s.cron,
            error: (cronErr as Error).message,
          });
        }
        // Phase 31 B — 실패 시 backoff override (cron 의 다음 발화보다 backoff 가 나중이면 적용).
        if (error && nextMs !== null) {
          const failures = s.consecutiveFailures + 1;
          const backoffMs = errorBackoffMs(failures);
          const backoffNextMs = Date.now() + backoffMs;
          if (backoffNextMs > nextMs) {
            nextMs = backoffNextMs;
            this.deps.logger.info('schedule.backoff_applied', {
              event: 'schedule.backoff_applied',
              scheduleId: s.id,
              consecutiveFailures: failures,
              backoffMs,
              nextRunAt: backoffNextMs,
            });
          }
        }

        markScheduleRun(this.deps.db, s.id, runId, Date.now(), nextMs);

        // 연속 실패 추적 + auto-disable.
        const max = this.deps.maxConsecutiveFailures ?? 3;
        const fresh = getSchedule(this.deps.db, s.id);
        if (!fresh) {
          // 레이스: 삭제된 schedule. 갱신만 skip.
        } else if (error) {
          const failures = fresh.consecutiveFailures + 1;
          const shouldDisable = failures >= max;
          updateSchedule(this.deps.db, s.id, {
            consecutiveFailures: failures,
            status: shouldDisable ? 'disabled' : 'failing',
            ...(shouldDisable ? { enabled: false } : {}),
          });
        } else if (fresh.consecutiveFailures > 0 || fresh.status !== 'active') {
          updateSchedule(this.deps.db, s.id, {
            consecutiveFailures: 0,
            status: 'active',
          });
        }

        this.deps.logger.info(error ? 'schedule.failed' : 'schedule.triggered', {
          event: error ? 'schedule.failed' : 'schedule.triggered',
          scheduleId: s.id,
          name: s.name,
          agentRunId: runId,
          durationMs: Date.now() - startedAt,
          manual: opts.manual,
          error,
        });

        if (this.deps.onRunComplete) {
          try {
            await this.deps.onRunComplete({
              schedule: fresh ?? s,
              agentRunId: runId,
              output,
              error,
            });
          } catch (deliveryErr) {
            this.deps.logger.warn('schedule.delivery_failed', {
              event: 'schedule.delivery_failed',
              scheduleId: s.id,
              error: (deliveryErr as Error).message,
            });
          }
        }
        return { runId };
      } finally {
        handle.release();
        this.active.delete(s.id);
      }
    });
  }
}
