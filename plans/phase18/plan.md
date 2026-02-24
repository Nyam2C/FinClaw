# Phase 18: 금융 스킬 -- 알림 시스템

## 1. 목표

금융 이벤트에 대한 조건부 알림(Alert) 시스템을 구현한다. 구체적으로:

1. **다양한 알림 조건**: 가격 임계값(price threshold), 퍼센트 변동(% change), 거래량 급증(volume spike), 뉴스 키워드 매칭(news alert) 4가지 조건 타입을 지원한다.
2. **영속적 알림 저장**: SQLite 기반으로 알림 정의를 CRUD 관리하며, 서버 재시작 후에도 알림이 유지된다.
3. **주기적 조건 모니터링**: 크론 기반 주기적 체크(기본 30초 간격, 설정 가능)로 알림 조건을 평가하고, 조건 충족 시 알림을 트리거한다.
4. **멀티 채널 알림 전달**: Discord DM/채널 메시지, Gateway WebSocket 인앱 알림, 로그 기반 폴백의 3단계 전달 체계를 구현한다.
5. **알림 이력 및 쿨다운**: 트리거된 알림 이력을 추적하고, 동일 알림의 반복 발송을 방지하는 쿨다운 메커니즘(기본 15분)을 적용한다.
6. **에이전트 도구 등록**: `set_alert`, `list_alerts`, `remove_alert`, `get_alert_history` 4가지 도구를 에이전트에 등록한다.

---

## 2. OpenClaw 참조

| 참조 문서       | 경로                                                    | 적용할 패턴                                                       |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| 크론/훅 시스템  | `openclaw_review/docs/13.데몬-크론-훅-프로세스-보안.md` | 크론 스케줄러의 interval 기반 작업 실행, 크론 작업 등록/해제 패턴 |
| 크론 Deep Dive  | `openclaw_review/deep-dive/13-daemon-cron-hooks.md`     | `CronJob` 인터페이스, 크론 작업의 에러 격리 및 재시도 패턴        |
| 스킬 시스템     | `openclaw_review/docs/20.스킬-빌드-배포-인프라.md`      | 스킬 메타데이터 스키마, 도구 정의 패턴                            |
| 메모리/스토리지 | `openclaw_review/deep-dive/14-memory-media-utils.md`    | SQLite 테이블 설계, 마이그레이션 패턴, CRUD 래퍼                  |
| 디스코드 어댑터 | `openclaw_review/deep-dive/10-discord-slack-signal.md`  | Discord DM 전송, 임베드 메시지 구성, 채널 메시지 패턴             |

**핵심 적용 패턴:**

1. **Condition Strategy 패턴**: 각 알림 조건 타입(price, change, volume, news)을 독립적인 `AlertConditionEvaluator` 전략 객체로 구현. 새로운 조건 타입 추가 시 기존 코드 변경 없이 확장 가능.
2. **Event-Driven Delivery**: 조건 충족 시 이벤트를 발행하고, 각 전달 채널(Discord, WebSocket, Log)이 독립적으로 구독하여 처리.
3. **Idempotent Trigger**: 쿨다운 + 이력 기반 중복 방지로 동일 조건에 대한 반복 알림 방지.

---

## 3. 생성할 파일

### 소스 파일 (8개)

| #   | 파일 경로                                | 설명                                                                         | 예상 LOC |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| 1   | `src/skills/alerts/index.ts`             | 알림 스킬 등록 진입점, 모니터 시작/정지 생명주기                             | ~70      |
| 2   | `src/skills/alerts/types.ts`             | 알림 도메인 타입 (AlertDefinition, AlertCondition, AlertHistory 등)          | ~130     |
| 3   | `src/skills/alerts/store.ts`             | SQLite 기반 알림 CRUD (테이블 생성, 마이그레이션, 쿼리)                      | ~180     |
| 4   | `src/skills/alerts/monitor.ts`           | 크론 기반 조건 모니터링 엔진 (주기적 체크, 조건 평가, 트리거)                | ~160     |
| 5   | `src/skills/alerts/conditions/price.ts`  | 가격 임계값 조건 평가 (above/below threshold)                                | ~60      |
| 6   | `src/skills/alerts/conditions/change.ts` | 퍼센트 변동 조건 평가 (daily/hourly % change)                                | ~70      |
| 7   | `src/skills/alerts/conditions/volume.ts` | 거래량 급증 조건 평가 (평균 대비 배수 초과)                                  | ~60      |
| 8   | `src/skills/alerts/conditions/news.ts`   | 뉴스 키워드 매칭 조건 평가                                                   | ~70      |
| 9   | `src/skills/alerts/delivery.ts`          | 멀티 채널 알림 전달 디스패처 (Discord, WebSocket, Log)                       | ~130     |
| 10  | `src/skills/alerts/tools.ts`             | 에이전트 도구 정의 (set_alert, list_alerts, remove_alert, get_alert_history) | ~150     |

