// @finclaw/infra — barrel export

// 에러
export { FinClawError, SsrfBlockedError, PortInUseError } from './errors.js';

// 백오프/재시도
export { computeBackoff, sleepWithAbort, type BackoffOptions } from './backoff.js';
export { retry, resolveRetryConfig, type RetryOptions } from './retry.js';
export { Dedupe, type DedupeOptions } from './dedupe.js';
export {
  CircuitBreaker,
  createCircuitBreaker,
  type CircuitState,
  type CircuitBreakerOptions,
} from './circuit-breaker.js';

// cron (Phase 39: server/automation/cron 에서 이동 — 순수 파서)
export { parseCron, matches, nextRunAt, CronParseError, type CronExpression } from './cron.js';

// 컨텍스트
export { runWithContext, getContext, type RequestContext } from './context.js';

// 환경/설정
export { assertSupportedRuntime, getNodeMajorVersion } from './runtime-guard.js';
export { loadDotenv } from './dotenv.js';

// 로깅
export { createLogger, type LoggerConfig, type FinClawLogger } from './logger.js';
export { attachFileTransport, type FileTransportConfig } from './logger-transports.js';

// 이벤트
export {
  createTypedEmitter,
  getEventBus,
  resetEventBus,
  type EventMap,
  type TypedEmitter,
  type FinClawEventMap,
} from './events.js';

// 네트워크
export { validateUrlSafety, isPrivateIp, type SsrfPolicy } from './ssrf.js';
export { safeFetch, safeFetchJson, type SafeFetchOptions } from './fetch.js';

// 프로세스
export { assertPortAvailable } from './ports.js';
export { inspectPortOccupant, formatPortOccupant, type PortOccupant } from './ports-inspect.js';
export {
  setupUnhandledRejectionHandler,
  classifyError,
  type ErrorLevel,
} from './unhandled-rejections.js';

// 동시성
export {
  ConcurrencyLane,
  ConcurrencyLaneManager,
  DEFAULT_LANE_CONFIG,
  type LaneId,
  type LaneConfig,
  type LaneHandle,
} from './concurrency-lane.js';
