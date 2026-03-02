# Phase 10: 게이트웨이 서버 - 코어 (Gateway Server: Core)

> **복잡도: XL** | 소스 22 파일 | 테스트 13 파일 | 기존 수정 2 파일 | 합계 37 파일

---

## 1. 목표

외부 클라이언트(웹 UI, CLI, 모바일 앱)가 FinClaw 실행 엔진과 통신할 수 있는 게이트웨이 서버를 구축한다. OpenClaw 게이트웨이(187 파일, 36.2K LOC)의 핵심 아키텍처를 기반으로, 금융 AI 어시스턴트에 필요한 코어 기능을 구현한다:

- **HTTP 서버**: Node.js 네이티브 `http`/`https` 모듈 기반, CORS 처리, 요청 라우팅
- **WebSocket 서버**: `ws` 라이브러리 기반, 연결 관리, 하트비트, 핸드셰이크 타임아웃
- **JSON-RPC 2.0 프로토콜**: 메서드 레지스트리, 요청 파싱, 응답 포맷팅, 배치 지원
- **스키마 검증**: Zod v4 런타임 검증으로 모든 RPC 파라미터 검증 (config, agent, server와 동일 스택)
- **4-layer 인증**: none(공개) → API key → token(JWT) → session-scoped
- **Chat 실행 레지스트리**: 활성 채팅 세션 추적, 중복 실행 방지, TTL 기반 정리
- **RPC 메서드 그룹**: chat, config, agent, system, finance, session 6개 그룹
- **에러 처리**: JSON-RPC 에러 코드 (`@finclaw/types` 기준), 구조화된 에러 응답
- **GatewayServerContext**: 중앙 DI 컨테이너로 모듈 전역 상태 제거
- **GatewayBroadcaster**: LLM 스트리밍 → WebSocket 알림 변환 (150ms delta 배치)
- **인증 Rate Limiting**: IP별 실패 횟수 제한 (DoS 방지)
- **Graceful Shutdown**: 기존 `setupGracefulShutdown()` + `CleanupFn` 통합

---

## 2. OpenClaw 참조

| OpenClaw 경로                                     | 적용 패턴                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `openclaw_review/deep-dive/03-gateway-core.md`    | HTTP/WS 서버 설정, JSON-RPC 프로토콜, 4-layer 인증, 전체 아키텍처 |
| `openclaw_review/deep-dive/03` (JSON-RPC 섹션)    | 85+ 메서드 레지스트리, 요청/응답/알림 패턴, 배치 처리             |
| `openclaw_review/deep-dive/03` (스키마 검증 섹션) | Zod v4 런타임 타입 안전성 확보 패턴                               |
| `openclaw_review/deep-dive/03` (인증 섹션)        | 4-layer 인증 체계: none → API key → token → session               |
| `openclaw_review/deep-dive/03` (레지스트리 섹션)  | Chat execution registry 패턴                                      |
| `openclaw_review/docs/` (server 관련)             | 서버 설정, 포트, TLS 설정 구조                                    |

**OpenClaw 차이점:**

- 85+ RPC 메서드 → FinClaw는 ~25개 핵심 메서드로 축소
- 187 파일 → ~35 파일로 경량화
- 금융 특화 RPC 메서드 추가: `finance.quote`, `finance.news`, `finance.alert.*`, `finance.portfolio.*`
- WebSocket 메시지에 실시간 시세 스트리밍 채널 추가
- 스키마 검증: TypeBox+AJV 대신 Zod v4 통일 (기존 config/agent/server와 동일 스택)

---

## 3. 생성할 파일

### 소스 파일 (`src/gateway/`)

| 파일 경로                            | 설명                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| `src/gateway/index.ts`               | 모듈 public API re-export                                |
| `src/gateway/server.ts`              | HTTP + WebSocket 서버 생성 및 설정                       |
| `src/gateway/context.ts`             | GatewayServerContext — 중앙 DI 컨테이너                  |
| `src/gateway/broadcaster.ts`         | GatewayBroadcaster — 스트리밍 → WS 알림 변환             |
| `src/gateway/router.ts`              | HTTP 요청 라우팅 (REST 엔드포인트)                       |
| `src/gateway/cors.ts`                | CORS 미들웨어                                            |
| `src/gateway/rpc/index.ts`           | JSON-RPC 디스패처 (메서드 레지스트리)                    |
| `src/gateway/rpc/types.ts`           | 게이트웨이 전용 타입 (공통은 @finclaw/types re-export)   |
| `src/gateway/rpc/errors.ts`          | JSON-RPC 에러 코드 (@finclaw/types 기준 + 확장)          |
| `src/gateway/rpc/methods/chat.ts`    | chat.\* RPC 메서드 (start, send, stop, history)          |
| `src/gateway/rpc/methods/config.ts`  | config.\* RPC 메서드 (get, set, reload)                  |
| `src/gateway/rpc/methods/agent.ts`   | agent.\* RPC 메서드 (status, list, capabilities)         |
| `src/gateway/rpc/methods/system.ts`  | system.\* RPC 메서드 (health, info, ping)                |
| `src/gateway/rpc/methods/finance.ts` | finance.\* RPC 메서드 (quote, news, alert.\*, portfolio) |
| `src/gateway/rpc/methods/session.ts` | session.\* RPC 메서드 (get, reset, list)                 |
| `src/gateway/auth/index.ts`          | 인증 미들웨어 디스패처                                   |
| `src/gateway/auth/api-key.ts`        | API 키 인증 (timingSafeEqual)                            |
| `src/gateway/auth/token.ts`          | JWT 토큰 인증 (alg 검증 포함)                            |
| `src/gateway/auth/rate-limit.ts`     | IP별 인증 실패 Rate Limiting                             |
| `src/gateway/ws/connection.ts`       | WebSocket 연결 관리                                      |
| `src/gateway/ws/heartbeat.ts`        | WebSocket 하트비트 (ping/pong)                           |
| `src/gateway/registry.ts`            | Chat 실행 레지스트리 (TTL + AbortSignal.timeout)         |

