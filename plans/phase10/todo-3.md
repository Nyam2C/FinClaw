# Phase 10 — Todo 3: Chat Registry + Broadcaster + 나머지 메서드 + 서버 조립

> **ChatRegistry 완성 + GatewayBroadcaster 완성 + 나머지 RPC 메서드 + 서버 조립 + main.ts**
> 파일 수: 소스 9 + 테스트 6 = **15개** (registry, broadcaster는 Part 1 스텁 교체)
> 의존성: Todo 1 + Todo 2

---

## 1. 개요

Part 1~2의 기반 위에 최종 조립:

- **ChatRegistry**: TTL 만료, AbortSignal.timeout, 중복 방지, 주기적 cleanup, 이벤트 발행
- **GatewayBroadcaster**: Phase 9 StreamEvent → WebSocket JSON-RPC Notification 변환, 150ms delta 배치, slow consumer 보호
- **chat.\*** RPC 메서드: start, send, stop, history (실행 엔진 연동)
- **finance.\*** RPC 메서드: quote, news, alert._, portfolio._ (스텁)
- **session.\*** RPC 메서드: get, reset, list
- **agent.\*** RPC 메서드: status, list, capabilities
- **createGatewayServer()**: HTTP+WS+DI 조립, start/stop 라이프사이클
- **main.ts**: 게이트웨이 서버 + ProcessLifecycle + graceful shutdown

---

## 2. 사전 작업

Todo 1 + Todo 2의 모든 파일이 완성되어 있어야 한다.

```bash
# 확인
pnpm typecheck
pnpm test -- src/gateway/
```

---

## 3. 소스 파일

### 3.1 `packages/server/src/gateway/registry.ts` (Part 1 스텁 교체)

Part 1 스텁을 **전체 교체**한다.

```typescript
// packages/server/src/gateway/registry.ts
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ActiveSession, RegistryEvent } from './rpc/types.js';

/**
 * Chat 실행 레지스트리
 *
 * - 세션 시작/종료/조회
 * - 동일 연결에서 중복 실행 방지
 * - TTL 기반 자동 만료 (AbortSignal.timeout)
 * - 주기적 cleanup (60초 간격)
 * - 이벤트 발행 (session_started, session_completed, session_error)
 */
export class ChatRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly emitter = new EventEmitter();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly sessionTtlMs: number) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /** 새 세션 시작 */
  startSession(params: { agentId: string; connectionId: string; model?: string }): ActiveSession {
    // 동일 연결에서 이미 running 세션이 있으면 거부
    for (const session of this.sessions.values()) {
      if (session.connectionId === params.connectionId && session.status === 'running') {
        throw new Error('Session already active on this connection');
      }
    }

    const session: ActiveSession = {
      sessionId: randomUUID(),
      agentId: params.agentId,
      connectionId: params.connectionId,
      startedAt: Date.now(),
      status: 'running',
      abortController: new AbortController(),
    };

    // TTL 기반 자동 타임아웃
    const ttlSignal = AbortSignal.timeout(this.sessionTtlMs);
    ttlSignal.addEventListener('abort', () => {
      if (this.sessions.has(session.sessionId)) {
        this.stopSession(session.sessionId);
      }
    });

    this.sessions.set(session.sessionId, session);
    this.emit({ type: 'session_started', session });

    return session;
  }

  /** 세션 중단 */
  stopSession(sessionId: string): { stopped: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session) return { stopped: false };

    session.abortController.abort();
    this.sessions.delete(sessionId);

    this.emit({
      type: 'session_completed',
      sessionId,
      durationMs: Date.now() - session.startedAt,
    });

    return { stopped: true };
  }

  /** 세션 조회 */
  getSession(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** 모든 세션 목록 */
  listSessions(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  /** 모든 세션 abort (shutdown 용) */
  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
  }

  /** 활성 세션 수 */
  activeCount(): number {
    return this.sessions.size;
  }

  /** TTL 만료 세션 정리 */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.startedAt > this.sessionTtlMs) {
        this.stopSession(id);
      }
    }
  }

  /** 리소스 해제 */
  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.abortAll();
  }

  /** 이벤트 리스너 등록. 해제 함수 반환. */
  on(listener: (event: RegistryEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  private emit(event: RegistryEvent): void {
    this.emitter.emit('event', event);
  }
}
```

### 3.2 `packages/server/src/gateway/broadcaster.ts` (Part 1 스텁 교체)

Part 1 스텁을 **전체 교체**한다.

