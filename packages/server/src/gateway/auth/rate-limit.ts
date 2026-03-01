// packages/server/src/gateway/auth/rate-limit.ts
import { getEventBus } from '@finclaw/infra';

interface RateLimitEntry {
  failures: number;
  lastFailure: number;
  blockedUntil: number;
}

export interface RateLimiterOptions {
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly blockDurationMs?: number;
}

/**
 * IP별 인증 실패 Rate Limiter
 *
 * - windowMs 내 maxFailures 회 실패 시 blockDurationMs 차단
 * - 차단 해제 후 카운터 리셋
 * - 기본값: 5분 윈도우, 5회 실패, 15분 차단
 */
export class AuthRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockDurationMs: number;

  constructor(opts?: RateLimiterOptions) {
    this.maxFailures = opts?.maxFailures ?? 5;
    this.windowMs = opts?.windowMs ?? 5 * 60_000;
    this.blockDurationMs = opts?.blockDurationMs ?? 15 * 60_000;
  }

  /** 차단 여부 확인 */
  isBlocked(ip: string): boolean {
    const entry = this.entries.get(ip);
    if (!entry) {
      return false;
    }

    if (Date.now() < entry.blockedUntil) {
      return true;
    }

    // 차단 해제 후 리셋
    if (entry.blockedUntil > 0) {
      this.entries.delete(ip);
      return false;
    }

    return false;
  }

  /** 실패 기록 */
  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.entries.get(ip);

    if (!entry || now - entry.lastFailure > this.windowMs) {
      this.entries.set(ip, { failures: 1, lastFailure: now, blockedUntil: 0 });
      return;
    }

    entry.failures++;
    entry.lastFailure = now;

    if (entry.failures >= this.maxFailures) {
      entry.blockedUntil = now + this.blockDurationMs;
      getEventBus().emit('gateway:auth:rate_limit', ip, entry.failures);
    }
  }

  /** 캐시 크기 */
  get size(): number {
    return this.entries.size;
  }

  /** 테스트용: 엔트리 초기화 */
  clear(): void {
    this.entries.clear();
  }
}
