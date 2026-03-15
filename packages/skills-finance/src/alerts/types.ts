// ─── Condition Types ───
export type AlertConditionType = 'price' | 'change' | 'volume' | 'news';
export type PriceDirection = 'above' | 'below';
export type ChangeDirection = 'up' | 'down' | 'both';

export interface PriceCondition {
  readonly type: 'price';
  readonly ticker: string;
  readonly direction: PriceDirection;
  readonly threshold: number;
}

export interface ChangeCondition {
  readonly type: 'change';
  readonly ticker: string;
  readonly thresholdPercent: number;
  readonly direction: ChangeDirection;
}

export interface VolumeCondition {
  readonly type: 'volume';
  readonly ticker: string;
  readonly multiplier: number;
}

export interface NewsCondition {
  readonly type: 'news';
  readonly keywords: readonly string[];
  readonly symbols?: readonly string[];
  readonly excludeKeywords?: readonly string[];
}

export type AlertCondition = PriceCondition | ChangeCondition | VolumeCondition | NewsCondition;

// ─── Alert Definition ───
export type DeliveryChannel = 'discord' | 'websocket' | 'log';

export interface AlertDefinition {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly condition: AlertCondition;
  readonly channels: readonly DeliveryChannel[];
  readonly cooldownMs: number;
  readonly enabled: boolean;
  readonly triggerCount: number;
  readonly expiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// R1: Omit에 enabled, cooldownMs 포함하여 intersection 충돌 방지
export type CreateAlertInput = Omit<
  AlertDefinition,
  'id' | 'createdAt' | 'updatedAt' | 'enabled' | 'cooldownMs' | 'triggerCount'
> & {
  readonly enabled?: boolean;
  readonly cooldownMs?: number;
};

// ─── Condition Evaluation ───
export interface ConditionEvaluation {
  readonly triggered: boolean;
  readonly currentValue: string;
  readonly message: string;
}

export interface AlertConditionEvaluator<T extends AlertCondition = AlertCondition> {
  readonly type: T['type'];
  evaluate(condition: T): Promise<ConditionEvaluation>;
}

// ─── History ───
export interface AlertHistory {
  readonly id: string;
  readonly alertId: string;
  readonly triggeredAt: number;
  readonly conditionSnapshot: string;
  readonly deliveryResults: readonly DeliveryResult[];
  readonly currentValue: string;
}

export interface DeliveryResult {
  readonly channel: DeliveryChannel;
  readonly success: boolean;
  readonly error?: string;
  readonly deliveredAt: number;
}

// ─── Monitor Config ───
export interface AlertMonitorConfig {
  readonly checkIntervalMs: number;
  readonly maxConcurrentChecks: number;
  readonly defaultCooldownMs: number;
}

// ─── AlertMarketService ───
export interface AlertMarketService {
  getQuote(ticker: string): Promise<{
    price: number;
    changePercent: number;
    volume: number;
  }>;
}

// ─── AlertStore ───
export interface AlertStore {
  create(input: CreateAlertInput): AlertDefinition;
  getById(id: string): AlertDefinition | null;
  listByUser(userId: string): AlertDefinition[];
  listEnabled(): AlertDefinition[];
  update(id: string, updates: Partial<CreateAlertInput>): AlertDefinition | null;
  delete(id: string): boolean;
  setEnabled(id: string, enabled: boolean): void;
  recordTrigger(
    alertId: string,
    evaluation: ConditionEvaluation,
    results: DeliveryResult[],
  ): AlertHistory;
  getHistory(alertId: string, limit?: number): AlertHistory[];
  getLastTrigger(alertId: string): AlertHistory | null;
}
