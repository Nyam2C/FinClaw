# Phase 23: 프로그래밍 배선 — Todo

## 개요

Phase 22 에서 대화형 도구 호출(Claude → 11개 skills)이 완성된 위에, **AI 를 거치지 않는 직접 접근 경로**를 배선한다. 5개 `finance.*` RPC + 3개 `agent.*` RPC + Web UI 3뷰.

**수정 9개 + 신규 3개 = 12개 파일, ~1,200 LOC**

### 전제 (변경되지 않는 인프라)

- `packages/server/src/gateway/rpc/index.ts` 의 `registerMethod(handler)` + 모듈 레벨 `methods` Map — 그대로 사용
- `packages/server/src/main.ts:171-202` 의 `marketHandle` / `newsHandle` 생성 흐름 — 그대로. handle 필드만 확장.
- Phase 22 에서 뚫린 `ConcurrencyLane`, `ExecutionToolDispatcher`, `Runner`, `runnerFactory` — 그대로 재사용.

### 실행 순서

```
Todo 1 (A1: skills-finance handle 확장)          — 독립
Todo 2 (A2: finance.ts 5 메서드 실구현)          — Todo 1 필요
Todo 3 (A3: main.ts 에 finance RPC 등록)         — Todo 1, 2 필요
Todo 4 (A4: finance.test.ts 재작성)              — Todo 2 필요

Todo 5 (B1: agent.ts 3 메서드 실구현)            — 독립 (types 만 필요)
Todo 6 (B2: main.ts 에 agent RPC 등록)           — Todo 5 필요
Todo 7 (B3: agent.test.ts 재작성)                — Todo 5 필요

Todo 8 (C1: app-gateway 래퍼 메서드 추가)        — 독립 (타입만 필요)
Todo 9 (C2: market-view 배선)                    — Todo 3, 8 필요
Todo 10 (C3: portfolio-view 배선)                — Todo 3, 8 필요
Todo 11 (C4: alerts-view 배선)                   — Todo 3, 8 필요

Todo 12 (최종: E2E 수동 검증)                    — Todo 3, 6, 9-11 필요
```

권장: **A (1→2→3→4) → B (5→6→7) → C (8→9→10→11) → Todo 12**. 각 밀스톤 끝에 `pnpm build && pnpm test` 로 실 동작 확인.

### 각 Milestone 정지 조건

- **A 후**: `curl -X POST /rpc -d '{"jsonrpc":"2.0","method":"finance.quote","params":{"symbol":"AAPL"},"id":1}'` 로 5개 RPC 모두 JSON 응답 반환. 단위 테스트 통과.
- **B 후**: `curl -X POST /rpc -d '{"jsonrpc":"2.0","method":"agent.run","params":{"agentId":"finclaw-partner","prompt":"지금 몇 시야"},"id":1}'` 로 datetime 도구 호출 흐름 관찰 가능. 큐잉 확인.
- **C 후**: 브라우저에서 Market 탭에 `AAPL` 입력 → 가격 카드. Portfolio 탭 → 테이블. Alerts 탭 → 리스트 + 추가 폼.
- **Todo 12 후**: E2E 시나리오 6개 전부 통과.

---

## Todo 1: skills-finance handle 확장 (alertStore, portfolioStore 노출) ✅

### 파일 목록

| 작업 | 파일 경로                                     | LOC |
| ---- | --------------------------------------------- | --- |
| 수정 | `packages/skills-finance/src/alerts/index.ts` | +10 |
| 수정 | `packages/skills-finance/src/news/index.ts`   | +10 |

### 주의사항

- `registerAlertTools` 의 현 반환 타입은 `Promise<AlertMonitor>` — `main.ts:195` 에서 `const alertMonitor = await registerAlertTools(...)` 로 받고 `lifecycle.register(() => alertMonitor.stop())` 함. 타입을 `Promise<AlertSkillHandle>` 로 바꾸고 `handle.monitor.stop()` 으로 경로 한 단계 늘어남 — main.ts 에서 1줄 변경 필요 (Todo 3 에 포함).
- `registerNewsTools` 는 이미 `Promise<NewsSkillHandle>` 반환 중. 현재 `{ aggregator }` 만 노출 → `portfolioStore` 필드 추가. `news/index.ts:67` 에서 이미 인스턴스화되어 있어 단순 export 만 하면 됨.
- `AlertStore` 타입은 `packages/skills-finance/src/alerts/types.ts:107` 에 이미 export 됨.
- `PortfolioStore` 클래스는 `packages/skills-finance/src/news/portfolio/store.ts` — export 확인하여 type-only import 가능한지 체크.

### 구현 코드

#### `packages/skills-finance/src/alerts/index.ts` (line 44-50 및 상단 export 수정)

```typescript
// 상단 export 블록 근처에 추가
export interface AlertSkillHandle {
  readonly monitor: AlertMonitor;
  readonly store: AlertStore;
}

// registerAlertTools 시그니처 및 반환값 변경
export async function registerAlertTools(
  toolRegistry: ToolRegistry,
  config: AlertSkillConfig,
): Promise<AlertSkillHandle> {
  const store = createAlertStore(config.db);
  // ... 기존 로직 전부 유지 ...

  const monitor = createAlertMonitor({
    /* ... 기존 ... */
  });
  await monitor.start();

  // 기존 registerSetAlertTool / registerListAlertsTool / registerRemoveAlertTool /
  // registerGetAlertHistoryTool 호출도 그대로 유지.

  return { monitor, store };
}
```

#### `packages/skills-finance/src/news/index.ts` (line 32-34 및 return 수정)

```typescript
export interface NewsSkillHandle {
  readonly aggregator: import('./types.js').NewsAggregator;
  readonly portfolioStore: PortfolioStore; // 신규 필드
}

// 함수 내부 return (line ~74)
return { aggregator: newsAggregator, portfolioStore };
```

### 검증

- `pnpm --filter @finclaw/skills-finance build` 통과
- `main.ts` 컴파일 에러 → Todo 3 에서 경로 수정으로 해소될 예정. 이 Todo 만 단독으로 끝나면 main.ts 가 빨갛게 됨 — 정상.

---

## Todo 2: `finance.ts` 5개 메서드 실구현 ✅

### 파일 목록

| 작업 | 파일 경로                                            | LOC              |
| ---- | ---------------------------------------------------- | ---------------- |
| 수정 | `packages/server/src/gateway/rpc/methods/finance.ts` | 전체 재작성 ~190 |

### 주의사항

