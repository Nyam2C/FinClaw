# Phase 16 TODO: 금융 스킬 — 시장 데이터

> plan.md 기반 구현 순서별 상세 TODO. 각 단계에 파일 경로, 코드 전문, 검증 방법을 기술한다.

---

## 사전 작업 (Pre-work)

### P-1. storage: getCachedData/setCachedData/getStaleCachedData export 추가

**파일:** `packages/storage/src/tables/market-cache.ts`

`getStaleCachedData` 함수를 추가한다. 만료 여부와 무관하게 캐시를 반환하여 graceful degradation에 사용한다.

```typescript
// 기존 함수 뒤에 추가 (~5줄)
export function getStaleCachedData<T>(db: DatabaseSync, key: string): T | null {
  const row = db.prepare('SELECT data FROM market_cache WHERE key = ?').get(key) as unknown as
    | { data: string }
    | undefined;

  if (!row) {
    return null;
  }
  return JSON.parse(row.data) as T;
}
```

**파일:** `packages/storage/src/index.ts`

barrel export에 `getCachedData`, `setCachedData`, `getStaleCachedData`를 추가한다.

```typescript
// 기존 market-cache 관련 export 라인을 교체:
// AS-IS:
export { CACHE_TTL, type MarketCacheEntry };
export { purgeExpiredCache } from './tables/market-cache.js';

// TO-BE:
export { CACHE_TTL, type MarketCacheEntry };
export {
  getCachedData,
  setCachedData,
  getStaleCachedData,
  purgeExpiredCache,
} from './tables/market-cache.js';
```

**검증:**

```bash
cd packages/storage && npx tsc --noEmit
```

---

### P-2. skills-finance: package.json에 infra, agent 의존성 추가

**파일:** `packages/skills-finance/package.json`

```json
{
  "name": "@finclaw/skills-finance",
  "version": "0.1.0",
  "private": true,
  "files": ["dist"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@finclaw/agent": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "@finclaw/storage": "workspace:*",
    "@finclaw/types": "workspace:*",
    "zod": "^4.0.0"
  }
}
```

추가 항목: `@finclaw/agent`, `@finclaw/infra`, `zod`

**검증:**

```bash
pnpm install
```

---

### P-3. skills-finance: tsconfig.json에 infra, agent references 추가

**파일:** `packages/skills-finance/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [
    { "path": "../types" },
    { "path": "../storage" },
    { "path": "../infra" },
    { "path": "../agent" }
  ]
}
```

추가 항목: `../infra`, `../agent`

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

## 구현 (10단계)

### Step 1. types.ts — 프로바이더 전용 확장 타입

**파일:** `packages/skills-finance/src/market/types.ts` (신규, ~80줄)

```typescript
// packages/skills-finance/src/market/types.ts — 프로바이더 전용 확장 타입
// @finclaw/types의 기존 타입을 재사용하고, 이 phase에서만 필요한 확장 타입을 정의한다.

import type {
  MarketQuote,
  OHLCVCandle,
  TickerSymbol,
  CurrencyCode,
} from '@finclaw/types/finance.js';

// 기존 타입 re-export (편의용)
export type { MarketQuote, OHLCVCandle, TickerSymbol, CurrencyCode };

/** 프로바이더 확장 시세 데이터 — MarketQuote에 프로바이더 메타데이터 추가 */
export interface ProviderMarketQuote extends MarketQuote {
  readonly provider: string; // "alpha-vantage" | "coingecko" | "frankfurter"
  readonly delayed: boolean; // 지연 데이터 여부
  readonly currency: CurrencyCode; // 가격 통화
}

/** 시장 데이터 프로바이더 인터페이스 */
export interface MarketDataProvider {
  readonly id: string; // "alpha-vantage" | "coingecko" | "frankfurter"
  readonly name: string; // 표시명
  readonly rateLimit: RateLimitConfig; // API 제한 설정

  /** 실시간/지연 시세 조회 */
  getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse>;

  /** 과거 데이터 조회 */
  getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse>;

  /** 지원 여부 확인 */
  supports(symbol: TickerSymbol): boolean;
}

/** Rate Limit 설정 */
export interface RateLimitConfig {
  readonly maxRequests: number; // 윈도우 내 최대 요청 수
  readonly windowMs: number; // 윈도우 크기 (밀리초)
  readonly dailyLimit?: number; // 일별 최대 요청 수 (Alpha Vantage: 25)
}

/** 과거 데이터 조회 기간 */
export type HistoricalPeriod = '1d' | '5d' | '1m' | '3m' | '6m' | '1y' | '5y';

/** 과거 데이터 응답 (정규화됨) — OHLCVCandle 재사용 */
export interface MarketHistorical {
  readonly symbol: TickerSymbol;
  readonly period: HistoricalPeriod;
  readonly currency: CurrencyCode;
  readonly candles: OHLCVCandle[];
  readonly provider: string;
}

/** 프로바이더 원시 응답 (정규화 전) */
export interface ProviderQuoteResponse {
  readonly raw: unknown; // 프로바이더별 원시 데이터
  readonly symbol: TickerSymbol;
  readonly provider: string;
}

export interface ProviderHistoricalResponse {
  readonly raw: unknown;
  readonly symbol: TickerSymbol;
  readonly period: HistoricalPeriod;
  readonly provider: string;
}

// 스파크라인 차트 옵션
export interface ChartOptions {
  readonly width?: number; // 차트 너비 (문자 수, 기본 40)
  readonly height?: number; // 차트 높이 (라인 수, 기본 5)
  readonly showAxis?: boolean; // 축 표시 (기본 true)
  readonly showPrice?: boolean; // 현재가 표시 (기본 true)
  readonly currency?: CurrencyCode; // 통화 단위 (기본 "USD")
}
```

**참고:** `ProviderMarketQuote`가 `MarketQuote`를 extends한다. `MarketQuote.volume`은 `number` 타입이므로, normalizer에서 null 대신 0을 사용해야 한다. `MarketQuote.timestamp`는 `Timestamp` (branded number)이므로, `Date.now() as Timestamp` 캐스트가 필요하다.

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 2. provider-registry.ts — 티커→프로바이더 라우팅

**파일:** `packages/skills-finance/src/market/provider-registry.ts` (신규, ~50줄)

```typescript
// packages/skills-finance/src/market/provider-registry.ts
import type { MarketDataProvider } from './types.js';
import type { TickerSymbol } from '@finclaw/types/finance.js';

/**
 * 티커 심볼을 적절한 프로바이더로 라우팅한다.
 * 등록 순서대로 supports()를 확인하여 첫 번째 매칭 프로바이더를 반환한다.
 */
export class ProviderRegistry {
  private readonly providers: MarketDataProvider[] = [];

  register(provider: MarketDataProvider): void {
    this.providers.push(provider);
  }

  /** 심볼에 맞는 프로바이더를 찾는다. 없으면 에러 */
  resolve(symbol: TickerSymbol): MarketDataProvider {
    const provider = this.providers.find((p) => p.supports(symbol));
    if (!provider) {
      throw new Error(`No provider found for symbol: ${symbol}`);
    }
    return provider;
  }

  /** 외환용 폴백 체인 — 첫 번째 실패 시 다음 프로바이더 시도 */
  resolveWithFallback(symbol: TickerSymbol): MarketDataProvider[] {
    return this.providers.filter((p) => p.supports(symbol));
  }
}

/** 기본 프로바이더 레지스트리를 생성한다 (AV → CoinGecko → Frankfurter 순서) */
export function createDefaultRegistry(config: {
  alphaVantageKey?: string;
  coinGeckoKey?: string;
}): ProviderRegistry {
  const { AlphaVantageProvider } = await import('./providers/alpha-vantage.js');
  const { CoinGeckoProvider } = await import('./providers/coingecko.js');
  const { FrankfurterProvider } = await import('./providers/frankfurter.js');

  const registry = new ProviderRegistry();

  // Alpha Vantage는 API 키가 있을 때만 등록
  if (config.alphaVantageKey) {
    registry.register(new AlphaVantageProvider(config.alphaVantageKey));
  }

  // CoinGecko는 항상 등록 (무키 동작 가능)
  registry.register(new CoinGeckoProvider(config.coinGeckoKey));

  // Frankfurter는 항상 등록 (무료, 키 불필요)
  registry.register(new FrankfurterProvider());

  return registry;
}
```

