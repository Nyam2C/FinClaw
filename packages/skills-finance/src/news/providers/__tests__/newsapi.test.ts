// packages/skills-finance/src/news/providers/__tests__/newsapi.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNewsApiProvider, extractTickers, inferCategory } from '../newsapi.js';

vi.mock('@finclaw/infra', () => ({
  safeFetchJson: vi.fn(),
  retry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { safeFetchJson } from '@finclaw/infra';
const mockFetch = vi.mocked(safeFetchJson);

describe('NewsAPI Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isAvailable', () => {
    it('API 키가 있으면 true', () => {
      const provider = createNewsApiProvider({ apiKey: 'test-key' });
      expect(provider.isAvailable()).toBe(true);
    });

    it('API 키가 빈 문자열이면 false', () => {
      const provider = createNewsApiProvider({ apiKey: '' });
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('fetchNews', () => {
    it('정상 응답을 NewsItem[]으로 정규화한다', async () => {
      const provider = createNewsApiProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        status: 'ok',
        totalResults: 1,
        articles: [
          {
            title: 'Apple $AAPL beats earnings',
            description: 'Revenue up 15%',
            url: 'https://example.com/article1',
            urlToImage: 'https://example.com/img.jpg',
            publishedAt: '2026-03-15T10:00:00Z',
            source: { name: 'Reuters' },
          },
        ],
      });

      const result = await provider.fetchNews({ limit: 10 });

      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe('Apple $AAPL beats earnings');
      expect(result[0]?.summary).toBe('Revenue up 15%');
      expect(result[0]?.source).toBe('newsapi');
      expect(result[0]?.id).toMatch(/^newsapi-/);
    });

    it('잘못된 응답 형식이면 에러를 던진다', async () => {
      const provider = createNewsApiProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({ unexpected: 'data' });

      await expect(provider.fetchNews({})).rejects.toThrow('validation failed');
    });

    it('description이 null이면 summary는 undefined', async () => {
      const provider = createNewsApiProvider({ apiKey: 'test-key' });
      mockFetch.mockResolvedValueOnce({
        status: 'ok',
        totalResults: 1,
        articles: [
          {
            title: 'Test',
            description: null,
            url: 'https://example.com/a',
            publishedAt: '2026-03-15T10:00:00Z',
            source: { name: 'Test' },
          },
        ],
      });

      const result = await provider.fetchNews({});
      expect(result[0]?.summary).toBeUndefined();
    });
  });

  describe('extractTickers', () => {
    it('$TICKER 패턴을 추출한다', () => {
      expect(extractTickers('$AAPL and $GOOGL are up')).toEqual(['AAPL', 'GOOGL']);
    });

    it('중복 티커를 제거한다', () => {
      expect(extractTickers('$AAPL $AAPL $AAPL')).toEqual(['AAPL']);
    });

    it('패턴이 없으면 빈 배열을 반환한다', () => {
      expect(extractTickers('no tickers here')).toEqual([]);
    });
  });

  describe('inferCategory', () => {
    it('earnings 관련 키워드를 감지한다', () => {
      expect(inferCategory('Q3 Earnings Beat Expectations', null)).toBe('earnings');
    });

    it('crypto 관련 키워드를 감지한다', () => {
      expect(inferCategory('Bitcoin hits new high', null)).toBe('crypto');
    });

    it('매칭 없으면 general을 반환한다', () => {
      expect(inferCategory('Random headline', null)).toBe('general');
    });
  });
});