```typescript
// packages/server/src/gateway/broadcaster.ts
import type { StreamEvent } from '@finclaw/agent/execution/streaming';
import type { WsConnection, JsonRpcNotification } from './rpc/types.js';

/**
 * GatewayBroadcaster — LLM 스트리밍 → WebSocket 알림 변환
 *
 * 스트리밍 알림 프로토콜:
 * | StreamEvent.type   | WS method                | 전송 정책   |
 * |--------------------|--------------------------|-------------|
 * | text_delta         | chat.stream.delta        | 150ms 배치  |
 * | tool_use_start     | chat.stream.tool_start   | 즉시        |
 * | tool_use_end       | chat.stream.tool_end     | 즉시        |
 * | done               | chat.stream.end          | 즉시        |
 * | error              | chat.stream.error        | 즉시        |
 *
 * 미매핑: state_change, message_complete, usage_update — 내부 FSM/집계용
 */
export class GatewayBroadcaster {
  private readonly deltaBuffers = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout> }
  >();
  private static readonly BATCH_INTERVAL_MS = 150;

  /** StreamEvent를 연결에 전송 */
  send(conn: WsConnection, sessionId: string, event: StreamEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.bufferDelta(conn, sessionId, event.delta);
        break;
      case 'tool_use_start':
        this.sendImmediate(conn, 'chat.stream.tool_start', {
          sessionId,
          toolCall: event.toolCall,
        });
        break;
      case 'tool_use_end':
        this.sendImmediate(conn, 'chat.stream.tool_end', {
          sessionId,
          result: event.result,
        });
        break;
      case 'done':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.end', {
          sessionId,
          result: event.result,
        });
        break;
      case 'error':
        this.flushDelta(conn.id, sessionId, conn);
        this.sendImmediate(conn, 'chat.stream.error', {
          sessionId,
          error: event.error.message,
        });
        break;
      // state_change, message_complete, usage_update → 무시
    }
  }

  /** text_delta 150ms 배치 */
  private bufferDelta(conn: WsConnection, sessionId: string, delta: string): void {
    const key = `${conn.id}:${sessionId}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) {
      existing.text += delta;
      return;
    }

    this.deltaBuffers.set(key, {
      text: delta,
      timer: setTimeout(
        () => this.flushDelta(conn.id, sessionId, conn),
        GatewayBroadcaster.BATCH_INTERVAL_MS,
      ),
    });
  }

  private flushDelta(connId: string, sessionId: string, conn: WsConnection): void {
    const key = `${connId}:${sessionId}`;
    const buf = this.deltaBuffers.get(key);
    if (!buf) return;
    clearTimeout(buf.timer);
    this.deltaBuffers.delete(key);
    if (buf.text.length > 0) {
      this.sendImmediate(conn, 'chat.stream.delta', { sessionId, delta: buf.text });
    }
  }

  /** 즉시 전송 (slow consumer 보호: 1MB 이상 버퍼링 시 skip) */
  private sendImmediate(conn: WsConnection, method: string, params: Record<string, unknown>): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > 1024 * 1024) return;

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    conn.ws.send(JSON.stringify(notification));
  }

  /** 종료 알림 broadcast */
  broadcastShutdown(connections: Map<string, WsConnection>): void {
    for (const conn of connections.values()) {
      this.sendImmediate(conn, 'system.shutdown', { reason: 'Server shutting down' });
    }
  }

  /** 모든 delta 버퍼 flush (shutdown 시) */
  flushAll(): void {
    for (const [key, buf] of this.deltaBuffers) {
      clearTimeout(buf.timer);
    }
    this.deltaBuffers.clear();
  }
}
```

### 3.3 `packages/server/src/gateway/rpc/methods/chat.ts`

`chat.start`, `chat.send`, `chat.stop`, `chat.history`.

```typescript
// packages/server/src/gateway/rpc/methods/chat.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';
import { RpcErrors, createError } from '../errors.js';

// -- chat.start --

const startHandler: RpcMethodHandler<{ agentId: string; model?: string }, { sessionId: string }> = {
  method: 'chat.start',
  description: '새 채팅 세션을 시작합니다',
  authLevel: 'token',
  schema: z.object({
    agentId: z.string(),
    model: z.string().optional(),
  }),
  async execute(params, ctx) {
    // TODO(Phase 10): GatewayServerContext에서 registry 접근
    // const session = serverCtx.registry.startSession({
    //   agentId: params.agentId,
    //   connectionId: ctx.connectionId!,
    //   model: params.model,
    // });
    // return { sessionId: session.sessionId };
    throw new Error('chat.start requires server context wiring — see server.ts');
  },
};

// -- chat.send --

const sendHandler: RpcMethodHandler<
  { sessionId: string; message: string; idempotencyKey?: string },
  { messageId: string }
> = {
  method: 'chat.send',
  description: '활성 세션에 메시지를 전송합니다',
  authLevel: 'session',
  schema: z.object({
    sessionId: z.string(),
    message: z.string(),
    idempotencyKey: z.string().optional(),
  }),
  async execute(params, ctx) {
    // TODO(Phase 10): Dedupe + Runner 연동
    // 1. idempotencyKey가 있으면 Dedupe<T>로 중복 실행 방지
    // 2. Runner.execute()로 LLM 호출
    // 3. GatewayBroadcaster.send()로 스트리밍 알림 전송
    throw new Error('chat.send requires execution engine wiring');
  },
};

