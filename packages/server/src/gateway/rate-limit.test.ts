// packages/server/src/gateway/rate-limit.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RequestRateLimiter } from './rate-limit.js';

describe('RequestRateLimiter', () => {
  let limiter: RequestRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RequestRateLimiter({
      windowMs: 60_000,
      maxRequests: 3,
      maxKeys: 5,
    });
  });

  afterEach(() => {
    limiter.dispose();
    vi.useRealTimers();
  });

  it('윈도우 내 요청 허용', () => {
    const r1 = limiter.check('client-1');
    expect(r1.allowed).toBe(true);
    expect(r1.info.remaining).toBe(2);
    expect(r1.info.limit).toBe(3);
  });

  it('maxRequests 초과 시 거부', () => {
    limiter.check('client-1');
    limiter.check('client-1');
    limiter.check('client-1');

    const r4 = limiter.check('client-1');
    expect(r4.allowed).toBe(false);
    expect(r4.info.remaining).toBe(0);
    expect(r4.info.retryAfterMs).toBeGreaterThan(0);
  });

  it('윈도우 경과 후 다시 허용', () => {
    limiter.check('client-1');
    limiter.check('client-1');
    limiter.check('client-1');

    // 윈도우 경과
    vi.advanceTimersByTime(60_001);

    const result = limiter.check('client-1');
    expect(result.allowed).toBe(true);
    expect(result.info.remaining).toBe(2);
  });

  it('MAX_KEYS 초과 시 가장 오래된 키 evict', () => {
    limiter.check('a');
    limiter.check('b');
    limiter.check('c');
    limiter.check('d');
    limiter.check('e');

    expect(limiter.size).toBe(5);

    // 6번째 키 → 'a' evict
    limiter.check('f');
    expect(limiter.size).toBe(5);
  });

  it('cleanup()으로 만료 키 제거', () => {
    limiter.check('old-client');
    vi.advanceTimersByTime(5 * 60_000 + 1); // cleanup 트리거

    // cleanup interval이 실행되어 빈 entry 제거
    expect(limiter.size).toBe(0);
  });

  describe('toRateLimitHeaders', () => {
    it('표준 rate-limit 헤더 생성', () => {
      const headers = RequestRateLimiter.toRateLimitHeaders({
        remaining: 5,
        limit: 10,
        resetAt: 1700000000_000,
      });

      expect(headers['X-RateLimit-Limit']).toBe('10');
      expect(headers['X-RateLimit-Remaining']).toBe('5');
      expect(headers['X-RateLimit-Reset']).toBe('1700000000');
      expect(headers['Retry-After']).toBeUndefined();
    });

    it('retryAfterMs 존재 시 Retry-After 헤더 포함', () => {
      const headers = RequestRateLimiter.toRateLimitHeaders({
        remaining: 0,
        limit: 10,
        resetAt: 1700000000_000,
        retryAfterMs: 30_000,
      });

      expect(headers['Retry-After']).toBe('30');
    });
  });
});
