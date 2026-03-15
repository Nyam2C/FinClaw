# Phase 18: 금융 스킬 -- 알림 시스템

## 1. 목표

금융 이벤트에 대한 조건부 알림(Alert) 시스템을 구현한다.

1. **다양한 알림 조건**: 가격 임계값(price threshold), 퍼센트 변동(% change), 거래량 급증(volume spike), 뉴스 키워드 매칭(news alert) 4가지 조건 타입 지원.
2. **영속적 알림 저장**: 기존 `database.ts`의 마이그레이션 시스템(MIGRATIONS[3])으로 `alerts` 테이블 재생성 + `alert_history` 테이블 신규 생성. `packages/storage` 패키지 CRUD 확장.
3. **주기적 조건 모니터링**: `setInterval` + `isChecking` 가드 기반 주기적 체크(기본 30초). `ConcurrencyLane`(infra 패키지)으로 동시성 제어.
4. **멀티 채널 알림 전달**: Discord DM(`user.createDM()`), Gateway WebSocket(`broadcaster.broadcastToChannel(connections, 'alerts', data)`), 로그 폴백 3단계.
5. **알림 이력 및 쿨다운**: `alert_history` 테이블 기반 이력 추적, `cooldownMs`(밀리초) 단위 반복 발송 방지 (기본 900,000ms = 15분).
6. **에이전트 도구 등록**: `registerSetAlertTool`, `registerListAlertsTool`, `registerRemoveAlertTool`, `registerGetAlertHistoryTool` — 개별 함수 4개.

---

## 2. OpenClaw 참조

| 참조 문서       | 경로                                                    | 적용 패턴                                                   |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| 크론/훅 시스템  | `openclaw_review/docs/13.데몬-크론-훅-프로세스-보안.md` | interval 기반 작업 실행, `state.running` 가드 (중복 방지)   |
| 크론 Deep Dive  | `openclaw_review/deep-dive/13-daemon-cron-hooks.md`     | 에러 격리 (핸들러별 try-catch), `MAX_TIMEOUT_MS` 클램핑     |
| 스킬 시스템     | `openclaw_review/docs/20.스킬-빌드-배포-인프라.md`      | 스킬 메타데이터 스키마, `group`/`source: 'skill'` 도구 등록 |
| 메모리/스토리지 | `openclaw_review/deep-dive/14-memory-media-utils.md`    | SQLite 테이블 설계, `rowToX()` 변환 헬퍼, CRUD 래퍼         |
| 디스코드 어댑터 | `openclaw_review/deep-dive/10-discord-slack-signal.md`  | Discord DM: `user.createDM()` → `dmChannel.send()`          |

**핵심 적용 패턴:**

1. **Condition Strategy 패턴**: 각 조건 타입을 독립 `AlertConditionEvaluator` 전략 객체로 구현. `satisfies Record<ExtendedConditionType, ...>`로 컴파일 타임 완전성 보장.
2. **Delivery Dispatcher**: 각 전달 채널(Discord, WebSocket, Log)이 `DeliveryHandler` 인터페이스를 구현. `Promise.allSettled` 기반 부분 실패 격리.
3. **Idempotent Trigger**: `cooldownMs` + `lastTriggeredAt`(Unix ms) 기반 중복 방지.

---

## 3. 코드베이스 제약 (선행 분석)

### 3.1 스키마 충돌 — MIGRATIONS[3] 필수

**기존 `SCHEMA_DDL`** (`packages/storage/src/database.ts` L98-113, SCHEMA_VERSION=2):

```sql
CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  symbol            TEXT NOT NULL,
  condition_type    TEXT NOT NULL CHECK(condition_type IN
    ('above','below','crosses_above','crosses_below','change_percent')),
  condition_value   REAL NOT NULL,
  condition_field   TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  channel_id        TEXT,
  trigger_count     INTEGER NOT NULL DEFAULT 0,
  cooldown_ms       INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  created_at        INTEGER NOT NULL
);
```

**문제**: 독립 `CREATE TABLE IF NOT EXISTS alerts`는 기존 테이블이 존재하므로 DDL이 **무시**됨. 이후 새 컬럼 참조 시 런타임 에러.

**해결**: `SCHEMA_VERSION = 3`, `MIGRATIONS[3]`에서 `DROP TABLE IF EXISTS alerts` + 새 구조로 재생성 + `alert_history` 신규 생성.

