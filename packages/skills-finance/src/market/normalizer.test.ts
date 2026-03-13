import { createTickerSymbol } from '@finclaw/types';
// packages/skills-finance/src/market/normalizer.test.ts
import { describe, it, expect } from 'vitest';
import type { ProviderQuoteResponse, ProviderHistoricalResponse } from './types.js';
import { normalizeQuote, normalizeHistorical } from './normalizer.js';

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
