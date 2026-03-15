// packages/skills-finance/src/news/providers/__tests__/alpha-vantage-news.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAlphaVantageNewsProvider } from '../alpha-vantage-news.js';

vi.mock('@finclaw/infra', () => ({
  safeFetchJson: vi.fn(),
  retry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { safeFetchJson } from '@finclaw/infra';
const mockFetch = vi.mocked(safeFetchJson);

describe('AlphaVantageNews Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isAvailable', () => {
    it('API 키가 있으면 true', () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      expect(provider.isAvailable()).toBe(true);
    });

    it('API 키가 빈 문자열이면 false', () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: '' });
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('fetchNews', () => {
    it('정상 응답을 NewsItem[]으로 정규화한다', async () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        feed: [
          {
            title: 'AAPL surges on earnings',
            url: 'https://example.com/av1',
            summary: 'Strong quarter results',
            time_published: '20260315T100000',
            source: 'Reuters',
            overall_sentiment_score: 0.45,
            overall_sentiment_label: 'Bullish',
            ticker_sentiment: [
              {
                ticker: 'AAPL',
                relevance_score: '0.95',
                ticker_sentiment_score: '0.50',
                ticker_sentiment_label: 'Bullish',
              },
            ],
          },
        ],
      });

      const result = await provider.fetchNews({ limit: 10 });

      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe('alpha-vantage');
      expect(result[0]?.id).toMatch(/^av-/);
      expect(result[0]?.symbols).toEqual(['AAPL']);
      expect(result[0]?.sentiment).toBeDefined();
      expect(result[0]?.sentiment?.label).toBe('very_positive');
    });

    it('rate limit 응답 시 에러를 던진다', async () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        Note: 'API rate limit exceeded',
      });

      await expect(provider.fetchNews({})).rejects.toThrow('rate limit');
    });

    it('feed가 없으면 빈 배열을 반환한다', async () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({});

      const result = await provider.fetchNews({});
      expect(result).toEqual([]);
    });

    it('sentiment 없는 뉴스도 처리한다', async () => {
      const provider = createAlphaVantageNewsProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        feed: [
          {
            title: 'Some news',
            url: 'https://example.com/av2',
            time_published: '20260315T120000',
            source: 'Test',
          },
        ],
      });

      const result = await provider.fetchNews({});
      expect(result[0]?.sentiment).toBeUndefined();
    });
  });
});
