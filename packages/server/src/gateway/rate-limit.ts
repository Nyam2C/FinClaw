// packages/server/src/gateway/rate-limit.ts
import type { RateLimitInfo } from './rpc/types.js';

interface WindowEntry {
  timestamps: number[];
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * 요청 수준 슬라이딩 윈도우 rate limiter.
 * MAX_KEYS 초과 시 가장 오래된 키를 evict하여 메모리 누수를 방지한다.
 */
export class RequestRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly cleanupInterval: ReturnType<typeof setInterval>;
  private readonly maxKeys: number;
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(config: { windowMs: number; maxRequests: number; maxKeys?: number }) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
    this.maxKeys = config.maxKeys ?? DEFAULT_MAX_KEYS;
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60_000);
  }

  check(key: string): { allowed: boolean; info: RateLimitInfo } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      if (this.windows.size >= this.maxKeys) {
        const oldestKey = this.windows.keys().next().value;
        if (oldestKey !== undefined) {
          this.windows.delete(oldestKey);
        }
      }
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // 윈도우 밖의 timestamp 제거
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    if (entry.timestamps.length >= this.maxRequests) {
      const oldestInWindow = entry.timestamps[0] ?? now;
      return {
        allowed: false,
        info: {
          remaining: 0,
          limit: this.maxRequests,
          resetAt: now + this.windowMs,
          retryAfterMs: oldestInWindow + this.windowMs - now,
        },
      };
    }

    entry.timestamps.push(now);

    return {
      allowed: true,
      info: {
        remaining: Math.max(0, this.maxRequests - entry.timestamps.length),
        limit: this.maxRequests,
        resetAt: now + this.windowMs,
      },
    };
  }

  /** 표준 rate-limit 응답 헤더 생성 */
  static toRateLimitHeaders(info: RateLimitInfo): Record<string, string> {
    const headers: Record<string, string> = {
      'X-RateLimit-Limit': String(info.limit),
      'X-RateLimit-Remaining': String(info.remaining),
      'X-RateLimit-Reset': String(Math.ceil(info.resetAt / 1000)),
    };
    if (info.retryAfterMs !== undefined) {
      headers['Retry-After'] = String(Math.ceil(info.retryAfterMs / 1000));
    }
    return headers;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > now - this.windowMs);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }

  get size(): number {
    return this.windows.size;
  }

  dispose(): void {
    clearInterval(this.cleanupInterval);
    this.windows.clear();
  }
}
