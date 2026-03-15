# Phase 18: 알림 시스템 — 상세 구현 TODO

## Context

Phase 18은 금융 이벤트 조건부 알림(Alert) 시스템을 구현한다. 4가지 조건 타입(가격/변동률/거래량/뉴스), 주기적 모니터링 엔진, 멀티 채널 전달(Discord DM/WebSocket/Log), 알림 이력 추적을 포함한다.

**산출물**: 신규 11 + 수정 4 + 테스트 5 = 20개 파일, ~1,700 LOC

**plan.md 기반, review.md 반영사항(R1~R7) 적용 완료.**

---

## Step 1: 타입 정의

### 1.1 `packages/skills-finance/src/alerts/types.ts` (NEW)

- [ ] 파일 생성

**핵심 결정:**

- `@finclaw/types` 미수정 — 스킬 로컬 타입 독립 정의
- R1 반영: `CreateAlertInput`의 `Omit`에 `enabled | cooldownMs` 포함
- `AlertStore` 메서드는 동기(`DatabaseSync` API)

```typescript
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
  readonly expiresAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// R1: Omit에 enabled, cooldownMs 포함하여 intersection 충돌 방지
export type CreateAlertInput = Omit<
  AlertDefinition,
  'id' | 'createdAt' | 'updatedAt' | 'enabled' | 'cooldownMs'
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
```

**검증:** `pnpm tsgo --noEmit`

---

## Step 2: 스키마 마이그레이션

### 2.1 `packages/storage/src/database.ts` (MODIFY)

- [ ] `SCHEMA_VERSION` 2 → 3 변경 (L21)
- [ ] `SCHEMA_DDL`의 alerts 테이블을 v3 구조로 교체 (L98-113)
- [ ] `alert_history` 테이블 DDL 추가 (alerts 테이블 뒤)
- [ ] `MIGRATIONS[3]` 추가 (L159 이후)

**SCHEMA_VERSION:**

```typescript
const SCHEMA_VERSION = 3; // was 2
```

**SCHEMA_DDL alerts 교체 (L98-113 대체):**

기존:

```sql
CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  symbol            TEXT NOT NULL,
  condition_type    TEXT NOT NULL CHECK(condition_type IN ('above','below','crosses_above','crosses_below','change_percent')),
  condition_value   REAL NOT NULL,
  condition_field   TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  channel_id        TEXT,
  trigger_count     INTEGER NOT NULL DEFAULT 0,
  cooldown_ms       INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(enabled) WHERE enabled = 1;
```

교체:

```sql
CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  condition_type    TEXT NOT NULL CHECK(
    condition_type IN ('price', 'change', 'volume', 'news')
  ),
  condition_json    TEXT NOT NULL,
  channels_json     TEXT NOT NULL DEFAULT '["discord","websocket"]',
  cooldown_ms       INTEGER NOT NULL DEFAULT 900000,
  enabled           INTEGER NOT NULL DEFAULT 1,
  trigger_count     INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  expires_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS alert_history (
  id                    TEXT PRIMARY KEY,
  alert_id              TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  triggered_at          INTEGER NOT NULL,
  condition_snapshot    TEXT NOT NULL,
  delivery_results_json TEXT NOT NULL DEFAULT '[]',
  current_value         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at DESC);
```

**MIGRATIONS[3] 추가 (기존 `2: \`...\`` 뒤에):**

```typescript
  3: `
    DROP TABLE IF EXISTS alerts;

    CREATE TABLE IF NOT EXISTS alerts (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      name              TEXT NOT NULL,
      condition_type    TEXT NOT NULL CHECK(
        condition_type IN ('price', 'change', 'volume', 'news')
      ),
      condition_json    TEXT NOT NULL,
      channels_json     TEXT NOT NULL DEFAULT '["discord","websocket"]',
      cooldown_ms       INTEGER NOT NULL DEFAULT 900000,
      enabled           INTEGER NOT NULL DEFAULT 1,
      trigger_count     INTEGER NOT NULL DEFAULT 0,
      last_triggered_at INTEGER,
      expires_at        INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled) WHERE enabled = 1;

    CREATE TABLE IF NOT EXISTS alert_history (
      id                    TEXT PRIMARY KEY,
      alert_id              TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      triggered_at          INTEGER NOT NULL,
      condition_snapshot    TEXT NOT NULL,
      delivery_results_json TEXT NOT NULL DEFAULT '[]',
      current_value         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id);
    CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at DESC);
  `,
```

### 2.2 `packages/storage/src/database.test.ts` (MODIFY)

- [ ] `schemaVersion` 기대값 `'2'` → `'3'` 변경
- [ ] 테이블 목록에 `'alert_history'` 추가

**변경 1 — 스키마 버전 (L78):**

```typescript
// Before
expect(result.value).toBe('2');
// After
expect(result.value).toBe('3');
```

**변경 2 — 테이블 목록 (L29):**

```typescript
// Before
expect(tableNames).toEqual(
  [
    'alerts',
    'conversations',
// After
expect(tableNames).toEqual(
  [
    'alert_history',
    'alerts',
    'conversations',
```

**참고:** `packages/storage/src/tables/alerts.ts`는 R4 Option B에 따라 **수정 불필요**. 기존 v2 스키마용 CRUD는 유지하되, 새 v3 CRUD는 `store.ts`에서 직접 구현.

**검증:** `pnpm vitest run packages/storage/`

---

## Step 3: AlertStore + MarketService 어댑터

### 3.1 `packages/skills-finance/src/alerts/store.ts` (NEW)

- [ ] 파일 생성

**핵심 결정:**

- `DatabaseSync` 직접 사용 (PortfolioStore 패턴)
- `crypto.randomUUID()` ID 생성
- JSON 직렬화: `condition_json`, `channels_json`, `delivery_results_json`
- `listEnabled()`에서 `expires_at` 필터링