### 3.2 기존 타입/CRUD 이중화

- `@finclaw/types`의 `Alert`, `AlertCondition`, `AlertConditionType`은 기존 5종 조건(`above`, `below`, `crosses_above`, `crosses_below`, `change_percent`).
- `packages/storage/src/tables/alerts.ts`에 7개 CRUD 함수 존재.
- **결정**: `@finclaw/types` **미수정**. Phase 18 타입은 `packages/skills-finance/src/alerts/types.ts`에 독립 정의. storage 패키지에 새 CRUD 함수 추가.

### 3.3 MarketDataService 미존재

- 실제 API: `MarketCache.getQuote(symbol, provider, normalize)` + `ProviderRegistry.resolve(symbol)`.
- `ProviderMarketQuote` 필드: `symbol, price, change, changePercent, volume, high, low, open, previousClose, marketCap, timestamp` — **`avgVolume` 없음**.
- **해결**: `AlertMarketService` 어댑터를 Phase 18에서 신규 생성. Phase 16 코드 미수정.

### 3.4 도구 등록 패턴

- 기존 패턴: `registerStockPriceTool(registry, state)`, `registerGetFinancialNewsTool(registry, deps)` — 개별 함수.
- `ToolExecutor = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolResult>`.
- `ToolExecutionContext.userId`로 사용자 식별 — `params._userId` 해킹 불필요.
- `ToolResult = { content: string, isError: boolean }`.
- `RegisteredToolDefinition`: `group`, `requiresApproval`, `isTransactional`, `accessesSensitiveData`, `isExternal?`, `timeoutMs?` 필수.

### 3.5 WebSocket/Discord 전달

- **WebSocket**: `GatewayBroadcaster.broadcastToChannel(connections, channel, data)` — 채널 구독 기반, userId 기반이 **아님**.
- **Discord DM**: `client.users.fetch(userId)` → `user.createDM()` → `dmChannel.send(content)`.

### 3.6 타임스탬프/쿨다운 단위

- 코드베이스 전체: `INTEGER` (Unix ms). `Timestamp = Brand<number, 'Timestamp'>`.
- 쿨다운: 기존 `cooldown_ms INTEGER` (밀리초). `cooldownMinutes` 아님.

### 3.7 뉴스 쿼리 필드명

- `NewsQuery.symbols?: readonly TickerSymbol[]` — `tickers`가 아닌 `symbols`.

### 3.8 기존 인프라 활용

- `ConcurrencyLane` (`packages/infra/src/concurrency-lane.ts`): per-key 동시성 제어, 큐, 타임아웃.
- `CircuitBreaker` (`packages/infra/src/circuit-breaker.ts`): closed→open→half-open, 5-fail threshold, 30s reset.
- `InMemoryToolRegistry`가 `isExternal: true` 도구에 CircuitBreaker 자동 적용 (조건 평가기는 도구가 아니므로 수동 적용 필요).
- Zod: 코드베이스 전체 `from 'zod/v4'`.

---

## 4. 생성/수정할 파일

### 수정 파일 (3개)

| #   | 파일 경로                                        | 수정 내용                                                                         |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| M1  | `packages/storage/src/database.ts`               | SCHEMA_VERSION=3, MIGRATIONS[3] 추가, SCHEMA_DDL의 alerts 테이블도 v3 구조로 갱신 |
| M2  | `packages/storage/src/tables/alerts.ts`          | 새 스키마용 CRUD 함수 추가 (기존 함수 유지)                                       |
| M3  | `packages/channel-discord/src/commands/alert.ts` | TODO 스텁 완성 — alertStorage CRUD 호출 연결                                      |

### 신규 소스 파일 (12개)