**주의:** `createDefaultRegistry`는 dynamic import를 사용하므로 `async` 함수로 변경해야 한다. plan.md의 주석 처리된 import를 실제 코드로 전환한다.

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 3. providers/frankfurter.ts — Frankfurter API 클라이언트 (환율)

**파일:** `packages/skills-finance/src/market/providers/frankfurter.ts` (신규, ~80줄)

```typescript
// packages/skills-finance/src/market/providers/frankfurter.ts
import type {
  MarketDataProvider,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
  HistoricalPeriod,
  RateLimitConfig,
} from '../types.js';
import type { TickerSymbol } from '@finclaw/types/finance.js';
import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';

const BASE_URL = 'https://api.frankfurter.dev';

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export class FrankfurterProvider implements MarketDataProvider {
  readonly id = 'frankfurter';
  readonly name = 'Frankfurter (ECB)';
  readonly rateLimit: RateLimitConfig = {
    maxRequests: 100, // ECB 데이터, 실질적으로 제한 없음
    windowMs: 60_000,
  };

  supports(symbol: TickerSymbol): boolean {
    // EUR/USD, USD/KRW 등 통화쌍 형식 (3글자/3글자)
    return /^[A-Z]{3}\/[A-Z]{3}$/.test(symbol);
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const [from, to] = (symbol as string).split('/');

    const url = new URL(`${BASE_URL}/latest`);
    url.searchParams.set('base', from);
    url.searchParams.set('symbols', to);

    const data = await retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
      maxAttempts: 2,
      shouldRetry: isTransientError,
    });

    return { raw: data, symbol, provider: this.id };
  }

  async getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const [from, to] = (symbol as string).split('/');

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodToDays(period));

    const url = new URL(`${BASE_URL}/${formatDate(startDate)}..${formatDate(endDate)}`);
    url.searchParams.set('base', from);
    url.searchParams.set('symbols', to);

    const data = await retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
      maxAttempts: 2,
      shouldRetry: isTransientError,
    });

    return { raw: data, symbol, period, provider: this.id };
  }
}

function periodToDays(period: HistoricalPeriod): number {
  const map: Record<HistoricalPeriod, number> = {
    '1d': 1,
    '5d': 5,
    '1m': 30,
    '3m': 90,
    '6m': 180,
    '1y': 365,
    '5y': 1825,
  };
  return map[period];
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}
```

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 4. providers/coingecko.ts — CoinGecko API 클라이언트 (암호화폐)

**파일:** `packages/skills-finance/src/market/providers/coingecko.ts` (신규, ~130줄)

```typescript
// packages/skills-finance/src/market/providers/coingecko.ts
import type {
  MarketDataProvider,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
  HistoricalPeriod,
  RateLimitConfig,
} from '../types.js';
import type { TickerSymbol } from '@finclaw/types/finance.js';
import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import { z } from 'zod/v4';

const BASE_URL = 'https://api.coingecko.com/api/v3';

/** CoinGecko ticker → coin ID 매핑 (주요 암호화폐) */
const TICKER_TO_ID: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'ripple',
  ADA: 'cardano',
  DOT: 'polkadot',
  DOGE: 'dogecoin',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  LINK: 'chainlink',
};

/** CoinGecko coin 상세 응답 스키마 */
const CoinDetailSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  market_data: z.object({
    current_price: z.record(z.string(), z.number()),
    price_change_24h: z.number().nullable(),
    price_change_percentage_24h: z.number().nullable(),
    high_24h: z.record(z.string(), z.number()),
    low_24h: z.record(z.string(), z.number()),
    total_volume: z.record(z.string(), z.number()),
    market_cap: z.record(z.string(), z.number()),
  }),
  last_updated: z.string(),
});

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export class CoinGeckoProvider implements MarketDataProvider {
  readonly id = 'coingecko';
  readonly name = 'CoinGecko';
  readonly rateLimit: RateLimitConfig;

  constructor(private readonly apiKey?: string) {
    this.rateLimit = {
      maxRequests: apiKey ? 30 : 10, // 무키: 10req/min, 키: 30req/min
      windowMs: 60_000,
    };
  }

  supports(symbol: TickerSymbol): boolean {
    // BTC, ETH 등 주요 암호화폐 ticker 또는 BTC-USD 형식
    const ticker = (symbol as string).split('-')[0].toUpperCase();
    return ticker in TICKER_TO_ID;
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const ticker = (symbol as string).split('-')[0].toUpperCase();
    const coinId = TICKER_TO_ID[ticker];
    if (!coinId) {
      throw new Error(`Unsupported cryptocurrency: ${symbol}`);
    }

    const url = new URL(`${BASE_URL}/coins/${coinId}`);
    url.searchParams.set('localization', 'false');
    url.searchParams.set('tickers', 'false');
    url.searchParams.set('community_data', 'false');
    url.searchParams.set('developer_data', 'false');

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.apiKey) {
      headers['x-cg-demo-api-key'] = this.apiKey;
    }

    const data = await retry(
      () => safeFetchJson(url.toString(), { timeoutMs: 10_000, init: { headers } }),
      { maxAttempts: 2, shouldRetry: isTransientError },
    );

    // Zod 검증
    const parsed = CoinDetailSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`Invalid CoinGecko response for ${symbol}: ${parsed.error.message}`);
    }

    return { raw: parsed.data, symbol, provider: this.id };
  }

  async getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const ticker = (symbol as string).split('-')[0].toUpperCase();
    const coinId = TICKER_TO_ID[ticker];
    if (!coinId) {
      throw new Error(`Unsupported cryptocurrency: ${symbol}`);
    }

    const vsCurrency = (symbol as string).includes('-')
      ? (symbol as string).split('-')[1].toLowerCase()
      : 'usd';
    const days = periodToDays(period);

    const url = new URL(`${BASE_URL}/coins/${coinId}/market_chart`);
    url.searchParams.set('vs_currency', vsCurrency);
    url.searchParams.set('days', String(days));

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) {
      headers['x-cg-demo-api-key'] = this.apiKey;
    }

    const data = await retry(
      () => safeFetchJson(url.toString(), { timeoutMs: 10_000, init: { headers } }),
      { maxAttempts: 2, shouldRetry: isTransientError },
    );

    return { raw: data, symbol, period, provider: this.id };
  }
}

function periodToDays(period: HistoricalPeriod): number {
  const map: Record<HistoricalPeriod, number> = {
    '1d': 1,
    '5d': 5,
    '1m': 30,
    '3m': 90,
    '6m': 180,
    '1y': 365,
    '5y': 1825,
  };
  return map[period];
}
```

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 5. providers/alpha-vantage.ts — Alpha Vantage API 클라이언트 (주식)

**파일:** `packages/skills-finance/src/market/providers/alpha-vantage.ts` (신규, ~150줄)

