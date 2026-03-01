// packages/server/src/gateway/context.ts
import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { GatewayBroadcaster } from './broadcaster.js';
import type { ChatRegistry } from './registry.js';
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
  readonly broadcaster: GatewayBroadcaster;
}