- **DI 방식**: 모듈 로드 시점에 registerMethod 하지 말고, **`registerFinanceMethods(deps)`** 를 main.ts 에서 호출할 때 `deps` 를 closure 로 캡처. handler 는 factory 안에서 생성.
- **Symbol kind 자동 판별**: `USD/KRW` 같은 `/` 포함 → forex. 3-5자 대문자면서 crypto 화이트리스트(BTC/ETH/SOL 등)에 있으면 crypto. 기본 stock.
- **에러 코드**: handle 없음 (키 미설정) → `-32010 provider_unavailable`. 알 수 없는 symbol → `-32011 invalid_symbol`. AlertMonitor 평가 실패 → 저장은 유지, `immediateTrigger: false`.
- **즉시 평가 (alert.create)**: `handle.monitor.evaluateOnce(alertId)` 류의 훅 필요. 없으면 `evaluators[conditionType].evaluate(alert)` 직접 호출 — evaluator 는 이미 공개됨 (`packages/skills-finance/src/alerts/conditions/*`).
- **cooldown 기본값**: `process.env.ALERT_DEFAULT_COOLDOWN_MS ?? 900_000`.
- **news limit**: 기본 20, 최대 50. `Math.min(params.limit ?? 20, 50)`.
- **portfolio**: `portfolioStore.getDefault()` 없으면 `portfolioStore.list()[0]` 류로 첫 번째 사용. 없으면 빈 결과 `{holdings: [], summary: {currency: 'USD'}}`.

### 구현 코드

#### `packages/server/src/gateway/rpc/methods/finance.ts` (전체 재작성)

```typescript
// packages/server/src/gateway/rpc/methods/finance.ts
import { z } from 'zod/v4';
import type { AlertStore } from '@finclaw/skills-finance';
import type { NewsAggregator, PortfolioStore, QuoteService } from '@finclaw/skills-finance';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';
import { createError, RpcErrors } from '../errors.js';

// 사용자 정의 에러 코드 (errors.ts 에 추가해도 무방)
const PROVIDER_UNAVAILABLE = -32010;
const INVALID_SYMBOL = -32011;

export interface FinanceRpcDeps {
  readonly quoteService?: QuoteService;
  readonly newsAggregator?: NewsAggregator;
  readonly alertStore?: AlertStore;
  readonly portfolioStore?: PortfolioStore;
  readonly evaluateAlertOnce?: (alertId: string) => Promise<boolean>; // 선택적
}

const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'MATIC']);

function detectKind(symbol: string): 'stock' | 'crypto' | 'forex' {
  if (symbol.includes('/')) return 'forex';
  const upper = symbol.toUpperCase();
  if (CRYPTO_SYMBOLS.has(upper)) return 'crypto';
  return 'stock';
}

/**
 * finance.* RPC 메서드 등록.
 * deps 가 undefined 인 서비스는 해당 메서드가 PROVIDER_UNAVAILABLE 반환.
 */
export function registerFinanceMethods(deps: FinanceRpcDeps): void {
  // -- finance.quote --
  const quoteHandler: RpcMethodHandler<
    { symbol: string; kind?: 'stock' | 'crypto' | 'forex' },
    unknown
  > = {
    method: 'finance.quote',
    description: '종목/암호화폐/외환 시세를 조회합니다',
    authLevel: 'token',
    schema: z.object({
      symbol: z.string().min(1).max(20),
      kind: z.enum(['stock', 'crypto', 'forex']).optional(),
    }),
    async execute(params) {
      if (!deps.quoteService) {
        throw createError(
          null,
          PROVIDER_UNAVAILABLE,
          'Market data provider unavailable (ALPHA_VANTAGE_KEY or COINGECKO_API_KEY missing)',
        );
      }
      const kind = params.kind ?? detectKind(params.symbol);
      try {
        let quote;
        if (kind === 'stock') quote = await deps.quoteService.getStockPrice(params.symbol);
        else if (kind === 'crypto') quote = await deps.quoteService.getCryptoPrice(params.symbol);
        else quote = await deps.quoteService.getForexRate(params.symbol);
        return {
          symbol: params.symbol,
          kind,
          price: quote.price,
          currency: quote.currency ?? 'USD',
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
          timestamp: quote.timestamp,
          provider: quote.provider,
          cached: quote.cached ?? false,
        };
      } catch (err) {
        throw createError(
          null,
          INVALID_SYMBOL,
          `Failed to fetch ${kind} quote for ${params.symbol}: ${(err as Error).message}`,
        );
      }
    },
  };

  // -- finance.news --
  const newsHandler: RpcMethodHandler<
    { query?: string; symbols?: string[]; limit?: number },
    unknown
  > = {
    method: 'finance.news',
    description: '금융 뉴스를 검색합니다',
    authLevel: 'token',
    schema: z.object({
      query: z.string().optional(),
      symbols: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute(params) {
      if (!deps.newsAggregator) {
        throw createError(
          null,
          PROVIDER_UNAVAILABLE,
          'News aggregator unavailable (ALPHA_VANTAGE_KEY missing)',
        );
      }
      const limit = Math.min(params.limit ?? 20, 50);
      const articles = await deps.newsAggregator.fetchNews({
        query: params.query,
        symbols: params.symbols,
        limit,
      });
      return {
        articles: articles.map((a) => ({
          title: a.title,
          url: a.url,
          source: a.source,
          publishedAt: a.publishedAt,
          summary: a.summary,
          tickers: a.tickers ?? [],
        })),
        total: articles.length,
      };
    },
  };

  // -- finance.alert.create --
  const alertCreateHandler: RpcMethodHandler<
    {
      symbol: string;
      condition: 'price_above' | 'price_below' | 'change_percent' | 'news_match';
      threshold?: number;
      keyword?: string;
      cooldownMs?: number;
      userId?: string;
    },
    unknown
  > = {
    method: 'finance.alert.create',
    description: '가격/뉴스 알림을 생성합니다. 생성 직후 현재 조건을 1회 평가합니다.',
    authLevel: 'token',
    schema: z.object({
      symbol: z.string().min(1),
      condition: z.enum(['price_above', 'price_below', 'change_percent', 'news_match']),
      threshold: z.number().optional(),
      keyword: z.string().optional(),
      cooldownMs: z.number().int().min(60_000).optional(),
      userId: z.string().optional(),
    }),
    async execute(params) {
      if (!deps.alertStore) {
        throw createError(null, PROVIDER_UNAVAILABLE, 'Alert store unavailable');
      }
      // condition 타입별 필수 파라미터 검증
      if (
        ['price_above', 'price_below', 'change_percent'].includes(params.condition) &&
        params.threshold === undefined
      ) {
        throw createError(
          null,
          RpcErrors.INVALID_PARAMS,
          `condition=${params.condition} requires threshold`,
        );
      }
      if (params.condition === 'news_match' && !params.keyword) {
        throw createError(null, RpcErrors.INVALID_PARAMS, 'condition=news_match requires keyword');
      }

      const alert = await deps.alertStore.create({
        userId: params.userId ?? 'default',
        symbol: params.symbol.toUpperCase(),
        conditionType: params.condition,
        threshold: params.threshold,
        keyword: params.keyword,
        cooldownMs: params.cooldownMs ?? 900_000,
      });

      // 즉시 평가 1회
      let immediateTrigger = false;
      if (deps.evaluateAlertOnce) {
        try {
          immediateTrigger = await deps.evaluateAlertOnce(alert.id);
        } catch {
          // 평가 실패는 저장 유지 + 경고만
          immediateTrigger = false;
        }
      }

      return {
        alertId: alert.id,
        createdAt: alert.createdAt,
        immediateTrigger,
      };
    },
  };

  // -- finance.alert.list --
  const alertListHandler: RpcMethodHandler<{ symbol?: string; userId?: string }, unknown> = {
    method: 'finance.alert.list',
    description: '설정된 알림 목록을 조회합니다',
    authLevel: 'token',
    schema: z.object({
      symbol: z.string().optional(),
      userId: z.string().optional(),
    }),
    async execute(params) {
      if (!deps.alertStore) {
        throw createError(null, PROVIDER_UNAVAILABLE, 'Alert store unavailable');
      }
      const alerts = await deps.alertStore.list({
        userId: params.userId ?? 'default',
        symbol: params.symbol?.toUpperCase(),
      });
      return {
        alerts: alerts.map((a) => ({
          id: a.id,
          symbol: a.symbol,
          condition: a.conditionType,
          threshold: a.threshold,
          keyword: a.keyword,
          enabled: a.enabled ?? true,
          cooldownMs: a.cooldownMs,
          createdAt: a.createdAt,
          lastTriggeredAt: a.lastTriggeredAt ?? null,
        })),
        total: alerts.length,
      };
    },
  };

  // -- finance.portfolio.get --
  const portfolioGetHandler: RpcMethodHandler<Record<string, never>, unknown> = {
    method: 'finance.portfolio.get',
    description: '포트폴리오 스냅샷을 조회합니다 (거래 이력 제외 — Phase 25)',
    authLevel: 'token',
    schema: z.object({}),
    async execute() {
      if (!deps.portfolioStore) {
        return { holdings: [], summary: { currency: 'USD' } };
      }
      const portfolios = await deps.portfolioStore.list();
      const portfolio = portfolios[0];
      if (!portfolio) {
        return { holdings: [], summary: { currency: 'USD' } };
      }
      const holdings = await deps.portfolioStore.getHoldings(portfolio.id);
      return {
        portfolioId: portfolio.id,
        name: portfolio.name,
        holdings: holdings.map((h) => ({
          symbol: h.symbol,
          quantity: h.quantity,
          avgPrice: h.averageCost,
          currency: portfolio.currency,
        })),
        summary: {
          currency: portfolio.currency,
          totalHoldings: holdings.length,
        },
      };
    },
  };

  registerMethod(quoteHandler);
  registerMethod(newsHandler);
  registerMethod(alertCreateHandler);
  registerMethod(alertListHandler);
  registerMethod(portfolioGetHandler);
}
```

