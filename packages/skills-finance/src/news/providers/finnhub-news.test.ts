// packages/skills-finance/src/news/providers/finnhub-news.test.ts
import { createTickerSymbol } from '@finclaw/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyRotator } from '../../shared/key-rotator.js';
import { createFinnhubNewsProvider } from './finnhub-news.js';

vi.mock('@finclaw/infra', () => ({
  safeFetchJson: vi.fn(),
  retry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { safeFetchJson } from '@finclaw/infra';
const mockFetch = vi.mocked(safeFetchJson);

describe('createFinnhubNewsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns [] when symbols not provided', async () => {
    const p = createFinnhubNewsProvider({ rotator: new KeyRotator(['k']) });
    const items = await p.fetchNews({});
    expect(items).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches company news per symbol', async () => {
    mockFetch.mockResolvedValueOnce([
      {
        id: 1,
        datetime: 1700000000,
        headline: 'AAPL hits new high',
        source: 'CNBC',
        summary: 'foo',
        url: 'https://example.com/1',
      },
    ]);
    const p = createFinnhubNewsProvider({ rotator: new KeyRotator(['k']) });
    const items = await p.fetchNews({ symbols: [createTickerSymbol('AAPL')], limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('AAPL hits new high');
  });

  it('preserves sentiment when present', async () => {
    mockFetch.mockResolvedValueOnce([
      {
        id: 2,
        datetime: 1700000000,
        headline: 'AAPL down',
        source: 'WSJ',
        url: 'https://example.com/2',
        headline_sentiment: -0.5,
      },
    ]);
    const p = createFinnhubNewsProvider({ rotator: new KeyRotator(['k']) });
    const items = await p.fetchNews({ symbols: [createTickerSymbol('AAPL')] });
    expect(items[0]).toBeDefined();
    expect(items[0].sentiment).toBeDefined();
    expect(items[0].sentiment?.score).toBe(-0.5);
  });
});