### 테스트 파일

| 파일 경로                                 | 테스트 대상                                    |
| ----------------------------------------- | ---------------------------------------------- |
| `src/gateway/server.test.ts`              | HTTP/WS 서버 생성, 포트 바인딩 (unit)          |
| `src/gateway/router.test.ts`              | 라우팅 매칭, 404 처리 (unit)                   |
| `src/gateway/rpc/index.test.ts`           | RPC 디스패처, 배치 처리, 배치 크기 제한 (unit) |
| `src/gateway/rpc/errors.test.ts`          | 에러 코드, 에러 포맷팅 (unit)                  |
| `src/gateway/rpc/methods/chat.test.ts`    | chat.\* 메서드 로직 (unit)                     |
| `src/gateway/rpc/methods/system.test.ts`  | system.\* 메서드 (unit)                        |
| `src/gateway/rpc/methods/finance.test.ts` | finance.\* 스텁 메서드 (unit)                  |
| `src/gateway/rpc/methods/session.test.ts` | session.\* 메서드 (unit)                       |
| `src/gateway/auth/index.test.ts`          | 인증 체인 (unit)                               |
| `src/gateway/auth/rate-limit.test.ts`     | IP별 실패 카운트, 차단/해제 (unit)             |
| `src/gateway/ws/connection.test.ts`       | WS 연결 관리, 핸드셰이크 타임아웃 (unit)       |
| `src/gateway/broadcaster.test.ts`         | 스트리밍 배치, slow consumer 보호 (unit)       |
| `src/gateway/registry.test.ts`            | 실행 레지스트리, TTL 정리 (unit)               |

### 기존 수정 파일

| 파일 경로                       | 변경 내용                                     |
| ------------------------------- | --------------------------------------------- |
| `packages/infra/src/events.ts`  | FinClawEventMap에 `gateway:*` 이벤트 8개 추가 |
| `packages/types/src/gateway.ts` | RpcMethod union에 `chat.*` 메서드 추가        |

---

## 4. 핵심 인터페이스/타입

### `@finclaw/types` 재활용 타입

`@finclaw/types/gateway`에서 다음을 re-export한다. 게이트웨이 서버에서 중복 정의하지 않는다:

```typescript
// rpc/types.ts — @finclaw/types re-export
export type {
  RpcRequest,
  RpcResponse,
  RpcError,
  RpcMethod,
  WsEvent,
  GatewayStatus,
} from '@finclaw/types';
export { RPC_ERROR_CODES } from '@finclaw/types';
```

### 게이트웨이 전용 타입 (`src/gateway/rpc/types.ts`)

`@finclaw/types`에 없는, 게이트웨이 서버 내부에서만 사용하는 타입:

```typescript
import { z } from 'zod/v4';
import type { RpcRequest, RpcResponse } from '@finclaw/types';

// === JSON-RPC 2.0 프로토콜 확장 타입 ===

/** JSON-RPC 알림 (서버 → 클라이언트, id 없음) */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 배치 요청 */
export type JsonRpcBatchRequest = readonly RpcRequest[];

/** RPC 메서드 핸들러 (Zod v4 스키마 기반) */
export interface RpcMethodHandler<TParams = unknown, TResult = unknown> {
  readonly method: string;
  readonly description: string;
  readonly authLevel: AuthLevel;
  readonly schema: z.ZodType<TParams>; // Zod v4 스키마
  execute(params: TParams, ctx: RpcContext): Promise<TResult>;
}

/** RPC 실행 컨텍스트 */
export interface RpcContext {
  readonly requestId: string | number;
  readonly auth: AuthInfo;
  readonly connectionId?: string; // WebSocket 연결 ID
  readonly remoteAddress: string;
}

/** WebSocket 서버 → 클라이언트 알림 */
export type WsServerNotification = JsonRpcNotification;
```

### 인증 타입 (`src/gateway/auth/`)

```typescript
/** 인증 레벨 (4-layer) */
export type AuthLevel =
  | 'none' // 공개 (health, info)
  | 'api_key' // API 키 (외부 서비스)
  | 'token' // JWT 토큰 (웹 클라이언트)
  | 'session'; // 세션 스코프 (활성 채팅 세션 전용)

/** 인증 정보 */
export interface AuthInfo {
  readonly level: AuthLevel;
  readonly clientId?: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly permissions: readonly Permission[];
}

/** 권한 */
export type Permission =
  | 'chat:read'
  | 'chat:write'
  | 'chat:execute'
  | 'config:read'
  | 'config:write'
  | 'agent:read'
  | 'agent:manage'
  | 'system:admin';

/** 인증 결과 */
export type AuthResult =
  | { readonly ok: true; readonly info: AuthInfo }
  | { readonly ok: false; readonly error: string; readonly code: number };
```

### 게이트웨이 서버 설정 타입

> **주의:** `@finclaw/types`에 간략한 `GatewayConfig`가 이미 존재한다 (port, host, tls, corsOrigins).
> 게이트웨이 서버의 상세 설정은 이름 충돌을 피하기 위해 `GatewayServerConfig`로 명명한다.

```typescript
/** 게이트웨이 서버 상세 설정 */
export interface GatewayServerConfig {
  readonly host: string; // 기본 '0.0.0.0'
  readonly port: number; // 기본 3000
  readonly tls?: {
    readonly cert: string; // 인증서 경로
    readonly key: string; // 키 경로
  };
  readonly cors?: {
    readonly origins: readonly string[]; // 허용 출처
    readonly maxAge?: number; // preflight 캐시 (초)
  };
  readonly auth: {
    readonly apiKeys: readonly string[]; // 허용된 API 키
    readonly jwtSecret: string; // JWT 서명 키
    readonly sessionTtlMs: number; // 세션 만료 시간
  };
  readonly ws: {
    readonly heartbeatIntervalMs: number; // 기본 30_000
    readonly heartbeatTimeoutMs: number; // 기본 10_000
    readonly maxPayloadBytes: number; // 기본 1MB
    readonly handshakeTimeoutMs: number; // 기본 10_000 (인증 완료 제한)
    readonly maxConnections: number; // 기본 100 (초과 시 close(1013))
  };
  readonly rpc: {
    readonly maxBatchSize: number; // 기본 10
    readonly timeoutMs: number; // 기본 60_000
  };
}
```

