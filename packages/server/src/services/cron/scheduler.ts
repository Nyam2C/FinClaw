import type { FinClawLogger, ConcurrencyLaneManager } from '@finclaw/infra';
// packages/server/src/services/cron/scheduler.ts
import { Cron } from 'croner';

// ─── Types ───

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly schedule: CronSchedule;
  readonly handler: (signal?: AbortSignal) => Promise<void>;
  readonly enabled: boolean;
  readonly lastRunAt: number | null;
  readonly lastStatus: 'ok' | 'error' | null;
  readonly nextRunAt: number | null;
}

export type CronSchedule =
  | { readonly kind: 'cron'; readonly expr: string; readonly tz?: string }
  | { readonly kind: 'every'; readonly intervalMs: number }
  | { readonly kind: 'at'; readonly atMs: number };

export interface CronSchedulerDeps {
  readonly logger: FinClawLogger;
  readonly lanes: ConcurrencyLaneManager;
}

export interface CronScheduler {
  add(job: Omit<CronJob, 'id' | 'lastRunAt' | 'lastStatus' | 'nextRunAt'>): CronJob;
  remove(jobId: string): boolean;
  setEnabled(jobId: string, enabled: boolean): void;
  list(): CronJob[];
  start(): void;
  stop(): void;
  readonly running: boolean;
}

// ─── Internal types ───

type InternalJob = CronJob & { _cron?: Cron; _timer?: ReturnType<typeof setTimeout> };
type MutableJobState = {
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  nextRunAt: number | null;
};

// ─── Implementation ───

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  const { logger, lanes } = deps;
  const jobs = new Map<string, InternalJob>();
  let isRunning = false;
  let abortController: AbortController | null = null;

  function computeNextRunAt(schedule: CronSchedule): number | null {
    const now = Date.now();
    switch (schedule.kind) {
      case 'cron': {
        const cron = new Cron(schedule.expr, { timezone: schedule.tz });
        const next = cron.nextRun();
        return next ? next.getTime() : null;
      }
      case 'every':
        return now + schedule.intervalMs;
      case 'at':
        return schedule.atMs > now ? schedule.atMs : null;
    }
  }

  function armJob(job: InternalJob): void {
    // 이전 크론 인스턴스 정리
    job._cron?.stop();
    if (job._timer) {
      clearTimeout(job._timer);
    }

    if (!job.enabled || !isRunning) {
      return;
    }

    const { schedule } = job;

    if (schedule.kind === 'cron') {
      job._cron = new Cron(schedule.expr, { timezone: schedule.tz }, async () => {
        await executeJob(job);
      });
    } else if (schedule.kind === 'every') {
      const delay = Math.min(schedule.intervalMs, MAX_TIMEOUT_MS);
      const run = async () => {
        if (!job.enabled || !isRunning) {
          return;
        }
        await executeJob(job);
        if (job.enabled && isRunning) {
          job._timer = setTimeout(run, delay);
          job._timer.unref();
        }
      };
      job._timer = setTimeout(run, delay);
      job._timer.unref();
    } else if (schedule.kind === 'at') {
      const delay = Math.min(schedule.atMs - Date.now(), MAX_TIMEOUT_MS);
      if (delay > 0) {
        job._timer = setTimeout(async () => {
          await executeJob(job);
        }, delay);
        job._timer.unref();
      }
    }
  }

  async function executeJob(job: InternalJob): Promise<void> {
    const state = job as unknown as MutableJobState;

    // ConcurrencyLane을 통한 동시성 제어 (laneId='cron', key=job.name)
    const handle = await lanes.acquire('cron', job.name);
    state.lastRunAt = Date.now();
    try {
      await job.handler(abortController?.signal);
      state.lastStatus = 'ok';
    } catch (error) {
      state.lastStatus = 'error';
      logger.error(`[Cron Error] ${job.name}: ${error}`);
    } finally {
      handle.release();
    }

    state.nextRunAt = computeNextRunAt(job.schedule);
  }

  return {
    add(input) {
      const id = crypto.randomUUID();
      const job: InternalJob = {
        ...input,
        id,
        lastRunAt: null,
        lastStatus: null,
        nextRunAt: computeNextRunAt(input.schedule),
      };
      jobs.set(id, job);
      if (isRunning) {
        armJob(job);
      }
      return job;
    },

    remove(jobId) {
      const job = jobs.get(jobId);
      if (!job) {
        return false;
      }
      job._cron?.stop();
      if (job._timer) {
        clearTimeout(job._timer);
      }
      return jobs.delete(jobId);
    },

    setEnabled(jobId, enabled) {
      const job = jobs.get(jobId);
      if (!job) {
        return;
      }
      (job as { enabled: boolean }).enabled = enabled;
      if (enabled && isRunning) {
        armJob(job);
      } else {
        job._cron?.stop();
        if (job._timer) {
          clearTimeout(job._timer);
        }
      }
    },

    list() {
      // TODO(review): InternalJob의 _cron, _timer 내부 필드가 노출됨 — 필요 시 pick으로 정리
      return Array.from(jobs.values());
    },

    start() {
      isRunning = true;
      abortController = new AbortController();
      for (const job of jobs.values()) {
        armJob(job);
      }
      logger.info(`[Cron] Scheduler started with ${jobs.size} jobs`);
    },

    stop() {
      isRunning = false;
      abortController?.abort();
      abortController = null;
      for (const job of jobs.values()) {
        job._cron?.stop();
        if (job._timer) {
          clearTimeout(job._timer);
        }
      }
      logger.info('[Cron] Scheduler stopped');
    },

    get running() {
      return isRunning;
    },
  };
}
