# Phase 16: 금융 스킬 -- 시장 데이터

> 복잡도: **L** | 소스 파일: ~10 | 테스트 파일: ~4 | 총 ~14 파일

---

## 1. 목표

FinClaw의 핵심 금융 기능인 **시장 데이터 스킬**을 구축한다. 주식(Alpha Vantage), 암호화폐(CoinGecko), 외환(Frankfurter) 3개 데이터 프로바이더를 통합하고, 통일된 `MarketQuote` 인터페이스로 정규화하여 에이전트 도구(tool)로 등록한다. SQLite 기반 TTL 캐시로 API 요청을 최소화하고, rate limiter로 프로바이더별 API 제한을 준수하며, 터미널/Discord용 텍스트 기반 스파크라인 차트를 생성한다.

**핵심 목표:**

- 3개 금융 데이터 프로바이더: Alpha Vantage (주식), CoinGecko (암호화폐), Frankfurter (환율, ECB 데이터, 무료/키 불필요)
- 통일된 MarketQuote 인터페이스로 프로바이더별 응답 정규화
- SQLite TTL 캐시 연동 (Phase 14의 market_cache 테이블 활용)
- 에이전트 도구 등록: `get_stock_price`, `get_crypto_price`, `get_forex_rate`, `get_market_chart`
- 프로바이더별 rate limiting (Alpha Vantage: 5req/min + 25req/day 무료 티어, CoinGecko: 10req/min 무키)
- 텍스트 기반 스파크라인 차트 생성 (터미널/Discord 호환)
- 그레이스풀 디그레이데이션: API 불가 시 캐시 폴백 + 에러 메시지
- 기존 인프라 최대 활용: @finclaw/infra의 safeFetchJson/retry/CircuitBreaker, @finclaw/types의 MarketQuote/OHLCVCandle 재사용

---

## 2. OpenClaw 참조

### 참조 문서

| 문서 경로                                             | 적용할 패턴                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `openclaw_review/deep-dive/20-skills-docs-scripts.md` | 스킬 시스템 구조, Progressive Disclosure 3-Level, OpenClawSkillMetadata, 스킬 등록 |
| `openclaw_review/deep-dive/04-agent-tools-sandbox.md` | 에이전트 도구 정의, 도구 등록 패턴                                                 |
| `openclaw_review/deep-dive/12-infrastructure.md`      | `ConcurrencyLane` 패턴 — Rate Limiter 설계 참고                                    |

### 적용할 핵심 패턴

**1) Provider Strategy Pattern (OpenClaw 전역 패턴)**

- OpenClaw: `EmbeddingProvider`, `MediaUnderstandingProvider`, `TtsProvider` 등 동일 인터페이스의 다중 구현체
- FinClaw: `MarketDataProvider` 인터페이스로 Alpha Vantage, CoinGecko, Frankfurter를 통합. 프로바이더 추가/교체가 인터페이스 변경 없이 가능

**2) Progressive Disclosure 3-Level (OpenClaw skills/ 구조)**

- Level 1 (메타데이터): 스킬 이름, 설명 — 항상 로드
- Level 2 (본문): 도구 정의, 사용 가이드 — 스킬 활성화 시 로드
- Level 3 (번들 리소스): 상세 API 문서, 예시 — 필요 시 참조
- FinClaw: 시장 데이터 스킬의 도구 4개를 Level 2에서 등록

**3) Batch + Fallback (OpenClaw 메모리 시스템)**

- OpenClaw: 배치 실패 시 개별 폴백
- FinClaw: 프로바이더 실패 시 캐시 폴백 → stale 데이터 반환 (with 경고)

**4) Singleton Cache with Key (OpenClaw memory/manager.ts)**

- OpenClaw: `INDEX_CACHE = new Map<string, MemoryIndexManager>()`
- FinClaw: Phase 14의 `market_cache` SQLite 테이블을 통한 TTL 캐시. 메모리 캐시 + DB 캐시 이중 구조

**5) Worker Pool Concurrency (OpenClaw concurrency.ts)**

- OpenClaw: `runWithConcurrency(tasks, limit)` 패턴
- FinClaw: rate limiter로 프로바이더별 동시 요청 제한

---

## 3. 생성할 파일

### 소스 파일 (10개)