### GatewayServerContext — 중앙 DI 컨테이너 (`src/gateway/context.ts`)

```typescript
import type { WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { GatewayServerConfig, WsConnection } from './rpc/types.js';
import type { ChatRegistry } from './registry.js';
import type { GatewayBroadcaster } from './broadcaster.js';

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
```

### WebSocket 연결 타입

```typescript
/** WebSocket 연결 정보 */
export interface WsConnection {
  readonly id: string;
  readonly ws: WebSocket;
  readonly auth: AuthInfo;
  readonly connectedAt: number;
  lastPongAt: number;
  readonly subscriptions: Set<string>; // 구독 중인 이벤트 채널
}

/** WebSocket 메시지 (서버 → 클라이언트) */
export type WsOutboundMessage = RpcResponse | JsonRpcNotification;
```

### Chat 실행 레지스트리 타입

```typescript
/** 활성 채팅 세션 */
export interface ActiveSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly startedAt: number;
  readonly status: 'running' | 'paused' | 'stopping';
  readonly abortController: AbortController;
}

/** 레지스트리 이벤트 */
export type RegistryEvent =
  | { readonly type: 'session_started'; readonly session: ActiveSession }
  | { readonly type: 'session_completed'; readonly sessionId: string; readonly durationMs: number }
  | { readonly type: 'session_error'; readonly sessionId: string; readonly error: Error };
```

---

## 5. 구현 상세

### 5.1 HTTP + WebSocket 서버 (`server.ts`)

Node.js 네이티브 `http`/`https` 모듈로 HTTP 서버를 생성하고, 동일 포트에서 WebSocket 업그레이드를 처리한다. `GatewayServerContext`를 생성하여 모든 하위 모듈에 주입한다.

```typescript
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

export interface GatewayServer {
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  readonly ctx: GatewayServerContext;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGatewayServer(config: GatewayServerConfig): GatewayServer {
  // HTTP 서버 생성 (TLS 여부에 따라 분기)
  const httpServer = config.tls
    ? createHttpsServer({
        cert: readFileSync(config.tls.cert),
        key: readFileSync(config.tls.key),
      })
    : createServer();

  // WebSocket 서버 (HTTP 서버에 연결)
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: config.ws.maxPayloadBytes,
  });

  // DI 컨테이너 구성
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
    handleHttpRequest(req, res, ctx);
  });

  // WebSocket 연결 처리 (연결 수 제한)
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (ctx.connections.size >= config.ws.maxConnections) {
      ws.close(1013, 'Too many connections');
      return;
    }
    handleWsConnection(ws, req, ctx);
  });

  // 하트비트 시작
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

    /** Graceful Shutdown — 5단계 */
    async stop(): Promise<void> {
      // 1. 활성 세션 abort
      ctx.registry.abortAll();

      // 2. 종료 알림 broadcast
      ctx.broadcaster.broadcastShutdown(ctx.connections);

      // 3. drain 대기 (최대 5초)
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      // 4. WebSocket 연결 종료
      clearInterval(heartbeatInterval);
      for (const client of wss.clients) {
        client.close(1001, 'Server shutting down');
      }

      // 5. HTTP 서버 종료
      return new Promise((resolve) => {
        httpServer.close(() => {
          getEventBus().emit('gateway:stop');
          resolve();
        });
      });
    },
  };
}
```

### 5.2 HTTP 라우터 (`router.ts`)

간단한 패턴 매칭 기반 라우터. 프레임워크 의존성 없이 순수 Node.js로 구현한다.

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayServerContext } from './context.js';
import { handleCors } from './cors.js';
import { dispatchRpc } from './rpc/index.js';

interface Route {
  readonly method: string;
  readonly path: string;
  handler(req: IncomingMessage, res: ServerResponse, ctx: GatewayServerContext): Promise<void>;
}

