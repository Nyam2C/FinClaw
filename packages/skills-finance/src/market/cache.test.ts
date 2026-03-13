import { DatabaseSync } from 'node:sqlite';
// packages/skills-finance/src/market/cache.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketCache, DailyLimitExceededError, RateLimiter } from './cache.js';

// ─── 테스트용 인메모리 DB 설정 ───

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE market_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      provider TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL,
      cached_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe('MarketCache', () => {
  let db: DatabaseSync;
  let cache: MarketCache;

  beforeEach(() => {
    db = createTestDb();
    cache = new MarketCache(db);
  });

  const mockProvider = {
    id: 'test-provider',
    rateLimit: { maxRequests: 10, windowMs: 60_000 },
    getQuote: vi.fn(),
  };

  const mockNormalize = vi.fn();

  it('캐시 HIT 시 프로바이더를 호출하지 않는다', async () => {
    // 캐시에 직접 데이터 삽입
    const now = Date.now();
    db.prepare(
      'INSERT INTO market_cache (key, data, provider, ttl_ms, cached_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'quote:AAPL:test-provider',
      JSON.stringify({ price: 100 }),
      'test-provider',
      300000,
      now,
      now + 300000,
    );

    const result = await cache.getQuote('AAPL', mockProvider, mockNormalize);

    expect(result).toEqual({ price: 100 });
    expect(mockProvider.getQuote).not.toHaveBeenCalled();
    expect(mockNormalize).not.toHaveBeenCalled();
  });

  it('캐시 MISS 시 프로바이더를 호출하고 캐시에 저장한다', async () => {
    const quote = { price: 173.5, provider: 'test-provider' };
    const rawResponse = { raw: {}, symbol: 'AAPL', provider: 'test-provider' };
    mockProvider.getQuote.mockResolvedValueOnce(rawResponse);
    mockNormalize.mockReturnValueOnce(quote);

    const result = await cache.getQuote('AAPL', mockProvider, mockNormalize);

    expect(result).toEqual(quote);
    expect(mockProvider.getQuote).toHaveBeenCalledWith('AAPL');

    // 캐시에 저장되었는지 확인
    const cached = db
      .prepare('SELECT data FROM market_cache WHERE key = ?')
      .get('quote:AAPL:test-provider') as unknown as { data: string } | undefined;
    expect(cached).toBeTruthy();
  });

  it('API 실패 시 stale 캐시를 반환한다 (graceful degradation)', async () => {
    // 만료된 캐시 삽입
    const now = Date.now();
    db.prepare(
      'INSERT INTO market_cache (key, data, provider, ttl_ms, cached_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'quote:AAPL:test-provider',
      JSON.stringify({ price: 100, delayed: false }),
      'test-provider',
      300000,
      now - 600000,
      now - 300000,
    );

    mockProvider.getQuote.mockRejectedValueOnce(new Error('API timeout'));

    const result = await cache.getQuote('AAPL', mockProvider, mockNormalize);

    expect(result.price).toBe(100);
    expect(result.delayed).toBe(true); // stale 표시
  });

  it('API 실패 + stale 캐시 없으면 에러를 던진다', async () => {
    mockProvider.getQuote.mockRejectedValueOnce(new Error('API timeout'));

    await expect(cache.getQuote('AAPL', mockProvider, mockNormalize)).rejects.toThrow(
      'API timeout',
    );
  });

  describe('일별 한도', () => {
    const limitedProvider = {
      id: 'limited',
      rateLimit: { maxRequests: 10, windowMs: 60_000, dailyLimit: 2 },
      getQuote: vi.fn(),
    };

    it('일별 한도 초과 시 DailyLimitExceededError를 던진다', async () => {
      const quote = { price: 100 };
      limitedProvider.getQuote.mockResolvedValue({ raw: {} });
      mockNormalize.mockReturnValue(quote);

      // 2번 호출 성공
      await cache.getQuote('A', limitedProvider, mockNormalize);
      await cache.getQuote('B', limitedProvider, mockNormalize);

      // 3번째 호출은 한도 초과
      await expect(cache.getQuote('C', limitedProvider, mockNormalize)).rejects.toThrow(
        DailyLimitExceededError,
      );
    });
  });
});

describe('RateLimiter', () => {
  it('제한 이내 요청은 즉시 통과한다', async () => {
    const limiter = new RateLimiter({ maxRequests: 5, windowMs: 60_000 });

    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    const elapsed = Date.now() - start;

    // 5개 요청이 대기 없이 통과 (100ms 이내)
    expect(elapsed).toBeLessThan(100);
  });

  it('제한 초과 요청은 대기 후 통과한다', async () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 200 });

    await limiter.acquire(); // 1
    await limiter.acquire(); // 2

    const start = Date.now();
    await limiter.acquire(); // 3 — 대기 필요
    const elapsed = Date.now() - start;

    // 최소 50ms 이상 대기 (windowMs=200이므로)
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