### 검증

- `pnpm --filter @finclaw/server build` 통과
- `AlertStore.list({userId, symbol})` 실제 시그니처 확인 — `packages/skills-finance/src/alerts/types.ts:107` 에서. 다르면 어댑트.
- `PortfolioStore.list()` / `getHoldings()` 실제 시그니처 확인 — 없으면 근접 메서드로 교체 (`getDefault()` 등).

---

## Todo 3: `main.ts` 에 finance RPC 등록 + handle 경로 수정 ✅

### 파일 목록

| 작업 | 파일 경로                     | LOC                |
| ---- | ----------------------------- | ------------------ |
| 수정 | `packages/server/src/main.ts` | +15, 기존 3줄 변경 |

### 주의사항

- Todo 1 에서 `registerAlertTools` 반환이 `AlertSkillHandle` 로 바뀜. 기존 `main.ts:195,204` 의 `alertMonitor.stop()` → `alertHandle.monitor.stop()` 로 경로 변경.
- `alertHandle.store` 와 `newsHandle.portfolioStore` 를 finance RPC 에 주입.
- `evaluateAlertOnce` 훅은 선택 — 없으면 finance.alert.create 의 즉시 평가 skip. 간단 구현: `alertHandle.monitor.evaluateOnce(alertId)` 추가 (alerts/monitor.ts 에 메서드 하나 추가). 없어도 PoC 동작 OK.

### 구현 코드 (diff 형태)

#### `packages/server/src/main.ts` 수정 지점

**① import 추가** (상단):

```typescript
import { registerFinanceMethods } from './gateway/rpc/methods/finance.js';
```

**② alerts 등록부 경로 변경** (line 195-206):

```typescript
// 변경 전
if (marketHandle && newsHandle) {
  const discordClient = discordAdapter.getClient();
  const alertMonitor = await registerAlertTools(toolRegistry, {
    /* ... */
  });
  lifecycle.register(async () => {
    await alertMonitor.stop();
  });
  logger.info('Alert monitor started');
}

// 변경 후
let alertHandle: AlertSkillHandle | undefined;
if (marketHandle && newsHandle) {
  const discordClient = discordAdapter.getClient();
  alertHandle = await registerAlertTools(toolRegistry, {
    /* ... 기존 deps ... */
  });
  lifecycle.register(async () => {
    await alertHandle!.monitor.stop();
  });
  logger.info('Alert monitor started');
}
```

**③ finance RPC 등록** (alert 블록 바로 다음):

```typescript
// Phase 23: finance.* RPC 배선
registerFinanceMethods({
  quoteService: marketHandle?.quoteService,
  newsAggregator: newsHandle?.aggregator,
  alertStore: alertHandle?.store,
  portfolioStore: newsHandle?.portfolioStore,
  evaluateAlertOnce: alertHandle
    ? async (alertId) => alertHandle!.monitor.evaluateOnce(alertId)
    : undefined,
});
logger.info('finance.* RPC methods registered');
```

**④ `AlertSkillHandle` import** (기존 `AlertMonitor` 대신):

```typescript
import type { AlertSkillHandle } from '@finclaw/skills-finance';
```

### 추가 작업: `alerts/monitor.ts` 에 `evaluateOnce` 추가 (선택)

```typescript
// packages/skills-finance/src/alerts/monitor.ts
export function createAlertMonitor(config): AlertMonitor {
  // ... 기존 ...
  return {
    start,
    stop,
    async evaluateOnce(alertId: string): Promise<boolean> {
      const alert = await store.get(alertId);
      if (!alert || !alert.enabled) return false;
      const evaluator = evaluators[alert.conditionType];
      const result = await evaluator.evaluate(alert);
      if (result.triggered) {
        await deliveryDispatcher.dispatch({ alert, result });
        return true;
      }
      return false;
    },
  };
}
```

### 검증

- `pnpm --filter @finclaw/server build` 통과
- `pnpm dev` 기동 시 로그: `finance.* RPC methods registered`
- `system.info` RPC → `methods` 에 `finance.quote`, `finance.news`, `finance.alert.create`, `finance.alert.list`, `finance.portfolio.get` 5개 포함

---

## Todo 4: `finance.test.ts` 재작성 ✅

### 파일 목록

| 작업 | 파일 경로                                                 | LOC              |
| ---- | --------------------------------------------------------- | ---------------- |
| 수정 | `packages/server/src/gateway/rpc/methods/finance.test.ts` | 전체 재작성 ~200 |

### 주의사항

- `registerFinanceMethods(deps)` 형태로 바뀌었으므로 테스트에서도 mock deps 주입.
- 각 테스트 전에 `clearMethods()` 호출 (기존 등록 청소).
- dispatch 호출하려면 `dispatchRpc` 또는 method handler 직접 실행. 후자가 단순.

### 구현 코드

