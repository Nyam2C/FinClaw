import type { TickerSymbol } from '@finclaw/types';
import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
// packages/skills-finance/src/market/providers/frankfurter.ts
import type {
  MarketDataProvider,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
  HistoricalPeriod,
  RateLimitConfig,
} from '../types.js';

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