// -- chat.stop --

const stopHandler: RpcMethodHandler<{ sessionId: string }, { stopped: boolean }> = {
  method: 'chat.stop',
  description: '활성 세션을 중단합니다',
  authLevel: 'session',
  schema: z.object({
    sessionId: z.string(),
  }),
  async execute(params, ctx) {
    // TODO(Phase 10): GatewayServerContext에서 registry 접근
    // return serverCtx.registry.stopSession(params.sessionId);
    throw new Error('chat.stop requires server context wiring');
  },
};

// -- chat.history --

const historyHandler: RpcMethodHandler<
  { sessionId: string; limit?: number; before?: string },
  { messages: unknown[] }
> = {
  method: 'chat.history',
  description: '세션의 대화 이력을 조회합니다',
  authLevel: 'token',
  schema: z.object({
    sessionId: z.string(),
    limit: z.number().int().min(1).max(100).optional(),
    before: z.string().optional(),
  }),
  async execute(params, ctx) {
    // TODO(Phase 10): @finclaw/storage 대화 이력 조회 연동
    return { messages: [] };
  },
};

/** chat.* 메서드 일괄 등록 */
export function registerChatMethods(): void {
  registerMethod(startHandler);
  registerMethod(sendHandler);
  registerMethod(stopHandler);
  registerMethod(historyHandler);
}
```

### 3.4 `packages/server/src/gateway/rpc/methods/finance.ts`

`finance.quote`, `finance.news`, `finance.alert.*`, `finance.portfolio.*` (스텁).

```typescript
// packages/server/src/gateway/rpc/methods/finance.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- finance.quote --

const quoteHandler: RpcMethodHandler<{ symbol: string }, unknown> = {
  method: 'finance.quote',
  description: '종목 시세를 조회합니다',
  authLevel: 'token',
  schema: z.object({ symbol: z.string() }),
  async execute(params) {
    // TODO(Phase 10): @finclaw/skills-finance 연동
    throw new Error('Not implemented: finance.quote');
  },
};

// -- finance.news --

const newsHandler: RpcMethodHandler<{ query?: string; symbols?: string[] }, unknown> = {
  method: 'finance.news',
  description: '금융 뉴스를 검색합니다',
  authLevel: 'token',
  schema: z.object({
    query: z.string().optional(),
    symbols: z.array(z.string()).optional(),
  }),
  async execute(params) {
    throw new Error('Not implemented: finance.news');
  },
};

// -- finance.alert.create --

const alertCreateHandler: RpcMethodHandler<
  { symbol: string; condition: string; threshold: number },
  unknown
> = {
  method: 'finance.alert.create',
  description: '가격 알림을 생성합니다',
  authLevel: 'token',
  schema: z.object({
    symbol: z.string(),
    condition: z.string(),
    threshold: z.number(),
  }),
  async execute(params) {
    throw new Error('Not implemented: finance.alert.create');
  },
};

// -- finance.alert.list --

const alertListHandler: RpcMethodHandler<{ symbol?: string }, unknown> = {
  method: 'finance.alert.list',
  description: '설정된 알림 목록을 조회합니다',
  authLevel: 'token',
  schema: z.object({
    symbol: z.string().optional(),
  }),
  async execute(params) {
    throw new Error('Not implemented: finance.alert.list');
  },
};

// -- finance.portfolio.get --

const portfolioGetHandler: RpcMethodHandler<Record<string, never>, unknown> = {
  method: 'finance.portfolio.get',
  description: '포트폴리오를 조회합니다',
  authLevel: 'token',
  schema: z.object({}),
  async execute() {
    throw new Error('Not implemented: finance.portfolio.get');
  },
};

/** finance.* 메서드 일괄 등록 */
export function registerFinanceMethods(): void {
  registerMethod(quoteHandler);
  registerMethod(newsHandler);
  registerMethod(alertCreateHandler);
  registerMethod(alertListHandler);
  registerMethod(portfolioGetHandler);
}
```

### 3.5 `packages/server/src/gateway/rpc/methods/session.ts`

`session.get`, `session.reset`, `session.list`.

```typescript
// packages/server/src/gateway/rpc/methods/session.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- session.get --

const getHandler: RpcMethodHandler<{ sessionId: string }, unknown> = {
  method: 'session.get',
  description: '세션 정보를 조회합니다',
  authLevel: 'token',
  schema: z.object({ sessionId: z.string() }),
  async execute(params) {
    // TODO(Phase 10): GatewayServerContext.registry.getSession() 연동
    throw new Error('session.get requires server context wiring');
  },
};