| #   | 파일 경로                                                 | 설명                                                                 | 예상 LOC |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| 1   | `packages/skills-finance/src/alerts/types.ts`             | 스킬 로컬 도메인 타입 (조건 유니온, 평가 결과, 설정)                 | ~120     |
| 2   | `packages/skills-finance/src/alerts/store.ts`             | storage facade — DB 직접 접근, CRUD + alert_history                  | ~150     |
| 3   | `packages/skills-finance/src/alerts/market-service.ts`    | AlertMarketService 어댑터 (MarketCache + ProviderRegistry 래핑)      | ~40      |
| 4   | `packages/skills-finance/src/alerts/monitor.ts`           | 모니터링 엔진 (setInterval + isChecking + ConcurrencyLane)           | ~140     |
| 5   | `packages/skills-finance/src/alerts/conditions/price.ts`  | 가격 임계값 조건 평가 (above/below)                                  | ~50      |
| 6   | `packages/skills-finance/src/alerts/conditions/change.ts` | 퍼센트 변동 조건 평가 (up/down/both)                                 | ~60      |
| 7   | `packages/skills-finance/src/alerts/conditions/volume.ts` | 거래량 급증 조건 평가 (avgVolume 미제공 시 triggered:false)          | ~55      |
| 8   | `packages/skills-finance/src/alerts/conditions/news.ts`   | 뉴스 키워드 매칭 조건 평가 (symbols 필드)                            | ~60      |
| 9   | `packages/skills-finance/src/alerts/delivery.ts`          | 멀티 채널 알림 전달 디스패처                                         | ~140     |
| 10  | `packages/skills-finance/src/alerts/tools.ts`             | 에이전트 도구 4개 개별 등록 + buildConditionFromParams + Zod v4 검증 | ~200     |
| 11  | `packages/skills-finance/src/alerts/index.ts`             | 알림 스킬 등록 진입점, registerAlertTools, 모니터 생명주기           | ~70      |
| 12  | `packages/storage/src/tables/alert-history.ts`            | alert_history CRUD (insert, getByAlert, getLast)                     | ~80      |

### 테스트 파일 (5개)

| #   | 파일 경로                                                            | 테스트 대상                                                 | 예상 LOC |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------- | -------- |
| 1   | `packages/skills-finance/src/alerts/__tests__/store.storage.test.ts` | SQLite CRUD + MIGRATIONS[3] + alert_history                 | ~160     |
| 2   | `packages/skills-finance/src/alerts/__tests__/monitor.test.ts`       | 모니터 엔진 (vi.useFakeTimers, ConcurrencyLane mock)        | ~140     |
| 3   | `packages/skills-finance/src/alerts/__tests__/conditions.test.ts`    | 4가지 조건 평가기 + 경계값 (avgVolume null, threshold 동등) | ~140     |
| 4   | `packages/skills-finance/src/alerts/__tests__/delivery.test.ts`      | 멀티 채널 전달 (mock GatewayBroadcaster, Discord DM)        | ~110     |
| 5   | `packages/skills-finance/src/alerts/__tests__/tools.test.ts`         | registerXxxTool + buildConditionFromParams + Zod 검증       | ~100     |

**합계: 신규 12 + 수정 3 + 테스트 5 = 20개 파일, 예상 ~1,815 LOC**

---

## 5. 핵심 인터페이스/타입