### 테스트 파일 (4개)

| #   | 파일 경로                                           | 테스트 대상                                  | 예상 LOC |
| --- | --------------------------------------------------- | -------------------------------------------- | -------- |
| 1   | `src/skills/alerts/__tests__/store.storage.test.ts` | SQLite CRUD (storage tier: 실제 SQLite 사용) | ~150     |
| 2   | `src/skills/alerts/__tests__/monitor.test.ts`       | 모니터링 엔진 (mock 조건 평가기, 타이머)     | ~130     |
| 3   | `src/skills/alerts/__tests__/conditions.test.ts`    | 4가지 조건 평가기 통합 테스트                | ~120     |
| 4   | `src/skills/alerts/__tests__/delivery.test.ts`      | 멀티 채널 전달 (mock Discord, WebSocket)     | ~100     |

**합계: 소스 10개 + 테스트 4개 = 14개 파일, 예상 ~1,580 LOC**

---

## 4. 핵심 인터페이스/타입

```typescript
// src/skills/alerts/types.ts

// ─── 알림 조건 타입 ───

/** 알림 조건 종류 */
export type AlertConditionType = 'price' | 'change' | 'volume' | 'news';

/** 가격 비교 방향 */
export type PriceDirection = 'above' | 'below';

/** 변동 기간 */
export type ChangePeriod = 'hourly' | 'daily' | 'weekly';

/** 가격 임계값 조건 */
export interface PriceCondition {
  readonly type: 'price';
  readonly ticker: string;
  readonly direction: PriceDirection;
  readonly threshold: number; // 목표 가격 (USD)
}

/** 퍼센트 변동 조건 */
export interface ChangeCondition {
  readonly type: 'change';
  readonly ticker: string;
  readonly period: ChangePeriod;
  readonly thresholdPercent: number; // 변동 임계값 (예: 5.0 = 5%)
  readonly direction: 'up' | 'down' | 'both'; // 상승만, 하락만, 양방향
}

/** 거래량 급증 조건 */
export interface VolumeCondition {
  readonly type: 'volume';
  readonly ticker: string;
  readonly multiplier: number; // 평균 대비 배수 (예: 2.0 = 2배 이상)
  readonly avgPeriodDays: number; // 평균 산출 기간 (기본 20일)
}

/** 뉴스 키워드 매칭 조건 */
export interface NewsCondition {
  readonly type: 'news';
  readonly keywords: readonly string[]; // 매칭 키워드 (OR 연산)
  readonly tickers?: readonly string[]; // 특정 종목 한정 (선택)
  readonly excludeKeywords?: readonly string[]; // 제외 키워드
}

/** 모든 조건의 유니온 타입 */
export type AlertCondition = PriceCondition | ChangeCondition | VolumeCondition | NewsCondition;

// ─── 알림 정의 ───

/** 알림 전달 채널 */
export type DeliveryChannel = 'discord' | 'websocket' | 'log';

/** 알림 정의 (사용자가 생성하는 단위) */
export interface AlertDefinition {
  readonly id: string; // UUID
  readonly userId: string; // 생성자 식별
  readonly name: string; // 알림 이름 (예: "AAPL 200달러 돌파")
  readonly condition: AlertCondition;
  readonly channels: readonly DeliveryChannel[]; // 전달 채널 목록
  readonly cooldownMinutes: number; // 쿨다운 시간 (분, 기본 15)
  readonly enabled: boolean; // 활성화 여부
  readonly expiresAt?: Date; // 만료 시각 (선택)
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 알림 생성 요청 (id, createdAt 등 자동 생성 필드 제외) */
export type CreateAlertInput = Omit<AlertDefinition, 'id' | 'createdAt' | 'updatedAt'> & {
  readonly enabled?: boolean; // 기본 true
  readonly cooldownMinutes?: number; // 기본 15
};

// ─── 알림 이력 ───

/** 트리거된 알림 이력 */
export interface AlertHistory {
  readonly id: string;
  readonly alertId: string; // 원본 AlertDefinition ID
  readonly triggeredAt: Date;
  readonly conditionSnapshot: string; // 트리거 시점의 조건 상태 (JSON)
  readonly deliveryResults: readonly DeliveryResult[];
  readonly currentValue: string; // 트리거 시점의 현재값 (가격, 변동률 등)
}

/** 개별 전달 결과 */
export interface DeliveryResult {
  readonly channel: DeliveryChannel;
  readonly success: boolean;
  readonly error?: string;
  readonly deliveredAt: Date;
}

// ─── 조건 평가기 인터페이스 ───

/** 조건 평가 결과 */
export interface ConditionEvaluation {
  readonly triggered: boolean; // 조건 충족 여부
  readonly currentValue: string; // 현재값 (표시용)
  readonly message: string; // 알림 메시지 본문
}

/** 조건 평가기 인터페이스 (Strategy 패턴) */
export interface AlertConditionEvaluator<T extends AlertCondition = AlertCondition> {
  readonly type: T['type'];
  evaluate(condition: T): Promise<ConditionEvaluation>;
}

// ─── 모니터 설정 ───

/** 모니터 설정 */
export interface AlertMonitorConfig {
  readonly checkIntervalMs: number; // 체크 주기 (기본 30_000 = 30초)
  readonly maxConcurrentChecks: number; // 최대 동시 체크 수 (기본 10)
  readonly defaultCooldownMinutes: number; // 기본 쿨다운 (기본 15)
}

// ─── 알림 스토어 인터페이스 ───

/** 알림 저장소 인터페이스 */
export interface AlertStore {
  // AlertDefinition CRUD
  create(input: CreateAlertInput): Promise<AlertDefinition>;
  getById(id: string): Promise<AlertDefinition | null>;
  listByUser(userId: string): Promise<AlertDefinition[]>;
  listEnabled(): Promise<AlertDefinition[]>;
  update(id: string, updates: Partial<CreateAlertInput>): Promise<AlertDefinition>;
  delete(id: string): Promise<boolean>;
  setEnabled(id: string, enabled: boolean): Promise<void>;

  // AlertHistory
  recordTrigger(
    alertId: string,
    evaluation: ConditionEvaluation,
    results: DeliveryResult[],
  ): Promise<AlertHistory>;
  getHistory(alertId: string, limit?: number): Promise<AlertHistory[]>;
  getLastTrigger(alertId: string): Promise<AlertHistory | null>;
}
```

