// packages/agent/src/providers/claude-cli/errors.ts

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
const AUTH_RE = /(unauthor|forbid|invalid.+token|please log ?in|claude login)/i;
const RATE_LIMIT_RE = /(rate ?limit|too many req|quota)/i;

export function classifyCliError(message: string): CliFailoverReason {
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