```typescript
// packages/skills-finance/src/market/providers/alpha-vantage.ts
import type {
  MarketDataProvider,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
  HistoricalPeriod,
  RateLimitConfig,
} from '../types.js';
import type { TickerSymbol } from '@finclaw/types/finance.js';
import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import { z } from 'zod/v4';

const BASE_URL = 'https://www.alphavantage.co/query';

/** Alpha Vantage Global Quote 응답 스키마 */
const GlobalQuoteSchema = z.object({
  'Global Quote': z.object({
    '01. symbol': z.string(),
    '02. open': z.string(),
    '03. high': z.string(),
    '04. low': z.string(),
    '05. price': z.string(),
    '06. volume': z.string(),
    '08. previous close': z.string(),
    '09. change': z.string(),
    '10. change percent': z.string(),
  }),
});

/** Alpha Vantage rate limit/error 응답 스키마 */
const ErrorResponseSchema = z.object({
  Note: z.string().optional(),
  Information: z.string().optional(),
});

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export class AlphaVantageProvider implements MarketDataProvider {
  readonly id = 'alpha-vantage';
  readonly name = 'Alpha Vantage';
  readonly rateLimit: RateLimitConfig = {
    maxRequests: 5, // 무료 티어: 5 requests/minute
    windowMs: 60_000,
    dailyLimit: 25, // 무료 티어: 25 requests/day
  };

  constructor(private readonly apiKey: string) {}

  supports(symbol: TickerSymbol): boolean {
    // 주식 전용 (알파벳 1-5자, 선택적 마켓 접미사). 외환은 Frankfurter 담당
    return /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(symbol);
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    return this.getStockQuote(symbol);
  }

  private async getStockQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const url = new URL(BASE_URL);
    url.searchParams.set('function', 'GLOBAL_QUOTE');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('apikey', this.apiKey);

    const data = await retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
      maxAttempts: 2,
      shouldRetry: isTransientError,
    });

    // Rate limit 감지
    const errorCheck = ErrorResponseSchema.safeParse(data);
    if (errorCheck.success && (errorCheck.data.Note || errorCheck.data.Information)) {
      throw new AlphaVantageError('API rate limit exceeded', 429);
    }

    // Zod 검증
    const parsed = GlobalQuoteSchema.safeParse(data);
    if (!parsed.success) {
      throw new AlphaVantageError(`No data found for symbol: ${symbol}`, 404);
    }

    return { raw: parsed.data, symbol, provider: this.id };
  }

  async getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const url = new URL(BASE_URL);
    const func = period === '1d' ? 'TIME_SERIES_INTRADAY' : 'TIME_SERIES_DAILY_ADJUSTED';
    url.searchParams.set('function', func);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('apikey', this.apiKey);

    if (period === '1d') {
      url.searchParams.set('interval', '5min');
    }

    url.searchParams.set('outputsize', periodToOutputSize(period));

    const data = await retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
      maxAttempts: 2,
      shouldRetry: isTransientError,
    });

    return { raw: data, symbol, period, provider: this.id };
  }
}

function periodToOutputSize(period: HistoricalPeriod): string {
  switch (period) {
    case '1d':
    case '5d':
    case '1m':
      return 'compact'; // 최근 100개 데이터 포인트
    default:
      return 'full'; // 전체 데이터 (최대 20년)
  }
}

export class AlphaVantageError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AlphaVantageError';
  }
}
```

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 6. normalizer.ts — 프로바이더별 응답 정규화

**파일:** `packages/skills-finance/src/market/normalizer.ts` (신규, ~120줄)

**타입 호환 주의사항:**

- `MarketQuote.volume`은 `number` (not nullable) → `?? 0` 사용
- `MarketQuote.marketCap`은 `number | undefined` (optional) → `?? undefined` 사용
- `MarketQuote.timestamp`는 `Timestamp` (branded number) → `Date.now() as Timestamp` 캐스트

```typescript
// packages/skills-finance/src/market/normalizer.ts
import type {
  ProviderMarketQuote,
  MarketHistorical,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
} from './types.js';
import type { OHLCVCandle, CurrencyCode } from '@finclaw/types/finance.js';
import type { Timestamp } from '@finclaw/types';
import { createCurrencyCode } from '@finclaw/types/finance.js';
import { z } from 'zod/v4';

/** Alpha Vantage Global Quote 정규화용 스키마 */
const AVGlobalQuoteSchema = z.object({
  'Global Quote': z.object({
    '01. symbol': z.string(),
    '02. open': z.string(),
    '03. high': z.string(),
    '04. low': z.string(),
    '05. price': z.string(),
    '06. volume': z.string(),
    '08. previous close': z.string(),
    '09. change': z.string(),
    '10. change percent': z.string(),
  }),
});

/** CoinGecko 정규화용 스키마 (이미 프로바이더에서 CoinDetailSchema으로 검증 완료) */
const CoinGeckoDataShape = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  market_data: z.object({
    current_price: z.record(z.string(), z.number()),
    price_change_24h: z.number().nullable(),
    price_change_percentage_24h: z.number().nullable(),
    high_24h: z.record(z.string(), z.number()),
    low_24h: z.record(z.string(), z.number()),
    total_volume: z.record(z.string(), z.number()),
    market_cap: z.record(z.string(), z.number()),
  }),
  last_updated: z.string(),
});

/** Frankfurter 응답 스키마 */
const FrankfurterQuoteSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

/**
 * 프로바이더별 원시 응답을 통일된 ProviderMarketQuote로 변환한다.
 */
export function normalizeQuote(response: ProviderQuoteResponse): ProviderMarketQuote {
  switch (response.provider) {
    case 'alpha-vantage':
      return normalizeAlphaVantageQuote(response);
    case 'coingecko':
      return normalizeCoinGeckoQuote(response);
    case 'frankfurter':
      return normalizeFrankfurterQuote(response);
    default:
      throw new Error(`Unknown provider: ${response.provider}`);
  }
}

function normalizeAlphaVantageQuote(response: ProviderQuoteResponse): ProviderMarketQuote {
  const parsed = AVGlobalQuoteSchema.safeParse(response.raw);
  if (!parsed.success) {
    throw new Error(`Invalid Alpha Vantage response: ${parsed.error.message}`);
  }

  const q = parsed.data['Global Quote'];
  return {
    symbol: response.symbol,
    price: parseFloat(q['05. price']),
    change: parseFloat(q['09. change']),
    changePercent: parseFloat(q['10. change percent']?.replace('%', '') ?? '0'),
    high: parseFloat(q['03. high']),
    low: parseFloat(q['04. low']),
    open: parseFloat(q['02. open']),
    previousClose: parseFloat(q['08. previous close']),
    volume: parseInt(q['06. volume'], 10),
    marketCap: undefined,
    timestamp: Date.now() as Timestamp,
    provider: 'alpha-vantage',
    delayed: true, // Alpha Vantage 무료 티어는 15분 지연
    currency: createCurrencyCode('USD'),
  };
}

function normalizeCoinGeckoQuote(response: ProviderQuoteResponse): ProviderMarketQuote {
  const parsed = CoinGeckoDataShape.safeParse(response.raw);
  if (!parsed.success) {
    throw new Error(`Invalid CoinGecko response: ${parsed.error.message}`);
  }

  const data = parsed.data;
  const vsCurrency = 'usd';
  const md = data.market_data;

  return {
    symbol: response.symbol,
    price: md.current_price[vsCurrency] ?? 0,
    change: md.price_change_24h ?? 0,
    changePercent: md.price_change_percentage_24h ?? 0,
    high: md.high_24h[vsCurrency] ?? 0,
    low: md.low_24h[vsCurrency] ?? 0,
    open: 0, // CoinGecko 무료 API는 시가 미제공
    previousClose: 0,
    volume: md.total_volume[vsCurrency] ?? 0,
    marketCap: md.market_cap[vsCurrency] ?? undefined,
    timestamp: new Date(data.last_updated).getTime() as Timestamp,
    provider: 'coingecko',
    delayed: false,
    currency: createCurrencyCode('USD'),
  };
}

function normalizeFrankfurterQuote(response: ProviderQuoteResponse): ProviderMarketQuote {
  const parsed = FrankfurterQuoteSchema.safeParse(response.raw);
  if (!parsed.success) {
    throw new Error(`Invalid Frankfurter response: ${parsed.error.message}`);
  }

  const data = parsed.data;
  const [_from, to] = (response.symbol as string).split('/');
  const rate = data.rates[to] ?? 0;

  return {
    symbol: response.symbol,
    price: rate,
    change: 0,
    changePercent: 0,
    high: rate,
    low: rate,
    open: rate,
    previousClose: rate,
    volume: 0,
    marketCap: undefined,
    timestamp: new Date(data.date).getTime() as Timestamp,
    provider: 'frankfurter',
    delayed: false,
    currency: createCurrencyCode(to),
  };
}

/**
 * 과거 데이터 응답을 정규화한다.
 */
export function normalizeHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  switch (response.provider) {
    case 'alpha-vantage':
      return normalizeAlphaVantageHistorical(response);
    case 'coingecko':
      return normalizeCoinGeckoHistorical(response);
    default:
      throw new Error(`Historical data not supported for: ${response.provider}`);
  }
}

function normalizeAlphaVantageHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const data = response.raw as Record<string, Record<string, Record<string, string>>>;

  // "Time Series (Daily)" 또는 "Time Series (5min)" 키를 찾는다
  const timeSeriesKey = Object.keys(data).find((k) => k.startsWith('Time Series'));
  if (!timeSeriesKey) throw new Error('No time series data in response');

  const series = data[timeSeriesKey];
  const candles: OHLCVCandle[] = Object.entries(series)
    .map(([date, values]) => ({
      timestamp: new Date(date).getTime() as Timestamp,
      open: parseFloat(values['1. open']),
      high: parseFloat(values['2. high']),
      low: parseFloat(values['3. low']),
      close: parseFloat(values['4. close']),
      volume: parseInt(values['5. volume'] ?? values['6. volume'] ?? '0', 10),
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  return {
    symbol: response.symbol,
    period: response.period,
    currency: createCurrencyCode('USD'),
    candles,
    provider: 'alpha-vantage',
  };
}

function normalizeCoinGeckoHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const data = response.raw as {
    prices: Array<[number, number]>;
    market_caps: Array<[number, number]>;
    total_volumes: Array<[number, number]>;
  };

  const candles: OHLCVCandle[] = data.prices.map(([timestamp, price]) => ({
    timestamp: timestamp as Timestamp,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
  }));

  return {
    symbol: response.symbol,
    period: response.period,
    currency: createCurrencyCode('USD'),
    candles,
    provider: 'coingecko',
  };
}
```

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 7. cache.ts — SQLite TTL 캐시 래퍼 + rate limiter