```typescript
// packages/server/src/gateway/rpc/methods/finance.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearMethods, getRegisteredMethods } from '../index.js';
import { registerFinanceMethods } from './finance.js';

describe('finance.* RPC', () => {
  beforeEach(() => clearMethods());

  describe('registration', () => {
    it('registers 5 methods', () => {
      registerFinanceMethods({});
      const names = getRegisteredMethods();
      expect(names).toEqual(
        expect.arrayContaining([
          'finance.quote',
          'finance.news',
          'finance.alert.create',
          'finance.alert.list',
          'finance.portfolio.get',
        ]),
      );
    });
  });

  describe('finance.quote', () => {
    it('returns PROVIDER_UNAVAILABLE when quoteService missing', async () => {
      registerFinanceMethods({});
      // getMethod('finance.quote').execute(...) 호출하거나 dispatchRpc 사용
      // 실제 테스트는 구현 후 확정
    });

    it('calls getStockPrice for stock kind', async () => {
      const quoteService = {
        getStockPrice: vi
          .fn()
          .mockResolvedValue({ price: 187, currency: 'USD', provider: 'alpha_vantage' }),
        getCryptoPrice: vi.fn(),
        getForexRate: vi.fn(),
      };
      registerFinanceMethods({ quoteService: quoteService as never });
      // ...
      expect(quoteService.getStockPrice).toHaveBeenCalledWith('AAPL');
    });

    it('auto-detects crypto from known symbols', async () => {
      const quoteService = {
        getCryptoPrice: vi.fn().mockResolvedValue({ price: 70000, currency: 'USD' }),
      };
      registerFinanceMethods({ quoteService: quoteService as never });
      // params: { symbol: 'BTC' } — kind 생략
      expect(quoteService.getCryptoPrice).toHaveBeenCalled();
    });

    it('auto-detects forex from XXX/YYY pattern', async () => {
      // symbol: 'USD/KRW' → forex
    });
  });

  describe('finance.news', () => {
    it('clamps limit to max 50', async () => {
      const aggregator = { fetchNews: vi.fn().mockResolvedValue([]) };
      registerFinanceMethods({ newsAggregator: aggregator as never });
      // params: { limit: 999 } → aggregator 호출 시 limit=50
      expect(aggregator.fetchNews).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });
  });

  describe('finance.alert.create', () => {
    it('requires threshold for price_above', async () => {
      const store = { create: vi.fn() };
      registerFinanceMethods({ alertStore: store as never });
      // params: { symbol: 'AAPL', condition: 'price_above' } — threshold 생략
      // expect INVALID_PARAMS error
    });

    it('calls evaluateAlertOnce and reports immediateTrigger', async () => {
      const store = { create: vi.fn().mockResolvedValue({ id: 'a1', createdAt: Date.now() }) };
      const evaluate = vi.fn().mockResolvedValue(true);
      registerFinanceMethods({ alertStore: store as never, evaluateAlertOnce: evaluate });
      // expect immediateTrigger: true
    });
  });

  describe('finance.portfolio.get', () => {
    it('returns empty when no portfolioStore', async () => {
      registerFinanceMethods({});
      // expect { holdings: [], summary: { currency: 'USD' } }
    });
  });
});
```

### 검증

- `pnpm --filter @finclaw/server test` — 본 파일 전 케이스 통과
- 모든 케이스: 에러 코드 / 반환 구조 / mock 호출 인자

---

## Todo 5: `agent.ts` 3개 메서드 실구현 ✅

### 파일 목록

| 작업 | 파일 경로                                          | LOC              |
| ---- | -------------------------------------------------- | ---------------- |
| 수정 | `packages/server/src/gateway/rpc/methods/agent.ts` | 전체 재작성 ~180 |

### 주의사항

- **단일 에이전트 전제**: Phase 23 는 `finclaw-partner` 1개만. Phase 24 의 라우팅 도입 시 다수 지원.
- **one-shot Runner 사용**: `runnerFactory(dispatcher)` 로 Runner 생성. dispatcher 는 `new ExecutionToolDispatcher({ registry: toolRegistry })`. 세션 컨텍스트 없이 prompt 만 주입.
- **큐잉 lane**: `lanes.getOrCreate('agent-run', { maxConcurrent: 1, maxQueueSize: 10, waitTimeoutMs: 120_000 })`. 해당 lane 의 `run(() => runner.execute(...))` 로 감쌈.
- **감사 로그 (DB 저장 없음, Phase 25 로 미룸)**: `logger.info({event: 'agent.run.started', ...})` / `logger.info({event: 'agent.run.completed', ...})` / `logger.warn({event: 'agent.run.failed', ...})` 3개 지점.
- **Runner API**: 실제 `Runner.execute(messages, options)` 시그니처는 `packages/agent/src/execution/Runner.ts` 에서 확인. 기존 `execution-adapter.ts:137` 의 호출 패턴을 참고. `messages` 는 `[{role:'user', content: prompt}]` 형태 + system prompt 는 Runner 생성 시 또는 execute 옵션으로.
- **activeRuns 카운터**: 서버 프로세스 내 Map 또는 단순 변수. 동시 1개 제약이면 boolean 1개로도 충분.

### 구현 코드

#### `packages/server/src/gateway/rpc/methods/agent.ts` (전체 재작성)

