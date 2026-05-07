// packages/skills-finance/src/market/providers/finnhub.test.ts
// Phase 27 B: Finnhub provider 유닛 테스트 (safeFetchJson mock).

import { createTickerSymbol } from '@finclaw/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyRotator } from '../../shared/key-rotator.js';
import { FinnhubError, FinnhubProvider } from './finnhub.js';

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

describe('FinnhubProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supports US stock tickers only', () => {
    const provider = new FinnhubProvider(new KeyRotator(['k']));
    expect(provider.supports(createTickerSymbol('AAPL'))).toBe(true);
    expect(provider.supports(createTickerSymbol('MSFT'))).toBe(true);
    expect(provider.supports(createTickerSymbol('USD/KRW'))).toBe(false);
    expect(provider.supports(createTickerSymbol('BTC'))).toBe(true); // 3-char alpha — 한계 (현행 AV 와 동일)
  });

  it('returns parsed quote on 200', async () => {
    mockFetch.mockResolvedValueOnce({
      c: 175.5,
      h: 176,
      l: 174,
      o: 175,
      pc: 174.8,
      t: 1700000000,
    });
    const provider = new FinnhubProvider(new KeyRotator(['k1']));
    const res = await provider.getQuote(createTickerSymbol('AAPL'));
    expect(res.symbol).toBe('AAPL');
    expect(res.provider).toBe('finnhub');
    expect((res.raw as { c: number }).c).toBe(175.5);
  });

  it('rotates key on 429 and succeeds with next key', async () => {
    let call = 0;
    mockFetch.mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.reject(new HttpError('rate limited', 429));
      }
      return Promise.resolve({ c: 100, h: 101, l: 99, o: 100, pc: 99, t: 1 });
    });
    const rotator = new KeyRotator(['k1', 'k2'], { failureThreshold: 5 });
    const provider = new FinnhubProvider(rotator);
    const res = await provider.getQuote(createTickerSymbol('AAPL'));
    expect(res.provider).toBe('finnhub');
    expect(call).toBe(2);
  });

  it('throws FinnhubError when symbol unknown (c=0, pc=0)', async () => {
    mockFetch.mockResolvedValueOnce({ c: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 });
    const provider = new FinnhubProvider(new KeyRotator(['k']));
    await expect(provider.getQuote(createTickerSymbol('XYZQQ'))).rejects.toThrow(FinnhubError);
  });

  it('isAvailable reflects rotator availableCount', () => {
    const rotator = new KeyRotator(['k1'], { failureThreshold: 1, cooldownMs: 1_000_000 });
    const provider = new FinnhubProvider(rotator);
    expect(provider.isAvailable()).toBe(true);
    rotator.markFailure('k1', new Error('429'));
    expect(provider.isAvailable()).toBe(false);
  });
});