**파일:** `packages/skills-finance/src/market/cache.ts` (신규, ~120줄)

**의존:** P-1에서 추가한 `getCachedData`, `setCachedData`, `getStaleCachedData` export

```typescript
// packages/skills-finance/src/market/cache.ts
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderMarketQuote, RateLimitConfig } from './types.js';
import { getCachedData, setCachedData, getStaleCachedData, CACHE_TTL } from '@finclaw/storage';

/**
 * 일별 한도 초과 에러.
 * Alpha Vantage 무료 티어 (25req/day) 등에서 발생한다.
 */
export class DailyLimitExceededError extends Error {
  constructor(providerId: string) {
    super(`Daily API limit exceeded for provider: ${providerId}`);
    this.name = 'DailyLimitExceededError';
  }
}

/**
 * 시장 데이터 캐시 매니저.
 * SQLite TTL 캐시(Phase 14)를 래핑하고 rate limiting을 추가한다.
 */
export class MarketCache {
  private readonly rateLimiters = new Map<string, RateLimiter>();

  constructor(private readonly db: DatabaseSync) {}

  /** 시세 데이터를 캐시에서 조회하거나 프로바이더를 호출한다 */
  async getQuote(
    symbol: string,
    provider: {
      id: string;
      rateLimit: RateLimitConfig;
      getQuote: (s: string) => Promise<unknown>;
    },
    normalize: (raw: unknown) => ProviderMarketQuote,
  ): Promise<ProviderMarketQuote> {
    const cacheKey = `quote:${symbol}:${provider.id}`;

    // 1. 캐시 확인
    const cached = getCachedData<ProviderMarketQuote>(this.db, cacheKey);
    if (cached) return cached;

    // 2. 일별 한도 확인
    if (provider.rateLimit.dailyLimit) {
      this.checkDailyLimit(provider.id, provider.rateLimit.dailyLimit);
    }

    // 3. Rate limit 확인
    const limiter = this.getRateLimiter(provider.id, provider.rateLimit);
    await limiter.acquire();

    // 4. API 호출
    try {
      const raw = await provider.getQuote(symbol);
      const normalized = normalize(raw);

      // 5. 캐시 저장
      const ttl = symbol.includes('/')
        ? CACHE_TTL.FOREX
        : /^[A-Z]{1,5}$/.test(symbol)
          ? CACHE_TTL.QUOTE
          : CACHE_TTL.CRYPTO;
      setCachedData(this.db, cacheKey, normalized, provider.id, ttl);

      // 6. 일별 카운터 증가
      if (provider.rateLimit.dailyLimit) {
        this.incrementDailyCount(provider.id);
      }

      return normalized;
    } catch (error) {
      // 7. Graceful degradation: stale 캐시 반환
      const stale = getStaleCachedData<ProviderMarketQuote>(this.db, cacheKey);
      if (stale) {
        return { ...stale, delayed: true };
      }
      throw error;
    }
  }

  /** 일별 API 호출 횟수를 SQLite에 영속화하여 확인한다 */
  private checkDailyLimit(providerId: string, dailyLimit: number): void {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const counterKey = `rate:daily:${providerId}:${today}`;
    const count = getCachedData<number>(this.db, counterKey) ?? 0;
    if (count >= dailyLimit) {
      throw new DailyLimitExceededError(providerId);
    }
  }

  /** 일별 카운터를 증가시킨다 */
  private incrementDailyCount(providerId: string): void {
    const today = new Date().toISOString().split('T')[0];
    const counterKey = `rate:daily:${providerId}:${today}`;
    const current = getCachedData<number>(this.db, counterKey) ?? 0;
    // TTL = 24시간 (자정 이후 자동 만료)
    setCachedData(this.db, counterKey, current + 1, providerId, 86_400_000);
  }

  private getRateLimiter(providerId: string, config: RateLimitConfig): RateLimiter {
    let limiter = this.rateLimiters.get(providerId);
    if (!limiter) {
      limiter = new RateLimiter(config);
      this.rateLimiters.set(providerId, limiter);
    }
    return limiter;
  }
}

/**
 * 슬라이딩 윈도우 rate limiter.
 * 프로바이더별 API 요청 빈도를 제한한다.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly config: RateLimitConfig) {}

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();

      // 윈도우 밖의 타임스탬프 제거
      while (this.timestamps.length > 0 && this.timestamps[0] < now - this.config.windowMs) {
        this.timestamps.shift();
      }

      // 제한 이내이면 타임스탬프 기록 후 반환
      if (this.timestamps.length < this.config.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      // 제한 초과 시 대기 (최소 50ms 보장)
      const oldestInWindow = this.timestamps[0];
      const waitMs = Math.max(50, oldestInWindow + this.config.windowMs - now + 100);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
```

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 8. charts.ts — 텍스트 기반 스파크라인 차트

**파일:** `packages/skills-finance/src/market/charts.ts` (신규, ~80줄)

````typescript
// packages/skills-finance/src/market/charts.ts
import type { OHLCVCandle } from '@finclaw/types/finance.js';
import type { ChartOptions } from './types.js';

/** 스파크라인 블록 문자 (하단→상단, 8레벨) */
const SPARK_CHARS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * 과거 데이터를 텍스트 기반 스파크라인 차트로 변환한다.
 * 터미널과 Discord 코드 블록에서 동일하게 렌더링된다.
 *
 * 예시 출력:
 * ```
 * $192.53
 * ▆█▇▅▃▂▃▄▅▆▇█▇▆▅▄▃▃▄▅▆▇█▇▅▃▄▅▆█
 * H: $195.00  L: $185.00  Δ: +3.2%
 * ```
 */
export function generateSparkline(candles: OHLCVCandle[], options: ChartOptions = {}): string {
  const { width = 40, showPrice = true, currency = 'USD' } = options;

  if (candles.length === 0) return '(데이터 없음)';

  // 데이터를 차트 너비에 맞게 리샘플링
  const prices = resample(
    candles.map((c) => c.close),
    width,
  );

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1; // 0 방지

  // 각 가격을 0-8 레벨로 매핑
  const bars = prices.map((price) => {
    const level = Math.round(((price - min) / range) * 8);
    return SPARK_CHARS[Math.min(level, 8)];
  });

  const sparkline = bars.join('');
  const latest = candles[candles.length - 1];
  const first = candles[0];
  const change = ((latest.close - first.close) / first.close) * 100;
  const changeSign = change >= 0 ? '+' : '';

  const lines: string[] = [];

  if (showPrice) {
    lines.push(`${formatCurrency(latest.close, currency as string)}`);
  }

  lines.push(sparkline);
  lines.push(
    `H: ${formatCurrency(max, currency as string)}  L: ${formatCurrency(min, currency as string)}  Δ: ${changeSign}${change.toFixed(1)}%`,
  );

  return lines.join('\n');
}