// -- session.reset --

const resetHandler: RpcMethodHandler<{ sessionId: string }, { reset: boolean }> = {
  method: 'session.reset',
  description: '세션을 리셋합니다',
  authLevel: 'token',
  schema: z.object({ sessionId: z.string() }),
  async execute(params) {
    // TODO(Phase 10): registry.stopSession() + 새 세션 시작
    throw new Error('session.reset requires server context wiring');
  },
};

// -- session.list --

const listHandler: RpcMethodHandler<Record<string, never>, unknown> = {
  method: 'session.list',
  description: '활성 세션 목록을 조회합니다',
  authLevel: 'token',
  schema: z.object({}),
  async execute() {
    // TODO(Phase 10): GatewayServerContext.registry.listSessions() 연동
    throw new Error('session.list requires server context wiring');
  },
};

/** session.* 메서드 일괄 등록 */
export function registerSessionMethods(): void {
  registerMethod(getHandler);
  registerMethod(resetHandler);
  registerMethod(listHandler);
}
```

### 3.6 `packages/server/src/gateway/rpc/methods/agent.ts`

`agent.status`, `agent.list`, `agent.capabilities`.

```typescript
// packages/server/src/gateway/rpc/methods/agent.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- agent.status --

const statusHandler: RpcMethodHandler<{ agentId: string }, unknown> = {
  method: 'agent.status',
  description: '에이전트 상태를 조회합니다',
  authLevel: 'token',
  schema: z.object({ agentId: z.string() }),
  async execute(params) {
    // TODO(Phase 10): @finclaw/agent 에이전트 상태 조회 연동
    return {
      agentId: params.agentId,
      status: 'idle',
      activeSessions: 0,
    };
  },
};

// -- agent.list --

const listHandler: RpcMethodHandler<Record<string, never>, unknown> = {
  method: 'agent.list',
  description: '등록된 에이전트 목록을 조회합니다',
  authLevel: 'token',
  schema: z.object({}),
  async execute() {
    // TODO(Phase 10): @finclaw/agent 에이전트 레지스트리 연동
    return { agents: [] };
  },
};

// -- agent.capabilities (agent.run 메서드명으로 등록 — 기존 RpcMethod union에 있음) --

const capabilitiesHandler: RpcMethodHandler<{ agentId: string }, unknown> = {
  method: 'agent.run',
  description: '에이전트 실행을 시작합니다',
  authLevel: 'token',
  schema: z.object({ agentId: z.string() }),
  async execute(params) {
    // TODO(Phase 10): Runner 연동
    throw new Error('agent.run requires execution engine wiring');
  },
};

/** agent.* 메서드 일괄 등록 */
export function registerAgentMethods(): void {
  registerMethod(statusHandler);
  registerMethod(listHandler);
  registerMethod(capabilitiesHandler);
}
```

### 3.7 `packages/server/src/gateway/server.ts`

HTTP+WS+DI 조립. start/stop 라이프사이클.

```typescript
// packages/server/src/gateway/server.ts
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GatewayServerConfig } from './rpc/types.js';
import type { GatewayServerContext } from './context.js';
import { handleHttpRequest } from './router.js';
import { handleWsConnection } from './ws/connection.js';
import { startHeartbeat } from './ws/heartbeat.js';
import { ChatRegistry } from './registry.js';
import { GatewayBroadcaster } from './broadcaster.js';
import { getEventBus } from '@finclaw/infra';

// 메서드 등록
import { registerSystemMethods } from './rpc/methods/system.js';
import { registerConfigMethods } from './rpc/methods/config.js';
import { registerChatMethods } from './rpc/methods/chat.js';
import { registerFinanceMethods } from './rpc/methods/finance.js';
import { registerSessionMethods } from './rpc/methods/session.js';
import { registerAgentMethods } from './rpc/methods/agent.js';

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

      // 4. drain 대기 (최대 5초)
      await new Promise((resolve) => setTimeout(resolve, 5_000));

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
```

### 3.8 `packages/server/src/gateway/index.ts`

배럴 export.

```typescript
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
```

### 3.9 `packages/server/src/main.ts` (기존 스텁 교체)

게이트웨이 서버 + ProcessLifecycle + graceful shutdown 연결.

```typescript
// packages/server/src/main.ts
import { createLogger, getEventBus, assertPortAvailable } from '@finclaw/infra';
import { ProcessLifecycle } from './process/lifecycle.js';
import { createGatewayServer } from './gateway/server.js';
import type { GatewayServerConfig } from './gateway/rpc/types.js';

