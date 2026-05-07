// packages/skills-finance/src/market/providers/twelve-data.test.ts
import { createTickerSymbol } from '@finclaw/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyRotator } from '../../shared/key-rotator.js';
import { TwelveDataError, TwelveDataProvider } from './twelve-data.js';

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

describe('TwelveDataProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supports US tickers only', () => {
    const p = new TwelveDataProvider(new KeyRotator(['k']));
    expect(p.supports(createTickerSymbol('AAPL'))).toBe(true);
    expect(p.supports(createTickerSymbol('USD/KRW'))).toBe(false);
  });

  it('dailyLimit scales with key count', () => {
    const p1 = new TwelveDataProvider(new KeyRotator(['k1']));
    const p3 = new TwelveDataProvider(new KeyRotator(['k1', 'k2', 'k3']));
    expect(p1.rateLimit.dailyLimit).toBe(800);
    expect(p3.rateLimit.dailyLimit).toBe(2400);
  });

  it('returns parsed quote on 200', async () => {
    mockFetch.mockResolvedValueOnce({
      symbol: 'AAPL',
      open: '175',
      high: '176',
      low: '174',
      close: '175.5',
      previous_close: '174.8',
      change: '0.7',
      percent_change: '0.4',
    });
    const p = new TwelveDataProvider(new KeyRotator(['k']));
    const res = await p.getQuote(createTickerSymbol('AAPL'));
    expect(res.provider).toBe('twelve-data');
  });

  it('rotates key on 429', async () => {
    let call = 0;
    mockFetch.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.reject(new HttpError('rate limited', 429));
      }
      return Promise.resolve({
        symbol: 'AAPL',
        open: '1',
        high: '1',
        low: '1',
        close: '1',
        previous_close: '1',
        change: '0',
        percent_change: '0',
      });
    });
    const rotator = new KeyRotator(['k1', 'k2'], { failureThreshold: 5 });
    const p = new TwelveDataProvider(rotator);
    const res = await p.getQuote(createTickerSymbol('AAPL'));
    expect(call).toBe(2);
    expect(res.provider).toBe('twelve-data');
  });

  it('throws TwelveDataError when payload malformed', async () => {
    mockFetch.mockResolvedValueOnce({ status: 'error' });
    const p = new TwelveDataProvider(new KeyRotator(['k']));
    await expect(p.getQuote(createTickerSymbol('AAPL'))).rejects.toThrow(TwelveDataError);
  });
});