/**
 * 데이터 배열을 targetLength 크기로 리샘플링한다.
 * 데이터가 targetLength보다 길면 평균값 집계를 사용한다.
 */
function resample(data: number[], targetLength: number): number[] {
  if (data.length <= targetLength) return data;

  const result: number[] = [];
  const bucketSize = data.length / targetLength;

  for (let i = 0; i < targetLength; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    const bucket = data.slice(start, end);
    const avg = bucket.reduce((a, b) => a + b, 0) / bucket.length;
    result.push(avg);
  }

  return result;
}

function formatCurrency(value: number, currency: string): string {
  const symbols: Record<string, string> = {
    USD: '$',
    KRW: '₩',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    BTC: '₿',
  };
  const symbol = symbols[currency] ?? currency;

  if (value >= 1_000_000) {
    return `${symbol}${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${symbol}${(value / 1_000).toFixed(2)}K`;
  }
  if (value < 1) {
    return `${symbol}${value.toFixed(6)}`;
  }
  return `${symbol}${value.toFixed(2)}`;
}
````

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 9. formatters.ts — Discord/터미널용 시세 포맷팅

**파일:** `packages/skills-finance/src/market/formatters.ts` (신규, ~80줄)

```typescript
// packages/skills-finance/src/market/formatters.ts
import type { ProviderMarketQuote } from './types.js';

/**
 * 시세 데이터를 사용자 친화적 텍스트로 포맷한다.
 * Discord 코드블록과 터미널 양쪽에서 읽기 좋은 형태를 생성한다.
 */
export function formatQuote(quote: ProviderMarketQuote): string {
  const changeSign = quote.change >= 0 ? '+' : '';
  const price = formatPrice(quote.price, quote.currency as string);
  const change = `${changeSign}${quote.change.toFixed(2)}`;
  const changePct = `${changeSign}${quote.changePercent.toFixed(2)}%`;

  const lines = [
    `${quote.symbol} ${price}`,
    `변동: ${change} (${changePct})`,
    `고가: ${formatPrice(quote.high, quote.currency as string)}  저가: ${formatPrice(quote.low, quote.currency as string)}`,
  ];

  if (quote.volume != null && quote.volume > 0) {
    lines.push(`거래량: ${formatNumber(quote.volume)}`);
  }
  if (quote.marketCap != null) {
    lines.push(`시가총액: ${formatNumber(quote.marketCap)}`);
  }
  if (quote.delayed) {
    lines.push('(15분 지연 데이터)');
  }

  return lines.join('\n');
}

/** 환율을 포맷한다 */
export function formatForexRate(quote: ProviderMarketQuote): string {
  const [from, to] = (quote.symbol as string).split('/');
  return `${from}/${to}: ${formatPrice(quote.price, to)}`;
}

/** 차트를 코드블록으로 래핑한다 */
export function formatChart(symbol: string, sparkline: string, period: string): string {
  return `${symbol} (${period})\n\`\`\`\n${sparkline}\n\`\`\``;
}

function formatPrice(value: number, currency: string): string {
  const symbols: Record<string, string> = {
    USD: '$',
    KRW: '₩',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    BTC: '₿',
  };
  const sym = symbols[currency] ?? currency;

  if (value >= 1_000_000) return `${sym}${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${sym}${(value / 1_000).toFixed(2)}K`;
  if (value < 1) return `${sym}${value.toFixed(6)}`;
  return `${sym}${value.toFixed(2)}`;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(0);
}
```

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
```

---

### Step 10. index.ts — 스킬 등록 (도구 4개 + 내부 배선)

**파일:** `packages/skills-finance/src/market/index.ts` (신규, ~180줄)

이 파일은 plan.md의 `declare` 함수들을 실제 구현으로 전환하고, 모든 모듈을 연결한다.

```typescript
// packages/skills-finance/src/market/index.ts
import type { DatabaseSync } from 'node:sqlite';
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { ProviderMarketQuote, HistoricalPeriod } from './types.js';
import { createTickerSymbol } from '@finclaw/types/finance.js';
import { ProviderRegistry, createDefaultRegistry } from './provider-registry.js';
import { MarketCache } from './cache.js';
import { normalizeQuote, normalizeHistorical } from './normalizer.js';
import { generateSparkline } from './charts.js';
import { formatQuote, formatForexRate, formatChart } from './formatters.js';

/** 스킬 초기화에 필요한 설정 */
export interface MarketSkillConfig {
  readonly db: DatabaseSync;
  readonly alphaVantageKey?: string;
  readonly coinGeckoKey?: string;
}

/** 초기화된 스킬 상태 (내부 상태 캡슐화) */
interface MarketSkillState {
  readonly providers: ProviderRegistry;
  readonly cache: MarketCache;
}

/** 스킬을 초기화하고 도구를 등록한다 */
export async function registerMarketTools(
  registry: ToolRegistry,
  config: MarketSkillConfig,
): Promise<void> {
  const providers = await createDefaultRegistry({
    alphaVantageKey: config.alphaVantageKey,
    coinGeckoKey: config.coinGeckoKey,
  });
  const cache = new MarketCache(config.db);
  const state: MarketSkillState = { providers, cache };

  registerStockPriceTool(registry, state);
  registerCryptoPriceTool(registry, state);
  registerForexRateTool(registry, state);
  registerMarketChartTool(registry, state);
}

// ── 내부 헬퍼 ──

async function getQuoteFromState(
  state: MarketSkillState,
  symbolStr: string,
): Promise<ProviderMarketQuote> {
  const symbol = createTickerSymbol(symbolStr);
  const provider = state.providers.resolve(symbol);

  return state.cache.getQuote(
    symbol as string,
    {
      id: provider.id,
      rateLimit: provider.rateLimit,
      getQuote: (s) => provider.getQuote(createTickerSymbol(s)),
    },
    (raw) => normalizeQuote(raw as { raw: unknown; symbol: typeof symbol; provider: string }),
  );
}

async function getChartFromState(
  state: MarketSkillState,
  symbolStr: string,
  periodStr: string,
): Promise<string> {
  const symbol = createTickerSymbol(symbolStr);
  const period = periodStr as HistoricalPeriod;
  const provider = state.providers.resolve(symbol);
  const rawResponse = await provider.getHistorical(symbol, period);
  const historical = normalizeHistorical(rawResponse);
  return generateSparkline(historical.candles, { currency: historical.currency });
}

// ── 도구 등록 ──

function registerStockPriceTool(registry: ToolRegistry, state: MarketSkillState): void {
  const def: RegisteredToolDefinition = {
    name: 'get_stock_price',
    description:
      '주식 실시간/지연 시세를 조회합니다. 미국 주식 티커(예: AAPL, GOOGL, MSFT)를 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '주식 티커 심볼 (예: AAPL)' },
      },
      required: ['symbol'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 15_000,
  };
  const executor: ToolExecutor = async (input) => {
    const quote = await getQuoteFromState(state, input.symbol as string);
    return { content: formatQuote(quote), isError: false };
  };
  registry.register(def, executor, 'skill');
}

function registerCryptoPriceTool(registry: ToolRegistry, state: MarketSkillState): void {
  const def: RegisteredToolDefinition = {
    name: 'get_crypto_price',
    description: '암호화폐 실시간 시세를 조회합니다. BTC, ETH, SOL 등 주요 암호화폐를 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '암호화폐 심볼 (예: BTC, ETH)' },
      },
      required: ['symbol'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 15_000,
  };
  const executor: ToolExecutor = async (input) => {
    const quote = await getQuoteFromState(state, input.symbol as string);
    return { content: formatQuote(quote), isError: false };
  };
  registry.register(def, executor, 'skill');
}

function registerForexRateTool(registry: ToolRegistry, state: MarketSkillState): void {
  const def: RegisteredToolDefinition = {
    name: 'get_forex_rate',
    description: '외환 환율을 조회합니다. USD/KRW, EUR/USD 등의 통화쌍을 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '기준 통화 (예: USD)' },
        to: { type: 'string', description: '대상 통화 (예: KRW)' },
      },
      required: ['from', 'to'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 15_000,
  };
  const executor: ToolExecutor = async (input) => {
    const from = input.from as string;
    const to = input.to as string;
    const quote = await getQuoteFromState(state, `${from}/${to}`);
    return { content: formatForexRate(quote), isError: false };
  };
  registry.register(def, executor, 'skill');
}

function registerMarketChartTool(registry: ToolRegistry, state: MarketSkillState): void {
  const def: RegisteredToolDefinition = {
    name: 'get_market_chart',
    description:
      '시세 차트를 텍스트 스파크라인으로 생성합니다. 기간별(1일~5년) 과거 데이터를 시각화합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '티커 심볼 (예: AAPL, BTC)' },
        period: {
          type: 'string',
          description: '기간 (1d, 5d, 1m, 3m, 6m, 1y, 5y)',
          default: '1m',
          enum: ['1d', '5d', '1m', '3m', '6m', '1y', '5y'],
        },
      },
      required: ['symbol'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: 15_000,
  };
  const executor: ToolExecutor = async (input) => {
    const symbol = input.symbol as string;
    const period = (input.period as string) ?? '1m';
    const sparkline = await getChartFromState(state, symbol, period);
    return { content: formatChart(symbol, sparkline, period), isError: false };
  };
  registry.register(def, executor, 'skill');
}

/** 스킬 메타데이터 — Phase 7의 skill registry에 등록 */
export const MARKET_SKILL_METADATA = {
  name: 'market-data',
  description: '주식, 암호화폐, 외환 시장 데이터를 조회하고 차트를 생성합니다.',
  version: '1.0.0',
  requires: {
    env: [], // API 키는 선택사항 (무료 티어 가능)
    optionalEnv: ['ALPHA_VANTAGE_KEY', 'COINGECKO_DEMO_KEY'],
  },
  tools: ['get_stock_price', 'get_crypto_price', 'get_forex_rate', 'get_market_chart'],
} as const;
```

