// packages/server/src/gateway/index.ts

// 서버
export { createGatewayServer, type GatewayServer } from './server.js';

// DI 컨테이너
export type { GatewayServerContext } from './context.js';

// 타입
export type {
  GatewayServerConfig,
  AuthLevel,
  AuthInfo,
  AuthResult,
  Permission,
  RpcMethodHandler,
  RpcContext,
  JsonRpcNotification,
  JsonRpcBatchRequest,
  WsConnection,
  WsOutboundMessage,
  ActiveSession,
  RegistryEvent,
} from './rpc/types.js';

// 에러
export { RpcErrors, createError, type RpcErrorCode } from './rpc/errors.js';

// 레지스트리 + 브로드캐스터
export { ChatRegistry } from './registry.js';
export { GatewayBroadcaster } from './broadcaster.js';

// 인증
export { authenticate } from './auth/index.js';
export { AuthRateLimiter } from './auth/rate-limit.js';

// RPC 디스패처
export { dispatchRpc, registerMethod, hasRequiredAuth } from './rpc/index.js';

// Phase 11: 고급 기능
export { RequestRateLimiter } from './rate-limit.js';
export { createAccessLogger, sanitizePath } from './access-log.js';
export {
  checkLiveness,
  checkReadiness,
  registerHealthChecker,
  createProviderHealthChecker,
  createDbHealthChecker,
} from './health.js';
export { createHotReloader, type HotReloadManager, type HotReloadConfig } from './hot-reload.js';
export { handleChatCompletions } from './openai-compat/router.js';
export {
  mapModelId,
  adaptRequest,
  adaptResponse,
  adaptStreamChunk,
} from './openai-compat/adapter.js';

// Phase 11 타입 추가 export
export type {
  ConfigChangeEvent,
  BroadcastChannel,
  RateLimitInfo,
  ComponentHealth,
  SystemHealth,
  LivenessResponse,
  AccessLogEntry,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIStreamChunk,
  OpenAIErrorResponse,
} from './rpc/types.js';
