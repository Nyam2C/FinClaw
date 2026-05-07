// packages/skills-finance/src/market/providers/twelve-data.ts
// Phase 27 B: Twelve Data 시세 provider (4시간 지연, 800 calls/day · 키).

import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import type { TickerSymbol } from '@finclaw/types';
import { z } from 'zod/v4';
import { AllKeysCooldownError, KeyRotator } from '../../shared/key-rotator.js';
import type {
  HistoricalPeriod,
  MarketDataProvider,
  ProviderHistoricalResponse,
  ProviderQuoteResponse,
  RateLimitConfig,
} from '../types.js';

const QUOTE_URL = 'https://api.twelvedata.com/quote';
const TIMESERIES_URL = 'https://api.twelvedata.com/time_series';

const QuoteSchema = z.object({
  symbol: z.string(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  previous_close: z.string(),
  change: z.string(),
  percent_change: z.string(),
  volume: z.string().optional(),
});

const TimeSeriesSchema = z.object({
  values: z
    .array(
      z.object({
        datetime: z.string(),
        open: z.string(),
        high: z.string(),
        low: z.string(),
        close: z.string(),
        volume: z.string().optional(),
      }),
    )
    .optional(),
  status: z.string().optional(),
  message: z.string().optional(),
});

export class TwelveDataError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'TwelveDataError';
  }
}

function isAuthOrRateError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 401 || code === 429;
  }
  return false;
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error && 'statusCode' in error) {
    const code = (error as { statusCode: number }).statusCode;
    return code === 429 || code >= 500;
  }
  return false;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly id = 'twelve-data';
  readonly name = 'Twelve Data';
  readonly rateLimit: RateLimitConfig;

  constructor(private readonly rotator: KeyRotator) {
    // 키 수만큼 daily 한도 곱 (질문 Q6 참조).
    this.rateLimit = {
      maxRequests: 8, // 분당 8 회 (free tier).
      windowMs: 60_000,
      dailyLimit: 800 * rotator.totalCount(),
    };
  }

  isAvailable(): boolean {
    return this.rotator.availableCount() > 0;
  }

  supports(symbol: TickerSymbol): boolean {
    return /^[A-Z]{1,5}$/.test(symbol);
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const data = await this.callWithRotation((token) => {
      const url = new URL(QUOTE_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('apikey', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const parsed = QuoteSchema.safeParse(data);
    if (!parsed.success) {
      throw new TwelveDataError(`No data for ${symbol}`, 404);
    }
    return { raw: parsed.data, symbol, provider: this.id };
  }

  async getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const { interval, outputsize } = periodToTimeSeriesParams(period);
    const data = await this.callWithRotation((token) => {
      const url = new URL(TIMESERIES_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('interval', interval);
      url.searchParams.set('outputsize', String(outputsize));
      url.searchParams.set('apikey', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const parsed = TimeSeriesSchema.safeParse(data);
    if (!parsed.success || !parsed.data.values?.length) {
      throw new TwelveDataError(`No historical for ${symbol}`, 404);
    }
    return { raw: parsed.data, symbol, period, provider: this.id };
  }

  private async callWithRotation<T>(
    fetcher: (token: string) => Promise<T>,
    maxRotations = 3,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let i = 0; i < maxRotations; i++) {
      let token: string;
      try {
        token = this.rotator.next();
      } catch (err) {
        if (err instanceof AllKeysCooldownError) {
          throw err;
        }
        throw err;
      }
      try {
        const result = await fetcher(token);
        this.rotator.markSuccess(token);
        return result;
      } catch (err) {
        lastError = err as Error;
        if (isAuthOrRateError(err)) {
          this.rotator.markFailure(token, lastError);
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new TwelveDataError('All key rotations exhausted', 429);
  }
}

function periodToTimeSeriesParams(period: HistoricalPeriod): {
  interval: string;
  outputsize: number;
} {
  switch (period) {
    case '1d':
      return { interval: '5min', outputsize: 78 };
    case '5d':
      return { interval: '30min', outputsize: 130 };
    case '1m':
      return { interval: '1day', outputsize: 30 };
    case '3m':
      return { interval: '1day', outputsize: 90 };
    case '6m':
      return { interval: '1day', outputsize: 180 };
    case '1y':
      return { interval: '1day', outputsize: 365 };
    case '5y':
      return { interval: '1week', outputsize: 260 };
  }
}