```typescript
// packages/server/src/gateway/rpc/methods/agent.ts
import { z } from 'zod/v4';
import type { Logger } from '@finclaw/infra';
import type {
  ConcurrencyLaneManager,
  ExecutionToolDispatcher,
  ProfileHealthMonitor,
  Runner,
  RunnerFactory,
  ToolRegistry,
} from '@finclaw/agent';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';
import { createError, RpcErrors } from '../errors.js';

const AGENT_NOT_FOUND = -32020;
const AGENT_RUN_STREAM_UNSUPPORTED = -32021;

export interface AgentRpcDeps {
  readonly toolRegistry: ToolRegistry;
  readonly runnerFactory: RunnerFactory;
  readonly lanes: ConcurrencyLaneManager;
  readonly healthMonitor: ProfileHealthMonitor;
  readonly systemPrompt: string;
  readonly logger: Logger;
}

interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

const AGENTS: readonly AgentInfo[] = [
  {
    id: 'finclaw-partner',
    name: 'FinClaw Personal Finance Partner',
    description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
  },
];

// activeRuns 는 per-agent 카운터. 동시 1개 lane 이지만 status 응답용.
const activeRuns = new Map<string, number>();
const totalCalls = new Map<string, number>();
const lastCallAt = new Map<string, number>();
const lastError = new Map<string, string | undefined>();

export function registerAgentMethods(deps: AgentRpcDeps): void {
  // -- agent.list --
  const listHandler: RpcMethodHandler<Record<string, never>, unknown> = {
    method: 'agent.list',
    description: '등록된 에이전트 목록을 조회합니다',
    authLevel: 'token',
    schema: z.object({}),
    async execute() {
      return {
        agents: AGENTS.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          toolCount: deps.toolRegistry.list().length,
        })),
      };
    },
  };

  // -- agent.status --
  const statusHandler: RpcMethodHandler<{ agentId: string }, unknown> = {
    method: 'agent.status',
    description: '에이전트 상태를 조회합니다',
    authLevel: 'token',
    schema: z.object({ agentId: z.string() }),
    async execute(params) {
      if (!AGENTS.find((a) => a.id === params.agentId)) {
        throw createError(null, AGENT_NOT_FOUND, `Unknown agent: ${params.agentId}`);
      }
      const health = deps.healthMonitor.getStatus?.(params.agentId) ?? null;
      const active = activeRuns.get(params.agentId) ?? 0;
      return {
        agentId: params.agentId,
        status: active > 0 ? 'busy' : 'idle',
        activeRuns: active,
        totalCalls: totalCalls.get(params.agentId) ?? 0,
        lastCallAt: lastCallAt.get(params.agentId) ?? null,
        lastError: lastError.get(params.agentId) ?? null,
        health,
      };
    },
  };

  // -- agent.run --
  const runHandler: RpcMethodHandler<
    { agentId: string; prompt: string; maxTurns?: number; timeoutMs?: number; stream?: boolean },
    unknown
  > = {
    method: 'agent.run',
    description: '에이전트를 1회 실행합니다. 동일 agentId 는 순차 처리(큐잉)됩니다.',
    authLevel: 'token',
    schema: z.object({
      agentId: z.string(),
      prompt: z.string().min(1).max(10_000),
      maxTurns: z.number().int().min(1).max(20).optional(),
      timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      stream: z.boolean().optional(),
    }),
    async execute(params) {
      if (!AGENTS.find((a) => a.id === params.agentId)) {
        throw createError(null, AGENT_NOT_FOUND, `Unknown agent: ${params.agentId}`);
      }
      if (params.stream) {
        throw createError(
          null,
          AGENT_RUN_STREAM_UNSUPPORTED,
          'Streaming not supported on agent.run. Use chat.* for streaming.',
        );
      }

      const lane = deps.lanes.getOrCreate('agent-run', {
        maxConcurrent: 1,
        maxQueueSize: 10,
        waitTimeoutMs: 120_000,
      });

      const startedAt = Date.now();
      deps.logger.info({
        event: 'agent.run.started',
        agentId: params.agentId,
        promptLength: params.prompt.length,
      });

      activeRuns.set(params.agentId, (activeRuns.get(params.agentId) ?? 0) + 1);

      try {
        const result = await lane.run(async () => {
          const dispatcher = /* ExecutionToolDispatcher 생성. 실제 생성 방식은
                             execution-adapter.ts 참고 */ null as never;
          const runner: Runner = deps.runnerFactory(dispatcher);
          // Runner.execute() 실제 시그니처 확인 후 어댑트
          return await runner.execute({
            messages: [{ role: 'user', content: params.prompt }],
            system: deps.systemPrompt,
            maxTurns: params.maxTurns ?? 5,
            timeoutMs: params.timeoutMs ?? 60_000,
          });
        });

        const durationMs = Date.now() - startedAt;
        totalCalls.set(params.agentId, (totalCalls.get(params.agentId) ?? 0) + 1);
        lastCallAt.set(params.agentId, Date.now());
        lastError.delete(params.agentId);

        deps.logger.info({
          event: 'agent.run.completed',
          agentId: params.agentId,
          durationMs,
          tokensInput: result.tokenUsage?.input,
          tokensOutput: result.tokenUsage?.output,
          toolCallCount: result.toolCalls?.length ?? 0,
        });

        return {
          agentId: params.agentId,
          output: result.output ?? '',
          toolCalls: (result.toolCalls ?? []).map((tc) => ({
            name: tc.name,
            input: tc.input,
            output: tc.output,
            durationMs: tc.durationMs,
          })),
          tokenUsage: result.tokenUsage ?? { input: 0, output: 0 },
          durationMs,
          stopReason: result.stopReason ?? 'end_turn',
        };
      } catch (err) {
        const msg = (err as Error).message;
        lastError.set(params.agentId, msg);
        deps.logger.warn({
          event: 'agent.run.failed',
          agentId: params.agentId,
          error: msg,
          durationMs: Date.now() - startedAt,
        });
        throw createError(null, RpcErrors.INTERNAL_ERROR, `agent.run failed: ${msg}`);
      } finally {
        activeRuns.set(params.agentId, Math.max(0, (activeRuns.get(params.agentId) ?? 1) - 1));
      }
    },
  };

  registerMethod(listHandler);
  registerMethod(statusHandler);
  registerMethod(runHandler);
}
```

### 검증

- `pnpm --filter @finclaw/server build` 통과
- **`ExecutionToolDispatcher` 생성 방식**은 `execution-adapter.ts` 에서 참고. 생성자 시그니처에 맞게 교체.
- **`Runner.execute()` 반환 타입**은 실제 API 확인 후 필드명 어댑트 (`output` vs `content` 등).
- **`healthMonitor.getStatus()`** 가 없으면 생략 또는 다른 메서드 (`getSnapshot()` 등).

---

## Todo 6: `main.ts` 에 agent RPC 등록 ✅

### 파일 목록

| 작업 | 파일 경로                     | LOC |
| ---- | ----------------------------- | --- |
| 수정 | `packages/server/src/main.ts` | +15 |

### 주의사항

- finance RPC 등록 직후에 배치. 순서: toolRegistry 등록 완료 → registerFinanceMethods → registerAgentMethods.
- `healthMonitor` 는 `main.ts` 의 기존 `profileHealthMonitor` 인스턴스 재사용.
- `DEFAULT_SYSTEM_PROMPT` 는 이미 상수로 있음 (Phase 22 에서 작성). 그대로 주입.

### 구현 코드

**① import 추가** (상단):

```typescript
import { registerAgentMethods } from './gateway/rpc/methods/agent.js';
```

**② 등록 호출** (registerFinanceMethods 직후):

```typescript
registerAgentMethods({
  toolRegistry,
  runnerFactory,
  lanes,
  healthMonitor: profileHealthMonitor, // 기존 인스턴스 이름 확인
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  logger,
});
logger.info('agent.* RPC methods registered');
```

### 검증

- 기동 로그: `agent.* RPC methods registered`
- `curl ... method:"system.info"` → methods 에 `agent.list`, `agent.status`, `agent.run` 포함

---

## Todo 7: `agent.test.ts` 재작성 ✅

### 파일 목록

| 작업 | 파일 경로                                                                                                                       | LOC  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 수정 | `packages/server/src/gateway/rpc/methods/agent.test.ts` (기존 chat.test.ts 는 있으나 agent.test.ts 는 없을 수 있음 — 신규 작성) | ~150 |

### 주의사항

- mock: runnerFactory 는 `() => mockRunner`, mockRunner.execute 는 vi.fn().
- ConcurrencyLaneManager 는 실제 인스턴스 사용 (단순해서 mock 불필요). 또는 mock.

### 구현 코드

