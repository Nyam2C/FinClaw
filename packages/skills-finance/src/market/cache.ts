// packages/skills-finance/src/market/cache.ts
import type { DatabaseSync } from 'node:sqlite';
import { getCachedData, setCachedData, getStaleCachedData, CACHE_TTL } from '@finclaw/storage';
import type { ProviderMarketQuote, RateLimitConfig } from './types.js';

/**
 * 일별 한도 초과 에러.
 * Alpha Vantage 무료 티어 (25req/day) 등에서 발생한다.
 */
export class DailyLimitExceededError extends Error {
  constructor(providerId: string) {
    super(`Daily API limit exceeded for provider: ${providerId}`);
    this.name = 'DailyLimitExceededError';
  }
}

/**
 * 시장 데이터 캐시 매니저.
 * SQLite TTL 캐시(Phase 14)를 래핑하고 rate limiting을 추가한다.
 */
export class MarketCache {
  private readonly rateLimiters = new Map<string, RateLimiter>();

  constructor(private readonly db: DatabaseSync) {}

  /** 시세 데이터를 캐시에서 조회하거나 프로바이더를 호출한다 */
  async getQuote(
    symbol: string,
    provider: {
      id: string;
      rateLimit: RateLimitConfig;
      getQuote: (s: string) => Promise<unknown>;
    },
    normalize: (raw: unknown) => ProviderMarketQuote,
  ): Promise<ProviderMarketQuote> {
    const cacheKey = `quote:${symbol}:${provider.id}`;

    // 1. 캐시 확인
    const cached = getCachedData<ProviderMarketQuote>(this.db, cacheKey);
    if (cached) {
      return cached;
    }

    // 2. 일별 한도 확인
    if (provider.rateLimit.dailyLimit) {
      this.checkDailyLimit(provider.id, provider.rateLimit.dailyLimit);
    }

    // 3. Rate limit 확인
    const limiter = this.getRateLimiter(provider.id, provider.rateLimit);
    await limiter.acquire();

    // 4. API 호출
    try {
      const raw = await provider.getQuote(symbol);
      const normalized = normalize(raw);

      // 5. 캐시 저장
      const ttl = symbol.includes('/')
        ? CACHE_TTL.FOREX
        : /^[A-Z]{1,5}$/.test(symbol)
          ? CACHE_TTL.QUOTE
          : CACHE_TTL.CRYPTO;
      setCachedData(this.db, cacheKey, normalized, provider.id, ttl);

      // 6. 일별 카운터 증가
      if (provider.rateLimit.dailyLimit) {
        this.incrementDailyCount(provider.id);
      }

      return normalized;
    } catch (error) {
      // 7. Graceful degradation: stale 캐시 반환
      const stale = getStaleCachedData<ProviderMarketQuote>(this.db, cacheKey);
      if (stale) {
        return { ...stale, delayed: true };
      }
      throw error;
    }
  }

  /** 일별 API 호출 횟수를 SQLite에 영속화하여 확인한다 */
  private checkDailyLimit(providerId: string, dailyLimit: number): void {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const counterKey = `rate:daily:${providerId}:${today}`;
    const count = getCachedData<number>(this.db, counterKey) ?? 0;
    if (count >= dailyLimit) {
      throw new DailyLimitExceededError(providerId);
    }
  }

  /** 일별 카운터를 증가시킨다 */
  private incrementDailyCount(providerId: string): void {
    const today = new Date().toISOString().split('T')[0];
    const counterKey = `rate:daily:${providerId}:${today}`;
    const current = getCachedData<number>(this.db, counterKey) ?? 0;
    // TTL = 24시간 (자정 이후 자동 만료)
    setCachedData(this.db, counterKey, current + 1, providerId, 86_400_000);
  }

  private getRateLimiter(providerId: string, config: RateLimitConfig): RateLimiter {
    let limiter = this.rateLimiters.get(providerId);
    if (!limiter) {
      limiter = new RateLimiter(config);
      this.rateLimiters.set(providerId, limiter);
    }
    return limiter;
  }
}

/**
 * 슬라이딩 윈도우 rate limiter.
 * 프로바이더별 API 요청 빈도를 제한한다.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly config: RateLimitConfig) {}

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();

      // 윈도우 밖의 타임스탬프 제거
      while (this.timestamps.length > 0 && this.timestamps[0] < now - this.config.windowMs) {
        this.timestamps.shift();
      }

      // 제한 이내이면 타임스탬프 기록 후 반환
      if (this.timestamps.length < this.config.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      // 제한 초과 시 대기 (최소 50ms 보장)
      const oldestInWindow = this.timestamps[0];
      const waitMs = Math.max(50, oldestInWindow + this.config.windowMs - now + 100);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
