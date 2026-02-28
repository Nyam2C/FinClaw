// packages/server/src/auto-reply/errors.ts
import { FinClawError } from '@finclaw/infra';

/** 파이프라인 에러 코드 */
export type PipelineErrorCode =
  | 'PIPELINE_TIMEOUT'
  | 'STAGE_FAILED'
  | 'CONTEXT_BUILD_FAILED'
  | 'EXECUTION_FAILED'
  | 'DELIVERY_FAILED';

export class PipelineError extends FinClawError {
  constructor(
    message: string,
    code: PipelineErrorCode,
    opts?: { cause?: Error; details?: Record<string, unknown> },
  ) {
    super(message, code, {
      statusCode: 500,
      isOperational: true,
      ...opts,
    });
    this.name = 'PipelineError';
  }
}