/** 기본 게이트웨이 설정 */
const defaultConfig: GatewayServerConfig = {
  host: '0.0.0.0',
  port: 3000,
  cors: {
    origins: ['*'],
    maxAge: 600,
  },
  auth: {
    apiKeys: [],
    jwtSecret: process.env.GATEWAY_JWT_SECRET ?? 'dev-secret',
    sessionTtlMs: 30 * 60_000, // 30분
  },
  ws: {
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 10_000,
    maxPayloadBytes: 1024 * 1024, // 1MB
    handshakeTimeoutMs: 10_000,
    maxConnections: 100,
  },
  rpc: {
    maxBatchSize: 10,
    timeoutMs: 60_000,
  },
};

async function main(): Promise<void> {
  const logger = createLogger({ name: 'finclaw', level: 'info' });
  const lifecycle = new ProcessLifecycle({ logger });

  // 포트 사용 가능 확인
  await assertPortAvailable(defaultConfig.port);

  // 게이트웨이 서버 생성
  const gateway = createGatewayServer(defaultConfig);

  // CleanupFn 등록
  lifecycle.register(() => gateway.stop());

  // 시그널 핸들러 초기화
  lifecycle.init();

  // 서버 시작
  await gateway.start();
  logger.info(`Gateway server listening on ${defaultConfig.host}:${defaultConfig.port}`);

  // 시스템 준비 이벤트
  getEventBus().emit('system:ready');
}

main().catch((err) => {
  console.error('Failed to start gateway server:', err);
  process.exit(1);
});
```

---

## 4. 테스트 파일

### 4.1 `packages/server/src/gateway/registry.test.ts`

```typescript
// packages/server/src/gateway/registry.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ChatRegistry } from './registry.js';