```typescript
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  AlertStore,
  AlertDefinition,
  CreateAlertInput,
  AlertCondition,
  DeliveryChannel,
  ConditionEvaluation,
  DeliveryResult,
  AlertHistory,
} from './types.js';

// ─── Row 타입 ───
interface AlertRow {
  id: string;
  user_id: string;
  name: string;
  condition_type: string;
  condition_json: string;
  channels_json: string;
  cooldown_ms: number;
  enabled: number;
  trigger_count: number;
  last_triggered_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AlertHistoryRow {
  id: string;
  alert_id: string;
  triggered_at: number;
  condition_snapshot: string;
  delivery_results_json: string;
  current_value: string;
}

// ─── 헬퍼 ───
function rowToAlertDefinition(row: AlertRow): AlertDefinition {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    condition: JSON.parse(row.condition_json) as AlertCondition,
    channels: JSON.parse(row.channels_json) as DeliveryChannel[],
    cooldownMs: row.cooldown_ms,
    enabled: Boolean(row.enabled),
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAlertHistory(row: AlertHistoryRow): AlertHistory {
  return {
    id: row.id,
    alertId: row.alert_id,
    triggeredAt: row.triggered_at,
    conditionSnapshot: row.condition_snapshot,
    deliveryResults: JSON.parse(row.delivery_results_json) as DeliveryResult[],
    currentValue: row.current_value,
  };
}

// ─── Factory ───
export function createAlertStore(db: DatabaseSync): AlertStore {
  return {
    create(input) {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO alerts (id, user_id, name, condition_type, condition_json,
           channels_json, cooldown_ms, enabled, trigger_count, last_triggered_at,
           expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      ).run(
        id,
        input.userId,
        input.name,
        input.condition.type,
        JSON.stringify(input.condition),
        JSON.stringify(input.channels),
        input.cooldownMs ?? 900_000,
        (input.enabled ?? true) ? 1 : 0,
        input.expiresAt ?? null,
        now,
        now,
      );
      return this.getById(id)!;
    },

    getById(id) {
      const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as unknown as
        | AlertRow
        | undefined;
      return row ? rowToAlertDefinition(row) : null;
    },

    listByUser(userId) {
      const rows = db
        .prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId) as unknown as AlertRow[];
      return rows.map(rowToAlertDefinition);
    },

    listEnabled() {
      const now = Date.now();
      const rows = db
        .prepare(
          'SELECT * FROM alerts WHERE enabled = 1 AND (expires_at IS NULL OR expires_at > ?)',
        )
        .all(now) as unknown as AlertRow[];
      return rows.map(rowToAlertDefinition);
    },

    update(id, updates) {
      const existing = this.getById(id);
      if (!existing) return null;
      const now = Date.now();
      const merged = {
        name: updates.name ?? existing.name,
        condition: updates.condition ?? existing.condition,
        channels: updates.channels ?? existing.channels,
        cooldownMs: updates.cooldownMs ?? existing.cooldownMs,
        enabled: updates.enabled ?? existing.enabled,
        expiresAt: updates.expiresAt ?? existing.expiresAt,
      };
      db.prepare(
        `UPDATE alerts SET name = ?, condition_type = ?, condition_json = ?,
           channels_json = ?, cooldown_ms = ?, enabled = ?, expires_at = ?,
           updated_at = ? WHERE id = ?`,
      ).run(
        merged.name,
        merged.condition.type,
        JSON.stringify(merged.condition),
        JSON.stringify(merged.channels),
        merged.cooldownMs,
        merged.enabled ? 1 : 0,
        merged.expiresAt ?? null,
        now,
        id,
      );
      return this.getById(id);
    },

    delete(id) {
      const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    setEnabled(id, enabled) {
      db.prepare('UPDATE alerts SET enabled = ?, updated_at = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        Date.now(),
        id,
      );
    },

    recordTrigger(alertId, evaluation, results) {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO alert_history (id, alert_id, triggered_at, condition_snapshot,
           delivery_results_json, current_value) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        alertId,
        now,
        JSON.stringify(evaluation),
        JSON.stringify(results),
        evaluation.currentValue,
      );
      db.prepare(
        'UPDATE alerts SET trigger_count = trigger_count + 1, last_triggered_at = ?, updated_at = ? WHERE id = ?',
      ).run(now, now, alertId);
      return this.getHistory(alertId, 1)[0]!;
    },

    getHistory(alertId, limit) {
      const sql = limit
        ? 'SELECT * FROM alert_history WHERE alert_id = ? ORDER BY triggered_at DESC LIMIT ?'
        : 'SELECT * FROM alert_history WHERE alert_id = ? ORDER BY triggered_at DESC';
      const rows = (limit
        ? db.prepare(sql).all(alertId, limit)
        : db.prepare(sql).all(alertId)) as unknown as AlertHistoryRow[];
      return rows.map(rowToAlertHistory);
    },

    getLastTrigger(alertId) {
      const rows = this.getHistory(alertId, 1);
      return rows[0] ?? null;
    },
  };
}
```

### 3.2 `packages/skills-finance/src/alerts/market-service.ts` (NEW)

- [ ] 파일 생성

**핵심:** `MarketCache` + `ProviderRegistry` → 간단한 `AlertMarketService` 래핑

```typescript
import { createTickerSymbol } from '@finclaw/types';
import type { MarketCache } from '../market/cache.js';
import type { ProviderRegistry } from '../market/provider-registry.js';
import { normalizeQuote } from '../market/normalizer.js';
import type { AlertMarketService } from './types.js';

export function createAlertMarketService(deps: {
  cache: MarketCache;
  registry: ProviderRegistry;
}): AlertMarketService {
  return {
    async getQuote(ticker) {
      const symbol = createTickerSymbol(ticker);
      const provider = deps.registry.resolve(symbol);
      const quote = await deps.cache.getQuote(
        symbol as string,
        {
          id: provider.id,
          rateLimit: provider.rateLimit,
          getQuote: (s) => provider.getQuote(createTickerSymbol(s)),
        },
        (raw) => normalizeQuote(raw),
      );
      return { price: quote.price, changePercent: quote.changePercent, volume: quote.volume };
    },
  };
}
```

**검증:** `pnpm tsgo --noEmit`

---

## Step 4: 조건 평가기

### 4.1 `packages/skills-finance/src/alerts/conditions/price.ts` (NEW)

- [ ] 파일 생성
- [ ] `createPriceConditionEvaluator(marketService, circuitBreaker)` 팩토리
- [ ] `above`: `price >= threshold`, `below`: `price <= threshold`
- [ ] 한국어 메시지 포맷

```typescript
import type { CircuitBreaker } from '@finclaw/infra';
import type {
  AlertConditionEvaluator,
  AlertMarketService,
  ConditionEvaluation,
  PriceCondition,
} from '../types.js';

export function createPriceConditionEvaluator(
  marketService: AlertMarketService,
  circuitBreaker: CircuitBreaker,
): AlertConditionEvaluator<PriceCondition> {
  return {
    type: 'price',
    async evaluate(condition) {
      const quote = await circuitBreaker.execute(() => marketService.getQuote(condition.ticker));
      const { price } = quote;
      const triggered =
        condition.direction === 'above'
          ? price >= condition.threshold
          : price <= condition.threshold;
      const directionLabel = condition.direction === 'above' ? '이상' : '이하';
      return {
        triggered,
        currentValue: String(price),
        message: triggered
          ? `${condition.ticker} 현재가 ${price}이(가) 목표가 ${condition.threshold} ${directionLabel} 조건을 충족했습니다.`
          : `${condition.ticker} 현재가 ${price} (목표: ${condition.threshold} ${directionLabel})`,
      };
    },
  };
}
```

### 4.2 `packages/skills-finance/src/alerts/conditions/change.ts` (NEW)

- [ ] 파일 생성
- [ ] `up`: `changePercent >= thresholdPercent`
- [ ] `down`: `changePercent <= -thresholdPercent`
- [ ] `both`: `Math.abs(changePercent) >= thresholdPercent`

```typescript
import type { CircuitBreaker } from '@finclaw/infra';
import type {
  AlertConditionEvaluator,
  AlertMarketService,
  ChangeCondition,
  ConditionEvaluation,
} from '../types.js';

export function createChangeConditionEvaluator(
  marketService: AlertMarketService,
  circuitBreaker: CircuitBreaker,
): AlertConditionEvaluator<ChangeCondition> {
  return {
    type: 'change',
    async evaluate(condition) {
      const quote = await circuitBreaker.execute(() => marketService.getQuote(condition.ticker));
      const { changePercent } = quote;
      let triggered: boolean;
      switch (condition.direction) {
        case 'up':
          triggered = changePercent >= condition.thresholdPercent;
          break;
        case 'down':
          triggered = changePercent <= -condition.thresholdPercent;
          break;
        case 'both':
          triggered = Math.abs(changePercent) >= condition.thresholdPercent;
          break;
      }
      const directionLabel = { up: '상승', down: '하락', both: '변동' }[condition.direction];
      return {
        triggered,
        currentValue: `${changePercent.toFixed(2)}%`,
        message: triggered
          ? `${condition.ticker} ${directionLabel}률 ${changePercent.toFixed(2)}%이(가) 기준 ${condition.thresholdPercent}%를 충족했습니다.`
          : `${condition.ticker} 변동률 ${changePercent.toFixed(2)}% (기준: ±${condition.thresholdPercent}% ${directionLabel})`,
      };
    },
  };
}
```