**마지막으로** `packages/skills-finance/src/index.ts`를 갱신한다:

```typescript
// packages/skills-finance/src/index.ts
export { registerMarketTools, MARKET_SKILL_METADATA } from './market/index.js';
export type { MarketSkillConfig } from './market/index.js';
```

**검증:**

```bash
cd packages/skills-finance && npx tsc --noEmit
# 프로젝트 전체 빌드 확인
npx tsc --build
```

---

## 테스트 (4단계)

### T-1. normalizer.test.ts — 프로바이더별 응답 정규화 테스트

**파일:** `packages/skills-finance/src/market/normalizer.test.ts` (신규)

```typescript
// packages/skills-finance/src/market/normalizer.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeQuote, normalizeHistorical } from './normalizer.js';
import type { ProviderQuoteResponse, ProviderHistoricalResponse } from './types.js';
import { createTickerSymbol } from '@finclaw/types/finance.js';

describe('normalizeQuote', () => {
  describe('alpha-vantage', () => {
    const validResponse: ProviderQuoteResponse = {
      raw: {
        'Global Quote': {
          '01. symbol': 'AAPL',
          '02. open': '170.00',
          '03. high': '175.00',
          '04. low': '168.00',
          '05. price': '173.50',
          '06. volume': '50000000',
          '08. previous close': '171.00',
          '09. change': '2.50',
          '10. change percent': '1.4620%',
        },
      },
      symbol: createTickerSymbol('AAPL'),
      provider: 'alpha-vantage',
    };

    it('정상 응답을 ProviderMarketQuote로 변환한다', () => {
      const result = normalizeQuote(validResponse);

      expect(result.symbol).toBe('AAPL');
      expect(result.price).toBe(173.5);
      expect(result.change).toBe(2.5);
      expect(result.changePercent).toBeCloseTo(1.462);
      expect(result.high).toBe(175);
      expect(result.low).toBe(168);
      expect(result.open).toBe(170);
      expect(result.previousClose).toBe(171);
      expect(result.volume).toBe(50000000);
      expect(result.provider).toBe('alpha-vantage');
      expect(result.delayed).toBe(true);
      expect(result.currency).toBe('USD');
    });

    it('잘못된 형식이면 에러를 던진다', () => {
      const invalid: ProviderQuoteResponse = {
        raw: { bad: 'data' },
        symbol: createTickerSymbol('AAPL'),
        provider: 'alpha-vantage',
      };
      expect(() => normalizeQuote(invalid)).toThrow('Invalid Alpha Vantage response');
    });
  });

  describe('coingecko', () => {
    const validResponse: ProviderQuoteResponse = {
      raw: {
        id: 'bitcoin',
        symbol: 'btc',
        name: 'Bitcoin',
        market_data: {
          current_price: { usd: 67234.5 },
          price_change_24h: 1234.5,
          price_change_percentage_24h: 1.87,
          high_24h: { usd: 68000 },
          low_24h: { usd: 65000 },
          total_volume: { usd: 28000000000 },
          market_cap: { usd: 1320000000000 },
        },
        last_updated: '2025-01-15T10:00:00Z',
      },
      symbol: createTickerSymbol('BTC'),
      provider: 'coingecko',
    };

    it('정상 응답을 ProviderMarketQuote로 변환한다', () => {
      const result = normalizeQuote(validResponse);

      expect(result.price).toBe(67234.5);
      expect(result.change).toBe(1234.5);
      expect(result.changePercent).toBe(1.87);
      expect(result.volume).toBe(28000000000);
      expect(result.marketCap).toBe(1320000000000);
      expect(result.provider).toBe('coingecko');
      expect(result.delayed).toBe(false);
    });

    it('nullable 필드가 null이면 0으로 처리한다', () => {
      const withNulls: ProviderQuoteResponse = {
        ...validResponse,
        raw: {
          ...(validResponse.raw as Record<string, unknown>),
          market_data: {
            current_price: { usd: 100 },
            price_change_24h: null,
            price_change_percentage_24h: null,
            high_24h: { usd: 100 },
            low_24h: { usd: 100 },
            total_volume: { usd: 0 },
            market_cap: { usd: 0 },
          },
        },
      };
      const result = normalizeQuote(withNulls);
      expect(result.change).toBe(0);
      expect(result.changePercent).toBe(0);
    });
  });

  describe('frankfurter', () => {
    const validResponse: ProviderQuoteResponse = {
      raw: {
        base: 'USD',
        date: '2025-01-15',
        rates: { KRW: 1350.25 },
      },
      symbol: createTickerSymbol('USD/KRW'),
      provider: 'frankfurter',
    };

    it('환율 응답을 ProviderMarketQuote로 변환한다', () => {
      const result = normalizeQuote(validResponse);

      expect(result.price).toBe(1350.25);
      expect(result.provider).toBe('frankfurter');
      expect(result.currency).toBe('KRW');
      expect(result.volume).toBe(0);
    });

    it('잘못된 형식이면 에러를 던진다', () => {
      const invalid: ProviderQuoteResponse = {
        raw: { bad: 'data' },
        symbol: createTickerSymbol('USD/KRW'),
        provider: 'frankfurter',
      };
      expect(() => normalizeQuote(invalid)).toThrow('Invalid Frankfurter response');
    });
  });

  it('알 수 없는 프로바이더는 에러를 던진다', () => {
    const unknown: ProviderQuoteResponse = {
      raw: {},
      symbol: createTickerSymbol('TEST'),
      provider: 'unknown',
    };
    expect(() => normalizeQuote(unknown)).toThrow('Unknown provider');
  });
});

describe('normalizeHistorical', () => {
  describe('alpha-vantage', () => {
    it('Time Series를 정렬된 OHLCVCandle 배열로 변환한다', () => {
      const response: ProviderHistoricalResponse = {
        raw: {
          'Time Series (Daily)': {
            '2025-01-15': {
              '1. open': '170.00',
              '2. high': '175.00',
              '3. low': '168.00',
              '4. close': '173.50',
              '5. volume': '50000000',
            },
            '2025-01-14': {
              '1. open': '168.00',
              '2. high': '171.00',
              '3. low': '167.00',
              '4. close': '170.00',
              '5. volume': '45000000',
            },
          },
        },
        symbol: createTickerSymbol('AAPL'),
        period: '5d',
        provider: 'alpha-vantage',
      };

      const result = normalizeHistorical(response);

      expect(result.candles).toHaveLength(2);
      // 날짜순 정렬 확인 (14일이 먼저)
      expect(result.candles[0].close).toBe(170);
      expect(result.candles[1].close).toBe(173.5);
      expect(result.provider).toBe('alpha-vantage');
    });
  });

  describe('coingecko', () => {
    it('prices 배열을 OHLCVCandle 배열로 변환한다', () => {
      const response: ProviderHistoricalResponse = {
        raw: {
          prices: [
            [1705276800000, 42000],
            [1705363200000, 43000],
          ],
          market_caps: [],
          total_volumes: [],
        },
        symbol: createTickerSymbol('BTC'),
        period: '5d',
        provider: 'coingecko',
      };

      const result = normalizeHistorical(response);

      expect(result.candles).toHaveLength(2);
      expect(result.candles[0].close).toBe(42000);
      expect(result.candles[1].close).toBe(43000);
    });
  });

  it('지원하지 않는 프로바이더는 에러를 던진다', () => {
    const response: ProviderHistoricalResponse = {
      raw: {},
      symbol: createTickerSymbol('USD/KRW'),
      period: '1m',
      provider: 'frankfurter',
    };
    expect(() => normalizeHistorical(response)).toThrow('Historical data not supported');
  });
});
```

