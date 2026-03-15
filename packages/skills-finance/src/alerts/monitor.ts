import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import type { DeliveryDispatcher } from './delivery.js';
import type {
  AlertConditionEvaluator,
  AlertConditionType,
  AlertDefinition,
  AlertMonitorConfig,
  AlertStore,
} from './types.js';

export interface AlertMonitor {
  start(): void;
  stop(): void;
  checkAlerts(): Promise<void>;
}

export function createAlertMonitor(deps: {
  store: AlertStore;
  evaluators: Record<AlertConditionType, AlertConditionEvaluator>;
  deliveryDispatcher: DeliveryDispatcher;
  logger: FinClawLogger;
  config: AlertMonitorConfig;
  lane: ConcurrencyLane;
}): AlertMonitor {
  let timer: ReturnType<typeof setInterval> | null = null;
  let isChecking = false;

  async function checkAlerts(): Promise<void> {
    if (isChecking) {
      return;
    }
    isChecking = true;
    try {
      const alerts = deps.store.listEnabled();
      deps.logger.debug(`Checking ${alerts.length} enabled alerts`);
      await Promise.allSettled(alerts.map(checkSingleAlert));
    } finally {
      isChecking = false;
    }
  }

  async function checkSingleAlert(alert: AlertDefinition): Promise<void> {
    const handle = await deps.lane.acquire(alert.id).catch(() => null);
    if (!handle) {
      return;
    }
    try {
      // 쿨다운 체크
      const last = deps.store.getLastTrigger(alert.id);
      if (last && alert.cooldownMs > 0 && Date.now() - last.triggeredAt < alert.cooldownMs) {
        return;
      }

      const evaluator = deps.evaluators[alert.condition.type];
      if (!evaluator) {
        deps.logger.warn(`No evaluator: ${alert.condition.type}`);
        return;
      }

      const evaluation = await evaluator.evaluate(alert.condition);
      if (evaluation.triggered) {
        deps.logger.info('Alert triggered', { alertId: alert.id, name: alert.name });
        const results = await deps.deliveryDispatcher.dispatch(alert, evaluation);
        deps.store.recordTrigger(alert.id, evaluation, results);
      }
    } catch (error) {
      deps.logger.error('Alert check failed', {
        alertId: alert.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      handle.release();
    }
  }

  return {
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        checkAlerts().catch(() => {});
      }, deps.config.checkIntervalMs);
      checkAlerts().catch(() => {});
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    checkAlerts,
  };
}
