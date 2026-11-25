// packages/agent/src/providers/claude-cli/errors.ts
import type { AgentErrorReason } from '../../runtime/types.js';

export type CliFailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'format'
  | 'model_not_found'
  | 'unknown';

export class CliFailoverError extends Error {
  readonly reason: CliFailoverReason;
  readonly provider: string;
  readonly model: string;
  readonly status?: number;

  constructor(
    message: string,
    opts: {
      reason: CliFailoverReason;
      provider: string;
      model: string;
      status?: number;
    },
  ) {
    super(message);
    this.name = 'CliFailoverError';
    this.reason = opts.reason;
    this.provider = opts.provider;
    this.model = opts.model;
    this.status = opts.status;
  }
}

const TIMEOUT_RE = /timeout|timed out|deadline exceeded|no output for/i;
// Phase 46: 'not logged in' — 실측 2.1.332 미인증 result 문구 ("Not logged in · Please run /login")
const AUTH_RE = /(unauthor|forbid|invalid.+token|please log ?in|claude login|not logged in)/i;
const RATE_LIMIT_RE = /(rate ?limit|too many req|quota)/i;

export function classifyCliError(
  message: string,
): Extract<AgentErrorReason, 'auth' | 'rate_limit' | 'timeout' | 'unknown'> {
  if (AUTH_RE.test(message)) {
    return 'auth';
  }
  if (RATE_LIMIT_RE.test(message)) {
    return 'rate_limit';
  }
  if (TIMEOUT_RE.test(message)) {
    return 'timeout';
  }
  return 'unknown';
}