const routes: Route[] = [
  { method: 'POST', path: '/rpc', handler: handleRpcRequest },
  { method: 'GET', path: '/health', handler: handleHealthRequest },
  { method: 'GET', path: '/info', handler: handleInfoRequest },
];

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  // CORS preflight 처리
  if (req.method === 'OPTIONS') {
    handleCors(req, res, ctx.config.cors);
    return;
  }

  // CORS 헤더 추가
  handleCors(req, res, ctx.config.cors);

  // 라우트 매칭
  const route = routes.find((r) => r.method === req.method && req.url?.startsWith(r.path));

  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  try {
    await route.handler(req, res, ctx);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

/** POST /rpc - JSON-RPC 엔드포인트 */
async function handleRpcRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  const body = await readBody(req);
  const parsed = JSON.parse(body);

  const response = await dispatchRpc(
    parsed,
    {
      auth: { level: 'none', permissions: [] },
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
    },
    ctx,
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/** 요청 body 읽기 (스트리밍) */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
```

### 5.3 JSON-RPC 디스패처 (`rpc/index.ts`)

메서드 레지스트리 패턴으로 RPC 호출을 디스패치한다. **Zod v4**로 파라미터를 런타임 검증한다.

```typescript
import type { RpcRequest, RpcResponse } from '@finclaw/types';
import type { JsonRpcBatchRequest, RpcMethodHandler, RpcContext } from './types.js';
import type { GatewayServerContext } from '../context.js';
import { RpcErrors, createError } from './errors.js';

const methods = new Map<string, RpcMethodHandler>();

/** 메서드 등록 */
export function registerMethod(handler: RpcMethodHandler): void {
  if (methods.has(handler.method)) {
    throw new Error(`RPC method already registered: ${handler.method}`);
  }
  methods.set(handler.method, handler);
}

/** RPC 요청 디스패치 (단일 또는 배치) */
export async function dispatchRpc(
  request: RpcRequest | JsonRpcBatchRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  serverCtx: GatewayServerContext,
): Promise<RpcResponse | RpcResponse[]> {
  // 배치 요청 처리
  if (Array.isArray(request)) {
    // 배치 크기 제한 적용
    if (request.length > serverCtx.config.rpc.maxBatchSize) {
      return createError(
        null,
        RpcErrors.INVALID_REQUEST,
        `Batch size ${request.length} exceeds limit ${serverCtx.config.rpc.maxBatchSize}`,
      );
    }
    return Promise.all(request.map((req) => handleSingleRequest(req, ctx)));
  }

  return handleSingleRequest(request, ctx);
}

/** 단일 RPC 요청 처리 */
async function handleSingleRequest(
  request: RpcRequest,
  ctx: Omit<RpcContext, 'requestId'>,
): Promise<RpcResponse> {
  // 1. jsonrpc 버전 검증
  if (request.jsonrpc !== '2.0') {
    return createError(request.id, RpcErrors.INVALID_REQUEST, 'Invalid JSON-RPC version');
  }

  // 2. 메서드 조회
  const handler = methods.get(request.method);
  if (!handler) {
    return createError(request.id, RpcErrors.METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
  }

  // 3. 인증 레벨 확인
  if (!hasRequiredAuth(ctx.auth, handler.authLevel)) {
    return createError(request.id, RpcErrors.UNAUTHORIZED, 'Insufficient permissions');
  }

  // 4. 파라미터 스키마 검증 (Zod v4)
  if (handler.schema) {
    const result = handler.schema.safeParse(request.params ?? {});
    if (!result.success) {
      return createError(
        request.id,
        RpcErrors.INVALID_PARAMS,
        `Invalid params: ${result.error.message}`,
      );
    }
  }

  // 5. 핸들러 실행
  try {
    const result = await handler.execute(request.params ?? {}, { ...ctx, requestId: request.id });
    return { jsonrpc: '2.0', id: request.id, result };
  } catch (error) {
    return createError(request.id, RpcErrors.INTERNAL_ERROR, (error as Error).message);
  }
}
```

### 5.4 JSON-RPC 에러 코드 (`rpc/errors.ts`)

`@finclaw/types`의 `RPC_ERROR_CODES`를 기준으로 하되, 게이트웨이 전용 에러를 확장한다.

```typescript
import { RPC_ERROR_CODES } from '@finclaw/types';
import type { RpcResponse } from '@finclaw/types';

/**
 * 게이트웨이 에러 코드
 *
 * @finclaw/types 기준 (변경 불가):
 *   PARSE_ERROR:       -32700
 *   INVALID_REQUEST:   -32600
 *   METHOD_NOT_FOUND:  -32601
 *   INVALID_PARAMS:    -32602
 *   INTERNAL_ERROR:    -32603
 *   UNAUTHORIZED:      -32001
 *   RATE_LIMITED:      -32002
 *   SESSION_NOT_FOUND: -32003
 *   AGENT_BUSY:        -32004
 *
 * 게이트웨이 전용 확장:
 */
export const RpcErrors = {
  ...RPC_ERROR_CODES,

  // 게이트웨이 전용 (범위: -32005 ~ -32099)
  AGENT_NOT_FOUND: -32005,
  EXECUTION_ERROR: -32006,
  CONTEXT_OVERFLOW: -32007,
} as const;

export type RpcErrorCode = (typeof RpcErrors)[keyof typeof RpcErrors];

export function createError(
  id: string | number | null,
  code: RpcErrorCode,
  message: string,
  data?: unknown,
): RpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined && { data }) },
  };
}
```

### 5.5 RPC 메서드 그룹

각 메서드 그룹의 핵심 메서드와 시그니처. 모든 스키마는 **Zod v4**로 정의한다.

```typescript
import { z } from 'zod/v4';

// === rpc/methods/chat.ts ===

/** chat.start - 새 채팅 세션 시작 */
registerMethod({
  method: 'chat.start',
  description: '새 채팅 세션을 시작합니다',
  authLevel: 'token',
  schema: z.object({
    agentId: z.string(),
    model: z.string().optional(),
  }),
  async execute(params, ctx): Promise<{ sessionId: string }> {
    const session = await registry.startSession({
      agentId: params.agentId,
      connectionId: ctx.connectionId!,
      model: params.model,
    });
    return { sessionId: session.sessionId };
  },
});

/** chat.send - 메시지 전송 (멱등키로 중복 방지) */
registerMethod({
  method: 'chat.send',
  description: '활성 세션에 메시지를 전송합니다',
  authLevel: 'session',
  schema: z.object({
    sessionId: z.string(),
    message: z.string(),
    idempotencyKey: z.string().optional(),
  }),
  async execute(params, ctx): Promise<{ messageId: string }> {
    // idempotencyKey가 있으면 Dedupe<T>로 중복 실행 방지 (§5.11)
    // 실행 엔진(Phase 9)을 통해 메시지 처리
    // 결과는 GatewayBroadcaster를 통해 WebSocket 알림으로 스트리밍
  },
});

/** chat.stop - 세션 중단 */
registerMethod({
  method: 'chat.stop',
  description: '활성 세션을 중단합니다',
  authLevel: 'session',
  schema: z.object({
    sessionId: z.string(),
  }),
  async execute(params, ctx): Promise<{ stopped: boolean }> {
    return registry.stopSession(params.sessionId);
  },
});