**검증:**

```bash
cd packages/skills-finance && npx vitest run src/market/normalizer.test.ts
```

---

### T-2. cache.test.ts — TTL 캐시 + rate limiter 테스트

**파일:** `packages/skills-finance/src/market/cache.test.ts` (신규)

```typescript
// packages/skills-finance/src/market/cache.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketCache, DailyLimitExceededError, RateLimiter } from './cache.js';
import { DatabaseSync } from 'node:sqlite';

// ─── 테스트용 인메모리 DB 설정 ───

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE market_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      provider TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL,
      cached_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe('MarketCache', () => {
  let db: DatabaseSync;
  let cache: MarketCache;

  beforeEach(() => {
    db = createTestDb();
    cache = new MarketCache(db);
  });

  const mockProvider = {
    id: 'test-provider',
    rateLimit: { maxRequests: 10, windowMs: 60_000 },
    getQuote: vi.fn(),
  };

  const mockNormalize = vi.fn();

  it('캐시 HIT 시 프로바이더를 호출하지 않는다', async () => {
    // 캐시에 직접 데이터 삽입
    const now = Date.now();
    db.prepare(
      'INSERT INTO market_cache (key, data, provider, ttl_ms, cached_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'quote:AAPL:test-provider',
      JSON.stringify({ price: 100 }),
      'test-provider',
      300000,
      now,
      now + 300000,
    );

    const result = await cache.getQuote('AAPL', mockProvider, mockNormalize);

    expect(result).toEqual({ price: 100 });
    expect(mockProvider.getQuote).not.toHaveBeenCalled();
    expect(mockNormalize).not.toHaveBeenCalled();
  });

  it('캐시 MISS 시 프로바이더를 호출하고 캐시에 저장한다', async () => {
    const quote = { price: 173.5, provider: 'test-provider' };
    const rawResponse = { raw: {}, symbol: 'AAPL', provider: 'test-provider' };
    mockProvider.getQuote.mockResolvedValueOnce(rawResponse);
    mockNormalize.mockReturnValueOnce(quote);

    const result = await cache.getQuote('AAPL', mockProvider, mockNormalize);

    expect(result).toEqual(quote);
    expect(mockProvider.getQuote).toHaveBeenCalledWith('AAPL');

    // 캐시에 저장되었는지 확인
    const cached = db
      .prepare('SELECT data FROM market_cache WHERE key = ?')
      .get('quote:AAPL:test-provider') as unknown as { data: string } | undefined;
    expect(cached).toBeTruthy();
  });

  it('API 실패 시 stale 캐시를 반환한다 (graceful degradation)', async () => {
    // 만료된 캐시 삽입
    const now = Date.now();
    db.prepare(
      'INSERT INTO market_cache (key, data, provider, ttl_ms, cached_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'quote:AAPL:test-provider',
      JSON.stringify({ price: 100, delayed: false }),
      'test-provider',
      300000,
      now - 600000,
      now - 300000,
    );

    mockProvider.getQuote.mockRejectedValueOnce(new Error('API timeout'));

    const result = await cache.getQuote('AAPL', mockProvider, mockNormalize);

    expect(result.price).toBe(100);
    expect(result.delayed).toBe(true); // stale 표시
  });

  it('API 실패 + stale 캐시 없으면 에러를 던진다', async () => {
    mockProvider.getQuote.mockRejectedValueOnce(new Error('API timeout'));

    await expect(cache.getQuote('AAPL', mockProvider, mockNormalize)).rejects.toThrow(
      'API timeout',
    );
  });

  describe('일별 한도', () => {
    const limitedProvider = {
      id: 'limited',
      rateLimit: { maxRequests: 10, windowMs: 60_000, dailyLimit: 2 },
      getQuote: vi.fn(),
    };

    it('일별 한도 초과 시 DailyLimitExceededError를 던진다', async () => {
      const quote = { price: 100 };
      limitedProvider.getQuote.mockResolvedValue({ raw: {} });
      mockNormalize.mockReturnValue(quote);

      // 2번 호출 성공
      await cache.getQuote('A', limitedProvider, mockNormalize);
      await cache.getQuote('B', limitedProvider, mockNormalize);

      // 3번째 호출은 한도 초과
      await expect(cache.getQuote('C', limitedProvider, mockNormalize)).rejects.toThrow(
        DailyLimitExceededError,
      );
    });
  });
});

describe('RateLimiter', () => {
  it('제한 이내 요청은 즉시 통과한다', async () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60_000 });

    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    const elapsed = Date.now() - start;

    // 5개 요청이 대기 없이 통과 (100ms 이내)
    expect(elapsed).toBeLessThan(100);
  });

  it('제한 초과 요청은 대기 후 통과한다', async () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 200 });

    await limiter.acquire(); // 1
    await limiter.acquire(); // 2

    const start = Date.now();
    await limiter.acquire(); // 3 — 대기 필요
    const elapsed = Date.now() - start;

    // 최소 50ms 이상 대기 (windowMs=200이므로)
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
```

**검증:**

```bash
cd packages/skills-finance && npx vitest run src/market/cache.test.ts
```

---

### T-3. charts.test.ts — 스파크라인 생성 테스트

**파일:** `packages/skills-finance/src/market/charts.test.ts` (신규)

