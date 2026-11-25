// packages/agent/src/providers/claude-cli/errors.ts
// Phase 46 D5: CliFailoverError/Reason 삭제(유일 사용처 runner.ts 삭제). stderr·result 분류만 — cli-driver 가 사용.
import type { AgentErrorReason } from '../../runtime/types.js';

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
