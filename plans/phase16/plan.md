# Phase 16: 금융 스킬 -- 시장 데이터

> 복잡도: **L** | 소스 파일: ~8 | 테스트 파일: ~4 | 총 ~12 파일

---

## 1. 목표

FinClaw의 핵심 금융 기능인 **시장 데이터 스킬**을 구축한다. 주식(Alpha Vantage), 암호화폐(CoinGecko), 외환(exchangerate.host) 3개 데이터 프로바이더를 통합하고, 통일된 `MarketData` 인터페이스로 정규화하여 에이전트 도구(tool)로 등록한다. SQLite 기반 TTL 캐시로 API 요청을 최소화하고, rate limiter로 프로바이더별 API 제한을 준수하며, 터미널/Discord용 텍스트 기반 스파크라인 차트를 생성한다.

**핵심 목표:**

- 3개 금융 데이터 프로바이더: Alpha Vantage (주식/외환), CoinGecko (암호화폐), exchangerate.host (환율)
- 통일된 MarketData 인터페이스로 프로바이더별 응답 정규화
- SQLite TTL 캐시 연동 (Phase 14의 market_cache 테이블 활용)
- 에이전트 도구 등록: `get_stock_price`, `get_crypto_price`, `get_forex_rate`, `get_market_chart`
- 프로바이더별 rate limiting (Alpha Vantage: 5req/min 무료 티어, CoinGecko: 30req/min)
- 텍스트 기반 스파크라인 차트 생성 (터미널/Discord 호환)
- 그레이스풀 디그레이데이션: API 불가 시 캐시 폴백 + 에러 메시지

---

## 2. OpenClaw 참조

### 참조 문서

| 문서 경로                                             | 적용할 패턴                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `openclaw_review/deep-dive/20-skills-docs-scripts.md` | 스킬 시스템 구조, Progressive Disclosure 3-Level, OpenClawSkillMetadata, 스킬 등록 |
| `openclaw_review/deep-dive/04-agent-tools-sandbox.md` | 에이전트 도구 정의, 도구 등록 패턴                                                 |

### 적용할 핵심 패턴

**1) Provider Strategy Pattern (OpenClaw 전역 패턴)**

- OpenClaw: `EmbeddingProvider`, `MediaUnderstandingProvider`, `TtsProvider` 등 동일 인터페이스의 다중 구현체
- FinClaw: `MarketDataProvider` 인터페이스로 Alpha Vantage, CoinGecko, exchangerate.host를 통합. 프로바이더 추가/교체가 인터페이스 변경 없이 가능

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

### 소스 파일 (8개)

| 파일 경로                                              | 역할                                                  | 예상 줄 수 |
| ------------------------------------------------------ | ----------------------------------------------------- | ---------- |
| `src/skills/finance/market/index.ts`                   | 시장 데이터 스킬 등록 (barrel + skill metadata)       | ~40        |
| `src/skills/finance/market/types.ts`                   | 프로바이더별 API 응답 타입 + 정규화된 MarketData 타입 | ~120       |
| `src/skills/finance/market/providers/alpha-vantage.ts` | Alpha Vantage API 클라이언트 (주식 시세, 외환)        | ~180       |
| `src/skills/finance/market/providers/coingecko.ts`     | CoinGecko API 클라이언트 (암호화폐 시세, 시가총액)    | ~150       |
| `src/skills/finance/market/providers/exchangerate.ts`  | exchangerate.host API 클라이언트 (환율)               | ~100       |
| `src/skills/finance/market/normalizer.ts`              | 프로바이더별 응답을 통일된 MarketData로 변환          | ~120       |
| `src/skills/finance/market/cache.ts`                   | SQLite TTL 캐시 래퍼 + rate limiter                   | ~100       |
| `src/skills/finance/market/charts.ts`                  | 텍스트 기반 스파크라인 차트 생성                      | ~80        |

### 테스트 파일 (4개)