```typescript
// packages/skills-finance/src/market/charts.test.ts
import { describe, it, expect } from 'vitest';
import { generateSparkline } from './charts.js';
import type { OHLCVCandle } from '@finclaw/types/finance.js';
import type { Timestamp } from '@finclaw/types';

function makeCandle(close: number, idx: number): OHLCVCandle {
  return {
    timestamp: (1705276800000 + idx * 86400000) as Timestamp,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  };
}

describe('generateSparkline', () => {
  it('빈 배열이면 "(데이터 없음)"을 반환한다', () => {
    expect(generateSparkline([])).toBe('(데이터 없음)');
  });

  it('단일 캔들에 대해 스파크라인을 생성한다', () => {
    const candles = [makeCandle(100, 0)];
    const result = generateSparkline(candles);
    expect(result).toContain('$100.00');
    expect(result).toContain('Δ: +0.0%');
  });

  it('상승 추세를 올바르게 표현한다', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(100 + i * 10, i));
    const result = generateSparkline(candles);

    // 상승 추세: 첫 문자보다 마지막 문자가 높아야 한다
    const lines = result.split('\n');
    const sparkLine = lines[1]; // 두 번째 줄이 스파크라인
    expect(sparkLine.length).toBeGreaterThan(0);
    expect(result).toContain('Δ: +');
  });

  it('하락 추세를 올바르게 표현한다', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(200 - i * 10, i));
    const result = generateSparkline(candles);
    expect(result).toContain('Δ: -');
  });

  it('width 옵션으로 차트 너비를 조절한다', () => {
    const candles = Array.from({ length: 100 }, (_, i) => makeCandle(100 + Math.sin(i) * 10, i));
    const result = generateSparkline(candles, { width: 20 });
    const lines = result.split('\n');
    const sparkLine = lines[1];
    expect(sparkLine.length).toBe(20);
  });

  it('showPrice=false이면 가격을 표시하지 않는다', () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(100, i));
    const result = generateSparkline(candles, { showPrice: false });
    const lines = result.split('\n');
    // 가격 줄 없이 스파크라인 + 요약만 (2줄)
    expect(lines).toHaveLength(2);
  });

  it('KRW 통화를 올바르게 포맷한다', () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(1350 + i, i));
    const result = generateSparkline(candles, { currency: 'KRW' as any });
    expect(result).toContain('₩');
  });

  it('대규모 데이터를 리샘플링한다', () => {
    const candles = Array.from({ length: 365 }, (_, i) => makeCandle(100 + Math.random() * 50, i));
    const result = generateSparkline(candles, { width: 40 });
    const lines = result.split('\n');
    const sparkLine = lines[1];
    expect(sparkLine.length).toBe(40);
  });

  it('모든 가격이 동일해도 에러 없이 동작한다', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(100, i));
    const result = generateSparkline(candles);
    expect(result).toBeTruthy();
    expect(result).toContain('Δ: +0.0%');
  });
});
```

**검증:**

```bash
cd packages/skills-finance && npx vitest run src/market/charts.test.ts
```

---

### T-4. providers/alpha-vantage.test.ts — Alpha Vantage 프로바이더 테스트

**파일:** `packages/skills-finance/src/market/providers/alpha-vantage.test.ts` (신규)

```typescript
// packages/skills-finance/src/market/providers/alpha-vantage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlphaVantageProvider, AlphaVantageError } from './alpha-vantage.js';
import { createTickerSymbol } from '@finclaw/types/finance.js';

// safeFetchJson mock
vi.mock('@finclaw/infra', () => ({
  safeFetchJson: vi.fn(),
  retry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { safeFetchJson } from '@finclaw/infra';
const mockFetch = vi.mocked(safeFetchJson);

describe('AlphaVantageProvider', () => {
  let provider: AlphaVantageProvider;

  beforeEach(() => {
    provider = new AlphaVantageProvider('test-api-key');
    vi.clearAllMocks();
  });

  describe('supports', () => {
    it('1-5글자 알파벳 티커를 지원한다', () => {
      expect(provider.supports(createTickerSymbol('AAPL'))).toBe(true);
      expect(provider.supports(createTickerSymbol('MSFT'))).toBe(true);
      expect(provider.supports(createTickerSymbol('A'))).toBe(true);
      expect(provider.supports(createTickerSymbol('GOOGL'))).toBe(true);
    });

    it('마켓 접미사가 있는 티커를 지원한다', () => {
      expect(provider.supports(createTickerSymbol('005930.KS'))).toBe(true);
    });

    it('암호화폐 형식은 지원하지 않는다', () => {
      expect(provider.supports(createTickerSymbol('BTC-USD'))).toBe(false);
    });

    it('통화쌍 형식은 지원하지 않는다', () => {
      expect(provider.supports(createTickerSymbol('USD/KRW'))).toBe(false);
    });
  });

  describe('getQuote', () => {
    it('정상 응답을 ProviderQuoteResponse로 반환한다', async () => {
      mockFetch.mockResolvedValueOnce({
        'Global Quote': {
          '01. symbol': 'AAPL',
          '02. open': '170.00',
          '03. high': '175.00',
          '04. low': '168.00',
          '05. price': '173.50',
          '06. volume': '50000000',
          '08. previous close': '171.00',
          '09. change': '2.50',
          '10. change percent': '1.4620%',
        },
      });

      const result = await provider.getQuote(createTickerSymbol('AAPL'));

      expect(result.provider).toBe('alpha-vantage');
      expect(result.symbol).toBe('AAPL');
      expect(result.raw).toBeTruthy();
    });

    it('rate limit 응답 시 AlphaVantageError(429)를 던진다', async () => {
      mockFetch.mockResolvedValueOnce({
        Note: 'Thank you for using Alpha Vantage! Our standard API rate limit is 5 calls per minute.',
      });

      await expect(provider.getQuote(createTickerSymbol('AAPL'))).rejects.toThrow(
        AlphaVantageError,
      );
    });

    it('Information 필드로 에러를 반환하면 AlphaVantageError(429)를 던진다', async () => {
      mockFetch.mockResolvedValueOnce({
        Information: 'The daily API limit has been reached.',
      });

      await expect(provider.getQuote(createTickerSymbol('AAPL'))).rejects.toThrow(
        'API rate limit exceeded',
      );
    });

    it('잘못된 응답 형식이면 AlphaVantageError(404)를 던진다', async () => {
      mockFetch.mockResolvedValueOnce({ unexpected: 'format' });

      await expect(provider.getQuote(createTickerSymbol('INVALID'))).rejects.toThrow(
        'No data found for symbol',
      );
    });
  });

  describe('getHistorical', () => {
    it('1d 기간은 INTRADAY 함수를 사용한다', async () => {
      mockFetch.mockResolvedValueOnce({
        'Time Series (5min)': {
          '2025-01-15 16:00:00': {
            '1. open': '170.00',
            '2. high': '175.00',
            '3. low': '168.00',
            '4. close': '173.50',
            '5. volume': '50000000',
          },
        },
      });

      const result = await provider.getHistorical(createTickerSymbol('AAPL'), '1d');

      expect(result.period).toBe('1d');
      expect(result.raw).toBeTruthy();
    });
  });

  describe('rateLimit', () => {
    it('무료 티어 설정이 올바르다', () => {
      expect(provider.rateLimit.maxRequests).toBe(5);
      expect(provider.rateLimit.windowMs).toBe(60_000);
      expect(provider.rateLimit.dailyLimit).toBe(25);
    });
  });
});
```

**검증:**

```bash
cd packages/skills-finance && npx vitest run src/market/providers/alpha-vantage.test.ts
```

---

## 최종 검증

모든 단계 완료 후 실행:

```bash
# 1. 전체 타입 검증
npx tsc --build

# 2. 전체 테스트 실행
cd packages/skills-finance && npx vitest run

# 3. 린트
pnpm lint

# 4. 포맷
pnpm format:fix
```

---

## 파일 커버리지 매트릭스

| plan.md 파일                        | todo.md 단계 | 상태      |
| ----------------------------------- | ------------ | --------- |
| `market/types.ts`                   | Step 1       | 전체 코드 |
| `market/provider-registry.ts`       | Step 2       | 전체 코드 |
| `market/providers/frankfurter.ts`   | Step 3       | 전체 코드 |
| `market/providers/coingecko.ts`     | Step 4       | 전체 코드 |
| `market/providers/alpha-vantage.ts` | Step 5       | 전체 코드 |
| `market/normalizer.ts`              | Step 6       | 전체 코드 |
| `market/cache.ts`                   | Step 7       | 전체 코드 |
| `market/charts.ts`                  | Step 8       | 전체 코드 |
| `market/formatters.ts`              | Step 9       | 전체 코드 |
| `market/index.ts`                   | Step 10      | 전체 코드 |
| `normalizer.test.ts`                | T-1          | 전체 코드 |
| `cache.test.ts`                     | T-2          | 전체 코드 |
| `charts.test.ts`                    | T-3          | 전체 코드 |
| `alpha-vantage.test.ts`             | T-4          | 전체 코드 |

**사전 작업 (의존성 갭):**
| 갭 | 해결 단계 |
|---|---|
| `getCachedData`/`setCachedData` 미export | P-1 |
| `getStaleCachedData` 미존재 | P-1 |
| `@finclaw/infra`, `@finclaw/agent` 의존성 없음 | P-2 |
| tsconfig references 없음 | P-3 |