/** chat.history - 대화 이력 조회 */
registerMethod({
  method: 'chat.history',
  description: '세션의 대화 이력을 조회합니다',
  authLevel: 'token',
  schema: z.object({
    sessionId: z.string(),
    limit: z.number().int().min(1).max(100).optional(),
    before: z.string().optional(),
  }),
  async execute(params, ctx): Promise<{ messages: Message[] }> {
    // storage에서 대화 이력 조회
  },
});

// === rpc/methods/config.ts ===

/** config.get - 설정 조회 */
registerMethod({
  method: 'config.get',
  description: '현재 설정을 조회합니다',
  authLevel: 'token',
  schema: z.object({
    keys: z.array(z.string()).optional(),
  }),
  async execute(params, ctx): Promise<Record<string, unknown>> {
    // 요청된 설정 키들의 값 반환 (민감 정보 마스킹)
  },
});

// === rpc/methods/system.ts ===

/** system.health - 헬스 체크 */
registerMethod({
  method: 'system.health',
  description: '서버 상태를 확인합니다',
  authLevel: 'none',
  schema: z.object({}),
  async execute(
    _params,
    _ctx,
    serverCtx,
  ): Promise<{
    status: 'ok' | 'degraded' | 'error';
    uptime: number;
    activeSessions: number;
    connections: number;
    memoryMB: number;
  }> {
    return {
      status: 'ok',
      uptime: process.uptime(),
      activeSessions: serverCtx.registry.activeCount(),
      connections: serverCtx.connections.size,
      memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  },
});

/** system.info - 서버 정보 */
registerMethod({
  method: 'system.info',
  description: '서버 버전 및 기능 정보를 반환합니다',
  authLevel: 'none',
  schema: z.object({}),
  async execute(): Promise<{
    name: string;
    version: string;
    methods: string[];
    capabilities: string[];
  }> {
    return {
      name: 'finclaw-gateway',
      version: '0.1.0',
      methods: [...methods.keys()],
      capabilities: ['streaming', 'batch', 'subscriptions'],
    };
  },
});

// === rpc/methods/finance.ts (스텁) ===

/** finance.quote - 시세 조회 */
registerMethod({
  method: 'finance.quote',
  description: '종목 시세를 조회합니다',
  authLevel: 'token',
  schema: z.object({ symbol: z.string() }),
  async execute(params, ctx) {
    // skills-finance 패키지와 연동
    throw new Error('Not implemented');
  },
});

/** finance.news - 뉴스 검색 */
registerMethod({
  method: 'finance.news',
  description: '금융 뉴스를 검색합니다',
  authLevel: 'token',
  schema: z.object({
    query: z.string().optional(),
    symbols: z.array(z.string()).optional(),
  }),
  async execute(params, ctx) {
    throw new Error('Not implemented');
  },
});

// finance.alert.create, finance.alert.list, finance.portfolio.get — 동일 패턴

// === rpc/methods/session.ts ===

/** session.get - 세션 정보 조회 */
registerMethod({
  method: 'session.get',
  description: '세션 정보를 조회합니다',
  authLevel: 'token',
  schema: z.object({ sessionId: z.string() }),
  async execute(params, ctx) {
    return serverCtx.registry.getSession(params.sessionId);
  },
});

/** session.reset, session.list — 동일 패턴 */
```

### 5.6 4-layer 인증 (`auth/`)

```typescript
// auth/index.ts - 인증 미들웨어 체인
import type { IncomingMessage } from 'node:http';
import type { AuthInfo, AuthLevel, AuthResult, GatewayServerConfig } from '../rpc/types.js';
import { validateApiKey } from './api-key.js';
import { validateToken } from './token.js';

/**
 * 요청의 인증 정보를 추출하고 검증한다.
 * Authorization 헤더를 파싱하여 적절한 인증 레이어로 위임한다.
 *
 * 우선순위: Bearer token > X-API-Key > none
 */
export async function authenticate(
  req: IncomingMessage,
  config: GatewayServerConfig['auth'],
): Promise<AuthResult> {
  const authorization = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] as string | undefined;

  // Bearer 토큰 인증
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7);
    return validateToken(token, config.jwtSecret);
  }

  // API 키 인증
  if (apiKey) {
    return validateApiKey(apiKey, config.apiKeys);
  }

  // 인증 없음 (public 엔드포인트만 접근 가능)
  return {
    ok: true,
    info: {
      level: 'none',
      permissions: [],
    },
  };
}

/** 필요한 인증 레벨 충족 여부 확인 */
export function hasRequiredAuth(auth: AuthInfo, required: AuthLevel): boolean {
  const levels: AuthLevel[] = ['none', 'api_key', 'token', 'session'];
  return levels.indexOf(auth.level) >= levels.indexOf(required);
}

// auth/api-key.ts
import { createHash, timingSafeEqual } from 'node:crypto';

export function validateApiKey(key: string, allowedKeys: readonly string[]): AuthResult {
  const keyHash = createHash('sha256').update(key).digest();
  const found = allowedKeys.some((allowed) => {
    const allowedHash = createHash('sha256').update(allowed).digest();
    // timingSafeEqual — 타이밍 공격 방어 (Buffer 비교, 문자열 === 아님)
    return keyHash.length === allowedHash.length && timingSafeEqual(keyHash, allowedHash);
  });

  if (!found) {
    return { ok: false, error: 'Invalid API key', code: 401 };
  }

  return {
    ok: true,
    info: {
      level: 'api_key',
      clientId: keyHash.toString('hex').slice(0, 8),
      permissions: ['chat:read', 'chat:write', 'chat:execute'],
    },
  };
}