```typescript
// packages/server/src/gateway/rpc/methods/agent.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConcurrencyLaneManager } from '@finclaw/infra';
import { clearMethods, getRegisteredMethods } from '../index.js';
import { registerAgentMethods } from './agent.js';

function makeDeps(overrides = {}) {
  return {
    toolRegistry: { list: () => ['get_current_datetime'] } as never,
    runnerFactory: vi.fn(() => ({
      execute: vi.fn().mockResolvedValue({
        output: 'result',
        toolCalls: [],
        tokenUsage: { input: 10, output: 5 },
        stopReason: 'end_turn',
      }),
    })) as never,
    lanes: new ConcurrencyLaneManager(),
    healthMonitor: { getStatus: () => ({ profileId: 'default', healthy: true }) } as never,
    systemPrompt: 'test system prompt',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ...overrides,
  };
}

describe('agent.* RPC', () => {
  beforeEach(() => clearMethods());

  it('registers 3 methods', () => {
    registerAgentMethods(makeDeps());
    expect(getRegisteredMethods()).toEqual(
      expect.arrayContaining(['agent.list', 'agent.status', 'agent.run']),
    );
  });

  describe('agent.list', () => {
    it('returns finclaw-partner agent', async () => {
      registerAgentMethods(makeDeps());
      // dispatch agent.list 또는 handler 직접 실행
      // expect(result.agents[0].id).toBe('finclaw-partner')
    });
  });

  describe('agent.run', () => {
    it('rejects unknown agentId', async () => {
      registerAgentMethods(makeDeps());
      // execute with { agentId: 'unknown', prompt: 'hi' }
      // expect AGENT_NOT_FOUND error
    });

    it('rejects stream=true', async () => {
      registerAgentMethods(makeDeps());
      // execute with stream: true
      // expect AGENT_RUN_STREAM_UNSUPPORTED
    });

    it('queues concurrent requests on same agent', async () => {
      // 2개 동시 실행 → 두 번째는 lane queue 에 들어감
      // Runner.execute 가 각 요청당 1회씩, 순차로 호출되는지 확인
    });

    it('updates activeRuns counter', async () => {
      // before: 0, during: 1, after: 0
    });

    it('records lastError on failure', async () => {
      const failingRunner = vi.fn(() => ({
        execute: vi.fn().mockRejectedValue(new Error('boom')),
      }));
      registerAgentMethods(makeDeps({ runnerFactory: failingRunner }));
      // execute → error
      // then agent.status → lastError === 'boom'
    });
  });
});
```

### 검증

- `pnpm --filter @finclaw/server test agent.test` — 본 파일 통과

---

## Todo 8: `app-gateway` 래퍼 메서드 추가

### 파일 목록

| 작업 | 파일 경로                         | LOC |
| ---- | --------------------------------- | --- |
| 수정 | `packages/web/src/app-gateway.ts` | +60 |

### 주의사항

- 기존 `send(method, params)` 는 유지. 그 위에 **타입드 래퍼** 추가.
- 뷰 쪽에서 `gateway.finance.quote({symbol: 'AAPL'})` 형태 호출 가능하게.

### 구현 코드

```typescript
// packages/web/src/app-gateway.ts 끝 부분에 추가

export interface FinanceQuote {
  symbol: string;
  kind: 'stock' | 'crypto' | 'forex';
  price: number;
  currency: string;
  change?: number;
  changePercent?: number;
  volume?: number;
  timestamp: number;
  provider: string;
  cached: boolean;
}

export interface FinanceAlert {
  id: string;
  symbol: string;
  condition: 'price_above' | 'price_below' | 'change_percent' | 'news_match';
  threshold?: number;
  keyword?: string;
  enabled: boolean;
  cooldownMs: number;
  createdAt: number;
  lastTriggeredAt: number | null;
}

export interface PortfolioSnapshot {
  portfolioId?: string;
  name?: string;
  holdings: Array<{ symbol: string; quantity: number; avgPrice: number; currency: string }>;
  summary: { currency: string; totalHoldings?: number };
}

export interface FinanceClient {
  quote(params: { symbol: string; kind?: 'stock' | 'crypto' | 'forex' }): Promise<FinanceQuote>;
  news(params: {
    query?: string;
    symbols?: string[];
    limit?: number;
  }): Promise<{ articles: unknown[]; total: number }>;
  alertCreate(params: {
    symbol: string;
    condition: string;
    threshold?: number;
    keyword?: string;
    cooldownMs?: number;
  }): Promise<{ alertId: string; createdAt: number; immediateTrigger: boolean }>;
  alertList(params?: { symbol?: string }): Promise<{ alerts: FinanceAlert[]; total: number }>;
  portfolioGet(): Promise<PortfolioSnapshot>;
}

export interface AgentClient {
  list(): Promise<{
    agents: Array<{ id: string; name: string; description: string; toolCount: number }>;
  }>;
  status(
    agentId: string,
  ): Promise<{ agentId: string; status: string; activeRuns: number; totalCalls: number }>;
  run(params: { agentId: string; prompt: string; maxTurns?: number }): Promise<{
    output: string;
    toolCalls: unknown[];
    tokenUsage: { input: number; output: number };
    durationMs: number;
  }>;
}

export function createFinanceClient(gateway: AppGateway): FinanceClient {
  return {
    quote: (p) => gateway.send('finance.quote', p) as Promise<FinanceQuote>,
    news: (p) => gateway.send('finance.news', p) as never,
    alertCreate: (p) => gateway.send('finance.alert.create', p) as never,
    alertList: (p = {}) => gateway.send('finance.alert.list', p) as never,
    portfolioGet: () => gateway.send('finance.portfolio.get', {}) as never,
  };
}

export function createAgentClient(gateway: AppGateway): AgentClient {
  return {
    list: () => gateway.send('agent.list', {}) as never,
    status: (agentId) => gateway.send('agent.status', { agentId }) as never,
    run: (p) => gateway.send('agent.run', p) as never,
  };
}
```

### 검증

- `pnpm --filter @finclaw/web build` 통과
- `import { createFinanceClient } from './app-gateway.js'` 타입 체크

---

## Todo 9: `market-view` 배선

### 파일 목록

| 작업 | 파일 경로                               | LOC              |
| ---- | --------------------------------------- | ---------------- |
| 수정 | `packages/web/src/views/market-view.ts` | 전체 재작성 ~150 |

### 주의사항

- Phase 22 web 은 Lit + `@customElement` 사용 (확인된 파일 구조).
- `app.ts` 에서 gateway 를 어떻게 주입하는지 확인 필요. `globalThis` 또는 `app-context` 패턴 예상. 기존 chat-view 참고.
- 수동 refresh 버튼 + 최근 5개 심볼 로컬 상태.
- 에러 UX: API 키 누락 → 친화 메시지.

### 구현 코드