---

## 5. 구현 상세

### 5.1 전체 아키텍처

```
┌─────────────────────────────────────────────────────┐
│  AlertMonitor (크론 기반 주기적 체크)                   │
│  ┌──────────────────────────────────────────────┐    │
│  │  매 checkIntervalMs (30초) 마다:              │    │
│  │  1. store.listEnabled() → 활성 알림 목록       │    │
│  │  2. 각 알림에 대해 조건 평가기 호출             │    │
│  │  3. 쿨다운 체크 (lastTrigger + cooldown > now?) │   │
│  │  4. 조건 충족 + 쿨다운 통과 → 트리거            │    │
│  └──────────────────────────────────────────────┘    │
│                      │ 트리거                        │
│                      ▼                              │
│  ┌─────────────────────────────────────┐            │
│  │  DeliveryDispatcher                  │            │
│  │  ├── DiscordDelivery (DM/채널 메시지) │            │
│  │  ├── WebSocketDelivery (인앱 알림)    │            │
│  │  └── LogDelivery (폴백 로깅)          │            │
│  └─────────────────────────────────────┘            │
│                      │                              │
│                      ▼                              │
│  store.recordTrigger() → AlertHistory 기록           │
└─────────────────────────────────────────────────────┘
```

### 5.2 SQLite 스키마 및 CRUD

```typescript
// store.ts

import type { DatabaseSync } from 'node:sqlite';
import type {
  AlertStore,
  AlertDefinition,
  CreateAlertInput,
  AlertHistory,
  ConditionEvaluation,
  DeliveryResult,
} from './types.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    condition_type TEXT NOT NULL,
    condition_json TEXT NOT NULL,
    channels_json TEXT NOT NULL,
    cooldown_minutes INTEGER NOT NULL DEFAULT 15,
    enabled INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled);

  CREATE TABLE IF NOT EXISTS alert_history (
    id TEXT PRIMARY KEY,
    alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
    condition_snapshot TEXT NOT NULL,
    delivery_results_json TEXT NOT NULL,
    current_value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id);
  CREATE INDEX IF NOT EXISTS idx_alert_history_triggered_at ON alert_history(triggered_at);
`;

