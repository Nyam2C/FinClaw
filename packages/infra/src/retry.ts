// packages/infra/src/retry.ts
import { computeBackoff, sleepWithAbort } from './backoff.js';

export interface RetryOptions {
  /** 최대 재시도 횟수 (기본: 3) */
  maxAttempts?: number;
  /** 최소 지연 (ms, 기본: 1000) */
  minDelay?: number;
  /** 최대 지연 (ms, 기본: 30000) */
  maxDelay?: number;
  /** jitter 활성화 (기본: true) */
  jitter?: boolean;
  /** 재시도 조건 함수 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 중단 시그널 */
  signal?: AbortSignal;
  /** 서버 제공 retryAfter (ms) */
  retryAfterMs?: number;
  /** 재시도 시 콜백 */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

/** Partial config → 완전한 config으로 병합 (기본값 적용) */
export function resolveRetryConfig(
  partial?: Partial<RetryOptions>,
): Required<Pick<RetryOptions, 'maxAttempts' | 'minDelay' | 'maxDelay' | 'jitter'>> {
  return {
    maxAttempts: partial?.maxAttempts ?? 3,
    minDelay: partial?.minDelay ?? 1000,
    maxDelay: partial?.maxDelay ?? 30000,
    jitter: partial?.jitter ?? true,
  };
}

/**
 * 지수 백오프 재시도
 *
 * delay = min(maxDelay, 2^attempt * minDelay) + jitter
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    minDelay = 1000,
    maxDelay = 30000,
    jitter = true,
    shouldRetry = defaultShouldRetry,
    signal,
    onRetry,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error('Retry aborted');
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts - 1 || !shouldRetry(error, attempt)) {
        throw error;
      }

      const delay = computeBackoff(attempt, { minDelay, maxDelay, jitter });
      const finalDelay = opts.retryAfterMs ? Math.max(delay, opts.retryAfterMs) : delay;

      onRetry?.(error, attempt, finalDelay);
      await sleepWithAbort(finalDelay, signal);
    }
  }

  throw lastError;
}

function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return TRANSIENT_ERROR_CODES.has(code ?? '');
  }
  return false;
}

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