| 파일 경로                                                   | 테스트 대상                            | 테스트 종류 |
| ----------------------------------------------------------- | -------------------------------------- | ----------- |
| `src/skills/finance/market/normalizer.test.ts`              | 프로바이더별 응답 정규화, 엣지 케이스  | unit        |
| `src/skills/finance/market/cache.test.ts`                   | TTL 캐시 HIT/MISS, rate limiter 동작   | unit        |
| `src/skills/finance/market/charts.test.ts`                  | 스파크라인 생성, 데이터 범위 처리      | unit        |
| `src/skills/finance/market/providers/alpha-vantage.test.ts` | API 호출 mock, 에러 핸들링, rate limit | unit        |

---

## 4. 핵심 인터페이스/타입

```typescript
// src/skills/finance/market/types.ts — 통일된 시장 데이터 인터페이스

/** 시장 데이터 프로바이더 인터페이스 */
export interface MarketDataProvider {
  readonly id: string; // "alpha-vantage" | "coingecko" | "exchangerate"
  readonly name: string; // 표시명
  readonly rateLimit: RateLimitConfig; // API 제한 설정

  /** 실시간/지연 시세 조회 */
  getQuote(ticker: string): Promise<ProviderQuoteResponse>;

  /** 과거 데이터 조회 */
  getHistorical(ticker: string, period: HistoricalPeriod): Promise<ProviderHistoricalResponse>;

  /** 지원 여부 확인 */
  supports(ticker: string): boolean;
}

/** Rate Limit 설정 */
export interface RateLimitConfig {
  readonly maxRequests: number; // 윈도우 내 최대 요청 수
  readonly windowMs: number; // 윈도우 크기 (밀리초)
}

/** 정규화된 시세 데이터 */
export interface MarketQuote {
  readonly ticker: string; // 예: "AAPL", "BTC", "USD/KRW"
  readonly name: string; // 예: "Apple Inc.", "Bitcoin"
  readonly price: number; // 현재가
  readonly currency: string; // 가격 통화 (예: "USD", "KRW")
  readonly change: number; // 변동액
  readonly changePercent: number; // 변동률 (%)
  readonly high: number; // 고가
  readonly low: number; // 저가
  readonly open: number; // 시가
  readonly previousClose: number; // 전일 종가
  readonly volume: number | null; // 거래량 (외환은 null)
  readonly marketCap: number | null; // 시가총액 (주식/암호화폐만)
  readonly timestamp: number; // 데이터 시점 (Unix ms)
  readonly provider: string; // 데이터 소스
  readonly delayed: boolean; // 지연 데이터 여부
}

/** 과거 데이터 조회 기간 */
export type HistoricalPeriod = '1d' | '5d' | '1m' | '3m' | '6m' | '1y' | '5y';

/** 과거 데이터 포인트 */
export interface HistoricalDataPoint {
  readonly date: string; // ISO 날짜 (YYYY-MM-DD)
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number | null;
}

/** 과거 데이터 응답 (정규화됨) */
export interface MarketHistorical {
  readonly ticker: string;
  readonly period: HistoricalPeriod;
  readonly currency: string;
  readonly dataPoints: HistoricalDataPoint[];
  readonly provider: string;
}

/** 프로바이더 원시 응답 (정규화 전) */
export interface ProviderQuoteResponse {
  readonly raw: unknown; // 프로바이더별 원시 데이터
  readonly ticker: string;
  readonly provider: string;
}

export interface ProviderHistoricalResponse {
  readonly raw: unknown;
  readonly ticker: string;
  readonly period: HistoricalPeriod;
  readonly provider: string;
}

// 에이전트 도구 정의
export interface MarketToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, ToolParameter>;
  readonly handler: (params: Record<string, unknown>) => Promise<string>;
}

export interface ToolParameter {
  readonly type: 'string' | 'number' | 'boolean';
  readonly description: string;
  readonly required: boolean;
  readonly enum?: string[];
  readonly default?: unknown;
}

// 스파크라인 차트 옵션
export interface ChartOptions {
  readonly width?: number; // 차트 너비 (문자 수, 기본 40)
  readonly height?: number; // 차트 높이 (라인 수, 기본 5)
  readonly showAxis?: boolean; // 축 표시 (기본 true)
  readonly showPrice?: boolean; // 현재가 표시 (기본 true)
  readonly currency?: string; // 통화 단위 (기본 "USD")
}
```