// auth/token.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 간이 JWT 검증 (node:crypto만 사용, 외부 라이브러리 불필요) */
export function validateToken(token: string, secret: string): AuthResult {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, error: 'Invalid token format', code: 401 };
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // alg 검증 — alg confusion attack 방어
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  if (header.alg !== 'HS256') {
    return { ok: false, error: `Unsupported algorithm: ${header.alg}`, code: 401 };
  }

  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  // 타이밍 안전 비교
  const sigBuffer = Buffer.from(signatureB64, 'base64url');
  const expectedBuffer = Buffer.from(expectedSig, 'base64url');

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { ok: false, error: 'Invalid token signature', code: 401 };
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

  // 만료 확인
  if (payload.exp && payload.exp < Date.now() / 1000) {
    return { ok: false, error: 'Token expired', code: 401 };
  }

  return {
    ok: true,
    info: {
      level: 'token',
      userId: payload.sub,
      clientId: payload.clientId,
      permissions: payload.permissions ?? [],
    },
  };
}
```

### 5.7 WebSocket 연결 관리 (`ws/connection.ts`)

연결 상태를 `GatewayServerContext.connections`에 저장한다 (모듈 전역 Map 제거). 핸드셰이크 타임아웃을 적용한다.

```typescript
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { WsConnection } from '../rpc/types.js';
import type { GatewayServerContext } from '../context.js';
import { authenticate } from '../auth/index.js';
import { dispatchRpc } from '../rpc/index.js';

export async function handleWsConnection(
  ws: WebSocket,
  req: IncomingMessage,
  ctx: GatewayServerContext,
): Promise<void> {
  // 핸드셰이크 타임아웃 (인증 완료까지 제한, DoS 방지)
  const handshakeTimer = setTimeout(() => {
    ws.close(4008, 'Authentication timeout');
  }, ctx.config.ws.handshakeTimeoutMs);

  // 인증
  const authResult = await authenticate(req, ctx.config.auth);
  clearTimeout(handshakeTimer);

  if (!authResult.ok) {
    ws.close(4001, authResult.error);
    return;
  }

  const conn: WsConnection = {
    id: randomUUID(),
    ws,
    auth: authResult.info,
    connectedAt: Date.now(),
    lastPongAt: Date.now(),
    subscriptions: new Set(),
  };

  // serverCtx에 저장 (모듈 전역 Map 대신)
  ctx.connections.set(conn.id, conn);

  ws.on('message', async (data: Buffer) => {
    try {
      const request = JSON.parse(data.toString('utf8'));
      const response = await dispatchRpc(
        request,
        {
          auth: conn.auth,
          connectionId: conn.id,
          remoteAddress: req.socket.remoteAddress ?? 'unknown',
        },
        ctx,
      );
      ws.send(JSON.stringify(response));
    } catch {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      );
    }
  });

  ws.on('pong', () => {
    conn.lastPongAt = Date.now();
  });

  ws.on('close', () => {
    ctx.connections.delete(conn.id);
  });
}

/** 특정 연결에 알림 전송 */
export function sendNotification(
  ctx: GatewayServerContext,
  connectionId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  const conn = ctx.connections.get(connectionId);
  if (conn && conn.ws.readyState === conn.ws.OPEN) {
    conn.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
      }),
    );
  }
}
```

### 5.8 Chat 실행 레지스트리 (`registry.ts`)

TTL 기반 만료 + `AbortSignal.timeout()` + 주기적 cleanup을 추가한다.

```typescript
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ActiveSession, RegistryEvent } from './rpc/types.js';

export class ChatRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly emitter = new EventEmitter();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly sessionTtlMs: number) {
    // 주기적 만료 세션 정리 (60초 간격)
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /** 새 세션 시작 */
  startSession(params: { agentId: string; connectionId: string; model?: string }): ActiveSession {
    // 동일 연결에서 이미 실행 중인 세션이 있는지 확인
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
    AbortSignal.timeout(this.sessionTtlMs).addEventListener('abort', () => {
      this.stopSession(session.sessionId);
    });

    this.sessions.set(session.sessionId, session);
    this.emitter.emit('event', {
      type: 'session_started',
      session,
    } satisfies RegistryEvent);

    return session;
  }

  /** 세션 중단 */
  stopSession(sessionId: string): { stopped: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session) return { stopped: false };

    session.abortController.abort();
    this.sessions.delete(sessionId);

    this.emitter.emit('event', {
      type: 'session_completed',
      sessionId,
      durationMs: Date.now() - session.startedAt,
    } satisfies RegistryEvent);

    return { stopped: true };
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

