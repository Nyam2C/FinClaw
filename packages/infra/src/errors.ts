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
// ──────────────────────────────────────────────
