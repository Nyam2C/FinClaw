// packages/config/src/errors.ts
import { FinClawError } from '@finclaw/infra';

/** 설정 시스템 기본 에러 */
export class ConfigError extends FinClawError {
  constructor(message: string, opts?: { cause?: Error; details?: Record<string, unknown> }) {
    super(message, 'CONFIG_ERROR', opts);
    this.name = 'ConfigError';
  }
}

/** 필수 환경변수 누락 */
export class MissingEnvVarError extends ConfigError {
  readonly variable: string;
  constructor(variable: string) {
    super(`Environment variable not set: ${variable}`, {
      details: { variable },
    });
    this.name = 'MissingEnvVarError';
    this.variable = variable;
  }
}

/** $include 순환 참조 */
export class CircularIncludeError extends ConfigError {
  constructor(chain: string[]) {
    super(`Circular $include detected: ${chain.join(' -> ')}`, {
      details: { chain },
    });
    this.name = 'CircularIncludeError';
  }
}

/** Zod 검증 실패 */
export class ConfigValidationError extends ConfigError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { details });
    this.name = 'ConfigValidationError';
  }
}