```typescript
// packages/skills-finance/src/alerts/types.ts
// 스킬 로컬 타입 — @finclaw/types 미수정

// ─── 조건 타입 ───

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
  readonly symbols?: readonly string[]; // NewsQuery.symbols 필드명 일치
  readonly excludeKeywords?: readonly string[];
}

export type AlertCondition = PriceCondition | ChangeCondition | VolumeCondition | NewsCondition;

// ─── 알림 정의 ───

export type DeliveryChannel = 'discord' | 'websocket' | 'log';

export interface AlertDefinition {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly condition: AlertCondition;
  readonly channels: readonly DeliveryChannel[];
  readonly cooldownMs: number; // 밀리초 (기본 900_000)
  readonly enabled: boolean;
  readonly expiresAt?: number; // Unix ms
  readonly createdAt: number; // Unix ms
  readonly updatedAt: number; // Unix ms
}

export type CreateAlertInput = Omit<AlertDefinition, 'id' | 'createdAt' | 'updatedAt'> & {
  readonly enabled?: boolean;
  readonly cooldownMs?: number;
};

// ─── 조건 평가 ───

export interface ConditionEvaluation {
  readonly triggered: boolean;
  readonly currentValue: string;
  readonly message: string;
}

export interface AlertConditionEvaluator<T extends AlertCondition = AlertCondition> {
  readonly type: T['type'];
  evaluate(condition: T): Promise<ConditionEvaluation>;
}

// ─── 이력 ───

export interface AlertHistory {
  readonly id: string;
  readonly alertId: string;
  readonly triggeredAt: number; // Unix ms
  readonly conditionSnapshot: string;
  readonly deliveryResults: readonly DeliveryResult[];
  readonly currentValue: string;
}

export interface DeliveryResult {
  readonly channel: DeliveryChannel;
  readonly success: boolean;
  readonly error?: string;
  readonly deliveredAt: number; // Unix ms
}

// ─── 모니터 설정 ───

export interface AlertMonitorConfig {
  readonly checkIntervalMs: number; // 기본 30_000
  readonly maxConcurrentChecks: number; // 기본 10
  readonly defaultCooldownMs: number; // 기본 900_000
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

---

## 6. 구현 상세

### 6.1 전체 아키텍처

```
┌────────────────────────────────────────────────────────┐
│  AlertMonitor (setInterval + isChecking 가드)            │
│  ┌──────────────────────────────────────────────────┐   │
│  │  매 checkIntervalMs (30초) 마다:                  │   │
│  │  1. store.listEnabled() → 활성 알림 목록           │   │
│  │  2. ConcurrencyLane.acquire(alertId) — 동시성 제어 │   │
│  │  3. 조건 평가기 호출 (CircuitBreaker 보호)         │   │
│  │  4. 쿨다운 체크 (lastTriggeredAt + cooldownMs)     │   │
│  │  5. 조건 충족 + 쿨다운 통과 → 트리거               │   │
│  └──────────────────────────────────────────────────┘   │
│                       │ 트리거                          │
│                       ▼                                │
│  ┌──────────────────────────────────────────┐           │
│  │  DeliveryDispatcher                       │           │
│  │  ├── DiscordDelivery (user.createDM→send) │           │
│  │  ├── WebSocketDelivery                    │           │
│  │  │   (broadcastToChannel(conns,'alerts')) │           │
│  │  └── LogDelivery (logger 폴백)            │           │
│  └──────────────────────────────────────────┘           │
│                       │                                │
│                       ▼                                │
│  store.recordTrigger() → alert_history INSERT          │
└────────────────────────────────────────────────────────┘
```

### 6.2 MIGRATIONS[3] 스키마 마이그레이션

`packages/storage/src/database.ts` 수정:

```typescript
const SCHEMA_VERSION = 3; // 2 → 3