```typescript
// packages/web/src/views/market-view.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { AppGateway, FinanceClient, FinanceQuote } from '../app-gateway.js';
import { createFinanceClient } from '../app-gateway.js';

@customElement('market-view')
export class MarketView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 16px;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 20px;
      color: var(--text-primary, #e6edf3);
    }
    form {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    input,
    select {
      background: var(--input-bg, #0d1117);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 14px;
    }
    button {
      background: var(--accent, #238636);
      color: white;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
    }
    .card {
      border: 1px solid var(--border, #30363d);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 8px;
    }
    .symbol {
      font-size: 18px;
      font-weight: 600;
    }
    .price {
      font-size: 24px;
      color: var(--accent-price, #3fb950);
    }
    .error {
      color: var(--err, #f85149);
      padding: 12px;
      border: 1px solid var(--err, #f85149);
      border-radius: 6px;
    }
    .meta {
      color: var(--text-secondary, #8b949e);
      font-size: 12px;
      margin-top: 4px;
    }
  `;

  @property({ attribute: false })
  gateway!: AppGateway;

  @state() private symbol = '';
  @state() private kind: 'stock' | 'crypto' | 'forex' | '' = '';
  @state() private quotes: FinanceQuote[] = [];
  @state() private loading = false;
  @state() private error = '';

  private client!: FinanceClient;

  override connectedCallback() {
    super.connectedCallback();
    this.client = createFinanceClient(this.gateway);
  }

  private async onSubmit(e: Event) {
    e.preventDefault();
    if (!this.symbol.trim()) return;
    this.loading = true;
    this.error = '';
    try {
      const quote = await this.client.quote({
        symbol: this.symbol.trim().toUpperCase(),
        kind: this.kind || undefined,
      });
      this.quotes = [quote, ...this.quotes.filter((q) => q.symbol !== quote.symbol)].slice(0, 5);
    } catch (err) {
      this.error = (err as Error).message || '조회 실패';
    } finally {
      this.loading = false;
    }
  }

  override render() {
    return html`
      <h2>Market</h2>
      <form @submit=${this.onSubmit}>
        <input
          type="text"
          placeholder="AAPL / BTC / USD/KRW"
          .value=${this.symbol}
          @input=${(e: Event) => (this.symbol = (e.target as HTMLInputElement).value)}
        />
        <select
          @change=${(e: Event) => (this.kind = (e.target as HTMLSelectElement).value as never)}
        >
          <option value="">자동판별</option>
          <option value="stock">주식</option>
          <option value="crypto">암호화폐</option>
          <option value="forex">외환</option>
        </select>
        <button type="submit" ?disabled=${this.loading}>
          ${this.loading ? '조회 중...' : '조회'}
        </button>
      </form>

      ${this.error ? html`<div class="error">${this.error}</div>` : ''}
      ${this.quotes.map(
        (q) => html`
          <div class="card">
            <div class="symbol">${q.symbol} <span class="meta">(${q.kind})</span></div>
            <div class="price">${q.price.toLocaleString()} ${q.currency}</div>
            ${q.changePercent !== undefined
              ? html`<div class="meta">변동 ${q.changePercent.toFixed(2)}%</div>`
              : ''}
            <div class="meta">
              ${q.provider} · ${new Date(q.timestamp).toLocaleTimeString()}
              ${q.cached ? '(캐시)' : ''}
            </div>
          </div>
        `,
      )}
    `;
  }
}
```

### 검증

- `pnpm dev` → 브라우저 Market 탭
- `AAPL` 입력 → 카드 렌더
- `INVALID_SYMBOL` 류 에러 → 빨간 박스

---

## Todo 10: `portfolio-view` 배선

### 파일 목록

| 작업 | 파일 경로                                  | LOC              |
| ---- | ------------------------------------------ | ---------------- |
| 수정 | `packages/web/src/views/portfolio-view.ts` | 전체 재작성 ~100 |

### 구현 코드

```typescript
// packages/web/src/views/portfolio-view.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { AppGateway, FinanceClient, PortfolioSnapshot } from '../app-gateway.js';
import { createFinanceClient } from '../app-gateway.js';

