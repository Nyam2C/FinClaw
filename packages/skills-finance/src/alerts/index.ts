import type { DatabaseSync } from 'node:sqlite';
import type { ToolRegistry } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import { ConcurrencyLane, createCircuitBreaker } from '@finclaw/infra';
import type { AlertTriggeredData } from '@finclaw/types';
import type { MarketCache } from '../market/cache.js';
import type { ProviderRegistry } from '../market/provider-registry.js';
import type { NewsAggregator } from '../news/types.js';
import { createChangeConditionEvaluator } from './conditions/change.js';
import { createNewsConditionEvaluator } from './conditions/news.js';
import { createPriceConditionEvaluator } from './conditions/price.js';
import { createVolumeConditionEvaluator } from './conditions/volume.js';
import {
  createDeliveryDispatcher,
  createDiscordDeliveryHandler,
  createLogDeliveryHandler,
  createWebSocketDeliveryHandler,
  type DeliveryHandler,
  type DiscordClientPort,
} from './delivery.js';
import { createAlertMarketService } from './market-service.js';
import { createAlertMonitor, type AlertMonitor } from './monitor.js';
import { createAlertStore } from './store.js';
import { registerListAlertsTool, registerGetAlertHistoryTool } from './tools.js';
import type { AlertConditionEvaluator, AlertConditionType, AlertMonitorConfig } from './types.js';

export type {
  AlertStore,
  AlertCondition,
  AlertConditionType,
  AlertDefinition,
  CreateAlertInput,
  DeliveryChannel,
  PriceCondition,
  ChangeCondition,
  VolumeCondition,
  NewsCondition,
} from './types.js';
export { createAlertStore } from './store.js';

/** Phase 23: RPC 배선에서 alertStore 접근을 위해 monitor 와 store 를 함께 노출 */
export interface AlertSkillHandle {
  readonly monitor: AlertMonitor;
  readonly store: import('./types.js').AlertStore;
  /** phase47: gateway 생성 뒤 main 이 호출 (scheduler setDeliveryHook 과 같은 late-bind — alerts 가 gateway 보다 먼저 생성됨). */
  setBroadcast(fn: (data: AlertTriggeredData) => number): void;
}

export interface AlertSkillConfig {
  readonly db: DatabaseSync;
  readonly cache: MarketCache;
  readonly registry: ProviderRegistry;
  readonly newsAggregator: NewsAggregator;
  readonly logger: FinClawLogger;
  readonly discordClient?: DiscordClientPort;
  readonly monitorConfig?: Partial<AlertMonitorConfig>;
}

export async function registerAlertTools(
  toolRegistry: ToolRegistry,
  config: AlertSkillConfig,
): Promise<AlertSkillHandle> {
  const store = createAlertStore(config.db);
  const marketService = createAlertMarketService({
    cache: config.cache,
    registry: config.registry,
  });

  const priceCB = createCircuitBreaker();
  const changeCB = createCircuitBreaker();
  const newsCB = createCircuitBreaker();

  const evaluators = {
    price: createPriceConditionEvaluator(marketService, priceCB),
    change: createChangeConditionEvaluator(marketService, changeCB),
    volume: createVolumeConditionEvaluator(marketService),
    news: createNewsConditionEvaluator(config.newsAggregator, newsCB),
  } satisfies Record<AlertConditionType, AlertConditionEvaluator>;

  let broadcast: ((data: AlertTriggeredData) => number) | undefined;
  const handlers: DeliveryHandler[] = [
    createLogDeliveryHandler({ logger: config.logger }),
    createWebSocketDeliveryHandler({ getBroadcast: () => broadcast }),
  ];
  if (config.discordClient) {
    handlers.push(createDiscordDeliveryHandler({ client: config.discordClient }));
  }

  const deliveryDispatcher = createDeliveryDispatcher({ handlers, logger: config.logger });

  const monitorConfig: AlertMonitorConfig = {
    checkIntervalMs: config.monitorConfig?.checkIntervalMs ?? 30_000,
    maxConcurrentChecks: config.monitorConfig?.maxConcurrentChecks ?? 10,
    defaultCooldownMs: config.monitorConfig?.defaultCooldownMs ?? 900_000,
  };

  const lane = new ConcurrencyLane({
    maxConcurrent: monitorConfig.maxConcurrentChecks,
    maxQueueSize: 50,
    waitTimeoutMs: 10_000,
  });

  const monitor = createAlertMonitor({
    store,
    evaluators,
    deliveryDispatcher,
    logger: config.logger,
    config: monitorConfig,
    lane,
  });

  registerListAlertsTool(toolRegistry, { store });
  registerGetAlertHistoryTool(toolRegistry, { store });

  monitor.start();
  return {
    monitor,
    store,
    setBroadcast(fn) {
      broadcast = fn;
    },
  };
}