const MIGRATIONS: Record<number, string> = {
  2: `/* 기존 portfolios 마이그레이션 (유지) */`,
  3: `
    -- Phase 18: alerts 테이블 재생성 (CHECK 제약 변경 불가)
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
};
```

**SCHEMA_DDL도 갱신**: 신규 DB에서 v3 구조로 바로 생성되도록 `SCHEMA_DDL`의 `alerts` 정의도 위 구조로 변경.

### 6.3 store.ts — AlertStore 구현

`packages/skills-finance/src/alerts/store.ts`:

- `DatabaseSync` 직접 사용 (`db.prepare().run/get/all`)
- 모든 타임스탬프: `Date.now()` (Unix ms `number`)
- `condition_json`: `JSON.stringify(condition)` / `JSON.parse(row.condition_json)`
- `channels_json`: `JSON.stringify(channels)` / `JSON.parse(row.channels_json)`
- `delivery_results_json`: 동일 패턴
- `rowToAlertDefinition()` 헬퍼: DB row → `AlertDefinition` 변환

```typescript
// 핵심 구조
export function createAlertStore(db: DatabaseSync): AlertStore {
  return {
    create(input) {
      const id = crypto.randomUUID();
      const now = Date.now();
      db.prepare(`INSERT INTO alerts (...) VALUES (...)`).run(
        id,
        input.userId,
        input.name,
        input.condition.type,
        JSON.stringify(input.condition),
        JSON.stringify(input.channels),
        input.cooldownMs ?? 900_000,
        (input.enabled ?? true) ? 1 : 0,
        0,
        null,
        input.expiresAt ?? null,
        now,
        now,
      );
      return this.getById(id)!;
    },
    // update, listEnabled (expires_at 체크), getHistory, getLastTrigger 등 전부 구현
  };
}
```

### 6.4 market-service.ts — AlertMarketService 어댑터

```typescript
// packages/skills-finance/src/alerts/market-service.ts
import type { MarketCache } from '../market/cache.js';
import type { ProviderRegistry } from '../market/provider-registry.js';
import { normalizeQuote } from '../market/normalizer.js';

export function createAlertMarketService(deps: {
  cache: MarketCache;
  registry: ProviderRegistry;
}): AlertMarketService {
  return {
    async getQuote(ticker) {
      const provider = deps.registry.resolve(ticker);
      const quote = await deps.cache.getQuote(ticker, provider, normalizeQuote);
      return { price: quote.price, changePercent: quote.changePercent, volume: quote.volume };
    },
  };
}
```

### 6.5 조건 평가기

**price.ts**: `AlertMarketService.getQuote(condition.ticker)` → `above: price >= threshold`, `below: price <= threshold`.

**change.ts**: `quote.changePercent` → `up: changePercent >= thresholdPercent`, `down: changePercent <= -thresholdPercent`, `both: |changePercent| >= thresholdPercent`.

**volume.ts**: `ProviderMarketQuote`에 `avgVolume` 필드 **없음**. 현 단계에서는 평균 거래량 데이터를 구할 수 없으므로:

```typescript
// avgVolume 미제공 → 조건 평가 불가
return {
  triggered: false,
  currentValue: formatVolume(currentVolume),
  message: `${condition.ticker} 평균 거래량 데이터 미지원 — 조건 평가 불가`,
};
```

향후 히스토리컬 데이터 기반 평균 산출로 확장 가능.

**news.ts**: `symbols` 필드 사용 (기존 plan.md의 `tickers` 수정):

```typescript
const news = await newsAggregator.fetchNews({
  symbols: condition.symbols, // ✅ NewsQuery.symbols 일치
  keywords: condition.keywords as string[],
  limit: 10,
  fromDate: new Date(Date.now() - 3_600_000),
});
```

**평가기 레지스트리 타입 안전성**:

```typescript
const EVALUATORS = {
  price: createPriceConditionEvaluator(marketService, priceCB),
  change: createChangeConditionEvaluator(marketService, changeCB),
  volume: createVolumeConditionEvaluator(marketService),
  news: createNewsConditionEvaluator(newsAggregator, newsCB),
} satisfies Record<AlertConditionType, AlertConditionEvaluator>;
```

### 6.6 모니터링 엔진

```typescript
// monitor.ts — 핵심 변경점
import type { ConcurrencyLane } from '@finclaw/infra';

export function createAlertMonitor(deps: {
  store: AlertStore;
  evaluators: Record<AlertConditionType, AlertConditionEvaluator>;
  deliveryDispatcher: DeliveryDispatcher;
  logger: Logger;
  config: AlertMonitorConfig;
  lane: ConcurrencyLane; // infra 패키지 — chunkArray 대체
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let isChecking = false;

  async function checkAlerts(): Promise<void> {
    if (isChecking) return;
    isChecking = true;
    try {
      const alerts = await deps.store.listEnabled();
      await Promise.allSettled(alerts.map(checkSingleAlert));
    } finally {
      isChecking = false;
    }
  }

  async function checkSingleAlert(alert: AlertDefinition): Promise<void> {
    const handle = await deps.lane.acquire(alert.id).catch(() => null);
    if (!handle) return; // 큐 포화 시 스킵
    try {
      // 쿨다운: Unix ms 직접 비교
      const last = await deps.store.getLastTrigger(alert.id);
      if (last && Date.now() - last.triggeredAt < alert.cooldownMs) return;

      const evaluator = deps.evaluators[alert.condition.type];
      const evaluation = await evaluator.evaluate(alert.condition);

      if (evaluation.triggered) {
        const results = await deps.deliveryDispatcher.dispatch(alert, evaluation);
        await deps.store.recordTrigger(alert.id, evaluation, results);
      }
    } catch (error) {
      deps.logger.error('Alert check failed', { alertId: alert.id, error });
    } finally {
      handle.release();
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => checkAlerts().catch(() => {}), deps.config.checkIntervalMs);
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

### 6.7 멀티 채널 알림 전달

```typescript
// delivery.ts

export interface DeliveryHandler {
  readonly channel: DeliveryChannel;
  deliver(alert: AlertDefinition, evaluation: ConditionEvaluation): Promise<void>;
}

export interface DeliveryDispatcher {
  dispatch(alert: AlertDefinition, evaluation: ConditionEvaluation): Promise<DeliveryResult[]>;
}

// Discord: DM 채널 resolve 필수
export function createDiscordDeliveryHandler(deps: { client: DiscordClient }): DeliveryHandler {
  return {
    channel: 'discord',
    async deliver(alert, evaluation) {
      const user = await deps.client.users.fetch(alert.userId);
      const dmChannel = await user.createDM();
      await dmChannel.send(formatAlertMessage(alert, evaluation));
    },
  };
}

// WebSocket: broadcastToChannel (채널 구독 기반)
export function createWebSocketDeliveryHandler(deps: {
  broadcaster: GatewayBroadcaster;
  connections: Map<string, WsConnection>;
}): DeliveryHandler {
  return {
    channel: 'websocket',
    async deliver(alert, evaluation) {
      deps.broadcaster.broadcastToChannel(deps.connections, 'alerts', {
        type: 'alert.triggered',
        alertId: alert.id,
        name: alert.name,
        message: evaluation.message,
        currentValue: evaluation.currentValue,
        triggeredAt: Date.now(),
      });
    },
  };
}

// Log: 폴백
export function createLogDeliveryHandler(deps: { logger: Logger }): DeliveryHandler {
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

// DeliveryDispatcher: Promise.allSettled 기반 부분 실패 격리
export function createDeliveryDispatcher(deps: {
  handlers: DeliveryHandler[];
  logger: Logger;
}): DeliveryDispatcher {
  const handlerMap = new Map(deps.handlers.map((h) => [h.channel, h]));
  return {
    async dispatch(alert, evaluation) {
      const results: DeliveryResult[] = [];
      for (const channel of alert.channels) {
        const handler = handlerMap.get(channel);
        if (!handler) {
          results.push({
            channel,
            success: false,
            error: `No handler: ${channel}`,
            deliveredAt: Date.now(),
          });
          continue;
        }
        try {
          await handler.deliver(alert, evaluation);
          results.push({ channel, success: true, deliveredAt: Date.now() });
        } catch (error) {
          results.push({ channel, success: false, error: String(error), deliveredAt: Date.now() });
        }
      }
      return results;
    },
  };
}
```

### 6.8 에이전트 도구 등록

```typescript
// tools.ts — 기존 registerXxxTool 패턴 준수

export function registerSetAlertTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  registry.register(
    {
      name: 'set_alert',
      description: '금융 알림을 설정합니다. 가격, 변동률, 거래량, 뉴스 키워드 조건을 지원합니다.',
      inputSchema: {
        /* JSON Schema */
      },
      group: 'finance',
      requiresApproval: false,
      isTransactional: true,
      accessesSensitiveData: false,
      isExternal: false,
      timeoutMs: 5_000,
    },
    async (input, context) => {
      // context.userId — ToolExecutionContext 제공
      const condition = buildConditionFromParams(input);
      const alert = deps.store.create({
        userId: context.userId,
        name: input.name as string,
        condition,
        channels: ['discord', 'websocket'],
        cooldownMs: (input.cooldownMs as number) ?? 900_000,
        enabled: true,
      });
      return { content: JSON.stringify({ alertId: alert.id, name: alert.name }), isError: false };
    },
    'skill',
  );
}

// buildConditionFromParams: Zod v4 검증 + 조건 빌드
import { z } from 'zod/v4';

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

function buildConditionFromParams(input: Record<string, unknown>): AlertCondition {
  const result = AlertConditionSchema.safeParse(input.condition);
  if (!result.success) throw new Error(`조건 파라미터 오류: ${result.error.message}`);
  return result.data;
}

// 나머지 도구:
export function registerListAlertsTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  /* ... */
}
export function registerRemoveAlertTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  /* ... */
}
export function registerGetAlertHistoryTool(
  registry: ToolRegistry,
  deps: { store: AlertStore },
): void {
  /* ... */
}

