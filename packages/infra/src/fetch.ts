// packages/infra/src/fetch.ts
import { validateUrlSafety, type SsrfPolicy } from './ssrf.js';

export interface SafeFetchOptions {
  /** 타임아웃 (ms, 기본: 30000) */
  timeoutMs?: number;
  /** SSRF 정책 */
  ssrfPolicy?: SsrfPolicy;
  /** 리다이렉트 허용 (기본: false — 'error' 모드) */
  allowRedirect?: boolean;
  /** 추가 fetch 옵션 */
  init?: RequestInit;
}

/**
 * SSRF 방지가 적용된 안전한 fetch
 *
 * 1. URL 안전성 검증 (DNS 핀닝)
 * 2. AbortSignal.timeout() 적용
 * 3. redirect: 'error' 기본 적용
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 30000, ssrfPolicy, allowRedirect = false, init = {} } = opts;

  // SSRF 검증
  await validateUrlSafety(url, ssrfPolicy);

  // AbortSignal 병합: 사용자 signal + timeout signal
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(url, {
    ...init,
    signal: combinedSignal,
    redirect: allowRedirect ? 'follow' : 'error',
  });

  return response;
}

/**
 * JSON 응답을 파싱하는 편의 함수
 */
export async function safeFetchJson<T = unknown>(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<T> {
  const response = await safeFetch(url, {
    ...opts,
    init: {
      ...opts.init,
      headers: {
        Accept: 'application/json',
        ...opts.init?.headers,
      },
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}
