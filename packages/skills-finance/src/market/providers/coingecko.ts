import type { TickerSymbol } from '@finclaw/types';
import { safeFetchJson } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import { z } from 'zod/v4';
// packages/skills-finance/src/market/providers/coingecko.ts
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
