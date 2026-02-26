// packages/server/src/process — barrel export

// 에러
export { SpawnError, SpawnTimeoutError, LaneClearedError, QueueFullError } from './errors.js';

// 프로세스 실행
export { safeSpawn, type SpawnOptions, type SpawnResult } from './spawn.js';

// 시그널 핸들링
export { setupGracefulShutdown } from './signal-handler.js';

// 라이프사이클
export { ProcessLifecycle } from './lifecycle.js';

// 세션 키
export {
  deriveRoutingSessionKey,
  deriveGlobalSessionKey,
  classifySessionKey,
  parseRoutingSessionKey,
  type RoutingSessionKeyParams,
  type SessionKeyKind,
} from './session-key.js';

// 바인딩 매칭
export {
  matchBinding,
  extractBindingRules,
  type MatchTier,
  type BindingRule,
  type BindingMatch,
} from './binding-matcher.js';

// 메시지 큐
export {
  MessageQueue,
  type QueueMode,
  type QueueDropPolicy,
  type QueueEntry,
  type MessageQueueConfig,
} from './message-queue.js';

// 디바운스
export { createDebouncer, type DebounceConfig } from './debounce.js';

// 메시지 라우터
export { MessageRouter, type MessageRouterDeps } from './message-router.js';
