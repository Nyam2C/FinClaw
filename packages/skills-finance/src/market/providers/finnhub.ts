// packages/skills-finance/src/market/providers/finnhub.ts
// Phase 27 B: Finnhub 시세 provider (real-time, 60 calls/min · 키 당).
// KeyRotator 통합 — 매 호출 next(), 401/429 시 markFailure + 다음 키 재시도 (최대 3회).

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

const QUOTE_URL = 'https://finnhub.io/api/v1/quote';
const CANDLE_URL = 'https://finnhub.io/api/v1/stock/candle';

/** Finnhub /quote 응답 — c=현재가, h=고가, l=저가, o=시가, pc=전일종가, t=timestamp */
const QuoteSchema = z.object({
  c: z.number(),
  h: z.number(),
  l: z.number(),
  o: z.number(),
  pc: z.number(),
  t: z.number(),
});

/** Finnhub /candle 응답 (s=ok 시 t/o/h/l/c/v 배열) */
const CandleSchema = z.object({
  s: z.string(),
  t: z.array(z.number()).optional(),
  o: z.array(z.number()).optional(),
  h: z.array(z.number()).optional(),
  l: z.array(z.number()).optional(),
  c: z.array(z.number()).optional(),
  v: z.array(z.number()).optional(),
});

export class FinnhubError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'FinnhubError';
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

export class FinnhubProvider implements MarketDataProvider {
  readonly id = 'finnhub';
  readonly name = 'Finnhub';
  readonly rateLimit: RateLimitConfig = {
    maxRequests: 60, // 60/min · 키
    windowMs: 60_000,
  };

  constructor(private readonly rotator: KeyRotator) {}

  isAvailable(): boolean {
    return this.rotator.availableCount() > 0;
  }

  supports(symbol: TickerSymbol): boolean {
    // 미국 주식 티커 (1-5 알파벳).
    return /^[A-Z]{1,5}$/.test(symbol);
  }

  async getQuote(symbol: TickerSymbol): Promise<ProviderQuoteResponse> {
    const data = await this.callWithRotation((token) => {
      const url = new URL(QUOTE_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('token', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const parsed = QuoteSchema.safeParse(data);
    if (!parsed.success) {
      throw new FinnhubError(`Malformed quote response for ${symbol}`, 502);
    }
    if (parsed.data.c === 0 && parsed.data.pc === 0) {
      throw new FinnhubError(`No data for symbol: ${symbol}`, 404);
    }

    return { raw: parsed.data, symbol, provider: this.id };
  }

  async getHistorical(
    symbol: TickerSymbol,
    period: HistoricalPeriod,
  ): Promise<ProviderHistoricalResponse> {
    const { resolution, from, to } = periodToCandleRange(period);
    const data = await this.callWithRotation((token) => {
      const url = new URL(CANDLE_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('resolution', resolution);
      url.searchParams.set('from', String(from));
      url.searchParams.set('to', String(to));
      url.searchParams.set('token', token);
      return retry(() => safeFetchJson(url.toString(), { timeoutMs: 10_000 }), {
        maxAttempts: 2,
        shouldRetry: isTransientError,
      });
    });

    const parsed = CandleSchema.safeParse(data);
    if (!parsed.success || parsed.data.s !== 'ok') {
      throw new FinnhubError(`No historical data for ${symbol}`, 404);
    }

    return { raw: parsed.data, symbol, period, provider: this.id };
  }

  /** 라운드 로빈 + 401/429 시 다음 키로 재시도 (최대 3회). */
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
    throw lastError ?? new FinnhubError('All key rotations exhausted', 429);
  }
}

function periodToCandleRange(period: HistoricalPeriod): {
  resolution: string;
  from: number;
  to: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;
  switch (period) {
    case '1d':
      return { resolution: '5', from: now - day, to: now };
    case '5d':
      return { resolution: '15', from: now - 5 * day, to: now };
    case '1m':
      return { resolution: '60', from: now - 30 * day, to: now };
    case '3m':
      return { resolution: 'D', from: now - 90 * day, to: now };
    case '6m':
      return { resolution: 'D', from: now - 180 * day, to: now };
    case '1y':
      return { resolution: 'D', from: now - 365 * day, to: now };
    case '5y':
      return { resolution: 'W', from: now - 5 * 365 * day, to: now };
  }
}