export function createAlertStore(db: DatabaseSync): AlertStore {
  // 스키마 초기화
  db.exec(SCHEMA_SQL);

  return {
    async create(input: CreateAlertInput): Promise<AlertDefinition> {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO alerts (id, user_id, name, condition_type, condition_json,
          channels_json, cooldown_minutes, enabled, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        input.userId,
        input.name,
        input.condition.type,
        JSON.stringify(input.condition),
        JSON.stringify(input.channels),
        input.cooldownMinutes ?? 15,
        (input.enabled ?? true) ? 1 : 0,
        input.expiresAt?.toISOString() ?? null,
        now,
        now,
      );

      return this.getById(id) as Promise<AlertDefinition>;
    },

    async getById(id: string): Promise<AlertDefinition | null> {
      const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as AlertRow | undefined;
      return row ? rowToAlertDefinition(row) : null;
    },

    async listByUser(userId: string): Promise<AlertDefinition[]> {
      const rows = db
        .prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId) as AlertRow[];
      return rows.map(rowToAlertDefinition);
    },

    async listEnabled(): Promise<AlertDefinition[]> {
      const now = new Date().toISOString();
      const rows = db
        .prepare(
          `
        SELECT * FROM alerts
        WHERE enabled = 1
        AND (expires_at IS NULL OR expires_at > ?)
      `,
        )
        .all(now) as AlertRow[];
      return rows.map(rowToAlertDefinition);
    },

    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
      return result.changes > 0;
    },

    async setEnabled(id: string, enabled: boolean): Promise<void> {
      db.prepare('UPDATE alerts SET enabled = ?, updated_at = datetime("now") WHERE id = ?').run(
        enabled ? 1 : 0,
        id,
      );
    },

    async recordTrigger(
      alertId: string,
      evaluation: ConditionEvaluation,
      results: DeliveryResult[],
    ): Promise<AlertHistory> {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `
        INSERT INTO alert_history (id, alert_id, triggered_at, condition_snapshot,
          delivery_results_json, current_value)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      ).run(id, alertId, now, evaluation.message, JSON.stringify(results), evaluation.currentValue);

      return {
        id,
        alertId,
        triggeredAt: new Date(now),
        conditionSnapshot: evaluation.message,
        deliveryResults: results,
        currentValue: evaluation.currentValue,
      };
    },

    async getLastTrigger(alertId: string): Promise<AlertHistory | null> {
      const row = db
        .prepare(
          `
        SELECT * FROM alert_history
        WHERE alert_id = ?
        ORDER BY triggered_at DESC
        LIMIT 1
      `,
        )
        .get(alertId) as HistoryRow | undefined;
      return row ? rowToAlertHistory(row) : null;
    },
  };
}

/** DB row -> AlertDefinition 변환 헬퍼 */
function rowToAlertDefinition(row: AlertRow): AlertDefinition {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    condition: JSON.parse(row.condition_json),
    channels: JSON.parse(row.channels_json),
    cooldownMinutes: row.cooldown_minutes,
    enabled: row.enabled === 1,
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
```

### 5.3 조건 평가기 구현

**가격 임계값 조건 (`conditions/price.ts`)**:

```typescript
import type { MarketDataService } from '../../../skills/market/types.js';
import type { PriceCondition, AlertConditionEvaluator, ConditionEvaluation } from '../types.js';

export function createPriceConditionEvaluator(
  marketData: MarketDataService,
): AlertConditionEvaluator<PriceCondition> {
  return {
    type: 'price',

    async evaluate(condition: PriceCondition): Promise<ConditionEvaluation> {
      const quote = await marketData.getQuote(condition.ticker);
      const currentPrice = quote.price;

      const triggered =
        condition.direction === 'above'
          ? currentPrice >= condition.threshold
          : currentPrice <= condition.threshold;

      const dirLabel = condition.direction === 'above' ? '이상' : '이하';

      return {
        triggered,
        currentValue: `$${currentPrice.toFixed(2)}`,
        message: triggered
          ? `${condition.ticker} 현재가 $${currentPrice.toFixed(2)} -- 목표가 $${condition.threshold.toFixed(2)} ${dirLabel} 도달`
          : `${condition.ticker} 현재가 $${currentPrice.toFixed(2)} (목표: $${condition.threshold.toFixed(2)} ${dirLabel})`,
      };
    },
  };
}
```

**퍼센트 변동 조건 (`conditions/change.ts`)**:

```typescript
import type { MarketDataService } from '../../../skills/market/types.js';
import type { ChangeCondition, AlertConditionEvaluator, ConditionEvaluation } from '../types.js';

export function createChangeConditionEvaluator(
  marketData: MarketDataService,
): AlertConditionEvaluator<ChangeCondition> {
  return {
    type: 'change',

    async evaluate(condition: ChangeCondition): Promise<ConditionEvaluation> {
      const quote = await marketData.getQuote(condition.ticker);
      const changePercent = quote.changePercent ?? 0;

      let triggered = false;
      if (condition.direction === 'up') {
        triggered = changePercent >= condition.thresholdPercent;
      } else if (condition.direction === 'down') {
        triggered = changePercent <= -condition.thresholdPercent;
      } else {
        // 'both': 절대값 비교
        triggered = Math.abs(changePercent) >= condition.thresholdPercent;
      }

      const sign = changePercent >= 0 ? '+' : '';

      return {
        triggered,
        currentValue: `${sign}${changePercent.toFixed(2)}%`,
        message: triggered
          ? `${condition.ticker} ${condition.period} 변동 ${sign}${changePercent.toFixed(2)}% -- 임계값 ${condition.thresholdPercent}% 초과`
          : `${condition.ticker} ${condition.period} 변동 ${sign}${changePercent.toFixed(2)}% (임계값: ${condition.thresholdPercent}%)`,
      };
    },
  };
}
```

**거래량 급증 조건 (`conditions/volume.ts`)**:

```typescript
export function createVolumeConditionEvaluator(
  marketData: MarketDataService,
): AlertConditionEvaluator<VolumeCondition> {
  return {
    type: 'volume',

    async evaluate(condition: VolumeCondition): Promise<ConditionEvaluation> {
      const quote = await marketData.getQuote(condition.ticker);
      const currentVolume = quote.volume ?? 0;

      // 평균 거래량은 Phase 16의 기술 분석 데이터에서 제공
      const avgVolume = quote.avgVolume ?? currentVolume;
      const ratio = avgVolume > 0 ? currentVolume / avgVolume : 0;

      const triggered = ratio >= condition.multiplier;

      return {
        triggered,
        currentValue: `${ratio.toFixed(1)}x avg`,
        message: triggered
          ? `${condition.ticker} 거래량 ${formatVolume(currentVolume)} (평균 대비 ${ratio.toFixed(1)}배) -- ${condition.multiplier}배 초과`
          : `${condition.ticker} 거래량 ${formatVolume(currentVolume)} (평균 대비 ${ratio.toFixed(1)}배)`,
      };
    },
  };
}

function formatVolume(volume: number): string {
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`;
  return String(volume);
}
```

**뉴스 키워드 매칭 조건 (`conditions/news.ts`)**:

```typescript
import type { NewsAggregator } from '../../news/types.js';

