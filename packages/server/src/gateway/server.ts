import { readFileSync } from 'node:fs';
// packages/server/src/gateway/server.ts
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { getEventBus } from '@finclaw/infra';
import type { ModelRef, StorageAdapter } from '@finclaw/types';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RunnerExecutionAdapter } from '../auto-reply/execution-adapter.js';
import { GatewayBroadcaster } from './broadcaster.js';
import type { GatewayServerContext } from './context.js';
import { ChatRegistry } from './registry.js';
import { handleHttpRequest } from './router.js';
import { registerAgentRunsMethods } from './rpc/methods/agent-runs.js';
import { registerAgentMethods, type AgentRpcDeps } from './rpc/methods/agent.js';
import { registerChatMethods } from './rpc/methods/chat.js';
import { registerConfigMethods } from './rpc/methods/config.js';
import { registerFinanceMethods, type FinanceRpcDeps } from './rpc/methods/finance.js';
import { registerMemoryMethods, type MemoryRpcDeps } from './rpc/methods/memory.js';
import { registerSessionMethods } from './rpc/methods/session.js';
// 메서드 등록
import { registerSystemMethods } from './rpc/methods/system.js';
import type { GatewayServerConfig } from './rpc/types.js';
import { handleWsConnection } from './ws/connection.js';
import { startHeartbeat } from './ws/heartbeat.js';

export interface GatewayServerDeps {
  readonly storage: StorageAdapter;
  readonly defaultModel: ModelRef;
  readonly adapter: RunnerExecutionAdapter;
  /** Phase 23: finance.* RPC 배선용 의존성 (생략 시 해당 메서드는 provider_unavailable 에러) */
  readonly financeDeps?: FinanceRpcDeps;
  /** Phase 23: agent.* RPC 배선용 의존성 (생략 시 agent.* 메서드 등록 스킵) */
  readonly agentDeps?: AgentRpcDeps;
  /** Phase 26 B: memory.* RPC 배선용 의존성 (생략 시 memory.* 메서드는 provider_unavailable) */
  readonly memoryDeps?: MemoryRpcDeps;
}

export interface GatewayServer {
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  readonly ctx: GatewayServerContext;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGatewayServer(
  config: GatewayServerConfig,
  deps: GatewayServerDeps,
): GatewayServer {
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
    isDraining: false,
  };

  // RPC 메서드 등록 (ctx가 생성된 후 deps 주입)
  registerSystemMethods();
  registerConfigMethods();
  registerChatMethods({
    registry: ctx.registry,
    connections: ctx.connections,
    broadcaster: ctx.broadcaster,
    storage: deps.storage,
    defaultModel: deps.defaultModel,
    adapter: deps.adapter,
    // Phase 24 D: ModelFloorExhaustedError 구조화 로그용 — agent.* 와 logger 공유
    logger: deps.agentDeps?.logger,
  });
  // Phase 26 A: transactions RPC 가 필요로 하는 broadcaster/connections 를 ctx 에서 주입.
  registerFinanceMethods({
    ...deps.financeDeps,
    broadcaster: ctx.broadcaster,
    connections: ctx.connections,
  });
  registerSessionMethods({
    registry: ctx.registry,
    storage: deps.storage,
  });
  // Phase 26 B: memory.* RPC 등록 (deps 미주입 시 모든 호출이 provider_unavailable).
  registerMemoryMethods(deps.memoryDeps ?? {});
  // Phase 26 D: agent.runs.* RPC 등록. agentDeps 또는 financeDeps 의 db 를 재사용
  // (둘 다 같은 storage.db 인스턴스를 가리키도록 main.ts 가 배선).
  registerAgentRunsMethods({ db: deps.agentDeps?.db ?? deps.financeDeps?.db });
  if (deps.agentDeps) {
    registerAgentMethods(deps.agentDeps);
  }

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
      ctx.isDraining = true;

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