### 4.3 `packages/skills-finance/src/alerts/conditions/volume.ts` (NEW)

- [ ] 파일 생성
- [ ] R5 — `avgVolume` 미제공이므로 항상 `triggered: false`
- [ ] `formatVolume` 헬퍼 (B/M/K 단위 변환)

```typescript
import type {
  AlertConditionEvaluator,
  AlertMarketService,
  ConditionEvaluation,
  VolumeCondition,
} from '../types.js';

export function createVolumeConditionEvaluator(
  marketService: AlertMarketService,
): AlertConditionEvaluator<VolumeCondition> {
  return {
    type: 'volume',
    async evaluate(condition) {
      const quote = await marketService.getQuote(condition.ticker);
      return {
        triggered: false,
        currentValue: formatVolume(quote.volume),
        message: `${condition.ticker} 현재 거래량 ${formatVolume(quote.volume)} — 평균 거래량 데이터 미지원으로 조건 평가 불가 (multiplier: ${condition.multiplier}x)`,
      };
    },
  };
}

function formatVolume(volume: number): string {
  if (volume >= 1_000_000_000) return `${(volume / 1_000_000_000).toFixed(1)}B`;
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`;
  return String(volume);
}
```

### 4.4 `packages/skills-finance/src/alerts/conditions/news.ts` (NEW)

- [ ] 파일 생성
- [ ] `NewsAggregator.fetchNews` 호출 (최근 1시간, limit: 10)
- [ ] `excludeKeywords` 필터링 (소문자 비교)
- [ ] `CircuitBreaker` 보호

```typescript
import type { CircuitBreaker } from '@finclaw/infra';
import type { TickerSymbol } from '@finclaw/types';
import type { NewsAggregator } from '../../news/types.js';
import type { AlertConditionEvaluator, ConditionEvaluation, NewsCondition } from '../types.js';

export function createNewsConditionEvaluator(
  newsAggregator: NewsAggregator,
  circuitBreaker: CircuitBreaker,
): AlertConditionEvaluator<NewsCondition> {
  return {
    type: 'news',
    async evaluate(condition) {
      const news = await circuitBreaker.execute(() =>
        newsAggregator.fetchNews({
          symbols: condition.symbols as TickerSymbol[] | undefined,
          keywords: condition.keywords as string[],
          limit: 10,
          fromDate: new Date(Date.now() - 3_600_000),
        }),
      );
      const filtered = condition.excludeKeywords?.length
        ? news.filter((item) => {
            const text = `${item.title} ${item.summary ?? ''}`.toLowerCase();
            return !condition.excludeKeywords!.some((kw) => text.includes(kw.toLowerCase()));
          })
        : news;
      const triggered = filtered.length > 0;
      return {
        triggered,
        currentValue: String(filtered.length),
        message: triggered
          ? `키워드 [${condition.keywords.join(', ')}] 관련 뉴스 ${filtered.length}건 발견: "${filtered[0]!.title}"`
          : `키워드 [${condition.keywords.join(', ')}] 관련 뉴스 없음 (최근 1시간)`,
      };
    },
  };
}
```

**검증:** `pnpm tsgo --noEmit`

---

## Step 5: 전달 디스패처

### 5.1 `packages/skills-finance/src/alerts/delivery.ts` (NEW)

- [ ] 파일 생성
- [ ] R6: `formatAlertMessage` 복원 (v1에서 누락)
- [ ] R2: `Promise.allSettled` 기반 병렬 전달 (plan 설명-코드 불일치 해소)
- [ ] R3: WebSocket payload에 `userId` 포함 (클라이언트 필터링용)
- [ ] Port 인터페이스로 외부 패키지 직접 import 회피 (`DiscordClientPort`, `BroadcasterPort`)

```typescript
import type { FinClawLogger } from '@finclaw/infra';
import type {
  AlertDefinition,
  ConditionEvaluation,
  DeliveryChannel,
  DeliveryResult,
} from './types.js';

// ─── Interfaces ───
export interface DeliveryHandler {
  readonly channel: DeliveryChannel;
  deliver(alert: AlertDefinition, evaluation: ConditionEvaluation): Promise<void>;
}

export interface DeliveryDispatcher {
  dispatch(alert: AlertDefinition, evaluation: ConditionEvaluation): Promise<DeliveryResult[]>;
}

// ─── R6: 메시지 포매터 ───
export function formatAlertMessage(
  alert: AlertDefinition,
  evaluation: ConditionEvaluation,
): string {
  return [
    `**[FinClaw Alert]** ${alert.name}`,
    '',
    evaluation.message,
    '',
    `현재값: ${evaluation.currentValue}`,
    `시각: ${new Date().toLocaleString('ko-KR')}`,
  ].join('\n');
}

// ─── Port Interfaces (외부 패키지 직접 import 회피) ───
export interface DiscordClientPort {
  users: {
    fetch(userId: string): Promise<{
      createDM(): Promise<{ send(content: string): Promise<unknown> }>;
    }>;
  };
}

export interface BroadcasterPort {
  broadcastToChannel(connections: Map<string, unknown>, channel: string, data: unknown): number;
}

// ─── Discord Delivery ───
export function createDiscordDeliveryHandler(deps: { client: DiscordClientPort }): DeliveryHandler {
  return {
    channel: 'discord',
    async deliver(alert, evaluation) {
      const user = await deps.client.users.fetch(alert.userId);
      const dmChannel = await user.createDM();
      await dmChannel.send(formatAlertMessage(alert, evaluation));
    },
  };
}

// ─── WebSocket Delivery ───
export function createWebSocketDeliveryHandler(deps: {
  broadcaster: BroadcasterPort;
  connections: Map<string, unknown>;
}): DeliveryHandler {
  return {
    channel: 'websocket',
    async deliver(alert, evaluation) {
      deps.broadcaster.broadcastToChannel(deps.connections, 'alerts', {
        type: 'alert.triggered',
        userId: alert.userId, // R3: 클라이언트 필터링용
        alertId: alert.id,
        name: alert.name,
        message: evaluation.message,
        currentValue: evaluation.currentValue,
        triggeredAt: Date.now(),
      });
    },
  };
}

// ─── Log Delivery ───
export function createLogDeliveryHandler(deps: { logger: FinClawLogger }): DeliveryHandler {
  return {
    channel: 'log',
    async deliver(alert, evaluation) {
      deps.logger.info('ALERT TRIGGERED', {
        alertId: alert.id,
        name: alert.name,
        message: evaluation.message,
        currentValue: evaluation.currentValue,
      });
    },
  };
}