export function createNewsConditionEvaluator(
  newsAggregator: NewsAggregator,
): AlertConditionEvaluator<NewsCondition> {
  return {
    type: 'news',

    async evaluate(condition: NewsCondition): Promise<ConditionEvaluation> {
      const news = await newsAggregator.fetchNews({
        tickers: condition.tickers,
        keywords: condition.keywords as string[],
        limit: 10,
        fromDate: new Date(Date.now() - 60 * 60 * 1000), // 최근 1시간
      });

      // 제외 키워드 필터링
      const filtered = condition.excludeKeywords?.length
        ? news.filter((item) => {
            const text = (item.title + ' ' + item.description).toLowerCase();
            return !condition.excludeKeywords!.some((kw) => text.includes(kw.toLowerCase()));
          })
        : news;

      const triggered = filtered.length > 0;

      return {
        triggered,
        currentValue: `${filtered.length} articles`,
        message: triggered
          ? `키워드 [${condition.keywords.join(', ')}] 관련 뉴스 ${filtered.length}건 발견: "${filtered[0].title}"`
          : `키워드 [${condition.keywords.join(', ')}] 관련 최근 뉴스 없음`,
      };
    },
  };
}
```

### 5.4 모니터링 엔진

```typescript
// monitor.ts

import type { Logger } from '../../infra/logger/types.js';
import type {
  AlertStore,
  AlertDefinition,
  AlertCondition,
  AlertConditionEvaluator,
  AlertMonitorConfig,
  ConditionEvaluation,
} from './types.js';

