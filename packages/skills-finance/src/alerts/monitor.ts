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
  /** Phase 23: RPC finance.alert.create 직후 단일 알림 1회 평가 (쿨다운/레인 우회) */
  evaluateOnce(alertId: string): Promise<boolean>;
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

  async function evaluateOnce(alertId: string): Promise<boolean> {
    const alert = deps.store.getById(alertId);
    if (!alert || !alert.enabled) {
      return false;
    }
    const evaluator = deps.evaluators[alert.condition.type];
    if (!evaluator) {
      return false;
    }
    try {
      const evaluation = await evaluator.evaluate(alert.condition);
      if (evaluation.triggered) {
        deps.logger.info('Alert triggered (immediate evaluation)', {
          alertId,
          name: alert.name,
        });
        const results = await deps.deliveryDispatcher.dispatch(alert, evaluation);
        deps.store.recordTrigger(alertId, evaluation, results);
        return true;
      }
      return false;
    } catch (error) {
      deps.logger.error('Alert immediate evaluation failed', {
        alertId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
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
    evaluateOnce,
  };
}