describe('ChatRegistry', () => {
  let registry: ChatRegistry;

  beforeEach(() => {
    registry = new ChatRegistry(60_000);
  });

  afterEach(() => {
    registry.dispose();
  });

  describe('startSession', () => {
    it('creates a new session with running status', () => {
      const session = registry.startSession({
        agentId: 'agent-1',
        connectionId: 'conn-1',
      });
      expect(session.sessionId).toBeDefined();
      expect(session.agentId).toBe('agent-1');
      expect(session.connectionId).toBe('conn-1');
      expect(session.status).toBe('running');
      expect(session.abortController).toBeInstanceOf(AbortController);
    });

    it('increments active count', () => {
      expect(registry.activeCount()).toBe(0);
      registry.startSession({ agentId: 'a', connectionId: 'c1' });
      expect(registry.activeCount()).toBe(1);
      registry.startSession({ agentId: 'a', connectionId: 'c2' });
      expect(registry.activeCount()).toBe(2);
    });

    it('throws when same connection already has running session', () => {
      registry.startSession({ agentId: 'a', connectionId: 'c1' });
      expect(() => registry.startSession({ agentId: 'b', connectionId: 'c1' })).toThrow(
        'Session already active',
      );
    });

    it('allows same connection after previous session stopped', () => {
      const s1 = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.stopSession(s1.sessionId);
      const s2 = registry.startSession({ agentId: 'b', connectionId: 'c1' });
      expect(s2.sessionId).toBeDefined();
    });

    it('emits session_started event', () => {
      const listener = vi.fn();
      registry.on(listener);
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session_started',
          session: expect.objectContaining({ sessionId: session.sessionId }),
        }),
      );
    });
  });

  describe('stopSession', () => {
    it('stops and removes existing session', () => {
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      const result = registry.stopSession(session.sessionId);
      expect(result.stopped).toBe(true);
      expect(registry.activeCount()).toBe(0);
    });

    it('returns { stopped: false } for unknown session', () => {
      const result = registry.stopSession('nonexistent');
      expect(result.stopped).toBe(false);
    });

    it('aborts the session AbortController', () => {
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.stopSession(session.sessionId);
      expect(session.abortController.signal.aborted).toBe(true);
    });

    it('emits session_completed event with duration', () => {
      const listener = vi.fn();
      registry.on(listener);
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.stopSession(session.sessionId);

      const completedEvent = listener.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'session_completed',
      );
      expect(completedEvent).toBeDefined();
      expect(completedEvent![0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getSession / listSessions', () => {
    it('getSession returns session by id', () => {
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      expect(registry.getSession(session.sessionId)).toBe(session);
    });

    it('getSession returns undefined for unknown id', () => {
      expect(registry.getSession('unknown')).toBeUndefined();
    });

    it('listSessions returns all active sessions', () => {
      registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.startSession({ agentId: 'b', connectionId: 'c2' });
      expect(registry.listSessions()).toHaveLength(2);
    });
  });

  describe('abortAll', () => {
    it('aborts all sessions and clears the map', () => {
      const s1 = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      const s2 = registry.startSession({ agentId: 'b', connectionId: 'c2' });
      registry.abortAll();
      expect(s1.abortController.signal.aborted).toBe(true);
      expect(s2.abortController.signal.aborted).toBe(true);
      expect(registry.activeCount()).toBe(0);
    });
  });

  describe('TTL expiry', () => {
    it('auto-stops session after TTL via cleanup', () => {
      vi.useFakeTimers();
      const shortRegistry = new ChatRegistry(1_000);
      const session = shortRegistry.startSession({ agentId: 'a', connectionId: 'c1' });

      // 60초 후 cleanup 실행
      vi.advanceTimersByTime(61_000);

      expect(shortRegistry.getSession(session.sessionId)).toBeUndefined();
      expect(shortRegistry.activeCount()).toBe(0);
      shortRegistry.dispose();
    });
  });

  describe('dispose', () => {
    it('clears cleanup timer and aborts all', () => {
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.dispose();
      expect(session.abortController.signal.aborted).toBe(true);
      expect(registry.activeCount()).toBe(0);
    });
  });
});
```

### 4.2 `packages/server/src/gateway/broadcaster.test.ts`

```typescript
// packages/server/src/gateway/broadcaster.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayBroadcaster } from './broadcaster.js';
import type { WsConnection } from './rpc/types.js';
import type { StreamEvent } from '@finclaw/agent/execution/streaming';

function createMockConn(id: string = 'conn-1'): WsConnection {
  const sent: string[] = [];
  return {
    id,
    ws: {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: vi.fn((data: string) => sent.push(data)),
    } as unknown as WsConnection['ws'],
    auth: { level: 'token' as const, permissions: [] },
    connectedAt: Date.now(),
    lastPongAt: Date.now(),
    subscriptions: new Set(),
    // 테스트 헬퍼
    get sentMessages() {
      return sent;
    },
  } as WsConnection & { sentMessages: string[] };
}

describe('GatewayBroadcaster', () => {
  let broadcaster: GatewayBroadcaster;

  beforeEach(() => {
    broadcaster = new GatewayBroadcaster();
  });

  describe('text_delta batching (150ms)', () => {
    it('batches multiple deltas within 150ms window', async () => {
      vi.useFakeTimers();
      const conn = createMockConn();

      broadcaster.send(conn, 'sess-1', { type: 'text_delta', delta: 'Hello' });
      broadcaster.send(conn, 'sess-1', { type: 'text_delta', delta: ' World' });

      // 아직 전송되지 않음
      expect(conn.ws.send).not.toHaveBeenCalled();

      // 150ms 경과
      vi.advanceTimersByTime(150);

      expect(conn.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('chat.stream.delta');
      expect(msg.params.delta).toBe('Hello World');
    });

    it('flushes remaining delta on done event', () => {
      const conn = createMockConn();

      broadcaster.send(conn, 'sess-1', { type: 'text_delta', delta: 'partial' });
      broadcaster.send(conn, 'sess-1', {
        type: 'done',
        result: {
          status: 'completed',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          turns: 1,
          durationMs: 100,
        },
      } as StreamEvent);

      // delta flush + done = 2 messages
      expect(conn.ws.send).toHaveBeenCalledTimes(2);
      const deltaMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(deltaMsg.method).toBe('chat.stream.delta');
      expect(deltaMsg.params.delta).toBe('partial');

      const doneMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0]);
      expect(doneMsg.method).toBe('chat.stream.end');
    });
  });

  describe('immediate events', () => {
    it('sends tool_use_start immediately', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', {
        type: 'tool_use_start',
        toolCall: { id: 'tc-1', name: 'search', input: {} },
      } as StreamEvent);

      expect(conn.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('chat.stream.tool_start');
    });

    it('sends tool_use_end immediately', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', {
        type: 'tool_use_end',
        result: { toolUseId: 'tc-1', content: 'result', isError: false },
      } as StreamEvent);

      expect(conn.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('chat.stream.tool_end');
    });

    it('sends error immediately with flush', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', { type: 'text_delta', delta: 'buf' });
      broadcaster.send(conn, 'sess-1', {
        type: 'error',
        error: new Error('something broke'),
      } as StreamEvent);

      // delta flush + error = 2
      expect(conn.ws.send).toHaveBeenCalledTimes(2);
      const errMsg = JSON.parse((conn.ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0]);
      expect(errMsg.method).toBe('chat.stream.error');
      expect(errMsg.params.error).toBe('something broke');
    });
  });

  describe('ignored events', () => {
    it('ignores state_change events', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', {
        type: 'state_change',
        from: 'idle',
        to: 'streaming',
      } as StreamEvent);
      expect(conn.ws.send).not.toHaveBeenCalled();
    });

    it('ignores usage_update events', () => {
      const conn = createMockConn();
      broadcaster.send(conn, 'sess-1', {
        type: 'usage_update',
        usage: { inputTokens: 10, outputTokens: 5 },
      } as StreamEvent);
      expect(conn.ws.send).not.toHaveBeenCalled();
    });
  });

  describe('slow consumer protection', () => {
    it('skips send when bufferedAmount > 1MB', () => {
      const conn = createMockConn();
      Object.defineProperty(conn.ws, 'bufferedAmount', { value: 2 * 1024 * 1024 });

      broadcaster.send(conn, 'sess-1', {
        type: 'tool_use_start',
        toolCall: { id: 'tc-1', name: 'x', input: {} },
      } as StreamEvent);

      expect(conn.ws.send).not.toHaveBeenCalled();
    });

    it('skips send when connection is not OPEN', () => {
      const conn = createMockConn();
      Object.defineProperty(conn.ws, 'readyState', { value: 3 }); // CLOSED

      broadcaster.send(conn, 'sess-1', {
        type: 'tool_use_start',
        toolCall: { id: 'tc-1', name: 'x', input: {} },
      } as StreamEvent);

      expect(conn.ws.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastShutdown', () => {
    it('sends system.shutdown to all open connections', () => {
      const connections = new Map<string, WsConnection>();
      const c1 = createMockConn('c1');
      const c2 = createMockConn('c2');
      connections.set('c1', c1);
      connections.set('c2', c2);

      broadcaster.broadcastShutdown(connections);

      expect(c1.ws.send).toHaveBeenCalledTimes(1);
      expect(c2.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((c1.ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
      expect(msg.method).toBe('system.shutdown');
    });
  });
});
```

### 4.3 `packages/server/src/gateway/rpc/methods/chat.test.ts`

```typescript
// packages/server/src/gateway/rpc/methods/chat.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatchRpc, clearMethods } from '../index.js';
import { registerChatMethods } from './chat.js';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig, AuthInfo } from '../types.js';
import { RpcErrors } from '../errors.js';
import { resetEventBus } from '@finclaw/infra';

function makeServerCtx(): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: { activeCount: () => 0 } as GatewayServerContext['registry'],
    broadcaster: {} as GatewayServerContext['broadcaster'],
  };
}

describe('chat.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
    registerChatMethods();
  });

  describe('schema validation', () => {
    it('chat.start rejects missing agentId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.start', params: {} },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { message: 'hi' } },
        { auth: { level: 'session', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.send rejects missing message', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId: 's1' } },
        { auth: { level: 'session', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('chat.history validates limit range', async () => {
      const result = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'chat.history',
          params: { sessionId: 's1', limit: 0 },
        },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });
  });

  describe('auth requirements', () => {
    it('chat.start requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'chat.start', params: { agentId: 'a' } },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });

    it('chat.send requires session level', async () => {
      const result = await dispatchRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'chat.send',
          params: { sessionId: 's1', message: 'hi' },
        },
        { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });
});
```

### 4.4 `packages/server/src/gateway/rpc/methods/finance.test.ts`

```typescript
// packages/server/src/gateway/rpc/methods/finance.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatchRpc, clearMethods } from '../index.js';
import { registerFinanceMethods } from './finance.js';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
import { RpcErrors } from '../errors.js';
import { resetEventBus } from '@finclaw/infra';

function makeServerCtx(): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: { activeCount: () => 0 } as GatewayServerContext['registry'],
    broadcaster: {} as GatewayServerContext['broadcaster'],
  };
}

const tokenCtx = {
  auth: { level: 'token' as const, permissions: [] },
  remoteAddress: '127.0.0.1',
};

describe('finance.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
    registerFinanceMethods();
  });

  describe('schema validation', () => {
    it('finance.quote rejects missing symbol', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.quote', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('finance.alert.create validates required fields', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.alert.create', params: { symbol: 'AAPL' } },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });
  });

  describe('auth requirements', () => {
    it('finance.quote requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.quote', params: { symbol: 'AAPL' } },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });

  describe('stub behavior', () => {
    it('finance.quote throws Not implemented', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.quote', params: { symbol: 'AAPL' } },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
      expect((result as { error: { message: string } }).error.message).toContain('Not implemented');
    });

    it('finance.news throws Not implemented', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.news', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
    });

    it('finance.portfolio.get throws Not implemented', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'finance.portfolio.get', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
    });
  });
});
```

### 4.5 `packages/server/src/gateway/rpc/methods/session.test.ts`

```typescript
// packages/server/src/gateway/rpc/methods/session.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatchRpc, clearMethods } from '../index.js';
import { registerSessionMethods } from './session.js';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
import { RpcErrors } from '../errors.js';
import { resetEventBus } from '@finclaw/infra';