| 파일 경로                                                       | 역할                                                        | 예상 줄 수 |
| --------------------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| `packages/skills-finance/src/market/index.ts`                   | 스킬 등록 (Phase 7 도구 정의 + handler 분리)                | ~60        |
| `packages/skills-finance/src/market/types.ts`                   | 확장 타입 (`@finclaw/types` 재사용, 프로바이더 전용만 정의) | ~80        |
| `packages/skills-finance/src/market/providers/alpha-vantage.ts` | Alpha Vantage API 클라이언트 (주식 시세)                    | ~150       |
| `packages/skills-finance/src/market/providers/coingecko.ts`     | CoinGecko API 클라이언트 (암호화폐)                         | ~130       |
| `packages/skills-finance/src/market/providers/frankfurter.ts`   | Frankfurter API 클라이언트 (환율, ECB 데이터)               | ~80        |
| `packages/skills-finance/src/market/provider-registry.ts`       | 티커→프로바이더 라우팅 (ProviderRegistry)                   | ~50        |
| `packages/skills-finance/src/market/normalizer.ts`              | 프로바이더별 응답을 ProviderMarketQuote로 변환              | ~120       |
| `packages/skills-finance/src/market/cache.ts`                   | SQLite TTL 캐시 래퍼 + rate limiter                         | ~120       |
| `packages/skills-finance/src/market/charts.ts`                  | 텍스트 기반 스파크라인 차트 생성                            | ~80        |
| `packages/skills-finance/src/market/formatters.ts`              | Discord/터미널용 시세 출력 포맷팅                           | ~80        |

### 테스트 파일 (4개)

| 파일 경로                                                            | 테스트 대상                                                 | 테스트 종류 |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | ----------- |
| `packages/skills-finance/src/market/normalizer.test.ts`              | 프로바이더별 응답 정규화, Zod 실패 케이스                   | unit        |
| `packages/skills-finance/src/market/cache.test.ts`                   | TTL 캐시 HIT/MISS/stale, rate limiter while 루프, 일별 한도 | unit        |
| `packages/skills-finance/src/market/charts.test.ts`                  | 스파크라인 생성, 데이터 범위 처리                           | unit        |
| `packages/skills-finance/src/market/providers/alpha-vantage.test.ts` | API 호출 mock, Zod 검증 실패, 일별 한도                     | unit        |

---

## 4. 핵심 인터페이스/타입

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

---

## 5. 구현 상세

### 5.1 Alpha Vantage 프로바이더 (주식)

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
import { safeFetchJson } from '@finclaw/infra/fetch.js';
import { retry } from '@finclaw/infra/retry.js';
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