export function createAlertMonitor(deps: {
  store: AlertStore;
  evaluators: Map<string, AlertConditionEvaluator>;
  deliveryDispatcher: DeliveryDispatcher;
  logger: Logger;
  config: AlertMonitorConfig;
}) {
  const { store, evaluators, deliveryDispatcher, logger, config } = deps;

  let timer: ReturnType<typeof setInterval> | null = null;
  let isChecking = false;

  /** 모니터링 시작 */
  function start(): void {
    if (timer) return;
    logger.info('Alert monitor started', { intervalMs: config.checkIntervalMs });

    timer = setInterval(() => {
      checkAlerts().catch((err) => {
        logger.error('Alert check cycle failed', { error: err });
      });
    }, config.checkIntervalMs);

    // 즉시 첫 체크 실행
    checkAlerts().catch((err) => {
      logger.error('Initial alert check failed', { error: err });
    });
  }

  /** 모니터링 정지 */
  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
      logger.info('Alert monitor stopped');
    }
  }

  /** 전체 알림 체크 사이클 */
  async function checkAlerts(): Promise<void> {
    if (isChecking) {
      logger.debug('Alert check already in progress, skipping');
      return;
    }

    isChecking = true;
    try {
      const enabledAlerts = await store.listEnabled();
      logger.debug('Checking alerts', { count: enabledAlerts.length });

      // 동시 실행 수 제한 (semaphore 패턴)
      const chunks = chunkArray(enabledAlerts, config.maxConcurrentChecks);
      for (const chunk of chunks) {
        await Promise.allSettled(chunk.map((alert) => checkSingleAlert(alert)));
      }
    } finally {
      isChecking = false;
    }
  }

  /** 단일 알림 체크 */
  async function checkSingleAlert(alert: AlertDefinition): Promise<void> {
    try {
      // 1. 쿨다운 체크
      const lastTrigger = await store.getLastTrigger(alert.id);
      if (lastTrigger && isInCooldown(lastTrigger.triggeredAt, alert.cooldownMinutes)) {
        return; // 쿨다운 중 -- 스킵
      }

      // 2. 조건 평가
      const evaluator = evaluators.get(alert.condition.type);
      if (!evaluator) {
        logger.warn('No evaluator for condition type', { type: alert.condition.type });
        return;
      }

      const evaluation = await evaluator.evaluate(alert.condition);

      // 3. 조건 충족 시 알림 전달
      if (evaluation.triggered) {
        logger.info('Alert triggered', { alertId: alert.id, name: alert.name });

        const results = await deliveryDispatcher.dispatch(alert, evaluation);
        await store.recordTrigger(alert.id, evaluation, results);
      }
    } catch (error) {
      // 개별 알림 실패가 전체 사이클을 중단하지 않음 (에러 격리)
      logger.error('Failed to check alert', {
        alertId: alert.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { start, stop, checkAlerts };
}

/** 쿨다운 체크 */
function isInCooldown(lastTriggeredAt: Date, cooldownMinutes: number): boolean {
  const cooldownMs = cooldownMinutes * 60 * 1000;
  return Date.now() - lastTriggeredAt.getTime() < cooldownMs;
}

/** 배열을 청크로 분할 */
function chunkArray<T>(array: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size) as T[]);
  }
  return chunks;
}
```

### 5.5 멀티 채널 알림 전달

```typescript
// delivery.ts

import type { Logger } from '../../infra/logger/types.js';
import type {
  AlertDefinition,
  ConditionEvaluation,
  DeliveryChannel,
  DeliveryResult,
} from './types.js';

export interface DeliveryHandler {
  readonly channel: DeliveryChannel;
  deliver(alert: AlertDefinition, evaluation: ConditionEvaluation): Promise<void>;
}

export interface DeliveryDispatcher {
  dispatch(alert: AlertDefinition, evaluation: ConditionEvaluation): Promise<DeliveryResult[]>;
}

export function createDeliveryDispatcher(deps: {
  handlers: DeliveryHandler[];
  logger: Logger;
}): DeliveryDispatcher {
  const { handlers, logger } = deps;
  const handlerMap = new Map(handlers.map((h) => [h.channel, h]));

  return {
    async dispatch(
      alert: AlertDefinition,
      evaluation: ConditionEvaluation,
    ): Promise<DeliveryResult[]> {
      const results: DeliveryResult[] = [];

      for (const channel of alert.channels) {
        const handler = handlerMap.get(channel);
        if (!handler) {
          results.push({
            channel,
            success: false,
            error: `No handler for channel: ${channel}`,
            deliveredAt: new Date(),
          });
          continue;
        }

        try {
          await handler.deliver(alert, evaluation);
          results.push({ channel, success: true, deliveredAt: new Date() });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error('Delivery failed', { channel, alertId: alert.id, error: errorMsg });
          results.push({
            channel,
            success: false,
            error: errorMsg,
            deliveredAt: new Date(),
          });
        }
      }

      return results;
    },
  };
}

/** Discord 전달 핸들러 */
export function createDiscordDeliveryHandler(deps: {
  sendDiscordMessage: (userId: string, content: string) => Promise<void>;
}): DeliveryHandler {
  return {
    channel: 'discord',
    async deliver(alert, evaluation) {
      const content = formatAlertMessage(alert, evaluation);
      await deps.sendDiscordMessage(alert.userId, content);
    },
  };
}