function makeServerCtx(): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: { activeCount: () => 0 } as GatewayServerContext['registry'],
    broadcaster: {} as GatewayServerContext['broadcaster'],
  };
}

const tokenCtx = {
  auth: { level: 'token' as const, permissions: [] },
  remoteAddress: '127.0.0.1',
};

describe('session.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
    registerSessionMethods();
  });

  describe('schema validation', () => {
    it('session.get rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.get', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('session.reset rejects missing sessionId', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.reset', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('session.list accepts empty params', async () => {
      // session.list는 params 없이 호출 가능하나 stub이므로 INTERNAL_ERROR
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.list', params: {} },
        tokenCtx,
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INTERNAL_ERROR);
    });
  });

  describe('auth requirements', () => {
    it('session.get requires token level', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'session.get', params: { sessionId: 's1' } },
        { auth: { level: 'none', permissions: [] }, remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });
  });
});
```

### 4.6 `packages/server/src/gateway/server.test.ts`

```typescript
// packages/server/src/gateway/server.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createGatewayServer, type GatewayServer } from './server.js';
import type { GatewayServerConfig } from './rpc/types.js';
import { clearMethods } from './rpc/index.js';
import { resetEventBus } from '@finclaw/infra';

/** 테스트용 설정 (포트 0 = OS 자동 할당) */
function makeTestConfig(): GatewayServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    cors: { origins: ['*'], maxAge: 600 },
    auth: { apiKeys: ['test-key'], jwtSecret: 'test-secret', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
  };
}