---

## 5. 구현 상세

### 5.1 Alpha Vantage 프로바이더 (주식/외환)

```typescript
// src/skills/finance/market/providers/alpha-vantage.ts
import type {
  MarketDataProvider,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
  HistoricalPeriod,
  RateLimitConfig,
} from '../types.js';

const BASE_URL = 'https://www.alphavantage.co/query';

export class AlphaVantageProvider implements MarketDataProvider {
  readonly id = 'alpha-vantage';
  readonly name = 'Alpha Vantage';
  readonly rateLimit: RateLimitConfig = {
    maxRequests: 5, // 무료 티어: 5 requests/minute
    windowMs: 60_000,
  };

  constructor(private readonly apiKey: string) {}

  supports(ticker: string): boolean {
    // 주식 (알파벳 1-5자) 또는 외환 (XXX/YYY 형식) 지원
    return /^[A-Z]{1,5}$/.test(ticker) || /^[A-Z]{3}\/[A-Z]{3}$/.test(ticker);
  }

  async getQuote(ticker: string): Promise<ProviderQuoteResponse> {
    if (ticker.includes('/')) {
      return this.getForexQuote(ticker);
    }
    return this.getStockQuote(ticker);
  }

  private async getStockQuote(ticker: string): Promise<ProviderQuoteResponse> {
    const url = new URL(BASE_URL);
    url.searchParams.set('function', 'GLOBAL_QUOTE');
    url.searchParams.set('symbol', ticker);
    url.searchParams.set('apikey', this.apiKey);

    const response = await fetch(url);
    if (!response.ok) {
      throw new AlphaVantageError(`API request failed: ${response.status}`, response.status);
    }

    const data = await response.json();

    // Rate limit 감지
    if (data['Note'] || data['Information']) {
      throw new AlphaVantageError('API rate limit exceeded', 429);
    }

    // 빈 응답 감지
    if (!data['Global Quote'] || Object.keys(data['Global Quote']).length === 0) {
      throw new AlphaVantageError(`No data found for ticker: ${ticker}`, 404);
    }

    return { raw: data, ticker, provider: this.id };
  }

  private async getForexQuote(pair: string): Promise<ProviderQuoteResponse> {
    const [from, to] = pair.split('/');
    const url = new URL(BASE_URL);
    url.searchParams.set('function', 'CURRENCY_EXCHANGE_RATE');
    url.searchParams.set('from_currency', from);
    url.searchParams.set('to_currency', to);
    url.searchParams.set('apikey', this.apiKey);

    const response = await fetch(url);
    if (!response.ok) {
      throw new AlphaVantageError(`API request failed: ${response.status}`, response.status);
    }

    const data = await response.json();

    if (data['Note'] || data['Information']) {
      throw new AlphaVantageError('API rate limit exceeded', 429);
    }

    return { raw: data, ticker: pair, provider: this.id };
  }

  async getHistorical(
    ticker: string,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const url = new URL(BASE_URL);
    const func = period === '1d' ? 'TIME_SERIES_INTRADAY' : 'TIME_SERIES_DAILY_ADJUSTED';
    url.searchParams.set('function', func);
    url.searchParams.set('symbol', ticker);
    url.searchParams.set('apikey', this.apiKey);

    if (period === '1d') {
      url.searchParams.set('interval', '5min');
    }

    url.searchParams.set('outputsize', periodToOutputSize(period));

    const response = await fetch(url);
    if (!response.ok) {
      throw new AlphaVantageError(`API request failed: ${response.status}`, response.status);
    }

    const data = await response.json();
    return { raw: data, ticker, period, provider: this.id };
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
// src/skills/finance/market/providers/coingecko.ts
import type {
  MarketDataProvider,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
  HistoricalPeriod,
  RateLimitConfig,
} from '../types.js';

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

export class CoinGeckoProvider implements MarketDataProvider {
  readonly id = 'coingecko';
  readonly name = 'CoinGecko';
  readonly rateLimit: RateLimitConfig = {
    maxRequests: 30, // 무료 티어: 30 requests/minute
    windowMs: 60_000,
  };

  constructor(private readonly apiKey?: string) {}

  supports(ticker: string): boolean {
    // BTC, ETH 등 주요 암호화폐 ticker 또는 BTC-USD 형식
    const symbol = ticker.split('-')[0].toUpperCase();
    return symbol in TICKER_TO_ID;
  }

  async getQuote(ticker: string): Promise<ProviderQuoteResponse> {
    const symbol = ticker.split('-')[0].toUpperCase();
    const coinId = TICKER_TO_ID[symbol];
    if (!coinId) {
      throw new Error(`Unsupported cryptocurrency: ${ticker}`);
    }

    const vsCurrency = ticker.includes('-') ? ticker.split('-')[1].toLowerCase() : 'usd';

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

    const response = await fetch(url, { headers });
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('CoinGecko API rate limit exceeded');
      }
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data = await response.json();
    return { raw: data, ticker, provider: this.id };
  }

  async getHistorical(
    ticker: string,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const symbol = ticker.split('-')[0].toUpperCase();
    const coinId = TICKER_TO_ID[symbol];
    if (!coinId) {
      throw new Error(`Unsupported cryptocurrency: ${ticker}`);
    }

    const vsCurrency = ticker.includes('-') ? ticker.split('-')[1].toLowerCase() : 'usd';
    const days = periodToDays(period);

    const url = new URL(`${BASE_URL}/coins/${coinId}/market_chart`);
    url.searchParams.set('vs_currency', vsCurrency);
    url.searchParams.set('days', String(days));

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) {
      headers['x-cg-demo-api-key'] = this.apiKey;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data = await response.json();
    return { raw: data, ticker, period, provider: this.id };
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
// src/skills/finance/market/normalizer.ts
import type {
  MarketQuote,
  MarketHistorical,
  HistoricalDataPoint,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
} from './types.js';

/**
 * 프로바이더별 원시 응답을 통일된 MarketQuote로 변환한다.
 * 각 프로바이더의 응답 형식이 완전히 다르므로 프로바이더별 파서를 분리한다.
 */
export function normalizeQuote(response: ProviderQuoteResponse): MarketQuote {
  switch (response.provider) {
    case 'alpha-vantage':
      return normalizeAlphaVantageQuote(response);
    case 'coingecko':
      return normalizeCoinGeckoQuote(response);
    case 'exchangerate':
      return normalizeExchangeRateQuote(response);
    default:
      throw new Error(`Unknown provider: ${response.provider}`);
  }
}

function normalizeAlphaVantageQuote(response: ProviderQuoteResponse): MarketQuote {
  const data = response.raw as Record<string, Record<string, string>>;

  // 주식 시세
  if (data['Global Quote']) {
    const q = data['Global Quote'];
    return {
      ticker: q['01. symbol'],
      name: q['01. symbol'], // Alpha Vantage 무료 티어는 회사명 미제공
      price: parseFloat(q['05. price']),
      currency: 'USD',
      change: parseFloat(q['09. change']),
      changePercent: parseFloat(q['10. change percent']?.replace('%', '') ?? '0'),
      high: parseFloat(q['03. high']),
      low: parseFloat(q['04. low']),
      open: parseFloat(q['02. open']),
      previousClose: parseFloat(q['08. previous close']),
      volume: parseInt(q['06. volume'], 10),
      marketCap: null,
      timestamp: Date.now(),
      provider: 'alpha-vantage',
      delayed: true, // Alpha Vantage 무료 티어는 15분 지연
    };
  }

  // 외환 시세
  if (data['Realtime Currency Exchange Rate']) {
    const q = data['Realtime Currency Exchange Rate'];
    const rate = parseFloat(q['5. Exchange Rate']);
    return {
      ticker: `${q['1. From_Currency Code']}/${q['3. To_Currency Code']}`,
      name: `${q['2. From_Currency Name']} to ${q['4. To_Currency Name']}`,
      price: rate,
      currency: q['3. To_Currency Code'],
      change: 0, // 외환은 변동액을 별도 계산해야 함
      changePercent: 0,
      high: rate,
      low: rate,
      open: rate,
      previousClose: rate,
      volume: null,
      marketCap: null,
      timestamp: new Date(q['6. Last Refreshed']).getTime(),
      provider: 'alpha-vantage',
      delayed: false,
    };
  }

  throw new Error('Unexpected Alpha Vantage response format');
}

function normalizeCoinGeckoQuote(response: ProviderQuoteResponse): MarketQuote {
  const data = response.raw as {
    id: string;
    symbol: string;
    name: string;
    market_data: {
      current_price: Record<string, number>;
      price_change_24h: number;
      price_change_percentage_24h: number;
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
    ticker: data.symbol.toUpperCase(),
    name: data.name,
    price: md.current_price[vsCurrency] ?? 0,
    currency: vsCurrency.toUpperCase(),
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
  };
}

function normalizeExchangeRateQuote(response: ProviderQuoteResponse): MarketQuote {
  const data = response.raw as {
    base: string;
    date: string;
    rates: Record<string, number>;
  };

  const [from, to] = response.ticker.split('/');
  const rate = data.rates[to] ?? 0;

  return {
    ticker: response.ticker,
    name: `${from} to ${to}`,
    price: rate,
    currency: to,
    change: 0,
    changePercent: 0,
    high: rate,
    low: rate,
    open: rate,
    previousClose: rate,
    volume: null,
    marketCap: null,
    timestamp: new Date(data.date).getTime(),
    provider: 'exchangerate',
    delayed: false,
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
  const dataPoints: HistoricalDataPoint[] = Object.entries(series)
    .map(([date, values]) => ({
      date,
      open: parseFloat(values['1. open']),
      high: parseFloat(values['2. high']),
      low: parseFloat(values['3. low']),
      close: parseFloat(values['4. close']),
      volume: parseInt(values['5. volume'] ?? values['6. volume'] ?? '0', 10),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    ticker: response.ticker,
    period: response.period,
    currency: 'USD',
    dataPoints,
    provider: 'alpha-vantage',
  };
}

function normalizeCoinGeckoHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const data = response.raw as {
    prices: Array<[number, number]>;
    market_caps: Array<[number, number]>;
    total_volumes: Array<[number, number]>;
  };

  const dataPoints: HistoricalDataPoint[] = data.prices.map(([timestamp, price]) => {
    const date = new Date(timestamp).toISOString().split('T')[0];
    return {
      date,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: null,
    };
  });

  return {
    ticker: response.ticker,
    period: response.period,
    currency: 'USD',
    dataPoints,
    provider: 'coingecko',
  };
}
```