/** WebSocket 전달 핸들러 (Gateway 인앱 알림) */
export function createWebSocketDeliveryHandler(deps: {
  broadcastEvent: (userId: string, event: unknown) => void;
}): DeliveryHandler {
  return {
    channel: 'websocket',
    async deliver(alert, evaluation) {
      deps.broadcastEvent(alert.userId, {
        type: 'alert.triggered',
        alertId: alert.id,
        name: alert.name,
        message: evaluation.message,
        currentValue: evaluation.currentValue,
        triggeredAt: new Date().toISOString(),
      });
    },
  };
}

/** 로그 전달 핸들러 (폴백) */
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

/** 알림 메시지 포맷 */
function formatAlertMessage(alert: AlertDefinition, evaluation: ConditionEvaluation): string {
  return [
    `**[FinClaw Alert]** ${alert.name}`,
    '',
    evaluation.message,
    '',
    `현재값: ${evaluation.currentValue}`,
    `시각: ${new Date().toLocaleString('ko-KR')}`,
  ].join('\n');
}
```

### 5.6 에이전트 도구 정의

```typescript
// tools.ts

export function createAlertTools(deps: {
  store: AlertStore;
  monitor: AlertMonitor;
}): ToolDefinition[] {
  return [
    {
      name: 'set_alert',
      description: '금융 알림을 설정합니다. 가격, 변동률, 거래량, 뉴스 키워드 조건을 지원합니다.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '알림 이름 (예: "AAPL 200달러 돌파")' },
          conditionType: {
            type: 'string',
            enum: ['price', 'change', 'volume', 'news'],
            description: '조건 유형',
          },
          ticker: { type: 'string', description: '종목 코드 (price/change/volume 조건 시)' },
          direction: {
            type: 'string',
            description: 'above/below (price) 또는 up/down/both (change)',
          },
          threshold: { type: 'number', description: '임계값 (가격 또는 퍼센트)' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '뉴스 키워드 (news 조건 시)',
          },
          cooldownMinutes: { type: 'number', description: '쿨다운 시간(분), 기본 15' },
        },
        required: ['name', 'conditionType'],
      },
      execute: async (params): Promise<ToolResult> => {
        const condition = buildConditionFromParams(params);
        const alert = await deps.store.create({
          userId: params._userId, // 컨텍스트에서 주입
          name: params.name,
          condition,
          channels: ['discord', 'websocket'],
          cooldownMinutes: params.cooldownMinutes ?? 15,
          enabled: true,
        });
        return { success: true, data: { alertId: alert.id, name: alert.name, condition } };
      },
    },
    {
      name: 'list_alerts',
      description: '설정된 알림 목록을 조회합니다.',
      parameters: {
        type: 'object',
        properties: {
          includeDisabled: { type: 'boolean', description: '비활성 알림 포함 여부' },
        },
      },
      execute: async (params): Promise<ToolResult> => {
        const alerts = await deps.store.listByUser(params._userId);
        const filtered = params.includeDisabled ? alerts : alerts.filter((a) => a.enabled);
        return { success: true, data: filtered };
      },
    },
    {
      name: 'remove_alert',
      description: '알림을 삭제합니다.',
      parameters: {
        type: 'object',
        properties: {
          alertId: { type: 'string', description: '삭제할 알림 ID' },
        },
        required: ['alertId'],
      },
      execute: async (params): Promise<ToolResult> => {
        const deleted = await deps.store.delete(params.alertId);
        return { success: deleted, data: { deleted } };
      },
    },
    {
      name: 'get_alert_history',
      description: '알림 발동 이력을 조회합니다.',
      parameters: {
        type: 'object',
        properties: {
          alertId: { type: 'string', description: '알림 ID' },
          limit: { type: 'number', description: '조회 건수 (기본 10)' },
        },
        required: ['alertId'],
      },
      execute: async (params): Promise<ToolResult> => {
        const history = await deps.store.getHistory(params.alertId, params.limit ?? 10);
        return { success: true, data: history };
      },
    },
  ];
}
```

---

## 6. 선행 조건

| 선행 Phase                 | 산출물                                                     | 사용 목적                                                |
| -------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| **Phase 2** (인프라)       | 로거, 에러 클래스                                          | 모니터링 로깅, 에러 격리                                 |
| **Phase 3** (설정)         | 환경변수, Zod 스키마                                       | `ALERT_CHECK_INTERVAL_MS`, `ALERT_DEFAULT_COOLDOWN` 설정 |
| **Phase 7** (도구 시스템)  | `ToolDefinition`, `ToolRegistry`                           | 에이전트 도구 등록                                       |
| **Phase 12** (Discord)     | Discord DM/채널 메시지 전송 API                            | Discord 알림 전달                                        |
| **Phase 14** (스토리지)    | `node:sqlite` `DatabaseSync` 래퍼, 마이그레이션            | 알림 정의 및 이력 영속화                                 |
| **Phase 15** (크론)        | 크론 스케줄러, 인터벌 기반 작업 실행                       | 주기적 조건 체크                                         |
| **Phase 16** (시장 데이터) | `MarketDataService.getQuote()`, quote.volume/changePercent | 가격/변동/거래량 조건 평가                               |
| **Phase 17** (뉴스)        | `NewsAggregator.fetchNews()`                               | 뉴스 키워드 매칭 조건 평가                               |

### 직접 의존 관계

```
Phase 14 (스토리지) ─────┐
Phase 15 (크론)    ─────┤
Phase 16 (시장 데이터) ──┼──→ Phase 18 (알림 시스템)
Phase 17 (뉴스)    ─────┤
Phase 12 (Discord) ─────┘
```

---

## 7. 산출물 및 검증

### 기능 검증 체크리스트

| #   | 검증 항목                                                | 테스트 방법                         | 테스트 tier |
| --- | -------------------------------------------------------- | ----------------------------------- | ----------- |
| 1   | alerts 테이블 생성 및 CRUD 정상 동작                     | storage test: 실제 SQLite 인스턴스  | storage     |
| 2   | 가격 조건: above/below 방향에 따라 정확한 triggered 판정 | unit test: mock quote               | unit        |
| 3   | 변동 조건: up/down/both 방향 + 임계값 비교               | unit test: mock changePercent       | unit        |
| 4   | 거래량 조건: 평균 대비 배수 계산 정확성                  | unit test: mock volume/avgVolume    | unit        |
| 5   | 뉴스 조건: 키워드 매칭 + 제외 키워드 필터링              | unit test: mock news items          | unit        |
| 6   | 쿨다운: lastTrigger + cooldownMinutes 이내 시 스킵       | unit test: 시간 비교                | unit        |
| 7   | 모니터: 활성 알림만 체크, 비활성/만료 알림 제외          | unit test: mock store               | unit        |
| 8   | 모니터: 개별 알림 실패가 전체 사이클을 중단하지 않음     | unit test: 하나 reject, 나머지 정상 | unit        |
| 9   | 전달: Discord/WebSocket/Log 핸들러 각각 정상 호출        | unit test: mock handlers            | unit        |
| 10  | 전달: 하나의 채널 실패 시 다른 채널은 정상 전달          | unit test: 하나 throw               | unit        |
| 11  | 이력: recordTrigger 후 getLastTrigger 일관성             | storage test: SQLite                | storage     |
| 12  | 도구: set_alert가 올바른 AlertDefinition 생성            | unit test: 파라미터 매핑            | unit        |
| 13  | 만료: expiresAt 지난 알림은 listEnabled에서 제외         | storage test                        | storage     |

### vitest 실행 기대 결과

```bash
# unit 테스트
pnpm vitest run src/skills/alerts/ --exclude='**/*.storage.test.ts'
# 예상: 4 파일, ~30 tests passed

