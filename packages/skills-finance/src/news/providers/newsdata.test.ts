// packages/skills-finance/src/news/providers/newsdata.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyRotator } from '../../shared/key-rotator.js';
import { createNewsDataProvider } from './newsdata.js';

vi.mock('@finclaw/infra', () => ({
  safeFetchJson: vi.fn(),
  retry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { safeFetchJson } from '@finclaw/infra';
const mockFetch = vi.mocked(safeFetchJson);

class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

describe('createNewsDataProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isAvailable reflects rotator', () => {
    const rotator = new KeyRotator(['k'], { failureThreshold: 1, cooldownMs: 1_000_000 });
    const p = createNewsDataProvider({ rotator });
    expect(p.isAvailable()).toBe(true);
    rotator.markFailure('k', new Error('429'));
    expect(p.isAvailable()).toBe(false);
  });

  it('returns parsed items', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 'success',
      totalResults: 1,
      results: [
        {
          article_id: 'a1',
          title: 'AAPL beats Q3 earnings',
          link: 'https://example.com/a1',
          description: 'Apple posts record revenue',
          pubDate: '2026-05-08T12:00:00Z',
          source_id: 'reuters',
        },
      ],
    });
    const rotator = new KeyRotator(['k']);
    const p = createNewsDataProvider({ rotator });
    const items = await p.fetchNews({ keywords: ['AAPL'], limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('AAPL beats Q3 earnings');
    expect(items[0].source).toBe('reuters');
  });

  it('returns [] on malformed response', async () => {
    mockFetch.mockResolvedValueOnce({ status: 'error' });
    const p = createNewsDataProvider({ rotator: new KeyRotator(['k']) });
    const items = await p.fetchNews({});
    expect(items).toEqual([]);
  });

  it('rotates key on 429', async () => {
    let call = 0;
    mockFetch.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.reject(new HttpError('rl', 429));
      }
      return Promise.resolve({ status: 'success', results: [] });
    });
    const rotator = new KeyRotator(['k1', 'k2'], { failureThreshold: 5 });
    const p = createNewsDataProvider({ rotator });
    await p.fetchNews({});
    expect(call).toBe(2);
  });
});
