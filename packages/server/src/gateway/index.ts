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