// index.ts에서 일괄 호출
export function registerAlertTools(registry: ToolRegistry, deps: { store: AlertStore }): void {
  registerSetAlertTool(registry, deps);
  registerListAlertsTool(registry, deps);
  registerRemoveAlertTool(registry, deps);
  registerGetAlertHistoryTool(registry, deps);
}
```

**도구별 메타데이터:**
| 도구 | isExternal | isTransactional | 근거 |
|------|-----------|-----------------|------|
| set_alert | false | true | DB 쓰기, 외부 API 없음 |
| list_alerts | false | false | DB 읽기만 |
| remove_alert | false | true | DB 삭제 |
| get_alert_history | false | false | DB 읽기만 |

---

## 7. 선행 조건

| 선행 요소                  | 산출물                                                                     | Phase 18 사용 목적                        |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| **Phase 2** (인프라)       | `ConcurrencyLane`, `CircuitBreaker`, 로거                                  | 동시성 제어, 외부 API 보호, 모니터링 로깅 |
| **Phase 3** (설정)         | 환경변수, Zod 스키마                                                       | 알림 설정 환경변수                        |
| **Phase 7** (도구)         | `RegisteredToolDefinition`, `ToolRegistry`, `ToolExecutionContext`         | 에이전트 도구 등록, `context.userId` 접근 |
| **Phase 12** (Discord)     | Discord Client                                                             | DM 전달 (`user.createDM()`)               |
| **Phase 14** (스토리지)    | `database.ts` (SCHEMA_VERSION, MIGRATIONS), `tables/alerts.ts` (기존 CRUD) | MIGRATIONS[3] 확장, CRUD 추가             |
| **Phase 16** (시장 데이터) | `MarketCache`, `ProviderRegistry`, `normalizeQuote`                        | AlertMarketService 어댑터 구성            |
| **Phase 17** (뉴스)        | `NewsAggregator`, `NewsQuery` (`symbols` 필드)                             | 뉴스 조건 평가                            |
| **Gateway** (서버)         | `GatewayBroadcaster`, `WsConnection`                                       | WebSocket 전달 (`broadcastToChannel`)     |

### 직접 의존 관계

```
packages/storage (database.ts, tables/alerts.ts) ──┐
packages/infra (ConcurrencyLane, CircuitBreaker)   ──┤
packages/skills-finance/market (Cache, Registry)   ──┼──→ packages/skills-finance/alerts
packages/skills-finance/news (Aggregator)          ──┤
packages/agent/tools (Registry, Context)            ──┤
packages/server/gateway (Broadcaster)              ──┤
packages/channel-discord (Client, commands/alert)  ──┘
```

---

## 8. 산출물 및 검증

### 기능 검증 체크리스트

| #   | 검증 항목                                                                 | 테스트 방법                                 | tier    |
| --- | ------------------------------------------------------------------------- | ------------------------------------------- | ------- |
| 1   | MIGRATIONS[3]: DROP+CREATE alerts, CREATE alert_history                   | storage test: openDatabase() 후 스키마 확인 | storage |
| 2   | 확장 CRUD: create/getById/listByUser/listEnabled/update/delete/setEnabled | storage test: 실제 SQLite                   | storage |
| 3   | 가격 조건: above/below 방향별 triggered 판정                              | unit: mock AlertMarketService               | unit    |
| 4   | 가격 조건: threshold 동등값 경계 (currentPrice === threshold)             | unit: 경계값                                | unit    |
| 5   | 변동 조건: up/down/both 방향 + thresholdPercent 비교                      | unit: mock changePercent                    | unit    |
| 6   | 거래량 조건: avgVolume 미제공 시 triggered:false + 메시지                 | unit: mock volume only                      | unit    |
| 7   | 뉴스 조건: symbols 필드 + excludeKeywords 필터링                          | unit: mock NewsAggregator                   | unit    |
| 8   | 쿨다운: lastTriggeredAt + cooldownMs 이내 시 스킵                         | unit: Unix ms 비교                          | unit    |
| 9   | 쿨다운 0: cooldownMs=0이면 항상 통과                                      | unit: 경계값                                | unit    |
| 10  | 모니터: isChecking 가드 — 체크 중 새 사이클 방지                          | unit: vi.useFakeTimers                      | unit    |
| 11  | 모니터: 개별 알림 실패가 전체 사이클 중단 안 함                           | unit: 하나 reject                           | unit    |
| 12  | 모니터: ConcurrencyLane acquire/release 정상                              | unit: mock lane                             | unit    |
| 13  | 전달: Discord DM (user.createDM → send 호출 확인)                         | unit: mock Client                           | unit    |
| 14  | 전달: WebSocket (broadcastToChannel 호출 확인)                            | unit: mock Broadcaster                      | unit    |
| 15  | 전달: 하나의 채널 실패 시 다른 채널 정상 전달                             | unit: 하나 throw                            | unit    |
| 16  | 이력: recordTrigger 후 getLastTrigger/getHistory 일관성                   | storage test                                | storage |
| 17  | 도구: context.userId 사용, params.\_userId 미사용                         | unit: ToolExecutionContext mock             | unit    |
| 18  | 도구: buildConditionFromParams 4가지 타입 + Zod 검증 실패                 | unit: 유효/무효 입력                        | unit    |
| 19  | 만료: expiresAt 지난 알림은 listEnabled에서 제외                          | storage test                                | storage |
| 20  | 모니터 테스트: vi.advanceTimersByTimeAsync(30_000) 패턴                   | unit: fake timer                            | unit    |
| 21  | DB 마이그레이션 v2→v3 후 alerts/alert_history 정상 존재                   | storage test                                | storage |

### vitest 실행 기대 결과

```bash
# unit 테스트
pnpm vitest run packages/skills-finance/src/alerts/ --exclude='**/*.storage.test.ts'
# 예상: 4 파일, ~40 tests passed

