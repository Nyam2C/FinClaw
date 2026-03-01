import { resetEventBus } from '@finclaw/infra';
// packages/server/src/gateway/auth/rate-limit.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthRateLimiter } from './rate-limit.js';

describe('AuthRateLimiter', () => {
  beforeEach(() => {
    resetEventBus();
  });

  it('allows requests from unknown IPs', () => {
    const limiter = new AuthRateLimiter();
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  it('blocks IP after maxFailures within window', () => {
    const limiter = new AuthRateLimiter({
      maxFailures: 3,
      windowMs: 60_000,
      blockDurationMs: 60_000,
    });

    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);

    limiter.recordFailure('1.2.3.4'); // 3rd → blocked
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
  });

  it('does not block different IPs', () => {
    const limiter = new AuthRateLimiter({
      maxFailures: 2,
      windowMs: 60_000,
      blockDurationMs: 60_000,
    });
    limiter.recordFailure('1.1.1.1');
    limiter.recordFailure('1.1.1.1');
    expect(limiter.isBlocked('1.1.1.1')).toBe(true);
    expect(limiter.isBlocked('2.2.2.2')).toBe(false);
  });

  it('unblocks after blockDuration expires', () => {
    vi.useFakeTimers();

    const limiter = new AuthRateLimiter({
      maxFailures: 2,
      windowMs: 60_000,
      blockDurationMs: 10_000,
    });

    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);

    vi.advanceTimersByTime(10_001);
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  it('resets counter when window expires', () => {
    vi.useFakeTimers();

    const limiter = new AuthRateLimiter({
      maxFailures: 3,
      windowMs: 5_000,
      blockDurationMs: 60_000,
    });

    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');

    // 윈도우 만료
    vi.advanceTimersByTime(5_001);

    // 새 윈도우에서 카운터 리셋
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  it('tracks size correctly', () => {
    const limiter = new AuthRateLimiter();
    expect(limiter.size).toBe(0);
    limiter.recordFailure('1.1.1.1');
    limiter.recordFailure('2.2.2.2');
    expect(limiter.size).toBe(2);
  });

  it('clear() removes all entries', () => {
    const limiter = new AuthRateLimiter();
    limiter.recordFailure('1.1.1.1');
    limiter.recordFailure('2.2.2.2');
    limiter.clear();
    expect(limiter.size).toBe(0);
  });
});