### 5.4 캐시 & Rate Limiter

```typescript
// src/skills/finance/market/cache.ts
import type { DatabaseSync } from 'node:sqlite';
import type { MarketQuote, MarketHistorical, RateLimitConfig } from './types.js';
import { getCachedData, setCachedData, CACHE_TTL } from '../../../storage/tables/market-cache.js';

/**
 * 시장 데이터 캐시 매니저.
 * SQLite TTL 캐시(Phase 14)를 래핑하고 rate limiting을 추가한다.
 */
export class MarketCache {
  private readonly rateLimiters = new Map<string, RateLimiter>();

  constructor(private readonly db: DatabaseSync) {}

  /** 시세 데이터를 캐시에서 조회하거나 프로바이더를 호출한다 */
  async getQuote(
    ticker: string,
    provider: { id: string; rateLimit: RateLimitConfig; getQuote: (t: string) => Promise<unknown> },
    normalize: (raw: unknown) => MarketQuote,
  ): Promise<MarketQuote> {
    const cacheKey = `quote:${ticker}:${provider.id}`;

    // 1. 캐시 확인
    const cached = getCachedData<MarketQuote>(this.db, cacheKey);
    if (cached) return cached;

    // 2. Rate limit 확인
    const limiter = this.getRateLimiter(provider.id, provider.rateLimit);
    await limiter.acquire();

    // 3. API 호출
    try {
      const raw = await provider.getQuote(ticker);
      const normalized = normalize(raw);

      // 4. 캐시 저장
      const ttl = ticker.includes('/')
        ? CACHE_TTL.FOREX
        : /^[A-Z]{1,5}$/.test(ticker)
          ? CACHE_TTL.QUOTE
          : CACHE_TTL.CRYPTO;
      setCachedData(this.db, cacheKey, normalized, provider.id, ttl);

      return normalized;
    } catch (error) {
      // 5. Graceful degradation: stale 캐시 반환
      const stale = getCachedData<MarketQuote>(this.db, cacheKey);
      if (stale) {
        console.warn(`[Cache] Returning stale data for ${ticker}: ${error}`);
        return { ...stale, delayed: true };
      }
      throw error;
    }
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
class RateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly config: RateLimitConfig) {}

  async acquire(): Promise<void> {
    const now = Date.now();

    // 윈도우 밖의 타임스탬프 제거
    while (this.timestamps.length > 0 && this.timestamps[0] < now - this.config.windowMs) {
      this.timestamps.shift();
    }

    // 제한 초과 시 대기
    if (this.timestamps.length >= this.config.maxRequests) {
      const oldestInWindow = this.timestamps[0];
      const waitMs = oldestInWindow + this.config.windowMs - now + 100; // 100ms 여유
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.acquire(); // 재시도
    }

    this.timestamps.push(now);
  }
}
```

