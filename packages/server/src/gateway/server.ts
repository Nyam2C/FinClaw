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
import { createAccessLogger } from './access-log.js';
import { AuthRateLimiter } from './auth/rate-limit.js';
import { GatewayBroadcaster } from './broadcaster.js';
import type { GatewayServerContext } from './context.js';
import {
  createDbHealthChecker,
  createProviderHealthChecker,
  registerHealthChecker,
} from './health.js';
import { RequestRateLimiter } from './rate-limit.js';
import { ChatRegistry } from './registry.js';
import { handleHttpRequest } from './router.js';
import { registerAgentRunsMethods } from './rpc/methods/agent-runs.js';
import { registerAgentMethods, type AgentRpcDeps } from './rpc/methods/agent.js';
import { registerAuditMethods } from './rpc/methods/audit.js';
import { registerChatMethods } from './rpc/methods/chat.js';
import { registerConfigMethods } from './rpc/methods/config.js';
import { registerFinanceMethods, type FinanceRpcDeps } from './rpc/methods/finance.js';
import { registerMemoryMethods, type MemoryRpcDeps } from './rpc/methods/memory.js';
import { registerScheduleMethods, type ScheduleRpcDeps } from './rpc/methods/schedule.js';
import { registerSessionMethods } from './rpc/methods/session.js';
// 메서드 등록
import { registerSystemMethods } from './rpc/methods/system.js';
import { registerTraceMethods } from './rpc/methods/trace.js';
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
  /** Phase 28: schedule.* RPC 배선용 의존성 (생략 시 schedule.* 메서드는 provider_unavailable) */
  readonly scheduleDeps?: ScheduleRpcDeps;
  /** Phase 29 E5: /readyz 의 db 컴포넌트 헬스 체커 (생략 시 db 항목 미등록) */
  readonly dbHealthCheck?: () => Promise<void>;
  /** Phase 29 E5: /readyz 의 embedding 컴포넌트 헬스 체커 (생략 시 embedding 항목 미등록) */
  readonly embeddingHealthCheck?: () => Promise<void>;
  /** Phase 30 C3: access-log SQLite dual-write 용 db (생략 시 stdout 만). */
  readonly accessLogDb?: import('node:sqlite').DatabaseSync;
  /** Phase 30 C3: 현재 active span 의 traceId 를 가져오는 함수 (옵션). */
  readonly getTraceId?: () => string | undefined;
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

  // Phase 29 E5: 운영성 인스턴스 생성. config 에 키가 있으면 활성, 없으면 기본값.
  // router 의 optional chain 으로 ctx 에 항상 주입되어 자동 활성.
  const rateLimiter = new RequestRateLimiter({
    windowMs: config.rateLimit?.windowMs ?? 60_000,
    maxRequests: config.rateLimit?.maxRequests ?? 60,
    maxKeys: config.rateLimit?.maxKeys ?? 10_000,
  });
  const accessLogger = createAccessLogger({
    db: deps.accessLogDb,
    getTraceId: deps.getTraceId,
  });
  const authRateLimiter = new AuthRateLimiter({
    maxFailures: 5,
    windowMs: 5 * 60_000,
    blockDurationMs: 15 * 60_000,
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
    rateLimiter,
    accessLogger,
    authRateLimiter,
  };

  // Phase 29 E5: deep health checker 등록. db ping 은 storage.db.exec('SELECT 1'),
  // embedding ping 은 매우 짧은 텍스트 1건. 모두 deps 미주입 시 skip.
  if (deps.dbHealthCheck) {
    registerHealthChecker(createDbHealthChecker(deps.dbHealthCheck));
  }
  if (deps.embeddingHealthCheck) {
    registerHealthChecker(createProviderHealthChecker('embedding', deps.embeddingHealthCheck));
  }

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
  // Phase 30 A9: trace.* RPC 등록 (agentDeps/financeDeps 의 db 재사용).
  registerTraceMethods({ db: deps.agentDeps?.db ?? deps.financeDeps?.db });
  // Phase 30 C5: audit.* RPC 등록 (감사 로그 조회).
  registerAuditMethods({ db: deps.agentDeps?.db ?? deps.financeDeps?.db });
  if (deps.agentDeps) {
    registerAgentMethods(deps.agentDeps);
  }
  // Phase 28: schedule.* RPC 등록 (db 미주입 시 provider_unavailable, scheduler 미주입 시 runNow 만 provider_unavailable).
  registerScheduleMethods(deps.scheduleDeps ?? {});

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

      // Phase 29 E5: rate-limiter / auth rate-limiter dispose.
      rateLimiter.dispose();
      authRateLimiter.clear();

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
