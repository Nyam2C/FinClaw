import type { FinClawLogger, ConcurrencyLane, LaneHandle } from '@finclaw/infra';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DeliveryDispatcher } from '../delivery.js';
import { createAlertMonitor } from '../monitor.js';
import type {
  AlertConditionEvaluator,
  AlertConditionType,
  AlertDefinition,
  AlertMonitorConfig,
  AlertStore,
} from '../types.js';

function mockLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn(),
  } as unknown as FinClawLogger;
}

function mockLane(): ConcurrencyLane {
  return {
    acquire: vi.fn().mockResolvedValue({ release: vi.fn() } satisfies LaneHandle),
  } as unknown as ConcurrencyLane;
}

function createMockAlert(overrides?: Partial<AlertDefinition>): AlertDefinition {
  return {
    id: 'alert-1',
    userId: 'user-1',
    name: 'Test Alert',
    condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
    channels: ['log'],
    cooldownMs: 900_000,
    enabled: true,
    triggerCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('AlertMonitor', () => {
  let store: AlertStore;
  let evaluators: Record<AlertConditionType, AlertConditionEvaluator>;
  let dispatcher: DeliveryDispatcher;
  let config: AlertMonitorConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    store = {
      listEnabled: vi.fn().mockReturnValue([]),
      getLastTrigger: vi.fn().mockReturnValue(null),
      recordTrigger: vi.fn(),
    } as unknown as AlertStore;

    evaluators = {
      price: {
        type: 'price',
        evaluate: vi
          .fn()
          .mockResolvedValue({ triggered: true, currentValue: '210', message: 'ok' }),
      },
      change: {
        type: 'change',
        evaluate: vi
          .fn()
          .mockResolvedValue({ triggered: false, currentValue: '1%', message: 'ok' }),
      },
      volume: {
        type: 'volume',
        evaluate: vi
          .fn()
          .mockResolvedValue({ triggered: false, currentValue: '1M', message: 'ok' }),
      },
      news: {
        type: 'news',
        evaluate: vi.fn().mockResolvedValue({ triggered: false, currentValue: '0', message: 'ok' }),
      },
    } as unknown as Record<AlertConditionType, AlertConditionEvaluator>;

    dispatcher = {
      dispatch: vi
        .fn()
        .mockResolvedValue([{ channel: 'log', success: true, deliveredAt: Date.now() }]),
    };
    config = { checkIntervalMs: 30_000, maxConcurrentChecks: 10, defaultCooldownMs: 900_000 };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() 시 즉시 checkAlerts 호출', async () => {
    const alert = createMockAlert();
    (store.listEnabled as ReturnType<typeof vi.fn>).mockReturnValue([alert]);

    const monitor = createAlertMonitor({
      store,
      evaluators,
      deliveryDispatcher: dispatcher,
      logger: mockLogger(),
      config,
      lane: mockLane(),
    });
    monitor.start();

    // 즉시 실행되는 checkAlerts의 Promise를 기다린다
    await vi.advanceTimersByTimeAsync(0);

    expect(store.listEnabled).toHaveBeenCalled();
    expect(evaluators.price.evaluate).toHaveBeenCalled();
    monitor.stop();
  });

  it('30초 후 재호출', async () => {
    const monitor = createAlertMonitor({
      store,
      evaluators,
      deliveryDispatcher: dispatcher,
      logger: mockLogger(),
      config,
      lane: mockLane(),
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.listEnabled).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.listEnabled).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('쿨다운 — 최근 트리거된 알림 스킵', async () => {
    const alert = createMockAlert({ cooldownMs: 60_000 });
    (store.listEnabled as ReturnType<typeof vi.fn>).mockReturnValue([alert]);
    (store.getLastTrigger as ReturnType<typeof vi.fn>).mockReturnValue({
      triggeredAt: Date.now() - 10_000,
    });

    const monitor = createAlertMonitor({
      store,
      evaluators,
      deliveryDispatcher: dispatcher,
      logger: mockLogger(),
      config,
      lane: mockLane(),
    });
    await monitor.checkAlerts();

    expect(evaluators.price.evaluate).not.toHaveBeenCalled();
  });

  it('cooldownMs=0 → 항상 통과', async () => {
    const alert = createMockAlert({ cooldownMs: 0 });
    (store.listEnabled as ReturnType<typeof vi.fn>).mockReturnValue([alert]);
    (store.getLastTrigger as ReturnType<typeof vi.fn>).mockReturnValue({
      triggeredAt: Date.now() - 100,
    });

    const monitor = createAlertMonitor({
      store,
      evaluators,
      deliveryDispatcher: dispatcher,
      logger: mockLogger(),
      config,
      lane: mockLane(),
    });
    await monitor.checkAlerts();

    expect(evaluators.price.evaluate).toHaveBeenCalled();
  });

  it('개별 알림 실패가 전체 사이클을 중단하지 않음', async () => {
    const alert1 = createMockAlert({ id: 'a1' });
    const alert2 = createMockAlert({ id: 'a2' });
    (store.listEnabled as ReturnType<typeof vi.fn>).mockReturnValue([alert1, alert2]);
    (evaluators.price.evaluate as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({ triggered: true, currentValue: '210', message: 'ok' });

    const logger = mockLogger();
    const monitor = createAlertMonitor({
      store,
      evaluators,
      deliveryDispatcher: dispatcher,
      logger,
      config,
      lane: mockLane(),
    });
    await monitor.checkAlerts();

    // 두 번째 알림은 정상 처리
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });
});