describe('createGatewayServer', () => {
  let server: GatewayServer | undefined;

  beforeEach(() => {
    clearMethods();
    resetEventBus();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('creates server with httpServer, wss, and ctx', () => {
    server = createGatewayServer(makeTestConfig());
    expect(server.httpServer).toBeDefined();
    expect(server.wss).toBeDefined();
    expect(server.ctx).toBeDefined();
    expect(server.ctx.connections).toBeInstanceOf(Map);
  });

  it('starts and listens on assigned port', async () => {
    server = createGatewayServer(makeTestConfig());
    await server.start();

    const addr = server.httpServer.address();
    expect(addr).not.toBeNull();
    if (typeof addr === 'object' && addr) {
      expect(addr.port).toBeGreaterThan(0);
    }
  });

  it('stops gracefully', async () => {
    server = createGatewayServer(makeTestConfig());
    await server.start();
    await server.stop();

    expect(server.httpServer.listening).toBe(false);
    server = undefined; // 이미 stop됨
  });

  it('responds to GET /health after start', async () => {
    server = createGatewayServer(makeTestConfig());
    await server.start();

    const addr = server.httpServer.address();
    if (typeof addr === 'object' && addr) {
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      const body = await res.json();
      expect(body.status).toBe('ok');
    }
  });

  it('responds to POST /rpc with system.ping', async () => {
    server = createGatewayServer(makeTestConfig());
    await server.start();

    const addr = server.httpServer.address();
    if (typeof addr === 'object' && addr) {
      const res = await fetch(`http://127.0.0.1:${addr.port}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'system.ping',
          params: {},
        }),
      });
      const body = await res.json();
      expect(body.result.pong).toBe(true);
    }
  });
});
```

---

## 5. 검증 기준

```bash
# 1. 타입 체크
pnpm typecheck

# 2. 전체 게이트웨이 유닛 테스트
pnpm test -- src/gateway/

# 3. 개별 테스트 (순서대로)
pnpm test -- src/gateway/registry.test
pnpm test -- src/gateway/broadcaster.test
pnpm test -- src/gateway/rpc/methods/chat.test
pnpm test -- src/gateway/rpc/methods/finance.test
pnpm test -- src/gateway/rpc/methods/session.test
pnpm test -- src/gateway/server.test

# 4. 포맷팅
pnpm format:fix
```

성공 기준:

1. `pnpm typecheck` → 에러 0개
2. 총 13개 테스트 파일 (Part 1: 4 + Part 2: 3 + Part 3: 6) 모두 통과
3. `pnpm format:fix` 후 diff 없음

---

## 6. 파일 생성 순서 (의존성 순)

```
1. src/gateway/registry.ts (스텁 교체)         → 검증: typecheck + registry.test
2. src/gateway/broadcaster.ts (스텁 교체)       → 검증: typecheck + broadcaster.test
3. src/gateway/rpc/methods/chat.ts             → 검증: typecheck + chat.test
4. src/gateway/rpc/methods/finance.ts          → 검증: typecheck + finance.test
5. src/gateway/rpc/methods/session.ts          → 검증: typecheck + session.test
6. src/gateway/rpc/methods/agent.ts            → 검증: typecheck
7. src/gateway/server.ts                       → 검증: typecheck + server.test
8. src/gateway/index.ts                        → 검증: typecheck
9. src/main.ts (스텁 교체)                      → 검증: typecheck
```

---

## 7. 최종 검증 (전체 Phase 10)

```bash
# 전체 타입 체크
pnpm typecheck

# 전체 게이트웨이 테스트 (13개 파일)
pnpm test -- src/gateway/

# 포맷팅
pnpm format:fix

# 기존 테스트 회귀 없음
pnpm test
```
