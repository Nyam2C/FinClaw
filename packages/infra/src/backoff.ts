// packages/infra/src/backoff.ts
import { setTimeout } from 'node:timers/promises';

export interface BackoffOptions {
  minDelay?: number; // 기본: 1000
  maxDelay?: number; // 기본: 30000
  jitter?: boolean; // 기본: true
}

/**
 * 지수 백오프 지연 시간 계산 (순수 함수)
 *
 * delay = min(maxDelay, 2^attempt * minDelay) + jitter
 */
export function computeBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const { minDelay = 1000, maxDelay = 30000, jitter = true } = opts;
  const exponential = Math.min(maxDelay, Math.pow(2, attempt) * minDelay);
  if (!jitter) {
    return exponential;
  }
  return exponential + Math.floor(Math.random() * exponential * 0.1);
}

/**
 * AbortSignal 지원 sleep
 *
 * `node:timers/promises` setTimeout은 AbortSignal을 네이티브 지원.
 * signal이 이미 abort된 경우 즉시 reject.
 */
export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  await setTimeout(ms, undefined, { signal });
}
