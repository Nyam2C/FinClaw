// packages/gateway/src/index.ts

// 서버
export { createGatewayServer, type GatewayServer } from './server.js';

// DI 컨테이너
export type { GatewayServerContext } from './context.js';

// RPC 메서드 등록자 + deps 타입 (Phase 39: server 재배치 통합 테스트가 참조)
export { registerAgentMethods, resetAgentStats, type AgentRpcDeps } from './rpc/methods/agent.js';
export { registerAgentRunsMethods } from './rpc/methods/agent-runs.js';
export { registerMemoryMethods } from './rpc/methods/memory.js';

// 타입
export type { GatewayServerConfig, WsConnection } from './rpc/types.js';

// 에러
export { RpcErrors } from './rpc/errors.js';

// 브로드캐스터
export { GatewayBroadcaster } from './broadcaster.js';

// 인증
export { signToken } from './auth/sign.js';

// RPC 디스패처
export { dispatchRpc, MethodRegistry } from './rpc/index.js';