# storage 테스트 (실제 SQLite)
pnpm vitest run packages/skills-finance/src/alerts/__tests__/store.storage.test.ts
# 예상: 1 파일, ~15 tests passed

# 타입체크
pnpm tsgo --noEmit
```

---

## 9. 복잡도 및 예상 파일 수

| 항목            | 값                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **복잡도**      | **L** (Large)                                                                                                                          |
| **신규 소스**   | 12개                                                                                                                                   |
| **수정 파일**   | 3개 (database.ts, tables/alerts.ts, commands/alert.ts)                                                                                 |
| **테스트 파일** | 5개                                                                                                                                    |
| **총 파일 수**  | **20개**                                                                                                                               |
| **예상 LOC**    | ~1,815                                                                                                                                 |
| **외부 의존성** | 없음 (기존 패키지만 사용)                                                                                                              |
| **새 환경변수** | `ALERT_CHECK_INTERVAL_MS` (30000), `ALERT_DEFAULT_COOLDOWN_MS` (900000), `ALERT_MAX_CONCURRENT_CHECKS` (10), `ALERT_MAX_PER_USER` (50) |
| **SQLite 변경** | SCHEMA_VERSION 2→3, MIGRATIONS[3]: DROP+CREATE alerts, CREATE alert_history                                                            |

### 구현 순서 (의존성 기반)

```
Step 1: 타입 정의
  packages/skills-finance/src/alerts/types.ts
  검증: tsc --noEmit 통과

