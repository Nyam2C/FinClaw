import { createTickerSymbol } from '@finclaw/types';
// packages/skills-finance/src/market/providers/alpha-vantage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlphaVantageProvider, AlphaVantageError } from './alpha-vantage.js';

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

    it('마켓 접미사가 있는 알파벳 티커를 지원한다', () => {
      expect(provider.supports(createTickerSymbol('SMSN.KS'))).toBe(true);
    });

    it('숫자 티커는 지원하지 않는다', () => {
      expect(provider.supports(createTickerSymbol('005930.KS'))).toBe(false);
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