  /** 이벤트 리스너 등록 */
  on(listener: (event: RegistryEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
```

### 5.9 GatewayBroadcaster — 스트리밍 → WS 알림 변환 (`broadcaster.ts`)

Phase 9 `StreamEvent`를 WebSocket JSON-RPC Notification으로 변환한다. `text_delta`는 150ms 배치, 나머지는 즉시 전송. Slow consumer를 감지하여 연결을 보호한다.

**스트리밍 알림 프로토콜 (Phase 9 StreamEvent → WebSocket Notification):**

| StreamEvent.type | WS method                | 전송 정책  |
| ---------------- | ------------------------ | ---------- |
| `text_delta`     | `chat.stream.delta`      | 150ms 배치 |
| `tool_use_start` | `chat.stream.tool_start` | 즉시       |
| `tool_use_end`   | `chat.stream.tool_end`   | 즉시       |
| `done`           | `chat.stream.end`        | 즉시       |
| `error`          | `chat.stream.error`      | 즉시       |

> **미매핑 이벤트:** `state_change`, `message_complete`, `usage_update`는 내부 FSM/집계용이므로
> WebSocket 클라이언트에 전달하지 않는다. Broadcaster의 `send()`가 이들을 무시한다.

```typescript
import type { StreamEvent } from '@finclaw/agent/execution/streaming';
import type { WsConnection, JsonRpcNotification } from './rpc/types.js';

export class GatewayBroadcaster {
  private readonly deltaBuffers = new Map<
    string,
    { text: string; timer: ReturnType<typeof setTimeout> }
  >();
  private static readonly BATCH_INTERVAL_MS = 150;

  /** StreamEvent를 connectionId에 전송 */
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
        this.flushDelta(conn.id, sessionId, conn); // 잔여 delta flush
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

  /** 즉시 전송 (slow consumer 보호) */
  private sendImmediate(conn: WsConnection, method: string, params: Record<string, unknown>): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > 1024 * 1024) {
      // slow consumer: 1MB 이상 버퍼링 시 건너뛰기
      return;
    }
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
}
```

### 5.10 인증 Rate Limiting (`auth/rate-limit.ts`)

IP별 인증 실패 횟수를 추적하여 DoS 공격을 방어한다.

```typescript
interface RateLimitEntry {
  failures: number;
  lastFailure: number;
  blockedUntil: number;
}

/**
 * IP별 인증 실패 Rate Limiter
 *
 * - 5분 윈도우 내 5회 실패 시 15분 차단
 * - 차단 해제 후 카운터 리셋
 */
export class AuthRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockDurationMs: number;

  constructor(opts?: { maxFailures?: number; windowMs?: number; blockDurationMs?: number }) {
    this.maxFailures = opts?.maxFailures ?? 5;
    this.windowMs = opts?.windowMs ?? 5 * 60_000;
    this.blockDurationMs = opts?.blockDurationMs ?? 15 * 60_000;
  }

  /** 차단 여부 확인 */
  isBlocked(ip: string): boolean {
    const entry = this.entries.get(ip);
    if (!entry) return false;
    if (Date.now() < entry.blockedUntil) return true;
    // 차단 해제 후 리셋
    this.entries.delete(ip);
    return false;
  }

  /** 실패 기록 */
  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.entries.get(ip);
    if (!entry || now - entry.lastFailure > this.windowMs) {
      this.entries.set(ip, { failures: 1, lastFailure: now, blockedUntil: 0 });
      return;
    }

    entry.failures++;
    entry.lastFailure = now;
    if (entry.failures >= this.maxFailures) {
      entry.blockedUntil = now + this.blockDurationMs;
    }
  }

  /** 캐시 크기 */
  get size(): number {
    return this.entries.size;
  }
}
```

### 5.11 chat.send 멱등키 — `@finclaw/infra` Dedupe 재활용

`chat.send`의 `idempotencyKey`를 기존 `@finclaw/infra`의 `Dedupe<T>`로 처리한다:

```typescript
import { Dedupe } from '@finclaw/infra';

// ChatRegistry 내부 또는 chat.ts 메서드 핸들러에서:
const chatDedupe = new Dedupe<{ messageId: string }>({ ttlMs: 60_000 });

// chat.send execute() 내:
if (params.idempotencyKey) {
  return chatDedupe.execute(params.idempotencyKey, () => doSend(params));
}
return doSend(params);
```

### 5.12 FinClawEventMap gateway 이벤트

`packages/infra/src/events.ts`의 `FinClawEventMap`에 추가할 이벤트:

```typescript
// ── Phase 10: Gateway events ──
'gateway:start': (port: number) => void;
'gateway:stop': () => void;
'gateway:ws:connect': (connectionId: string, authLevel: string) => void;
'gateway:ws:disconnect': (connectionId: string, code: number) => void;
'gateway:rpc:request': (method: string, connectionId: string) => void;
'gateway:rpc:error': (method: string, errorCode: number) => void;
'gateway:auth:failure': (ip: string, reason: string) => void;
'gateway:auth:rate_limit': (ip: string, failures: number) => void;
```

### 5.13 Graceful Shutdown 통합

`server.ts`의 `stop()`을 기존 `setupGracefulShutdown()` + `CleanupFn`과 연결한다:

```typescript
// packages/server/src/main.ts에서:
import { setupGracefulShutdown } from './process/signal-handler.js';
import { createGatewayServer } from './gateway/server.js';

const gateway = createGatewayServer(config);

// CleanupFn으로 등록
cleanupFns.push(() => gateway.stop());

// 기존 signal handler가 CleanupFn을 순차 실행
setupGracefulShutdown(logger, () => cleanupFns);
```

Shutdown 5단계 (§5.1 `stop()` 참조):

1. 활성 세션 abort (`registry.abortAll()`)
2. 종료 알림 broadcast (`broadcaster.broadcastShutdown()`)
3. drain 대기 (최대 5초)
4. WebSocket 연결 종료 (`ws.close(1001)`)
5. HTTP 서버 종료 (`httpServer.close()`)

### 데이터 흐름 다이어그램

```
Client (Web UI / CLI / Mobile)
     │
     ├── HTTP POST /rpc ──────────────────┐
     │                                     │
     └── WebSocket ws://host:port ────┐    │
                                      │    │
                                      ▼    ▼
                          ┌─────────────────────────┐
                          │    Gateway Server        │
                          │    (server.ts)           │
                          │                          │
                          │  ┌───────────────────┐   │
                          │  │ GatewayServerCtx   │  │
                          │  │ (DI container)     │  │
                          │  └────────┬──────────┘   │
                          └───────────┼──────────────┘
                                      │
                     ┌────────────────┼───────────────┐
                     ▼                ▼                ▼
               ┌──────────┐  ┌──────────────┐  ┌──────────┐
               │ Auth     │  │ Router       │  │ WS Conn  │
               │ (4-layer)│  │              │  │ Manager  │
               │+RateLimit│  │              │  │ +Timeout │
               └────┬─────┘  └──────┬───────┘  └────┬─────┘
                    │               │               │
                    ▼               ▼               ▼
               ┌───────────────────────────────────────────┐
               │  JSON-RPC Dispatcher                      │
               │  (method registry + Zod v4 validation)    │
               └──────────────────┬────────────────────────┘
                                  │
          ┌───────────┬───────────┼───────────┬────────────┐
          ▼           ▼           ▼           ▼            ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ chat.*   │ │ config.* │ │ system.* │ │ finance.*│ │ session.*│
    │ methods  │ │ methods  │ │ methods  │ │ (stubs)  │ │ methods  │
    └────┬─────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
         │
         ▼
  ┌──────────────┐     ┌────────────────────┐
  │ Chat Registry│ ──→ │ Execution Engine    │
  │ (TTL+Dedupe) │     │ (Phase 9)          │
  └──────┬───────┘     └────────┬───────────┘
         │                      │
         ▼                      ▼
  ┌──────────────┐     ┌────────────────────┐
  │ Broadcaster  │ ←── │ StreamStateMachine  │
  │ (150ms batch)│     │ (Phase 9)          │
  └──────┬───────┘     └────────────────────┘
         │
         ▼
  WebSocket Notifications
  (chat.stream.delta / tool_start / tool_end / end / error)
