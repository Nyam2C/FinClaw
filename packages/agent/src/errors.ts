// packages/agent/src/errors.ts
import { FinClawError, isFinClawError } from '@finclaw/infra';

/** 폴백 사유 */
export type FallbackReason =
  | 'rate-limit'
  | 'server-error'
  | 'timeout'
  | 'context-overflow'
  | 'model-unavailable';

/** 폴백 에러 — SDK 에러를 래핑하여 분류된 사유를 포함 */
export class FailoverError extends FinClawError {
  readonly fallbackReason: FallbackReason;

  constructor(
    message: string,
    reason: FallbackReason,
    opts?: { statusCode?: number; cause?: Error },
  ) {
    super(message, `FAILOVER_${reason.toUpperCase().replaceAll('-', '_')}`, opts);
    this.name = 'FailoverError';
    this.fallbackReason = reason;
  }
}

/**
 * 에러를 FallbackReason으로 분류
 *
 * 우선순위:
 * 1. FailoverError → 직접 reason 반환
 * 2. FinClawError statusCode → HTTP 상태 기반 분류
 * 3. SDK .status 프로퍼티 → HTTP 상태 기반 분류
 * 4. 네트워크 에러 코드 → timeout
 * 5. AbortError → null (폴백 대상 아님)
 * 6. 401/403 → null (인증 에러는 폴백 대상 아님)
 */
export function classifyFallbackError(error: Error): FallbackReason | null {
  // AbortError: 사용자 취소 — 즉시 전파
  if (error.name === 'AbortError') {
    return null;
  }

  // FailoverError: 이미 분류됨
  if (error instanceof FailoverError) {
    return error.fallbackReason;
  }

  // HTTP 상태 코드 기반 분류
  const status = getStatusCode(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return null;
    } // 인증 에러 — 폴백 불가
    if (status === 429) {
      return 'rate-limit';
    }
    if (status === 529) {
      return 'model-unavailable';
    }
    if (status >= 500) {
      return 'server-error';
    }
  }

  // 네트워크 에러 코드
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return 'timeout';
  }

  // context overflow 감지 (SDK 메시지 기반 — 최후 수단)
  if (error.message.includes('context length') || error.message.includes('token limit')) {
    return 'context-overflow';
  }

  return null;
}

/** 에러 객체에서 HTTP 상태 코드 추출 */
function getStatusCode(error: Error): number | undefined {
  if (isFinClawError(error)) {
    return error.statusCode;
  }
  // SDK 에러는 .status 프로퍼티를 가짐
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** API 키 마스킹 유틸리티 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return '***';
  }
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}