// ─── R2: Promise.allSettled 기반 병렬 전달 ───
export function createDeliveryDispatcher(deps: {
  handlers: DeliveryHandler[];
  logger: FinClawLogger;
}): DeliveryDispatcher {
  const handlerMap = new Map(deps.handlers.map((h) => [h.channel, h]));
  return {
    async dispatch(alert, evaluation) {
      const tasks = alert.channels.map(async (channel) => {
        const handler = handlerMap.get(channel);
        if (!handler) throw new Error(`No handler for channel: ${channel}`);
        await handler.deliver(alert, evaluation);
        return channel;
      });
      const settled = await Promise.allSettled(tasks);
      return settled.map((result, i) => ({
        channel: alert.channels[i]!,
        success: result.status === 'fulfilled',
        error: result.status === 'rejected' ? String(result.reason) : undefined,
        deliveredAt: Date.now(),
      }));
    },
  };
}
```

**검증:** `pnpm tsgo --noEmit`

---

## Step 6: 모니터링 엔진

### 6.1 `packages/skills-finance/src/alerts/monitor.ts` (NEW)

- [ ] 파일 생성
- [ ] `setInterval` + `isChecking` 가드 — 체크 중 새 사이클 방지
- [ ] `ConcurrencyLane.acquire(alertId)` — per-alert 동시성 제어
- [ ] 쿨다운: `Date.now() - last.triggeredAt < alert.cooldownMs` 이면 스킵
- [ ] `cooldownMs === 0`: 항상 통과 (`cooldownMs > 0` 체크 추가)
- [ ] 개별 알림 실패 격리: `Promise.allSettled(alerts.map(checkSingleAlert))`
- [ ] `start()` 호출 시 `setInterval` + 즉시 `checkAlerts()` 1회 실행

```typescript
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
    if (isChecking) return;
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
    if (!handle) return;
    try {
      // 쿨다운 체크
      const last = deps.store.getLastTrigger(alert.id);
      if (last && alert.cooldownMs > 0 && Date.now() - last.triggeredAt < alert.cooldownMs) return;

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
      if (timer) return;
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
```

**검증:** `pnpm tsgo --noEmit`

---

## Step 7: 에이전트 도구 + 진입점

### 7.1 `packages/skills-finance/src/alerts/tools.ts` (NEW)

- [ ] 파일 생성
- [ ] 4개 개별 `registerXxxTool` 함수 (기존 패턴 준수)
- [ ] `buildConditionFromParams`: Zod v4 `discriminatedUnion` 검증
- [ ] R7: `expiresAt` 파라미터 포함
- [ ] `context.userId` 사용 (`params._userId` 해킹 아님)
- [ ] `remove_alert`: 다른 사용자 알림 삭제 거부

```typescript
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import { z } from 'zod/v4';
import type { AlertCondition, AlertStore } from './types.js';

// ─── Zod 스키마 ───
const PriceConditionSchema = z.object({
  type: z.literal('price'),
  ticker: z.string().min(1).max(10),
  direction: z.enum(['above', 'below']),
  threshold: z.number().positive(),
});
const ChangeConditionSchema = z.object({
  type: z.literal('change'),
  ticker: z.string().min(1).max(10),
  thresholdPercent: z.number().positive(),
  direction: z.enum(['up', 'down', 'both']).default('both'),
});
const VolumeConditionSchema = z.object({
  type: z.literal('volume'),
  ticker: z.string().min(1).max(10),
  multiplier: z.number().positive(),
});
const NewsConditionSchema = z.object({
  type: z.literal('news'),
  keywords: z.array(z.string()).min(1),
  symbols: z.array(z.string()).optional(),
  excludeKeywords: z.array(z.string()).optional(),
});
const AlertConditionSchema = z.discriminatedUnion('type', [
  PriceConditionSchema,
  ChangeConditionSchema,
  VolumeConditionSchema,
  NewsConditionSchema,
]);

export function buildConditionFromParams(input: Record<string, unknown>): AlertCondition {
  const result = AlertConditionSchema.safeParse(input.condition);
  if (!result.success) throw new Error(`조건 파라미터 오류: ${result.error.message}`);
  return result.data;
}

// ─── set_alert ───
export function registerSetAlertTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  const def: RegisteredToolDefinition = {
    name: 'set_alert',
    description: '금융 알림을 설정합니다. 가격, 변동률, 거래량, 뉴스 키워드 조건을 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '알림 이름' },
        condition: { type: 'object', description: '알림 조건 (type: price|change|volume|news)' },
        cooldownMs: { type: 'number', description: '쿨다운 밀리초 (기본 900000)' },
        expiresAt: { type: 'number', description: '만료 시각 (Unix ms, 선택)' },
      },
      required: ['name', 'condition'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: true,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 5_000,
  };
  const executor: ToolExecutor = async (input, context) => {
    try {
      const condition = buildConditionFromParams(input);
      const alert = deps.store.create({
        userId: context.userId,
        name: input.name as string,
        condition,
        channels: ['discord', 'websocket'],
        cooldownMs: (input.cooldownMs as number | undefined) ?? undefined,
        enabled: true,
        expiresAt: input.expiresAt as number | undefined,
      });
      return {
        content: JSON.stringify({
          alertId: alert.id,
          name: alert.name,
          condition: alert.condition,
        }),
        isError: false,
      };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

// ─── list_alerts ───
export function registerListAlertsTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  const def: RegisteredToolDefinition = {
    name: 'list_alerts',
    description: '현재 사용자의 알림 목록을 조회합니다.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 5_000,
  };
  const executor: ToolExecutor = async (_input, context) => {
    try {
      const alerts = deps.store.listByUser(context.userId);
      return { content: JSON.stringify(alerts), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

// ─── remove_alert ───
export function registerRemoveAlertTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  const def: RegisteredToolDefinition = {
    name: 'remove_alert',
    description: '알림을 삭제합니다.',
    inputSchema: {
      type: 'object',
      properties: { alertId: { type: 'string', description: '삭제할 알림 ID' } },
      required: ['alertId'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: true,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 5_000,
  };
  const executor: ToolExecutor = async (input, context) => {
    try {
      const alertId = input.alertId as string;
      const alert = deps.store.getById(alertId);
      if (!alert) return { content: `알림을 찾을 수 없습니다: ${alertId}`, isError: true };
      if (alert.userId !== context.userId)
        return { content: '다른 사용자의 알림은 삭제할 수 없습니다.', isError: true };
      deps.store.delete(alertId);
      return { content: JSON.stringify({ deleted: true, alertId }), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

// ─── get_alert_history ───
export function registerGetAlertHistoryTool(
  registry: ToolRegistry,
  deps: { store: AlertStore },
): void {
  const def: RegisteredToolDefinition = {
    name: 'get_alert_history',
    description: '알림 트리거 이력을 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        alertId: { type: 'string', description: '알림 ID' },
        limit: { type: 'number', description: '반환할 이력 수 (기본 10)' },
      },
      required: ['alertId'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 5_000,
  };
  const executor: ToolExecutor = async (input, context) => {
    try {
      const alertId = input.alertId as string;
      const alert = deps.store.getById(alertId);
      if (!alert) return { content: `알림을 찾을 수 없습니다: ${alertId}`, isError: true };
      if (alert.userId !== context.userId)
        return { content: '다른 사용자의 알림 이력은 조회할 수 없습니다.', isError: true };
      const limit = (input.limit as number | undefined) ?? 10;
      const history = deps.store.getHistory(alertId, limit);
      return { content: JSON.stringify(history), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}
```

### 7.2 `packages/skills-finance/src/alerts/index.ts` (NEW)

- [ ] 파일 생성
- [ ] `registerAlertTools(toolRegistry, config)` — news/index.ts 패턴
- [ ] 평가기 4종 조립 + `satisfies Record<AlertConditionType, ...>` 타입 안전성
- [ ] 전달 핸들러 조건부 등록 (discordClient, broadcaster 옵션)
- [ ] `ConcurrencyLane` + `AlertMonitorConfig` 조립
- [ ] `monitor.start()` 호출 + `AlertMonitor` 반환
- [ ] `ALERT_SKILL_METADATA` 상수 export

```typescript
import type { ToolRegistry } from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';
import { ConcurrencyLane, createCircuitBreaker } from '@finclaw/infra';
import type { DatabaseSync } from 'node:sqlite';
import type { MarketCache } from '../market/cache.js';
import type { ProviderRegistry } from '../market/provider-registry.js';
import type { NewsAggregator } from '../news/types.js';
import { createPriceConditionEvaluator } from './conditions/price.js';
import { createChangeConditionEvaluator } from './conditions/change.js';
import { createVolumeConditionEvaluator } from './conditions/volume.js';
import { createNewsConditionEvaluator } from './conditions/news.js';
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

export type { AlertStore } from './types.js';
export { createAlertStore } from './store.js';

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
): Promise<AlertMonitor> {
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
  if (config.discordClient)
    handlers.push(createDiscordDeliveryHandler({ client: config.discordClient }));
  if (config.broadcaster && config.connections)
    handlers.push(
      createWebSocketDeliveryHandler({
        broadcaster: config.broadcaster,
        connections: config.connections,
      }),
    );

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
  return monitor;
}

export const ALERT_SKILL_METADATA = {
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
  tools: ['set_alert', 'list_alerts', 'remove_alert', 'get_alert_history'],
} as const;
```

### 7.3 `packages/skills-finance/src/index.ts` (MODIFY)

- [ ] alert export 추가

기존 export 뒤에 추가:

```typescript
export { registerAlertTools, ALERT_SKILL_METADATA } from './alerts/index.js';
export type { AlertSkillConfig } from './alerts/index.js';
```

**검증:** `pnpm tsgo --noEmit`

---

## Step 8: Discord 커맨드 완성

### 8.1 `packages/channel-discord/src/commands/alert.ts` (MODIFY)

- [ ] `case 'set'` 블록의 TODO 완성 — `deps.alertStorage.createAlert()` 호출

**기존 (L49-58):**

```typescript
case 'set': {
  const ticker = interaction.options.getString('ticker', true);
  const condition = interaction.options.getString('condition', true);
  const value = interaction.options.getNumber('value', true);
  // TODO: createAlert 호출
  await interaction.reply({
    content: `알림 설정 완료: ${ticker} ${condition} ${value}`,
    flags: MessageFlags.Ephemeral,
  });
  break;
}
```

**교체:**

```typescript
case 'set': {
  const ticker = interaction.options.getString('ticker', true);
  const condition = interaction.options.getString('condition', true);
  const value = interaction.options.getNumber('value', true);

  const alert = await deps.alertStorage.createAlert({
    name: `${ticker} ${condition} ${value}`,
    symbol: ticker as import('@finclaw/types').TickerSymbol,
    condition: {
      type: condition as import('@finclaw/types').AlertConditionType,
      value,
    },
    enabled: true,
    triggerCount: 0,
    cooldownMs: 900_000,
    createdAt: Date.now() as import('@finclaw/types').Timestamp,
  });

  await interaction.reply({
    content: `알림 설정 완료: ${alert.name} (ID: ${alert.id})`,
    flags: MessageFlags.Ephemeral,
  });
  break;
}
```

**참고:** `AlertStoragePort.createAlert`는 `@finclaw/types`의 기존 `Alert` 타입을 사용하므로, `condition.type`은 `'above' | 'below' | 'change_percent'` 등 기존 v2 조건 타입이다. Phase 18의 새 조건 타입('price' | 'change' | 'volume' | 'news')과는 별도 레이어.

**검증:** `pnpm tsgo --noEmit` for `@finclaw/channel-discord`

---

## Step 9: 테스트

### 9.1 `packages/skills-finance/src/alerts/__tests__/store.test.ts` (NEW)

- [ ] 파일 생성

**주의:** vitest 설정이 `**/*.storage.test.ts`를 제외하므로 `store.test.ts`로 명명.

**핵심:** `:memory:` DB에 v3 스키마 직접 생성, 전체 CRUD + history 검증

테스트 항목:

- `create + getById`: 기본값(cooldownMs=900000, enabled=true), 커스텀 값
- `listByUser`: 사용자별 필터링
- `listEnabled`: disabled 제외, 만료 제외, 미만료 포함
- `update`: 이름/조건 변경, 존재하지 않는 ID → null
- `delete`: 성공 시 true, 존재하지 않는 ID → false
- `recordTrigger + getHistory + getLastTrigger`: 이력 기록/조회, trigger_count 증가

```typescript
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach } from 'vitest';
import { createAlertStore } from '../store.js';
import type { AlertStore, CreateAlertInput, PriceCondition } from '../types.js';

// v3 스키마 DDL (database.ts의 SCHEMA_DDL에서 alerts + alert_history만 추출)
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  condition_type    TEXT NOT NULL CHECK(
    condition_type IN ('price', 'change', 'volume', 'news')
  ),
  condition_json    TEXT NOT NULL,
  channels_json     TEXT NOT NULL DEFAULT '["discord","websocket"]',
  cooldown_ms       INTEGER NOT NULL DEFAULT 900000,
  enabled           INTEGER NOT NULL DEFAULT 1,
  trigger_count     INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  expires_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_history (
  id                    TEXT PRIMARY KEY,
  alert_id              TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  triggered_at          INTEGER NOT NULL,
  condition_snapshot    TEXT NOT NULL,
  delivery_results_json TEXT NOT NULL DEFAULT '[]',
  current_value         TEXT NOT NULL
);
`;

function createTestInput(overrides?: Partial<CreateAlertInput>): CreateAlertInput {
  return {
    userId: 'user-1',
    name: 'AAPL 가격 알림',
    condition: {
      type: 'price',
      ticker: 'AAPL',
      direction: 'above',
      threshold: 200,
    } satisfies PriceCondition,
    channels: ['discord', 'websocket'],
    ...overrides,
  };
}

describe('AlertStore', () => {
  let db: DatabaseSync;
  let store: AlertStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_DDL);
    store = createAlertStore(db);
  });

  describe('create + getById', () => {
    it('기본값으로 알림을 생성한다 (cooldownMs=900000, enabled=true)', () => {
      const alert = store.create(createTestInput());
      expect(alert.id).toBeTruthy();
      expect(alert.userId).toBe('user-1');
      expect(alert.name).toBe('AAPL 가격 알림');
      expect(alert.cooldownMs).toBe(900_000);
      expect(alert.enabled).toBe(true);
      expect(alert.condition.type).toBe('price');
    });

    it('커스텀 값으로 알림을 생성한다', () => {
      const alert = store.create(
        createTestInput({
          cooldownMs: 60_000,
          enabled: false,
          expiresAt: Date.now() + 86_400_000,
        }),
      );
      expect(alert.cooldownMs).toBe(60_000);
      expect(alert.enabled).toBe(false);
      expect(alert.expiresAt).toBeTruthy();
    });

    it('getById — 존재하지 않는 ID는 null 반환', () => {
      expect(store.getById('nonexistent')).toBeNull();
    });
  });

  describe('listByUser', () => {
    it('사용자별 필터링', () => {
      store.create(createTestInput({ userId: 'user-1' }));
      store.create(createTestInput({ userId: 'user-1' }));
      store.create(createTestInput({ userId: 'user-2' }));
      expect(store.listByUser('user-1')).toHaveLength(2);
      expect(store.listByUser('user-2')).toHaveLength(1);
      expect(store.listByUser('user-3')).toHaveLength(0);
    });
  });

  describe('listEnabled', () => {
    it('disabled 알림 제외', () => {
      store.create(createTestInput());
      store.create(createTestInput({ enabled: false }));
      expect(store.listEnabled()).toHaveLength(1);
    });

    it('만료된 알림 제외', () => {
      store.create(createTestInput({ expiresAt: Date.now() - 1000 }));
      expect(store.listEnabled()).toHaveLength(0);
    });

    it('미만료 알림 포함', () => {
      store.create(createTestInput({ expiresAt: Date.now() + 86_400_000 }));
      expect(store.listEnabled()).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('이름/조건 변경', () => {
      const alert = store.create(createTestInput());
      const updated = store.update(alert.id, {
        name: '변경된 이름',
        condition: { type: 'price', ticker: 'TSLA', direction: 'below', threshold: 100 },
      });
      expect(updated!.name).toBe('변경된 이름');
      expect((updated!.condition as PriceCondition).ticker).toBe('TSLA');
    });

    it('존재하지 않는 ID → null', () => {
      expect(store.update('nonexistent', { name: 'x' })).toBeNull();
    });
  });

  describe('delete', () => {
    it('성공 시 true', () => {
      const alert = store.create(createTestInput());
      expect(store.delete(alert.id)).toBe(true);
      expect(store.getById(alert.id)).toBeNull();
    });

    it('존재하지 않는 ID → false', () => {
      expect(store.delete('nonexistent')).toBe(false);
    });
  });

  describe('recordTrigger + getHistory + getLastTrigger', () => {
    it('이력 기록/조회, trigger_count 증가', () => {
      const alert = store.create(createTestInput());
      const evaluation = { triggered: true, currentValue: '205', message: '조건 충족' };
      const deliveryResults = [{ channel: 'log' as const, success: true, deliveredAt: Date.now() }];

      const history = store.recordTrigger(alert.id, evaluation, deliveryResults);
      expect(history.alertId).toBe(alert.id);
      expect(history.currentValue).toBe('205');

      const lastTrigger = store.getLastTrigger(alert.id);
      expect(lastTrigger).toBeTruthy();
      expect(lastTrigger!.alertId).toBe(alert.id);

      const allHistory = store.getHistory(alert.id);
      expect(allHistory).toHaveLength(1);

      // trigger_count 증가 확인 (DB 직접 조회)
      const row = db
        .prepare('SELECT trigger_count FROM alerts WHERE id = ?')
        .get(alert.id) as unknown as { trigger_count: number };
      expect(row.trigger_count).toBe(1);
    });
  });
});
```

### 9.2 `packages/skills-finance/src/alerts/__tests__/conditions.test.ts` (NEW)

- [ ] 파일 생성

테스트 항목:

- **Price**: above/below 방향, 경계값(price === threshold → triggered)
- **Change**: up/down/both 방향, 음수 changePercent 처리
- **Volume**: 항상 triggered:false, 메시지에 "미지원" 포함
- **News**: 뉴스 있을 때 triggered, 없을 때 false, excludeKeywords 필터링

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createPriceConditionEvaluator } from '../conditions/price.js';
import { createChangeConditionEvaluator } from '../conditions/change.js';
import { createVolumeConditionEvaluator } from '../conditions/volume.js';
import { createNewsConditionEvaluator } from '../conditions/news.js';
import type {
  AlertMarketService,
  PriceCondition,
  ChangeCondition,
  VolumeCondition,
  NewsCondition,
} from '../types.js';
import type { NewsAggregator } from '../../news/types.js';
import type { CircuitBreaker } from '@finclaw/infra';

function mockMarketService(quote: {
  price: number;
  changePercent: number;
  volume: number;
}): AlertMarketService {
  return { getQuote: vi.fn().mockResolvedValue(quote) };
}

function passThroughCB(): CircuitBreaker {
  return { execute: (fn: () => Promise<unknown>) => fn() } as unknown as CircuitBreaker;
}

describe('PriceConditionEvaluator', () => {
  const condition: PriceCondition = {
    type: 'price',
    ticker: 'AAPL',
    direction: 'above',
    threshold: 200,
  };

  it('above — price >= threshold → triggered', async () => {
    const evaluator = createPriceConditionEvaluator(
      mockMarketService({ price: 210, changePercent: 1, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(true);
  });

  it('above — price < threshold → not triggered', async () => {
    const evaluator = createPriceConditionEvaluator(
      mockMarketService({ price: 190, changePercent: 1, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(false);
  });

  it('above — 경계값 (price === threshold) → triggered', async () => {
    const evaluator = createPriceConditionEvaluator(
      mockMarketService({ price: 200, changePercent: 1, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(true);
  });

  it('below — price <= threshold → triggered', async () => {
    const belowCondition: PriceCondition = { ...condition, direction: 'below' };
    const evaluator = createPriceConditionEvaluator(
      mockMarketService({ price: 190, changePercent: 1, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(belowCondition);
    expect(result.triggered).toBe(true);
  });
});

describe('ChangeConditionEvaluator', () => {
  const condition: ChangeCondition = {
    type: 'change',
    ticker: 'AAPL',
    thresholdPercent: 5,
    direction: 'up',
  };

  it('up — changePercent >= thresholdPercent → triggered', async () => {
    const evaluator = createChangeConditionEvaluator(
      mockMarketService({ price: 200, changePercent: 6, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(true);
  });

  it('down — 음수 changePercent 처리', async () => {
    const downCondition: ChangeCondition = { ...condition, direction: 'down' };
    const evaluator = createChangeConditionEvaluator(
      mockMarketService({ price: 200, changePercent: -6, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(downCondition);
    expect(result.triggered).toBe(true);
  });

  it('both — 절대값 기준', async () => {
    const bothCondition: ChangeCondition = { ...condition, direction: 'both' };
    const evaluator = createChangeConditionEvaluator(
      mockMarketService({ price: 200, changePercent: -5, volume: 1000 }),
      passThroughCB(),
    );
    const result = await evaluator.evaluate(bothCondition);
    expect(result.triggered).toBe(true);
  });
});

describe('VolumeConditionEvaluator', () => {
  const condition: VolumeCondition = { type: 'volume', ticker: 'AAPL', multiplier: 2 };

  it('항상 triggered:false, 메시지에 "미지원" 포함', async () => {
    const evaluator = createVolumeConditionEvaluator(
      mockMarketService({ price: 200, changePercent: 1, volume: 5_000_000 }),
    );
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(false);
    expect(result.message).toContain('미지원');
  });
});

describe('NewsConditionEvaluator', () => {
  const condition: NewsCondition = { type: 'news', keywords: ['실적', '배당'] };

  it('뉴스 있을 때 triggered', async () => {
    const aggregator: NewsAggregator = {
      fetchNews: vi.fn().mockResolvedValue([
        {
          title: '삼성전자 실적 발표',
          source: 'test',
          url: 'http://test.com',
          publishedAt: new Date(),
        },
      ]),
    };
    const evaluator = createNewsConditionEvaluator(aggregator, passThroughCB());
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(true);
    expect(result.currentValue).toBe('1');
  });

  it('뉴스 없을 때 false', async () => {
    const aggregator: NewsAggregator = { fetchNews: vi.fn().mockResolvedValue([]) };
    const evaluator = createNewsConditionEvaluator(aggregator, passThroughCB());
    const result = await evaluator.evaluate(condition);
    expect(result.triggered).toBe(false);
  });

  it('excludeKeywords 필터링', async () => {
    const conditionWithExclude: NewsCondition = { ...condition, excludeKeywords: ['실적'] };
    const aggregator: NewsAggregator = {
      fetchNews: vi.fn().mockResolvedValue([
        {
          title: '삼성전자 실적 발표',
          source: 'test',
          url: 'http://test.com',
          publishedAt: new Date(),
        },
      ]),
    };
    const evaluator = createNewsConditionEvaluator(aggregator, passThroughCB());
    const result = await evaluator.evaluate(conditionWithExclude);
    expect(result.triggered).toBe(false);
  });
});
```

### 9.3 `packages/skills-finance/src/alerts/__tests__/monitor.test.ts` (NEW)

- [ ] 파일 생성
- [ ] `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` 패턴

테스트 항목:

- `start()` 시 즉시 `checkAlerts` 호출 + 30초 후 재호출
- `isChecking` 가드: 체크 중 새 사이클 방지 (암묵적 — 두 번째 호출 시 listEnabled 1회만)
- 쿨다운: 최근 트리거된 알림 스킵
- `cooldownMs=0`: 항상 통과
- 개별 알림 실패가 전체 사이클 중단 안 함

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAlertMonitor } from '../monitor.js';
import type {
  AlertConditionEvaluator,
  AlertConditionType,
  AlertDefinition,
  AlertMonitorConfig,
  AlertStore,
} from '../types.js';
import type { DeliveryDispatcher } from '../delivery.js';
import type { FinClawLogger, ConcurrencyLane, LaneHandle } from '@finclaw/infra';

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
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });
});
```

### 9.4 `packages/skills-finance/src/alerts/__tests__/delivery.test.ts` (NEW)

- [ ] 파일 생성

테스트 항목:

- `formatAlertMessage`: 이름, 메시지, 현재값 포함
- Discord: `user.createDM()` → `send()` 호출 확인
- WebSocket: `broadcastToChannel('alerts', ...)` 호출, `userId` 포함 (R3)
- Log: `logger.info('ALERT TRIGGERED', ...)` 호출
- DeliveryDispatcher: 전체 성공, 부분 실패 격리

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  formatAlertMessage,
  createDiscordDeliveryHandler,
  createWebSocketDeliveryHandler,
  createLogDeliveryHandler,
  createDeliveryDispatcher,
} from '../delivery.js';
import type { AlertDefinition, ConditionEvaluation } from '../types.js';
import type { FinClawLogger } from '@finclaw/infra';

function mockAlert(overrides?: Partial<AlertDefinition>): AlertDefinition {
  return {
    id: 'alert-1',
    userId: 'user-1',
    name: 'AAPL 가격 알림',
    condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
    channels: ['log'],
    cooldownMs: 900_000,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

const mockEvaluation: ConditionEvaluation = {
  triggered: true,
  currentValue: '210',
  message: 'AAPL 현재가 210이(가) 목표가 200 이상 조건을 충족했습니다.',
};

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

describe('formatAlertMessage', () => {
  it('이름, 메시지, 현재값 포함', () => {
    const msg = formatAlertMessage(mockAlert(), mockEvaluation);
    expect(msg).toContain('AAPL 가격 알림');
    expect(msg).toContain(mockEvaluation.message);
    expect(msg).toContain('210');
  });
});

describe('DiscordDeliveryHandler', () => {
  it('user.createDM() → send() 호출', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const createDM = vi.fn().mockResolvedValue({ send });
    const fetch = vi.fn().mockResolvedValue({ createDM });
    const handler = createDiscordDeliveryHandler({ client: { users: { fetch } } });
    await handler.deliver(mockAlert(), mockEvaluation);
    expect(fetch).toHaveBeenCalledWith('user-1');
    expect(createDM).toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
  });
});

describe('WebSocketDeliveryHandler', () => {
  it('broadcastToChannel 호출, userId 포함', async () => {
    const broadcastToChannel = vi.fn().mockReturnValue(1);
    const connections = new Map();
    const handler = createWebSocketDeliveryHandler({
      broadcaster: { broadcastToChannel },
      connections,
    });
    await handler.deliver(mockAlert(), mockEvaluation);
    expect(broadcastToChannel).toHaveBeenCalledWith(
      connections,
      'alerts',
      expect.objectContaining({
        type: 'alert.triggered',
        userId: 'user-1',
        alertId: 'alert-1',
      }),
    );
  });
});

describe('LogDeliveryHandler', () => {
  it('logger.info(ALERT TRIGGERED, ...) 호출', async () => {
    const logger = mockLogger();
    const handler = createLogDeliveryHandler({ logger });
    await handler.deliver(mockAlert(), mockEvaluation);
    expect(logger.info).toHaveBeenCalledWith(
      'ALERT TRIGGERED',
      expect.objectContaining({
        alertId: 'alert-1',
        name: 'AAPL 가격 알림',
      }),
    );
  });
});

describe('DeliveryDispatcher', () => {
  it('전체 성공', async () => {
    const logger = mockLogger();
    const handler = { channel: 'log' as const, deliver: vi.fn().mockResolvedValue(undefined) };
    const dispatcher = createDeliveryDispatcher({ handlers: [handler], logger });
    const results = await dispatcher.dispatch(mockAlert({ channels: ['log'] }), mockEvaluation);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.channel).toBe('log');
  });

  it('부분 실패 격리', async () => {
    const logger = mockLogger();
    const failHandler = {
      channel: 'discord' as const,
      deliver: vi.fn().mockRejectedValue(new Error('fail')),
    };
    const okHandler = { channel: 'log' as const, deliver: vi.fn().mockResolvedValue(undefined) };
    const dispatcher = createDeliveryDispatcher({ handlers: [failHandler, okHandler], logger });
    const results = await dispatcher.dispatch(
      mockAlert({ channels: ['discord', 'log'] }),
      mockEvaluation,
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain('fail');
    expect(results[1]!.success).toBe(true);
  });
});
```

### 9.5 `packages/skills-finance/src/alerts/__tests__/tools.test.ts` (NEW)

- [ ] 파일 생성

테스트 항목:

- `buildConditionFromParams`: 4가지 유효 타입 파싱, 무효 입력 throw
- `registerSetAlertTool`: `context.userId` 사용 확인
- `registerRemoveAlertTool`: 다른 사용자 알림 삭제 거부

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildConditionFromParams } from '../tools.js';
import type { AlertStore, CreateAlertInput } from '../types.js';

describe('buildConditionFromParams', () => {
  it('price 조건 파싱', () => {
    const result = buildConditionFromParams({
      condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
    });
    expect(result).toEqual({ type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 });
  });

  it('change 조건 파싱 (default direction)', () => {
    const result = buildConditionFromParams({
      condition: { type: 'change', ticker: 'AAPL', thresholdPercent: 5 },
    });
    expect(result).toEqual({
      type: 'change',
      ticker: 'AAPL',
      thresholdPercent: 5,
      direction: 'both',
    });
  });

  it('volume 조건 파싱', () => {
    const result = buildConditionFromParams({
      condition: { type: 'volume', ticker: 'AAPL', multiplier: 2 },
    });
    expect(result).toEqual({ type: 'volume', ticker: 'AAPL', multiplier: 2 });
  });

  it('news 조건 파싱', () => {
    const result = buildConditionFromParams({
      condition: { type: 'news', keywords: ['실적'] },
    });
    expect(result).toEqual({ type: 'news', keywords: ['실적'] });
  });

  it('무효 입력 throw', () => {
    expect(() => buildConditionFromParams({ condition: { type: 'invalid' } })).toThrow();
    expect(() => buildConditionFromParams({ condition: {} })).toThrow();
    expect(() => buildConditionFromParams({})).toThrow();
  });
});

describe('registerSetAlertTool — context.userId', () => {
  it('context.userId를 사용하여 알림 생성', async () => {
    const { registerSetAlertTool } = await import('../tools.js');

    let capturedExecutor:
      | ((
          input: Record<string, unknown>,
          context: {
            userId: string;
            sessionId: string;
            channelId: string;
            abortSignal: AbortSignal;
          },
        ) => Promise<{ content: string; isError: boolean }>)
      | null = null;
    const mockRegistry = {
      register: vi.fn().mockImplementation((_def: unknown, executor: typeof capturedExecutor) => {
        capturedExecutor = executor;
      }),
    };

    const mockStore: Partial<AlertStore> = {
      create: vi.fn().mockImplementation((input: CreateAlertInput) => ({
        id: 'new-id',
        ...input,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cooldownMs: input.cooldownMs ?? 900_000,
        enabled: input.enabled ?? true,
      })),
    };

    registerSetAlertTool(mockRegistry as never, { store: mockStore as AlertStore });
    expect(capturedExecutor).toBeTruthy();

    const result = await capturedExecutor!(
      {
        name: 'Test',
        condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
      },
      {
        userId: 'test-user',
        sessionId: 's',
        channelId: 'c',
        abortSignal: new AbortController().signal,
      },
    );

    expect(result.isError).toBe(false);
    expect(mockStore.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'test-user' }));
  });
});

describe('registerRemoveAlertTool — 다른 사용자 알림 삭제 거부', () => {
  it('다른 사용자의 알림은 삭제 불가', async () => {
    const { registerRemoveAlertTool } = await import('../tools.js');

    let capturedExecutor:
      | ((
          input: Record<string, unknown>,
          context: {
            userId: string;
            sessionId: string;
            channelId: string;
            abortSignal: AbortSignal;
          },
        ) => Promise<{ content: string; isError: boolean }>)
      | null = null;
    const mockRegistry = {
      register: vi.fn().mockImplementation((_def: unknown, executor: typeof capturedExecutor) => {
        capturedExecutor = executor;
      }),
    };

    const mockStore: Partial<AlertStore> = {
      getById: vi.fn().mockReturnValue({
        id: 'alert-1',
        userId: 'other-user',
        name: 'Test',
        condition: { type: 'price', ticker: 'AAPL', direction: 'above', threshold: 200 },
        channels: ['log'],
        cooldownMs: 900_000,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      delete: vi.fn(),
    };

    registerRemoveAlertTool(mockRegistry as never, { store: mockStore as AlertStore });
    expect(capturedExecutor).toBeTruthy();

    const result = await capturedExecutor!(
      { alertId: 'alert-1' },
      {
        userId: 'my-user',
        sessionId: 's',
        channelId: 'c',
        abortSignal: new AbortController().signal,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('다른 사용자');
    expect(mockStore.delete).not.toHaveBeenCalled();
  });
});
```

---

## 검증 명령 (순차)

```bash
# Step 1 후
pnpm tsgo --noEmit

# Step 2 후 (storage test 기대값 갱신 포함)
pnpm vitest run packages/storage/

# Step 3 후
pnpm tsgo --noEmit

# Step 4 후
pnpm vitest run packages/skills-finance/src/alerts/__tests__/conditions.test.ts

# Step 5 후
pnpm vitest run packages/skills-finance/src/alerts/__tests__/delivery.test.ts

# Step 6 후
pnpm vitest run packages/skills-finance/src/alerts/__tests__/monitor.test.ts

# Step 7 후
pnpm vitest run packages/skills-finance/src/alerts/__tests__/tools.test.ts

# Step 9 전체
pnpm vitest run packages/skills-finance/src/alerts/__tests__/store.test.ts

# 최종 전체 검증
pnpm tsgo --noEmit
pnpm vitest run packages/skills-finance/src/alerts/
pnpm vitest run packages/storage/
```

---

## 파일 목록 (20개)

| #   | 파일                                                              | 액션   | Step |
| --- | ----------------------------------------------------------------- | ------ | ---- |
| 1   | `packages/skills-finance/src/alerts/types.ts`                     | NEW    | 1    |
| 2   | `packages/storage/src/database.ts`                                | MODIFY | 2    |
| 3   | `packages/storage/src/database.test.ts`                           | MODIFY | 2    |
| 4   | `packages/skills-finance/src/alerts/store.ts`                     | NEW    | 3    |
| 5   | `packages/skills-finance/src/alerts/market-service.ts`            | NEW    | 3    |
| 6   | `packages/skills-finance/src/alerts/conditions/price.ts`          | NEW    | 4    |
| 7   | `packages/skills-finance/src/alerts/conditions/change.ts`         | NEW    | 4    |
| 8   | `packages/skills-finance/src/alerts/conditions/volume.ts`         | NEW    | 4    |
| 9   | `packages/skills-finance/src/alerts/conditions/news.ts`           | NEW    | 4    |
| 10  | `packages/skills-finance/src/alerts/delivery.ts`                  | NEW    | 5    |
| 11  | `packages/skills-finance/src/alerts/monitor.ts`                   | NEW    | 6    |
| 12  | `packages/skills-finance/src/alerts/tools.ts`                     | NEW    | 7    |
| 13  | `packages/skills-finance/src/alerts/index.ts`                     | NEW    | 7    |
| 14  | `packages/skills-finance/src/index.ts`                            | MODIFY | 7    |
| 15  | `packages/channel-discord/src/commands/alert.ts`                  | MODIFY | 8    |
| 16  | `packages/skills-finance/src/alerts/__tests__/store.test.ts`      | NEW    | 9    |
| 17  | `packages/skills-finance/src/alerts/__tests__/conditions.test.ts` | NEW    | 9    |
| 18  | `packages/skills-finance/src/alerts/__tests__/monitor.test.ts`    | NEW    | 9    |
| 19  | `packages/skills-finance/src/alerts/__tests__/delivery.test.ts`   | NEW    | 9    |
| 20  | `packages/skills-finance/src/alerts/__tests__/tools.test.ts`      | NEW    | 9    |

**의도적 미수정:** `packages/storage/src/tables/alerts.ts` — R4 Option B에 따라 기존 v2 CRUD 유지, 새 v3 CRUD는 store.ts에서 직접 구현.

---

## plan.md 대비 변경점

| 항목                                       | plan.md                              | todo.md (구현 반영)           | 사유                                      |
| ------------------------------------------ | ------------------------------------ | ----------------------------- | ----------------------------------------- |
| store 테스트 파일명                        | `store.storage.test.ts`              | `store.test.ts`               | vitest 설정이 `**/*.storage.test.ts` 제외 |
| `storage/src/tables/alerts.ts` 수정        | M2 수정 예정                         | 미수정                        | R4 Option B: store.ts에서 DB 직접 접근    |
| `storage/src/tables/alert-history.ts` 신규 | 파일 #12 신규                        | 미생성                        | store.ts에서 alert_history CRUD 직접 구현 |
| 전달 디스패처                              | §6.7 순차 for-of                     | Promise.allSettled 병렬       | R2 반영                                   |
| WebSocket payload                          | userId 미포함                        | userId 포함                   | R3 반영                                   |
| formatAlertMessage                         | §6.7 미정의                          | delivery.ts에 포함            | R6 반영                                   |
| set_alert expiresAt                        | inputSchema 누락                     | inputSchema에 포함            | R7 반영                                   |
| CreateAlertInput Omit                      | `'id' \| 'createdAt' \| 'updatedAt'` | `+ 'enabled' \| 'cooldownMs'` | R1 반영                                   |
