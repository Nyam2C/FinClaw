// packages/infra/src/circuit-breaker.ts

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** open 전환 실패 임계 (기본: 5) */
  failureThreshold?: number;
  /** open → half-open 전환 대기 시간 (기본: 30_000ms) */
  resetTimeoutMs?: number;
  /** half-open에서 시도할 최대 요청 수 (기본: 1) */
  halfOpenMaxAttempts?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.halfOpenMaxAttempts = opts.halfOpenMaxAttempts ?? 1;
  }

  /** 보호된 함수 실행 */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
        this.state = 'half-open';
      } else {
        throw new Error(`Circuit is open (failures: ${this.failures})`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
  getFailures(): number {
    return this.failures;
  }
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }
}

export function createCircuitBreaker(opts?: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(opts);
}