```

---

## 6. 선행 조건

| Phase       | 구체적 산출물                                     | 필요 이유                                            |
| ----------- | ------------------------------------------------- | ---------------------------------------------------- |
| **Phase 8** | `src/agents/pipeline.ts` - 자동 응답 파이프라인   | chat.send RPC 메서드가 호출하는 상위 처리 파이프라인 |
| **Phase 9** | `src/execution/runner.ts` - 실행 엔진 메인 runner | chat.send가 실제 LLM 호출을 위임하는 실행 엔진       |
| **Phase 9** | `src/execution/streaming.ts` - 스트리밍 상태 머신 | GatewayBroadcaster가 StreamEvent를 WS 알림으로 변환  |
| **Phase 4** | `src/config/schema.ts` - 설정 스키마              | config.\* RPC 메서드가 참조하는 설정 구조            |
| **Phase 3** | `src/storage/` - 저장소 모듈                      | chat.history가 대화 이력을 조회하는 데 사용          |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| 산출물               | 검증 방법                                          |
| -------------------- | -------------------------------------------------- |
| HTTP 서버 생성       | unit: 서버 시작/종료, 포트 바인딩 확인             |
| HTTP 라우팅          | unit: GET/POST 라우트 매칭, 404 처리, CORS         |
| JSON-RPC 디스패처    | unit: 단일 요청, 배치 요청, 배치 크기 제한         |
| 스키마 검증          | unit: 유효/무효 파라미터, Zod v4 에러 메시지       |
| 4-layer 인증         | unit: 각 레벨 검증, 권한 부족 시 거부              |
| API 키 인증          | unit: 유효/무효 키, timingSafeEqual 비교           |
| JWT 토큰 인증        | unit: 서명 검증, alg 검증, 만료 확인               |
| 인증 Rate Limiting   | unit: 실패 횟수 추적, 차단/해제                    |
| WebSocket 연결       | unit: 연결/해제, 핸드셰이크 타임아웃, 연결 수 제한 |
| 하트비트             | unit: ping 전송, pong 타임아웃 감지                |
| Chat 레지스트리      | unit: 세션 시작/종료, 중복 방지, TTL 만료          |
| Broadcaster          | unit: 150ms 배치, slow consumer 보호, shutdown     |
| finance.\* 메서드    | unit: 스텁 호출, 파라미터 검증                     |
| session.\* 메서드    | unit: 세션 CRUD 동작                               |
| GatewayServerContext | unit: DI 컨테이너 생성, 주입                       |

### 검증 기준

```bash
# 단위 테스트
pnpm test -- src/gateway/

# E2E 테스트 (실제 서버 기동)
pnpm test:e2e -- src/gateway/

# 커버리지 목표: statements 80%, branches 75%
pnpm test:coverage -- src/gateway/
```

### 통합 검증 시나리오

```typescript
// test/e2e/gateway.e2e.test.ts
import { createGatewayServer } from '../../src/gateway/server.js';

it('HTTP JSON-RPC: system.health 호출', async () => {
  const server = createGatewayServer(testConfig);
  await server.start();

  const res = await fetch(`http://localhost:${testConfig.port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'system.health',
      params: {},
    }),
  });

  const data = await res.json();
  expect(data.result.status).toBe('ok');
  expect(data.result.memoryMB).toBeGreaterThan(0);

  await server.stop();
});

it('WebSocket JSON-RPC: chat.start → chat.send → 스트리밍 알림 → chat.stop', async () => {
  const server = createGatewayServer(testConfig);
  await server.start();

  const ws = new WebSocket(`ws://localhost:${testConfig.port}`, {
    headers: { authorization: `Bearer ${testToken}` },
  });

  // chat.start
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'chat.start',
      params: { agentId: 'finclaw' },
    }),
  );

  // 응답 수신 → sessionId 획득
  // chat.send → GatewayBroadcaster를 통한 스트리밍 알림 수신:
  //   chat.stream.delta (150ms 배치)
  //   chat.stream.tool_start / chat.stream.tool_end (즉시)
  //   chat.stream.end (즉시)
  // chat.stop → 세션 종료 확인

  await server.stop();
});

it('연결 수 제한: maxConnections 초과 시 close(1013)', async () => {
  const config = { ...testConfig, ws: { ...testConfig.ws, maxConnections: 1 } };
  const server = createGatewayServer(config);
  await server.start();

  const ws1 = new WebSocket(`ws://localhost:${config.port}`);
  const ws2 = new WebSocket(`ws://localhost:${config.port}`);

  // ws2는 1013 코드로 거부되어야 함

  await server.stop();
});

it('핸드셰이크 타임아웃: 인증 없이 대기 시 4008 close', async () => {
  // handshakeTimeoutMs 이내에 인증이 완료되지 않으면
  // 서버가 ws.close(4008) 호출
});
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값            |
| ----------------- | ------------- |
| **복잡도**        | **XL**        |
| 소스 파일         | 22            |
| 테스트 파일       | 13            |
| 기존 수정 파일    | 2             |
| **합계**          | **37 파일**   |
| 예상 LOC (소스)   | 1,800 ~ 2,500 |
| 예상 LOC (테스트) | 1,500 ~ 2,000 |
| 신규 의존성       | `ws`          |
