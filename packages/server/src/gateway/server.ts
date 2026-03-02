import { getEventBus } from '@finclaw/infra';
import { readFileSync } from 'node:fs';
// packages/server/src/gateway/server.ts
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GatewayServerContext } from './context.js';
import type { GatewayServerConfig } from './rpc/types.js';
import { GatewayBroadcaster } from './broadcaster.js';
import { ChatRegistry } from './registry.js';
import { handleHttpRequest } from './router.js';
import { registerAgentMethods } from './rpc/methods/agent.js';
import { registerChatMethods } from './rpc/methods/chat.js';
import { registerConfigMethods } from './rpc/methods/config.js';
import { registerFinanceMethods } from './rpc/methods/finance.js';
import { registerSessionMethods } from './rpc/methods/session.js';
// 메서드 등록
import { registerSystemMethods } from './rpc/methods/system.js';
import { handleWsConnection } from './ws/connection.js';
import { startHeartbeat } from './ws/heartbeat.js';

export interface GatewayServer {
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  readonly ctx: GatewayServerContext;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGatewayServer(config: GatewayServerConfig): GatewayServer {
  // RPC 메서드 등록
  registerSystemMethods();
  registerConfigMethods();
  registerChatMethods();
  registerFinanceMethods();
  registerSessionMethods();
  registerAgentMethods();

  // HTTP 서버 생성
  const httpServer = config.tls
    ? createHttpsServer({
        cert: readFileSync(config.tls.cert),
        key: readFileSync(config.tls.key),
      })
    : createServer();

  // WebSocket 서버
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: config.ws.maxPayloadBytes,
  });

  // DI 컨테이너
  const ctx: GatewayServerContext = {
    config,
    httpServer,
    wss,
    connections: new Map(),
    registry: new ChatRegistry(config.auth.sessionTtlMs),
    broadcaster: new GatewayBroadcaster(),
  };

  // HTTP 요청 처리
  httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void handleHttpRequest(req, res, ctx);
  });

  // WebSocket 연결 처리 (연결 수 제한)
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (ctx.connections.size >= config.ws.maxConnections) {
      ws.close(1013, 'Too many connections');
      return;
    }
    void handleWsConnection(ws, req, ctx);
  });

  // 하트비트
  const heartbeatInterval = startHeartbeat(wss, config.ws);

  return {
    httpServer,
    wss,
    ctx,

    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.listen(config.port, config.host, () => {
          getEventBus().emit('gateway:start', config.port);
          resolve();
        });
        httpServer.once('error', reject);
      });
    },

    async stop(): Promise<void> {
      // 1. 활성 세션 abort
      ctx.registry.abortAll();

      // 2. 종료 알림 broadcast
      ctx.broadcaster.broadcastShutdown(ctx.connections);

      // 3. broadcaster delta 버퍼 flush
      ctx.broadcaster.flushAll();

      // 4. drain 대기 (최대 5초) — 연결이 있을 때만
      if (ctx.connections.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }

      // 5. WebSocket 연결 종료
      clearInterval(heartbeatInterval);
      for (const client of wss.clients) {
        client.close(1001, 'Server shutting down');
      }

      // 6. HTTP 서버 종료
      return new Promise((resolve) => {
        httpServer.close(() => {
          ctx.registry.dispose();
          getEventBus().emit('gateway:stop');
          resolve();
        });
      });
    },
  };
}
