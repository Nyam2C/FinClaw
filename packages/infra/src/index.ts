// @finclaw/infra — barrel export

// 에러
export {
  FinClawError,
  SsrfBlockedError,
  PortInUseError,
  isFinClawError,
  wrapError,
  extractErrorInfo,
} from './errors.js';

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

// 유틸
export { formatDuration } from './format-duration.js';
export { warnOnce, resetWarnings } from './warnings.js';

// 컨텍스트
export { runWithContext, getContext, getRequestId, type RequestContext } from './context.js';

// 환경/설정
export { assertSupportedRuntime, getNodeMajorVersion } from './runtime-guard.js';
export { loadDotenv } from './dotenv.js';
export { normalizeEnv, getEnv, requireEnv, isTruthyEnvValue, logAcceptedEnvOption } from './env.js';
export {
  getStateDir,
  getDataDir,
  getConfigDir,
  getLogDir,
  getSessionDir,
  getLockDir,
  getConfigFilePath,
  getAllPaths,
} from './paths.js';
export { isMain } from './is-main.js';

// 로깅
export {
  createLogger,
  defaultLoggerFactory,
  type LoggerConfig,
  type LoggerFactory,
  type FinClawLogger,
} from './logger.js';
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
export {
  pushSystemEvent,
  drainSystemEvents,
  peekSystemEvents,
  clearSystemEvents,
  onContextKeyChange,
  resetForTest,
  type SystemEvent,
} from './system-events.js';
export {
  emitAgentRunStart,
  emitAgentRunEnd,
  emitAgentRunError,
  onAgentRunStart,
  onAgentRunEnd,
  onAgentRunError,
} from './agent-events.js';

// 네트워크
export { validateUrlSafety, isPrivateIp, type SsrfPolicy } from './ssrf.js';
export { safeFetch, safeFetchJson, type SafeFetchOptions } from './fetch.js';

// 파일시스템
export { writeFileAtomic, readFileSafe, ensureDir, unlinkSafe } from './fs-safe.js';
export { readJsonFile, writeJsonFile, readJsonFileSync } from './json-file.js';

// 프로세스
export {
  acquireGatewayLock,
  readLockInfo,
  GatewayLockError,
  type GatewayLockHandle,
  type GatewayLockOptions,
} from './gateway-lock.js';
export { assertPortAvailable, findAvailablePort, isValidPort } from './ports.js';
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