### 5.5 텍스트 스파크라인 차트

````typescript
// src/skills/finance/market/charts.ts
import type { HistoricalDataPoint, ChartOptions } from './types.js';

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
export function generateSparkline(
  dataPoints: HistoricalDataPoint[],
  options: ChartOptions = {},
): string {
  const { width = 40, showPrice = true, currency = 'USD' } = options;

  if (dataPoints.length === 0) return '(데이터 없음)';

  // 데이터를 차트 너비에 맞게 리샘플링
  const prices = resample(
    dataPoints.map((d) => d.close),
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
  const latest = dataPoints[dataPoints.length - 1];
  const first = dataPoints[0];
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
// src/skills/finance/market/index.ts
import type { MarketToolDefinition } from './types.js';

/**
 * 시장 데이터 스킬의 에이전트 도구 4개를 등록한다.
 * Phase 7의 tool registration 시스템과 연동된다.
 */
export function registerMarketTools(): MarketToolDefinition[] {
  return [
    {
      name: 'get_stock_price',
      description:
        '주식 실시간/지연 시세를 조회합니다. 미국 주식 티커(예: AAPL, GOOGL, MSFT)를 지원합니다.',
      parameters: {
        ticker: { type: 'string', description: '주식 티커 심볼 (예: AAPL)', required: true },
        currency: {
          type: 'string',
          description: '표시 통화 (기본: USD)',
          required: false,
          default: 'USD',
        },
      },
      handler: async (params) => {
        // MarketCache를 통해 시세 조회
        const ticker = params.ticker as string;
        // 구현은 Phase 14 캐시 + 프로바이더 연동
        return `${ticker} 시세 조회 결과`;
      },
    },
    {
      name: 'get_crypto_price',
      description:
        '암호화폐 실시간 시세를 조회합니다. BTC, ETH, SOL 등 주요 암호화폐를 지원합니다.',
      parameters: {
        ticker: { type: 'string', description: '암호화폐 심볼 (예: BTC, ETH)', required: true },
        currency: {
          type: 'string',
          description: '표시 통화 (기본: USD)',
          required: false,
          default: 'USD',
        },
      },
      handler: async (params) => {
        const ticker = params.ticker as string;
        return `${ticker} 암호화폐 시세 조회 결과`;
      },
    },
    {
      name: 'get_forex_rate',
      description: '외환 환율을 조회합니다. USD/KRW, EUR/USD 등의 통화쌍을 지원합니다.',
      parameters: {
        from: { type: 'string', description: '기준 통화 (예: USD)', required: true },
        to: { type: 'string', description: '대상 통화 (예: KRW)', required: true },
      },
      handler: async (params) => {
        const from = params.from as string;
        const to = params.to as string;
        return `${from}/${to} 환율 조회 결과`;
      },
    },
    {
      name: 'get_market_chart',
      description:
        '시세 차트를 텍스트 스파크라인으로 생성합니다. 기간별(1일~5년) 과거 데이터를 시각화합니다.',
      parameters: {
        ticker: { type: 'string', description: '티커 심볼 (예: AAPL, BTC)', required: true },
        period: {
          type: 'string',
          description: '기간 (1d, 5d, 1m, 3m, 6m, 1y, 5y)',
          required: false,
          default: '1m',
          enum: ['1d', '5d', '1m', '3m', '6m', '1y', '5y'],
        },
      },
      handler: async (params) => {
        const ticker = params.ticker as string;
        const period = params.period as string;
        return `${ticker} ${period} 차트`;
      },
    },
  ];
}

/** 스킬 메타데이터 — Phase 7의 skill registry에 등록 */
export const MARKET_SKILL_METADATA = {
  name: 'market-data',
  description: '주식, 암호화폐, 외환 시장 데이터를 조회하고 차트를 생성합니다.',
  version: '1.0.0',
  requires: {
    env: [], // API 키는 선택사항 (무료 티어 가능)
  },
  tools: ['get_stock_price', 'get_crypto_price', 'get_forex_rate', 'get_market_chart'],
} as const;
```

### 5.7 데이터 흐름 다이어그램

```
에이전트 도구 호출 흐름:
  사용자: "삼성전자 주가 알려줘"
    │
    └─→ Agent → tool_call: get_stock_price({ ticker: "005930.KS" })
         │
         ├─→ MarketCache.getQuote("005930.KS", alphaVantageProvider, normalizeQuote)
         │      │
         │      ├─→ [캐시 HIT] → 정규화된 MarketQuote 반환
         │      │
         │      └─→ [캐시 MISS]
         │           ├─→ RateLimiter.acquire() → 제한 확인
         │           ├─→ AlphaVantageProvider.getQuote("005930.KS") → HTTP API 호출
         │           ├─→ normalizeAlphaVantageQuote(response) → MarketQuote 변환
         │           └─→ setCachedData("quote:005930.KS", quote, TTL=5min)
         │
         └─→ 포맷팅 → "삼성전자 (005930.KS): ₩72,500 (+1.2%)"

차트 생성 흐름:
  사용자: "비트코인 1개월 차트 보여줘"
    │
    └─→ Agent → tool_call: get_market_chart({ ticker: "BTC", period: "1m" })
         │
         ├─→ CoinGeckoProvider.getHistorical("BTC", "1m") → 30일 데이터
         ├─→ normalizeCoinGeckoHistorical(response) → HistoricalDataPoint[]
         └─→ generateSparkline(dataPoints, { width: 40, currency: "USD" })
              │
              └─→ 텍스트 출력:
                   BTC (1m) $67,234.50
                   ▃▄▅▆▇█▇▆▅▄▃▂▃▄▅▆▇▇▆▅▅▆▇█▇▅▃▂▃▄▅▆▇█▇▅▄▃▂
                   H: $71,000.00  L: $58,500.00  Δ: +8.5%
```

---

## 6. 선행 조건

| 선행 Phase                  | 필요한 산출물                                                     | 사용처            |
| --------------------------- | ----------------------------------------------------------------- | ----------------- |
| Phase 1 (types)             | `MarketData`, `MarketQuote` 기초 타입                             | 데이터 인터페이스 |
| Phase 3 (config)            | API 키 설정 (ALPHA_VANTAGE_KEY, COINGECKO_KEY)                    | 프로바이더 인증   |
| Phase 7 (tool registration) | 에이전트 도구 등록 시스템                                         | 도구 4개 등록     |
| Phase 14 (storage)          | `market_cache` SQLite 테이블, `getCachedData()`/`setCachedData()` | TTL 캐시          |

### 새로운 의존성

이 phase에서는 새로운 npm 의존성이 필요하지 않다. 모든 API 호출은 Node.js 내장 `fetch`를 사용한다.

---

## 7. 산출물 및 검증

### 기능 검증 항목

| #   | 검증 항목               | 검증 방법                                                                  | 기대 결과                        |
| --- | ----------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| 1   | Alpha Vantage 주식 시세 | mock fetch → `getQuote("AAPL")`                                            | ProviderQuoteResponse 반환       |
| 2   | Alpha Vantage 외환      | mock fetch → `getQuote("USD/KRW")`                                         | 환율 ProviderQuoteResponse       |
| 3   | CoinGecko 암호화폐      | mock fetch → `getQuote("BTC")`                                             | 암호화폐 ProviderQuoteResponse   |
| 4   | exchangerate.host 환율  | mock fetch → `getQuote("EUR/USD")`                                         | 환율 ProviderQuoteResponse       |
| 5   | 주식 시세 정규화        | Alpha Vantage 원시 데이터 → `normalizeQuote()`                             | 모든 MarketQuote 필드 정상 변환  |
| 6   | 암호화폐 정규화         | CoinGecko 원시 데이터 → `normalizeQuote()`                                 | 시가총액, 거래량 포함            |
| 7   | 과거 데이터 정규화      | Alpha Vantage daily → `normalizeHistorical()`                              | 날짜순 정렬된 DataPoint 배열     |
| 8   | 캐시 HIT                | 캐시 저장 후 동일 키 조회                                                  | 캐시 데이터 반환, fetch 미호출   |
| 9   | 캐시 MISS + API 호출    | 캐시 없는 상태에서 조회                                                    | fetch 호출 + 캐시 저장           |
| 10  | Graceful degradation    | API 실패 + stale 캐시 존재                                                 | stale 데이터 반환 (delayed=true) |
| 11  | Rate limiter            | 6개 연속 요청 (limit=5/min)                                                | 6번째 요청이 대기 후 실행        |
| 12  | 스파크라인 생성         | 30개 데이터 포인트                                                         | 올바른 SPARK_CHARS 매핑          |
| 13  | 스파크라인 빈 데이터    | 빈 배열 입력                                                               | "(데이터 없음)" 반환             |
| 14  | 통화 포맷팅             | `formatCurrency(1234567, "USD")`                                           | "$1.23M"                         |
| 15  | 도구 등록               | `registerMarketTools()`                                                    | 4개 MarketToolDefinition 반환    |
| 16  | supports 판별           | `alphaVantage.supports("AAPL")` → true, `coingecko.supports("BTC")` → true | 올바른 프로바이더 라우팅         |

### 테스트 커버리지 목표

| 모듈             | 목표 커버리지     |
| ---------------- | ----------------- |
| `normalizer.ts`  | 90%+              |
| `cache.ts`       | 85%+              |
| `charts.ts`      | 90%+              |
| `providers/*.ts` | 80%+ (fetch mock) |

---

## 8. 복잡도 및 예상 파일 수

| 항목               | 값                                  |
| ------------------ | ----------------------------------- |
| 복잡도             | **L** (Large)                       |
| 소스 파일          | 8개                                 |
| 테스트 파일        | 4개                                 |
| 총 파일 수         | **~12개**                           |
| 예상 총 코드 줄 수 | ~1,500줄 (소스 ~1,000, 테스트 ~500) |
| 새 의존성          | 없음 (Node.js 내장 fetch 사용)      |
| 예상 구현 시간     | 4-6시간                             |

### 복잡도 근거

이 phase는 **FinClaw 고유 기능**으로 OpenClaw에 직접 대응하는 코드가 없다. 3개 외부 API 프로바이더의 응답 형식이 모두 다르므로 정규화 로직이 복잡하고, 각 프로바이더의 API 제한/에러 패턴도 다르다. 그러나 Provider Strategy 패턴으로 구조를 정리하면 개별 프로바이더는 자기 완결적이며, 캐시와 rate limiter는 Phase 14의 인프라를 재활용한다. 스파크라인 차트는 알고리즘적으로 흥미롭지만 코드 양은 적다. 전체적으로 API 통합의 폭(3 프로바이더 x 2 기능)이 복잡도를 L로 만드는 주요 요인이다.