### 5.2 CoinGecko 프로바이더 (암호화폐)

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
import { safeFetchJson } from '@finclaw/infra/fetch.js';
import { retry } from '@finclaw/infra/retry.js';
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
      maxRequests: apiKey ? 30 : 10, // 무키: 10req/min, 키 있으면: 30req/min
      windowMs: 60_000,
    };
  }

  supports(symbol: TickerSymbol): boolean {
    // BTC, ETH 등 주요 암호화폐 ticker 또는 BTC-USD 형식
    const ticker = symbol.split('-')[0].toUpperCase();
    return ticker in TICKER_TO_ID;
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const ticker = symbol.split('-')[0].toUpperCase();
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
    const ticker = symbol.split('-')[0].toUpperCase();
    const coinId = TICKER_TO_ID[ticker];
    if (!coinId) {
      throw new Error(`Unsupported cryptocurrency: ${symbol}`);
    }

    const vsCurrency = symbol.includes('-') ? symbol.split('-')[1].toLowerCase() : 'usd';
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

### 5.3 데이터 정규화

```typescript
// packages/skills-finance/src/market/normalizer.ts
import type {
  ProviderMarketQuote,
  MarketHistorical,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
} from './types.js';
import type { OHLCVCandle, CurrencyCode } from '@finclaw/types/finance.js';
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

/** Frankfurter 응답 스키마 */
const FrankfurterQuoteSchema = z.object({
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

/**
 * 프로바이더별 원시 응답을 통일된 ProviderMarketQuote로 변환한다.
 * 각 프로바이더의 응답 형식이 완전히 다르므로 프로바이더별 파서를 분리한다.
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
    timestamp: Date.now(),
    provider: 'alpha-vantage',
    delayed: true, // Alpha Vantage 무료 티어는 15분 지연
    currency: createCurrencyCode('USD'),
  };
}

function normalizeCoinGeckoQuote(response: ProviderQuoteResponse): ProviderMarketQuote {
  // CoinDetailSchema로 이미 검증된 데이터
  const data = response.raw as {
    id: string;
    symbol: string;
    name: string;
    market_data: {
      current_price: Record<string, number>;
      price_change_24h: number | null;
      price_change_percentage_24h: number | null;
      high_24h: Record<string, number>;
      low_24h: Record<string, number>;
      total_volume: Record<string, number>;
      market_cap: Record<string, number>;
    };
    last_updated: string;
  };

  const vsCurrency = 'usd'; // 기본 통화
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
    volume: md.total_volume[vsCurrency] ?? null,
    marketCap: md.market_cap[vsCurrency] ?? null,
    timestamp: new Date(data.last_updated).getTime(),
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
  const [from, to] = (response.symbol as string).split('/');
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
    volume: null,
    marketCap: null,
    timestamp: new Date(data.date).getTime(),
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
      timestamp: new Date(date).getTime(),
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
    timestamp,
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

### 5.4 캐시 & Rate Limiter

```typescript
// packages/skills-finance/src/market/cache.ts
import type { DatabaseSync } from 'node:sqlite';
import type { ProviderMarketQuote, MarketHistorical, RateLimitConfig } from './types.js';
import { getCachedData, setCachedData, CACHE_TTL } from '@finclaw/storage/tables/market-cache.js';

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
        console.warn(`[Cache] Returning stale data for ${symbol}: ${error}`);
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
 * stale 캐시 조회 — 만료된 데이터도 반환한다 (graceful degradation용).
 * 이것이 이 phase에서 @finclaw/storage/tables/market-cache.ts에 추가해야 하는
 * 유일한 함수(~5줄)이다. getCachedData와 동일하되 expiresAt 조건을 제거한다.
 */
declare function getStaleCachedData<T>(db: DatabaseSync, key: string): T | null;

/**
 * 슬라이딩 윈도우 rate limiter.
 * 프로바이더별 API 요청 빈도를 제한한다.
 */
class RateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly config: RateLimitConfig) {}

  async acquire(): Promise<void> {
    // while 루프로 재귀 호출 제거
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

### 5.5 텍스트 스파크라인 차트

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
 * AAPL (1m) $192.53
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
    lines.push(`${formatCurrency(latest.close, currency)}`);
  }

  lines.push(sparkline);
  lines.push(
    `H: ${formatCurrency(max, currency)}  L: ${formatCurrency(min, currency)}  Δ: ${changeSign}${change.toFixed(1)}%`,
  );

  return lines.join('\n');
}

/**
 * 데이터 배열을 targetLength 크기로 리샘플링한다.
 * 선형 보간 또는 평균값 집계를 사용한다.
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

### 5.6 에이전트 도구 등록

```typescript
// packages/skills-finance/src/market/index.ts
import type {
  RegisteredToolDefinition,
  ToolExecutor,
} from '@finclaw/agent/agents/tools/registry.js';
import type { ToolRegistry } from '@finclaw/agent/agents/tools/registry.js';
import type { ProviderMarketQuote } from './types.js';
import { formatQuote, formatForexRate, formatChart } from './formatters.js';

/**
 * 시장 데이터 스킬의 에이전트 도구 4개를 등록한다.
 * Phase 7의 RegisteredToolDefinition + ToolExecutor 분리 패턴을 따른다.
 */