Step 2: 스키마 마이그레이션 + Storage CRUD
  packages/storage/src/database.ts       (MIGRATIONS[3])
  packages/storage/src/tables/alerts.ts  (확장)
  packages/storage/src/tables/alert-history.ts (신규)
  검증: store.storage.test.ts 통과

Step 3: 시장 데이터 어댑터 + 스토어
  packages/skills-finance/src/alerts/market-service.ts
  packages/skills-finance/src/alerts/store.ts
  검증: 타입 컴파일

Step 4: 조건 평가기
  conditions/price.ts, change.ts, volume.ts, news.ts
  검증: conditions.test.ts 통과

Step 5: 전달 디스패처
  delivery.ts
  검증: delivery.test.ts 통과

Step 6: 모니터 엔진
  monitor.ts
  검증: monitor.test.ts 통과

Step 7: 도구 등록 + 진입점
  tools.ts, index.ts
  검증: tools.test.ts 통과

Step 8: Discord 커맨드 완성
  channel-discord/commands/alert.ts
  검증: /alert set 동작
```

### 의도적 제외 항목 (과잉 엔지니어링 방지)

| 제안                   | 결정    | 근거                                  |
| ---------------------- | ------- | ------------------------------------- |
| `croner` 패키지        | ❌ 제외 | `setInterval` + `isChecking`으로 충분 |
| 완전한 EventBus 전달   | ❌ 제외 | 3채널 규모에서 직접 호출이 더 단순    |
| `AlertId` Branded Type | ❌ 제외 | 단순 UUID, 혼동 가능성 낮음           |
| Redis Pub/Sub          | ❌ 제외 | 단일 서버 SQLite 기반                 |
| `AsyncDisposable`      | ⚠️ P2   | graceful shutdown 필요 시 추가        |
| EventBus emit          | ⚠️ P2   | 채널 확장 시 유용하나 현재 불필요     |
| pruneAlertHistory      | ⚠️ P2   | 장기 운영 시 이력 정리                |