# storage 테스트 (실제 SQLite)
pnpm vitest run src/skills/alerts/__tests__/store.storage.test.ts
# 예상: 1 파일, ~12 tests passed
```

---

## 8. 복잡도 및 예상 파일 수

| 항목               | 값                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------- |
| **복잡도**         | **L** (Large)                                                                      |
| **소스 파일**      | 10개                                                                               |
| **테스트 파일**    | 4개                                                                                |
| **총 파일 수**     | **14개**                                                                           |
| **예상 LOC**       | ~1,580                                                                             |
| **예상 소요 기간** | 3-4일                                                                              |
| **외부 의존성**    | 없음 (node:sqlite 내장, Phase 14 래퍼 사용)                                        |
| **새 환경변수**    | `ALERT_CHECK_INTERVAL_MS` (기본 30000), `ALERT_DEFAULT_COOLDOWN_MINUTES` (기본 15) |
| **SQLite 테이블**  | `alerts`, `alert_history` (2개)                                                    |

### 복잡도 근거 (L 판정)

- **4가지 조건 평가기**: 각각 독립적이지만 Strategy 패턴으로 통합 필요
- **SQLite 스키마 + CRUD**: 2개 테이블, 인덱스, 마이그레이션
- **크론 기반 모니터링**: 인터벌 관리, 동시성 제어, 에러 격리
- **멀티 채널 전달**: 3개 전달 핸들러, 부분 실패 처리
- **쿨다운 + 만료 + 이력**: 시간 기반 로직이 여러 곳에 분산
- **에이전트 도구 4개**: Phase 17 대비 도구 수 증가, 파라미터 -> 조건 변환 로직 필요
