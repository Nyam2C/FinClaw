import type { OHLCVCandle, Timestamp } from '@finclaw/types';
import { createCurrencyCode } from '@finclaw/types';
import { z } from 'zod/v4';
// packages/skills-finance/src/market/normalizer.ts
import type {
  ProviderMarketQuote,
  MarketHistorical,
  ProviderQuoteResponse,
  ProviderHistoricalResponse,
} from './types.js';

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

/** Alpha Vantage Time Series 엔트리 스키마 */
const AVTimeSeriesEntrySchema = z
  .object({
    '1. open': z.string(),
    '2. high': z.string(),
    '3. low': z.string(),
    '4. close': z.string(),
  })
  .catchall(z.string());

/** CoinGecko market_chart 응답 스키마 */
const CoinGeckoMarketChartSchema = z.object({
  prices: z.array(z.tuple([z.number(), z.number()])),
  market_caps: z.array(z.tuple([z.number(), z.number()])),
  total_volumes: z.array(z.tuple([z.number(), z.number()])),
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
    case 'finnhub':
      return normalizeFinnhubQuote(response);
    case 'twelve-data':
      return normalizeTwelveDataQuote(response);
    default:
      throw new Error(`Unknown provider: ${response.provider}`);
  }
}

function normalizeFinnhubQuote(response: ProviderQuoteResponse): ProviderMarketQuote {
  const r = response.raw as { c: number; h: number; l: number; o: number; pc: number; t: number };
  return {
    symbol: response.symbol,
    price: r.c,
    change: r.c - r.pc,
    changePercent: ((r.c - r.pc) / r.pc) * 100,
    open: r.o,
    high: r.h,
    low: r.l,
    previousClose: r.pc,
    volume: 0,
    marketCap: undefined,
    timestamp: (r.t * 1000) as Timestamp,
    provider: 'finnhub',
    delayed: false,
    currency: createCurrencyCode('USD'),
  };
}

function normalizeTwelveDataQuote(response: ProviderQuoteResponse): ProviderMarketQuote {
  const r = response.raw as {
    open: string;
    high: string;
    low: string;
    close: string;
    previous_close: string;
  };
  const close = Number(r.close);
  const prev = Number(r.previous_close);
  return {
    symbol: response.symbol,
    price: close,
    change: close - prev,
    changePercent: ((close - prev) / prev) * 100,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    previousClose: prev,
    volume: 0,
    marketCap: undefined,
    timestamp: Date.now() as Timestamp,
    provider: 'twelve-data',
    delayed: true, // 4시간 지연
    currency: createCurrencyCode('USD'),
  };
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
    case 'finnhub':
      return normalizeFinnhubHistorical(response);
    case 'twelve-data':
      return normalizeTwelveDataHistorical(response);
    default:
      throw new Error(`Historical data not supported for: ${response.provider}`);
  }
}

function normalizeFinnhubHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const r = response.raw as {
    s: string;
    t?: number[];
    o?: number[];
    h?: number[];
    l?: number[];
    c?: number[];
    v?: number[];
  };
  const t = r.t ?? [];
  const o = r.o ?? [];
  const h = r.h ?? [];
  const l = r.l ?? [];
  const c = r.c ?? [];
  const v = r.v ?? [];
  const candles: OHLCVCandle[] = t.map((ts, i) => ({
    timestamp: (ts * 1000) as Timestamp,
    open: o[i] ?? 0,
    high: h[i] ?? 0,
    low: l[i] ?? 0,
    close: c[i] ?? 0,
    volume: v[i] ?? 0,
  }));
  return {
    symbol: response.symbol,
    period: response.period,
    currency: createCurrencyCode('USD'),
    candles,
    provider: 'finnhub',
  };
}

function normalizeTwelveDataHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const r = response.raw as {
    values?: Array<{
      datetime: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume?: string;
    }>;
  };
  const values = r.values ?? [];
  const candles: OHLCVCandle[] = values
    .map((v) => ({
      timestamp: new Date(v.datetime).getTime() as Timestamp,
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume ? Number(v.volume) : 0,
    }))
    .toSorted((a, b) => a.timestamp - b.timestamp);
  return {
    symbol: response.symbol,
    period: response.period,
    currency: createCurrencyCode('USD'),
    candles,
    provider: 'twelve-data',
  };
}

function normalizeAlphaVantageHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const raw = response.raw;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid Alpha Vantage historical response: expected object');
  }

  // "Time Series (Daily)" 또는 "Time Series (5min)" 키를 찾는다
  const data = raw as Record<string, unknown>;
  const timeSeriesKey = Object.keys(data).find((k) => k.startsWith('Time Series'));
  if (!timeSeriesKey) {
    throw new Error('No time series data in response');
  }

  const rawSeries = data[timeSeriesKey];
  if (typeof rawSeries !== 'object' || rawSeries === null) {
    throw new Error('Invalid time series data');
  }

  const candles: OHLCVCandle[] = Object.entries(rawSeries as Record<string, unknown>)
    .map(([date, rawEntry]) => {
      const parsed = AVTimeSeriesEntrySchema.safeParse(rawEntry);
      if (!parsed.success) {
        throw new Error(`Invalid time series entry for ${date}: ${parsed.error.message}`);
      }
      const values = parsed.data;
      return {
        timestamp: new Date(date).getTime() as Timestamp,
        open: parseFloat(values['1. open']),
        high: parseFloat(values['2. high']),
        low: parseFloat(values['3. low']),
        close: parseFloat(values['4. close']),
        volume: parseInt(values['5. volume'] ?? values['6. volume'] ?? '0', 10),
      };
    })
    .toSorted((a, b) => a.timestamp - b.timestamp);

  return {
    symbol: response.symbol,
    period: response.period,
    currency: createCurrencyCode('USD'),
    candles,
    provider: 'alpha-vantage',
  };
}

function normalizeCoinGeckoHistorical(response: ProviderHistoricalResponse): MarketHistorical {
  const parsed = CoinGeckoMarketChartSchema.safeParse(response.raw);
  if (!parsed.success) {
    throw new Error(`Invalid CoinGecko market_chart response: ${parsed.error.message}`);
  }

  const data = parsed.data;
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
