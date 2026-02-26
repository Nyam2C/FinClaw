// packages/infra/src/errors.ts

/** FinClaw 기본 에러 — 모든 커스텀 에러의 상위 클래스 */
export class FinClawError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    opts: {
      statusCode?: number;
      isOperational?: boolean;
      cause?: Error;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'FinClawError';
    this.code = code;
    this.statusCode = opts.statusCode ?? 500;
    this.isOperational = opts.isOperational ?? true;
    this.details = opts.details;
  }
}

/** SSRF 차단 에러 */
export class SsrfBlockedError extends FinClawError {
  constructor(hostname: string, ip: string) {
    super(`SSRF blocked: ${hostname} resolved to private IP ${ip}`, 'SSRF_BLOCKED', {
      statusCode: 403,
      details: { hostname, ip },
    });
    this.name = 'SsrfBlockedError';
  }
}

/** 포트 사용 중 에러 */
export class PortInUseError extends FinClawError {
  constructor(port: number, occupiedBy?: string) {
    super(`Port ${port} is already in use${occupiedBy ? ` by ${occupiedBy}` : ''}`, 'PORT_IN_USE', {
      statusCode: 503,
      details: { port, occupiedBy },
    });
    this.name = 'PortInUseError';
  }
}

// ──────────────────────────────────────────────
// 도메인 에러 co-location 원칙:
//   ConfigError    → packages/config/src/errors.ts    (Phase 3)
//   AuthError      → packages/channel-discord/src/    (Phase 5)
//   RateLimitError → packages/skills-finance/src/     (Phase 4)
//   GatewayLockError → packages/infra/src/gateway-lock.ts (co-located)
// ──────────────────────────────────────────────

/** 타입 가드 */
export function isFinClawError(err: unknown): err is FinClawError {
  return err instanceof FinClawError;
}

/** 에러 래핑 유틸 — cause 체이닝 */
export function wrapError(message: string, code: string, cause: unknown): FinClawError {
  return new FinClawError(message, code, {
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });
}

/** 에러 객체에서 구조화된 정보 추출 */
export function extractErrorInfo(err: unknown): {
  code: string;
  message: string;
  isOperational?: boolean;
  stack?: string;
  cause?: string;
} {
  if (err instanceof FinClawError) {
    return {
      code: err.code,
      message: err.message,
      isOperational: err.isOperational,
      stack: err.stack,
      cause: err.cause instanceof Error ? err.cause.message : undefined,
    };
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: err.message, stack: err.stack };
  }
  return { code: 'UNKNOWN', message: String(err) };
}
