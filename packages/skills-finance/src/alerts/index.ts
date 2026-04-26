import type { DatabaseSync } from 'node:sqlite';
import type { ToolRegistry } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import { ConcurrencyLane, createCircuitBreaker } from '@finclaw/infra';
import type { SkillMetadata } from '@finclaw/types';
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
  type BroadcasterPort,
  type DeliveryHandler,
  type DiscordClientPort,
} from './delivery.js';
import { createAlertMarketService } from './market-service.js';
import { createAlertMonitor, type AlertMonitor } from './monitor.js';
import { createAlertStore } from './store.js';
import {
  registerSetAlertTool,
  registerListAlertsTool,
  registerRemoveAlertTool,
  registerGetAlertHistoryTool,
} from './tools.js';
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
}

export interface AlertSkillConfig {
  readonly db: DatabaseSync;
  readonly cache: MarketCache;
  readonly registry: ProviderRegistry;
  readonly newsAggregator: NewsAggregator;
  readonly logger: FinClawLogger;
  readonly discordClient?: DiscordClientPort;
  readonly broadcaster?: BroadcasterPort;
  readonly connections?: Map<string, unknown>;
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

  const handlers: DeliveryHandler[] = [createLogDeliveryHandler({ logger: config.logger })];
  if (config.discordClient) {
    handlers.push(createDiscordDeliveryHandler({ client: config.discordClient }));
  }
  if (config.broadcaster && config.connections) {
    handlers.push(
      createWebSocketDeliveryHandler({
        broadcaster: config.broadcaster,
        connections: config.connections,
      }),
    );
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

  registerSetAlertTool(toolRegistry, { store });
  registerListAlertsTool(toolRegistry, { store });
  registerRemoveAlertTool(toolRegistry, { store });
  registerGetAlertHistoryTool(toolRegistry, { store });

  monitor.start();
  return { monitor, store };
}

export const ALERT_SKILL_METADATA: SkillMetadata = {
  name: 'alert-system',
  description: '금융 이벤트 조건부 알림 시스템. 가격, 변동률, 거래량, 뉴스 키워드 모니터링.',
  version: '1.0.0',
  requires: {
    env: [],
    optionalEnv: [
      'ALERT_CHECK_INTERVAL_MS',
      'ALERT_DEFAULT_COOLDOWN_MS',
      'ALERT_MAX_CONCURRENT_CHECKS',
    ],
  },
  tools: [
    { name: 'set_alert', minModel: 'haiku', reason: 'CRUD' },
    { name: 'list_alerts', minModel: 'haiku', reason: 'CRUD' },
    { name: 'remove_alert', minModel: 'haiku', reason: 'CRUD' },
    { name: 'get_alert_history', minModel: 'haiku', reason: '조회' },
  ],
};