@customElement('portfolio-view')
export class PortfolioView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 16px;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border, #30363d);
    }
    th {
      color: var(--text-secondary, #8b949e);
      font-weight: 500;
    }
    .empty {
      padding: 32px;
      text-align: center;
      color: var(--text-secondary, #8b949e);
    }
    .error {
      color: var(--err, #f85149);
      padding: 12px;
    }
  `;

  @property({ attribute: false }) gateway!: AppGateway;
  @state() private snapshot: PortfolioSnapshot | null = null;
  @state() private loading = true;
  @state() private error = '';
  private client!: FinanceClient;

  override connectedCallback() {
    super.connectedCallback();
    this.client = createFinanceClient(this.gateway);
    void this.load();
  }

  private async load() {
    this.loading = true;
    this.error = '';
    try {
      this.snapshot = await this.client.portfolioGet();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  override render() {
    if (this.loading) return html`<div>Loading...</div>`;
    if (this.error) return html`<div class="error">${this.error}</div>`;
    const holdings = this.snapshot?.holdings ?? [];
    if (holdings.length === 0) {
      return html`
        <h2>Portfolio</h2>
        <div class="empty">
          포트폴리오에 종목이 없습니다.<br />
          (거래 기록·편집 기능은 Phase 25 예정)
        </div>
      `;
    }
    return html`
      <h2>Portfolio — ${this.snapshot?.name ?? 'Default'}</h2>
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>수량</th>
            <th>평균단가</th>
            <th>통화</th>
          </tr>
        </thead>
        <tbody>
          ${holdings.map(
            (h) => html`
              <tr>
                <td>${h.symbol}</td>
                <td>${h.quantity}</td>
                <td>${h.avgPrice.toLocaleString()}</td>
                <td>${h.currency}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }
}
```

### 검증

- 브라우저 Portfolio 탭 → 테이블 or 빈 상태 메시지
- DB 에 레코드 있으면 행 표시

---

## Todo 11: `alerts-view` 배선

### 파일 목록

| 작업 | 파일 경로                               | LOC              |
| ---- | --------------------------------------- | ---------------- |
| 수정 | `packages/web/src/views/alerts-view.ts` | 전체 재작성 ~180 |

### 주의사항

- 추가 폼 (symbol / condition / threshold or keyword / submit).
- 삭제 RPC (`finance.alert.remove`) 는 Phase 23 범위 밖 — 삭제 버튼은 **미구현** 으로 두고 "채팅에서 `remove_alert` 사용" 안내.
- 리스트 자동 로드 + 폼 제출 후 리스트 재로드.

### 구현 코드

```typescript
// packages/web/src/views/alerts-view.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { AppGateway, FinanceAlert, FinanceClient } from '../app-gateway.js';
import { createFinanceClient } from '../app-gateway.js';

type AlertCondition = 'price_above' | 'price_below' | 'change_percent' | 'news_match';

@customElement('alerts-view')
export class AlertsView extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 16px;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 20px;
    }
    form {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    input,
    select {
      background: var(--input-bg, #0d1117);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      padding: 6px 10px;
      border-radius: 6px;
    }
    button {
      background: var(--accent, #238636);
      color: white;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border, #30363d);
    }
    .triggered {
      color: var(--accent-price, #3fb950);
      font-size: 13px;
      margin-top: 8px;
    }
    .hint {
      color: var(--text-secondary, #8b949e);
      font-size: 12px;
      margin-top: 16px;
    }
    .error {
      color: var(--err, #f85149);
    }
  `;

  @property({ attribute: false }) gateway!: AppGateway;
  @state() private alerts: FinanceAlert[] = [];
  @state() private loading = true;
  @state() private error = '';
  @state() private lastTrigger = '';

  // form state
  @state() private symbol = '';
  @state() private condition: AlertCondition = 'price_above';
  @state() private threshold = '';
  @state() private keyword = '';

  private client!: FinanceClient;

  override connectedCallback() {
    super.connectedCallback();
    this.client = createFinanceClient(this.gateway);
    void this.load();
  }

  private async load() {
    this.loading = true;
    try {
      const result = await this.client.alertList();
      this.alerts = result.alerts;
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private async onSubmit(e: Event) {
    e.preventDefault();
    this.error = '';
    this.lastTrigger = '';
    try {
      const params: Parameters<FinanceClient['alertCreate']>[0] = {
        symbol: this.symbol.toUpperCase(),
        condition: this.condition,
      };
      if (this.condition === 'news_match') params.keyword = this.keyword;
      else params.threshold = parseFloat(this.threshold);
      const result = await this.client.alertCreate(params);
      if (result.immediateTrigger) {
        this.lastTrigger = `이미 조건 충족 — 즉시 알림 발사 (#${result.alertId})`;
      }
      this.symbol = '';
      this.threshold = '';
      this.keyword = '';
      await this.load();
    } catch (err) {
      this.error = (err as Error).message;
    }
  }

  override render() {
    return html`
      <h2>Alerts</h2>
      <form @submit=${this.onSubmit}>
        <input
          placeholder="Symbol"
          .value=${this.symbol}
          @input=${(e: Event) => (this.symbol = (e.target as HTMLInputElement).value)}
        />
        <select
          @change=${(e: Event) =>
            (this.condition = (e.target as HTMLSelectElement).value as AlertCondition)}
        >
          <option value="price_above">가격 상향</option>
          <option value="price_below">가격 하향</option>
          <option value="change_percent">변동률</option>
          <option value="news_match">뉴스 키워드</option>
        </select>
        ${this.condition === 'news_match'
          ? html`<input
              placeholder="키워드"
              .value=${this.keyword}
              @input=${(e: Event) => (this.keyword = (e.target as HTMLInputElement).value)}
            />`
          : html`<input
              placeholder="임계값"
              type="number"
              .value=${this.threshold}
              @input=${(e: Event) => (this.threshold = (e.target as HTMLInputElement).value)}
            />`}
        <button type="submit">추가</button>
      </form>

      ${this.lastTrigger ? html`<div class="triggered">${this.lastTrigger}</div>` : ''}
      ${this.error ? html`<div class="error">${this.error}</div>` : ''}
      ${this.loading
        ? html`<div>Loading...</div>`
        : this.alerts.length === 0
          ? html`<div>알림 없음</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>조건</th>
                    <th>임계값/키워드</th>
                    <th>상태</th>
                    <th>생성일</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.alerts.map(
                    (a) => html`
                      <tr>
                        <td>${a.symbol}</td>
                        <td>${a.condition}</td>
                        <td>${a.threshold ?? a.keyword ?? '-'}</td>
                        <td>${a.enabled ? '활성' : '비활성'}</td>
                        <td>${new Date(a.createdAt).toLocaleDateString()}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            `}
      <div class="hint">
        삭제는 채팅에서 <code>!finclaw</code> 로 "알림 X 제거" 요청 (Phase 23 는 추가만).
      </div>
    `;
  }
}
```

### 검증

- Alerts 탭 → 리스트 렌더
- "AAPL / 가격상향 / 200" 추가 → 리스트 갱신
- 이미 충족 조건 (현재가 > 200) 으로 추가 → `lastTrigger` 메시지 표시

---

## Todo 12: E2E 수동 검증

### 검증 체크리스트

```
서버 기동:
  [ ] pnpm dev → 에러 없이 기동
  [ ] 로그에 "finance.* RPC methods registered" 출력
  [ ] 로그에 "agent.* RPC methods registered" 출력
  [ ] curl http://localhost:PORT/info → methods 에 8개 신규 메서드 포함

finance.* 직접 호출 (curl):
  [ ] finance.quote {symbol: "AAPL"} → 가격 JSON
  [ ] finance.quote {symbol: "BTC"} → crypto 자동판별 후 가격
  [ ] finance.quote {symbol: "USD/KRW"} → forex 응답
  [ ] finance.quote {symbol: "INVALIDXX"} → INVALID_SYMBOL 에러
  [ ] finance.news {query: "Tesla"} → articles 배열
  [ ] finance.alert.create {symbol:"AAPL",condition:"price_above",threshold:9999} → immediateTrigger:false
  [ ] finance.alert.create {symbol:"AAPL",condition:"price_above",threshold:1} → immediateTrigger:true (현재가 > 1)
  [ ] finance.alert.list → 위 알림 포함
  [ ] finance.portfolio.get → holdings (빈 상태면 빈 배열)

agent.* 직접 호출:
  [ ] agent.list → finclaw-partner 1개
  [ ] agent.run {agentId:"finclaw-partner", prompt:"지금 몇 시야?"} → get_current_datetime 호출 후 응답
  [ ] agent.run {agentId:"finclaw-partner", prompt:"AAPL 시세"} → get_stock_price 호출 + toolCalls 배열
  [ ] agent.run {agentId:"unknown", ...} → AGENT_NOT_FOUND 에러
  [ ] agent.run {stream:true} → AGENT_RUN_STREAM_UNSUPPORTED
  [ ] 동시 2개 agent.run 요청 → 두 번째가 첫 번째 완료 후 시작 (로그 시간 차 확인)
  [ ] agent.run 1회 성공 후 agent.status → totalCalls 증가

Web UI:
  [ ] localhost 웹 접속, Market 탭 열림
  [ ] Market 에 AAPL 입력 → 카드 렌더, 가격 확인
  [ ] 같은 AAPL 재입력 → cached:true 표시
  [ ] Market 에 INVALIDXX → 에러 박스
  [ ] Portfolio 탭 → 빈 상태 메시지 또는 테이블
  [ ] Alerts 탭 → 기존 알림 리스트
  [ ] Alerts 새 알림 추가 → 즉시 목록에 반영
  [ ] Alerts 즉시 충족 조건 추가 → 삼각색 "이미 충족" 메시지

회귀:
  [ ] Phase 22 의 Discord !finclaw 동작 유지 (금융 파트너 페르소나 응답)
  [ ] 기존 chat.send WebSocket 스트리밍 유지
  [ ] !finclaw status 출력 유지
  [ ] 도구 11개 전부 여전히 Claude 에 노출 (agent.run 으로 "AAPL 시세" 시 get_stock_price 호출 확인)

빌드·테스트·타입:
  [ ] pnpm build 통과
  [ ] tsgo --noEmit 통과
  [ ] pnpm lint 통과
  [ ] pnpm test 전체 통과 (finance.test / agent.test 포함)
```

### Stretch (시간 남으면)

- `!finclaw status` 에 "RPC methods: 19 loaded, agent runners: 1 registered" 라인 추가
- Market 뷰에 "새로고침" 버튼 (재조회)
- Portfolio 뷰에 "Phase 25 에서 거래 편집 예정" 배너

---

## Done 조건

- Todo 1~12 전부 완료
- 위 E2E 체크리스트 모두 통과
- commit 메시지: `feat(phase23): finance.*/agent.* RPC 배선 + Web UI 3뷰 활성화 (todos 1-12)`
