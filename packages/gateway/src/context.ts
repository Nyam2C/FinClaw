// packages/server/src/gateway/context.ts
import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { AuthRateLimiter } from './auth/rate-limit.js';
import type { GatewayBroadcaster } from './broadcaster.js';
import type { ChatRegistry } from './registry.js';
import type { MethodRegistry } from './rpc/index.js';
import type { GatewayServerConfig, WsConnection } from './rpc/types.js';

/**
 * 게이트웨이 서버 전체의 공유 상태를 한 곳에 모은 DI 컨테이너.
 * 모듈 전역 Map/Registry를 제거하고 테스트 격리를 보장한다.
 */
export interface GatewayServerContext {
  readonly config: GatewayServerConfig;
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  readonly connections: Map<string, WsConnection>;
  readonly registry: ChatRegistry;
  /** Phase 35: RPC 메서드 레지스트리 (모듈 전역 Map 격리). */
  readonly methods: MethodRegistry;
  readonly broadcaster: GatewayBroadcaster;
  isDraining: boolean;
  /** Phase 29 E1: 요청 수준 IP rate limiter (없으면 비활성화) */
  readonly rateLimiter?: import('./rate-limit.js').RequestRateLimiter;
  /** Phase 29 E3: HTTP 액세스 로거 (없으면 비활성화) */
  readonly accessLogger?: ReturnType<typeof import('./access-log.js').createAccessLogger>;
  /** Phase 29 E4: auth 실패 IP rate limiter (없으면 비활성화) */
  readonly authRateLimiter?: AuthRateLimiter;
  /** Phase 40 A: in-process HTTP MCP 호스트 (deps.toolRegistry 주입 시 생성, 없으면 /mcp 비활성). */
  readonly mcpHost?: import('./mcp/host.js').McpHost;
}
