import { ConcurrencyLaneManager } from '@finclaw/infra';
// packages/server/src/services/cron/scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCronScheduler, type CronScheduler } from './scheduler.js';

function createTestLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let logger: ReturnType<typeof createTestLogger>;
  let lanes: ConcurrencyLaneManager;

  beforeEach(() => {
    logger = createTestLogger();
    lanes = new ConcurrencyLaneManager();
    scheduler = createCronScheduler({ logger, lanes });
  });

  afterEach(() => {
    scheduler.stop();
    lanes.dispose();
  });

  it('작업을 등록하고 list로 조회할 수 있다', () => {
    const job = scheduler.add({
      name: 'test-job',
      schedule: { kind: 'every', intervalMs: 60_000 },
      handler: async () => {},
      enabled: true,
    });

    expect(job.id).toBeTruthy();
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0].name).toBe('test-job');
  });

  it('작업을 제거할 수 있다', () => {
    const job = scheduler.add({
      name: 'test-job',
      schedule: { kind: 'every', intervalMs: 60_000 },
      handler: async () => {},
      enabled: true,
    });

    expect(scheduler.remove(job.id)).toBe(true);
    expect(scheduler.list()).toHaveLength(0);
  });

  it('존재하지 않는 작업 제거 시 false를 반환한다', () => {
    expect(scheduler.remove('nonexistent')).toBe(false);
  });

  it('start/stop으로 스케줄러를 제어할 수 있다', () => {
    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  it('setEnabled로 작업을 비활성화할 수 있다', () => {
    const job = scheduler.add({
      name: 'test-job',
      schedule: { kind: 'every', intervalMs: 60_000 },
      handler: async () => {},
      enabled: true,
    });

    scheduler.setEnabled(job.id, false);
    expect(scheduler.list()[0].enabled).toBe(false);
  });

  it('every 스케줄이 지정 간격 후 실행된다', async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockResolvedValue(undefined);

    scheduler.add({
      name: 'interval-job',
      schedule: { kind: 'every', intervalMs: 100 },
      handler,
      enabled: true,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(150);

    expect(handler).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it('handler 에러 시 lastStatus가 error로 설정된다', async () => {
    vi.useFakeTimers();
    const handler = vi.fn().mockRejectedValue(new Error('fail'));

    const job = scheduler.add({
      name: 'failing-job',
      schedule: { kind: 'every', intervalMs: 100 },
      handler,
      enabled: true,
    });

    scheduler.start();

    await vi.advanceTimersByTimeAsync(150);

    const updated = scheduler.list().find((j) => j.id === job.id);
    expect(updated?.lastStatus).toBe('error');
    expect(logger.error).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('stop 시 AbortSignal이 handler에 전파된다', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;

    scheduler.add({
      name: 'signal-job',
      schedule: { kind: 'every', intervalMs: 100 },
      handler: async (signal) => {
        receivedSignal = signal;
        // 긴 작업 시뮬레이션
        await new Promise((resolve) => setTimeout(resolve, 1000));
      },
      enabled: true,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(150);

    scheduler.stop();

    expect(receivedSignal?.aborted).toBe(true);

    vi.useRealTimers();
  });

  it('nextRunAt이 등록 시 계산된다', () => {
    const now = Date.now();
    const job = scheduler.add({
      name: 'test-job',
      schedule: { kind: 'every', intervalMs: 60_000 },
      handler: async () => {},
      enabled: true,
    });

    expect(job.nextRunAt).toBeGreaterThanOrEqual(now);
  });

  it('at 스케줄: 과거 시간이면 nextRunAt이 null이다', () => {
    const job = scheduler.add({
      name: 'past-job',
      schedule: { kind: 'at', atMs: Date.now() - 1000 },
      handler: async () => {},
      enabled: true,
    });

    expect(job.nextRunAt).toBeNull();
  });
});