export function registerMarketTools(registry: ToolRegistry): void {
  // get_stock_price
  const stockPriceDef: RegisteredToolDefinition = {
    name: 'get_stock_price',
    description:
      '주식 실시간/지연 시세를 조회합니다. 미국 주식 티커(예: AAPL, GOOGL, MSFT)를 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '주식 티커 심볼 (예: AAPL)' },
        currency: { type: 'string', description: '표시 통화 (기본: USD)', default: 'USD' },
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
  const stockPriceExecutor: ToolExecutor = async (input, context) => {
    const symbol = input.symbol as string;
    // ProviderRegistry.resolve(symbol) → MarketCache.getQuote(...) → formatQuote(...)
    const quote = await getQuoteFromRegistry(symbol);
    return { content: formatQuote(quote), isError: false };
  };
  registry.register(stockPriceDef, stockPriceExecutor, 'skill');

  // get_crypto_price
  const cryptoPriceDef: RegisteredToolDefinition = {
    name: 'get_crypto_price',
    description: '암호화폐 실시간 시세를 조회합니다. BTC, ETH, SOL 등 주요 암호화폐를 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '암호화폐 심볼 (예: BTC, ETH)' },
        currency: { type: 'string', description: '표시 통화 (기본: USD)', default: 'USD' },
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
  const cryptoPriceExecutor: ToolExecutor = async (input, context) => {
    const symbol = input.symbol as string;
    const quote = await getQuoteFromRegistry(symbol);
    return { content: formatQuote(quote), isError: false };
  };
  registry.register(cryptoPriceDef, cryptoPriceExecutor, 'skill');

  // get_forex_rate
  const forexRateDef: RegisteredToolDefinition = {
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
  const forexRateExecutor: ToolExecutor = async (input, context) => {
    const from = input.from as string;
    const to = input.to as string;
    const quote = await getQuoteFromRegistry(`${from}/${to}`);
    return { content: formatForexRate(quote), isError: false };
  };
  registry.register(forexRateDef, forexRateExecutor, 'skill');

  // get_market_chart
  const marketChartDef: RegisteredToolDefinition = {
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
  const marketChartExecutor: ToolExecutor = async (input, context) => {
    const symbol = input.symbol as string;
    const period = (input.period as string) ?? '1m';
    // ProviderRegistry.resolve(symbol) → getHistorical → generateSparkline → formatChart
    const sparkline = await getChartFromRegistry(symbol, period);
    return { content: formatChart(symbol, sparkline, period), isError: false };
  };
  registry.register(marketChartDef, marketChartExecutor, 'skill');
}

// 내부 헬퍼 (실제 구현에서 ProviderRegistry + MarketCache 연결)
declare function getQuoteFromRegistry(symbol: string): Promise<ProviderMarketQuote>;
declare function getChartFromRegistry(symbol: string, period: string): Promise<string>;

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

### 5.7 데이터 흐름 다이어그램

```
에이전트 도구 호출 흐름:
  사용자: "삼성전자 주가 알려줘"
    │
    └─→ Agent → tool_call: get_stock_price({ symbol: "005930.KS" })
         │
         ├─→ ProviderRegistry.resolve("005930.KS") → AlphaVantageProvider
         │
         ├─→ MarketCache.getQuote("005930.KS", alphaVantageProvider, normalizeQuote)
         │      │
         │      ├─→ [캐시 HIT] → 정규화된 ProviderMarketQuote 반환
         │      │
         │      └─→ [캐시 MISS]
         │           ├─→ checkDailyLimit() → 일별 한도 확인
         │           ├─→ RateLimiter.acquire() → 제한 확인
         │           ├─→ AlphaVantageProvider.getQuote("005930.KS") → safeFetchJson 호출
         │           ├─→ normalizeAlphaVantageQuote(response) → ProviderMarketQuote 변환
         │           └─→ setCachedData("quote:005930.KS", quote, TTL=5min)
         │
         └─→ formatQuote(quote) → "삼성전자 (005930.KS): ₩72,500 (+1.2%)"

차트 생성 흐름:
  사용자: "비트코인 1개월 차트 보여줘"
    │
    └─→ Agent → tool_call: get_market_chart({ symbol: "BTC", period: "1m" })
         │
         ├─→ ProviderRegistry.resolve("BTC") → CoinGeckoProvider
         ├─→ CoinGeckoProvider.getHistorical("BTC", "1m") → 30일 데이터
         ├─→ normalizeCoinGeckoHistorical(response) → OHLCVCandle[]
         └─→ generateSparkline(candles, { width: 40, currency: "USD" })
              │
              └─→ 텍스트 출력:
                   BTC (1m) $67,234.50
                   ▃▄▅▆▇█▇▆▅▄▃▂▃▄▅▆▇▇▆▅▅▆▇█▇▅▃▂▃▄▅▆▇█▇▅▄▃▂
                   H: $71,000.00  L: $58,500.00  Δ: +8.5%
```

### 5.8 ProviderRegistry

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
  // 지연 import로 순환 의존 방지
  // import { AlphaVantageProvider } from './providers/alpha-vantage.js';
  // import { CoinGeckoProvider } from './providers/coingecko.js';
  // import { FrankfurterProvider } from './providers/frankfurter.js';

  const registry = new ProviderRegistry();

  // Alpha Vantage는 API 키가 있을 때만 등록
  if (config.alphaVantageKey) {
    // registry.register(new AlphaVantageProvider(config.alphaVantageKey));
  }

  // CoinGecko는 항상 등록 (무키 동작 가능)
  // registry.register(new CoinGeckoProvider(config.coinGeckoKey));

  // Frankfurter는 항상 등록 (무료, 키 불필요)
  // registry.register(new FrankfurterProvider());

  return registry;
}
```

### 5.9 출력 포맷터

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

  if (quote.volume != null) {
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

---

## 6. 선행 조건

| 선행 Phase                  | 필요한 산출물                                                                          | 사용처                      |
| --------------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| Phase 1 (types)             | `MarketQuote`, `OHLCVCandle`, `TickerSymbol`, `CurrencyCode`, `createTickerSymbol()`   | 데이터 인터페이스           |
| Phase 3 (config)            | API 키 설정 (ALPHA_VANTAGE_KEY, COINGECKO_DEMO_KEY)                                    | 프로바이더 인증             |
| Phase 7 (tool registration) | 에이전트 도구 등록 시스템 (`RegisteredToolDefinition`, `ToolExecutor`, `ToolRegistry`) | 도구 4개 등록               |
| Phase 12 (infra)            | `safeFetchJson`, `retry`, `CircuitBreaker`, `createCircuitBreaker`                     | HTTP 클라이언트, 회로차단기 |
| Phase 14 (storage)          | `market_cache` SQLite 테이블, `getCachedData()`/`setCachedData()`                      | TTL 캐시                    |

### 새로운 의존성

이 phase에서는 새로운 npm 의존성이 필요하지 않다. `@finclaw/infra`의 `safeFetchJson`(SSRF 보호 + 타임아웃)을 사용한다. Zod v4는 이미 프로젝트 의존성. 새 npm 의존성 없음.

---

## 7. 산출물 및 검증

### 기능 검증 항목

| #   | 검증 항목               | 검증 방법                                                                    | 기대 결과                                                 |
| --- | ----------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Alpha Vantage 주식 시세 | mock safeFetchJson → `getQuote("AAPL")`                                      | ProviderQuoteResponse 반환                                |
| 2   | Alpha Vantage 외환      | mock safeFetchJson → `getQuote("USD/KRW")`                                   | 환율 ProviderQuoteResponse                                |
| 3   | CoinGecko 암호화폐      | mock safeFetchJson → `getQuote("BTC")`                                       | 암호화폐 ProviderQuoteResponse                            |
| 4   | Frankfurter 환율        | mock safeFetchJson → `getQuote("EUR/USD")`                                   | 환율 ProviderQuoteResponse                                |
| 5   | 주식 시세 정규화        | Alpha Vantage 원시 데이터 → `normalizeQuote()`                               | 모든 ProviderMarketQuote 필드 정상 변환                   |
| 6   | 암호화폐 정규화         | CoinGecko 원시 데이터 → `normalizeQuote()`                                   | 시가총액, 거래량 포함                                     |
| 7   | 과거 데이터 정규화      | Alpha Vantage daily → `normalizeHistorical()`                                | 타임스탬프순 정렬된 OHLCVCandle 배열                      |
| 8   | 캐시 HIT                | 캐시 저장 후 동일 키 조회                                                    | 캐시 데이터 반환, safeFetchJson 미호출                    |
| 9   | 캐시 MISS + API 호출    | 캐시 없는 상태에서 조회                                                      | safeFetchJson 호출 + 캐시 저장                            |
| 10  | Graceful degradation    | API 실패 + stale 캐시 존재                                                   | stale 데이터 반환 (delayed=true)                          |
| 11  | Rate limiter            | 6개 연속 요청 (limit=5/min) + 26번째 요청 (dailyLimit=25) 차단               | 6번째 요청이 대기 후 실행, 26번째 DailyLimitExceededError |
| 12  | 스파크라인 생성         | 30개 OHLCVCandle                                                             | 올바른 SPARK_CHARS 매핑                                   |
| 13  | 스파크라인 빈 데이터    | 빈 배열 입력                                                                 | "(데이터 없음)" 반환                                      |
| 14  | 통화 포맷팅             | `formatPrice(1234567, "USD")`                                                | "$1.23M"                                                  |
| 15  | 도구 등록               | `registerMarketTools(registry)`                                              | 4개 RegisteredToolDefinition 등록                         |
| 16  | supports 판별           | `alphaVantage.supports("AAPL")` → true, `coingecko.supports("BTC")` → true   | 올바른 프로바이더 라우팅                                  |
| 17  | safeFetch 사용 확인     | 모든 프로바이더가 safeFetchJson() 사용                                       | SSRF 보호 + 타임아웃 적용                                 |
| 18  | Zod 응답 검증           | 잘못된 형식의 API 응답 입력                                                  | ZodError throw (as 캐스트 아님)                           |
| 19  | ProviderRegistry 라우팅 | resolve("AAPL")→AV, resolve("BTC")→CoinGecko, resolve("USD/KRW")→Frankfurter | 올바른 분류                                               |
| 20  | 일별 한도 지속성        | 프로세스 재시작 후 dailyCount 복원                                           | SQLite에서 카운터 로드                                    |

### 테스트 커버리지 목표

| 모듈             | 목표 커버리지     |
| ---------------- | ----------------- |
| `normalizer.ts`  | 90%+              |
| `cache.ts`       | 85%+              |
| `charts.ts`      | 90%+              |
| `providers/*.ts` | 80%+ (fetch mock) |

---

## 8. 복잡도 및 예상 파일 수

| 항목               | 값                                                                 |
| ------------------ | ------------------------------------------------------------------ |
| 복잡도             | **L** (Large)                                                      |
| 소스 파일          | **10개**                                                           |
| 테스트 파일        | 4개                                                                |
| 총 파일 수         | **~14개**                                                          |
| 예상 총 코드 줄 수 | **~1,300줄** (소스 ~850, 테스트 ~450, infra/types 재사용으로 감소) |
| 새 의존성          | 없음 (safeFetchJson, retry, Zod v4 모두 기존 의존성)               |
| 예상 구현 시간     | 4-6시간                                                            |

### 복잡도 근거

이 phase는 **FinClaw 고유 기능**으로 OpenClaw에 직접 대응하는 코드가 없다. 3개 외부 API 프로바이더의 응답 형식이 모두 다르므로 정규화 로직이 복잡하고, 각 프로바이더의 API 제한/에러 패턴도 다르다. 그러나 Provider Strategy 패턴으로 구조를 정리하면 개별 프로바이더는 자기 완결적이며, 캐시와 rate limiter는 Phase 14의 인프라를 재활용한다. 스파크라인 차트는 알고리즘적으로 흥미롭지만 코드 양은 적다. `@finclaw/infra`의 `safeFetchJson`/`retry`/`CircuitBreaker`와 `@finclaw/types`의 `MarketQuote`/`OHLCVCandle` 재사용으로 코드량이 절감된다. 전체적으로 API 통합의 폭(3 프로바이더 x 2 기능)이 복잡도를 L로 만드는 주요 요인이다.

---

## 9. 구현 순서

| 단계 | 파일                       | 의존                     | 검증                              |
| ---- | -------------------------- | ------------------------ | --------------------------------- |
| 1    | types.ts                   | @finclaw/types           | tsc --noEmit 통과                 |
| 2    | provider-registry.ts       | types.ts                 | resolve() 단위 테스트             |
| 3    | providers/frankfurter.ts   | types.ts, @finclaw/infra | mock fetch 테스트                 |
| 4    | providers/coingecko.ts     | types.ts, @finclaw/infra | mock fetch 테스트                 |
| 5    | providers/alpha-vantage.ts | types.ts, @finclaw/infra | mock fetch + 일별 한도 테스트     |
| 6    | normalizer.ts              | types.ts, @finclaw/types | 3 프로바이더 정규화 테스트        |
| 7    | cache.ts + storage 소변경  | @finclaw/storage         | 캐시 HIT/MISS/stale, rate limiter |
| 8    | charts.ts                  | @finclaw/types           | 스파크라인 생성 테스트            |
| 9    | formatters.ts              | types.ts                 | 포맷 출력 테스트                  |
| 10   | index.ts (도구 등록)       | 전체                     | registry.register() + tsc + 통합  |

---

## 10. 빌드하지 않을 것

- WebSocket 실시간 스트리밍 (폴링 + TTL 캐시로 충분)
- 자체 CircuitBreaker/retry (@finclaw/infra 기존 것 사용)
- 프로바이더 플러그인 시스템 (3개 명시적 등록으로 충분)
- 멀티 프로바이더 합성 시세 (단일 프로바이더 결과면 충분)
- 기술 분석 도구 (타입은 있지만 Phase 16 범위 밖, 일별 25회 한도 고려)
- L1 메모리 + L2 SQLite 이중 캐시 (DatabaseSync 동기 API라 SQLite 단일로 충분)
- DI 컨테이너 (함수 파라미터 전달로 충분)
- 별도 schemas/ 디렉토리 (프로바이더 파일에 Zod 인라인)
- fetchWithTimeout 유틸 (safeFetchJson이 이미 AbortSignal.timeout 내장)
