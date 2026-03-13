import type { TickerSymbol } from '@finclaw/types';
import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import { z } from 'zod/v4';
// packages/skills-finance/src/market/providers/alpha-vantage.ts
import type {
  MarketDataProvider,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
  HistoricalPeriod,
  RateLimitConfig,
} from '../types.js';

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
