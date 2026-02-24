# Phase 10: 게이트웨이 서버 - 코어 (Gateway Server: Core)

> **복잡도: XL** | 소스 ~16 파일 | 테스트 ~9 파일 | 합계 ~25 파일

---

## 1. 목표

외부 클라이언트(웹 UI, CLI, 모바일 앱)가 FinClaw 실행 엔진과 통신할 수 있는 게이트웨이 서버를 구축한다. OpenClaw 게이트웨이(187 파일, 36.2K LOC)의 핵심 아키텍처를 기반으로, 금융 AI 어시스턴트에 필요한 코어 기능을 구현한다:

- **HTTP 서버**: Node.js 네이티브 `http`/`https` 모듈 기반, CORS 처리, 요청 라우팅
- **WebSocket 서버**: `ws` 라이브러리 기반, 연결 관리, 하트비트
- **JSON-RPC v3 프로토콜**: 메서드 레지스트리, 요청 파싱, 응답 포맷팅, 배치 지원
- **스키마 검증**: TypeBox 타입 정의 + AJV 런타임 검증으로 모든 RPC 파라미터 검증
- **4-layer 인증**: none(공개) → API key → token(JWT) → session-scoped
- **Chat 실행 레지스트리**: 활성 채팅 세션 추적, 중복 실행 방지
- **RPC 메서드 그룹**: chat, config, agent, system 4개 그룹
- **에러 처리**: JSON-RPC 에러 코드, 구조화된 에러 응답

---

## 2. OpenClaw 참조

| OpenClaw 경로                                     | 적용 패턴                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `openclaw_review/deep-dive/03-gateway-server.md`  | HTTP/WS 서버 설정, JSON-RPC 프로토콜, 4-layer 인증, 전체 아키텍처 |
| `openclaw_review/deep-dive/03` (JSON-RPC 섹션)    | 85+ 메서드 레지스트리, 요청/응답/알림 패턴, 배치 처리             |
| `openclaw_review/deep-dive/03` (스키마 검증 섹션) | TypeBox + AJV 조합, 런타임 타입 안전성 확보 패턴                  |
| `openclaw_review/deep-dive/03` (인증 섹션)        | 4-layer 인증 체계: none → API key → token → session               |
| `openclaw_review/deep-dive/03` (레지스트리 섹션)  | Chat execution registry 패턴                                      |
| `openclaw_review/docs/` (server 관련)             | 서버 설정, 포트, TLS 설정 구조                                    |

**OpenClaw 차이점:**

- 85+ RPC 메서드 → FinClaw는 ~25개 핵심 메서드로 축소
- 187 파일 → ~25 파일로 경량화
- 금융 특화 RPC 메서드 추가: `market.quote`, `market.history`, `news.search` 등
- WebSocket 메시지에 실시간 시세 스트리밍 채널 추가

---

## 3. 생성할 파일

### 소스 파일 (`src/gateway/`)

| 파일 경로                           | 설명                                             |
| ----------------------------------- | ------------------------------------------------ |
| `src/gateway/index.ts`              | 모듈 public API re-export                        |
| `src/gateway/server.ts`             | HTTP + WebSocket 서버 생성 및 설정               |
| `src/gateway/router.ts`             | HTTP 요청 라우팅 (REST 엔드포인트)               |
| `src/gateway/cors.ts`               | CORS 미들웨어                                    |
| `src/gateway/rpc/index.ts`          | JSON-RPC 디스패처 (메서드 레지스트리)            |
| `src/gateway/rpc/types.ts`          | JSON-RPC 요청/응답/에러 타입                     |
| `src/gateway/rpc/errors.ts`         | JSON-RPC 표준 에러 코드 + 커스텀 에러            |
| `src/gateway/rpc/methods/chat.ts`   | chat.\* RPC 메서드 (start, send, stop, history)  |
| `src/gateway/rpc/methods/config.ts` | config.\* RPC 메서드 (get, set, reload)          |
| `src/gateway/rpc/methods/agent.ts`  | agent.\* RPC 메서드 (status, list, capabilities) |
| `src/gateway/rpc/methods/system.ts` | system.\* RPC 메서드 (health, info, ping)        |
| `src/gateway/auth/index.ts`         | 인증 미들웨어 디스패처                           |
| `src/gateway/auth/api-key.ts`       | API 키 인증                                      |
| `src/gateway/auth/token.ts`         | JWT 토큰 인증                                    |
| `src/gateway/ws/connection.ts`      | WebSocket 연결 관리                              |
| `src/gateway/ws/heartbeat.ts`       | WebSocket 하트비트 (ping/pong)                   |
| `src/gateway/schema/index.ts`       | TypeBox 스키마 정의 + AJV 검증기                 |
| `src/gateway/registry.ts`           | Chat 실행 레지스트리                             |

### 테스트 파일

| 파일 경로                                | 테스트 대상                           |
| ---------------------------------------- | ------------------------------------- |
| `src/gateway/server.test.ts`             | HTTP/WS 서버 생성, 포트 바인딩 (unit) |
| `src/gateway/router.test.ts`             | 라우팅 매칭, 404 처리 (unit)          |
| `src/gateway/rpc/index.test.ts`          | RPC 디스패처, 배치 처리 (unit)        |
| `src/gateway/rpc/errors.test.ts`         | 에러 코드, 에러 포맷팅 (unit)         |
| `src/gateway/rpc/methods/chat.test.ts`   | chat.\* 메서드 로직 (unit)            |
| `src/gateway/rpc/methods/system.test.ts` | system.\* 메서드 (unit)               |
| `src/gateway/auth/index.test.ts`         | 인증 체인 (unit)                      |
| `src/gateway/ws/connection.test.ts`      | WS 연결 관리 (unit)                   |
| `src/gateway/registry.test.ts`           | 실행 레지스트리 (unit)                |

---

## 4. 핵심 인터페이스/타입

### JSON-RPC 프로토콜 타입 (`src/gateway/rpc/types.ts`)

```typescript
// === JSON-RPC v3 프로토콜 타입 ===

/** JSON-RPC 요청 */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 응답 (성공) */
export interface JsonRpcSuccess<T = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result: T;
}

/** JSON-RPC 응답 (에러) */
export interface JsonRpcError {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

/** JSON-RPC 알림 (서버 → 클라이언트, id 없음) */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 배치 요청 */
export type JsonRpcBatchRequest = readonly JsonRpcRequest[];

/** JSON-RPC 응답 (성공 또는 에러) */
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** RPC 메서드 핸들러 */
export interface RpcMethodHandler<TParams = unknown, TResult = unknown> {
  readonly method: string;
  readonly description: string;
  readonly authLevel: AuthLevel;
  readonly schema: TSchema; // TypeBox 스키마
  execute(params: TParams, ctx: RpcContext): Promise<TResult>;
}

/** RPC 실행 컨텍스트 */
export interface RpcContext {
  readonly requestId: string | number;
  readonly auth: AuthInfo;
  readonly connectionId?: string; // WebSocket 연결 ID
  readonly remoteAddress: string;
}
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

```typescript
/** 게이트웨이 서버 설정 */
export interface GatewayConfig {
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
  };
  readonly rpc: {
    readonly maxBatchSize: number; // 기본 10
    readonly timeoutMs: number; // 기본 60_000
  };
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
  readonly lastPongAt: number;
  readonly subscriptions: Set<string>; // 구독 중인 이벤트 채널
}

/** WebSocket 메시지 (서버 → 클라이언트) */
export type WsOutboundMessage = JsonRpcResponse | JsonRpcNotification;
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

Node.js 네이티브 `http`/`https` 모듈로 HTTP 서버를 생성하고, 동일 포트에서 WebSocket 업그레이드를 처리한다.

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
import type { GatewayConfig, WsConnection } from './types.js';
import { handleHttpRequest } from './router.js';
import { handleWsConnection } from './ws/connection.js';
import { startHeartbeat } from './ws/heartbeat.js';

export interface GatewayServer {
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGatewayServer(config: GatewayConfig): GatewayServer {
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

  // HTTP 요청 처리
  httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handleHttpRequest(req, res, config);
  });

  // WebSocket 연결 처리
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    handleWsConnection(ws, req, config);
  });

  // 하트비트 시작
  const heartbeatInterval = startHeartbeat(wss, config.ws);

  return {
    httpServer,
    wss,

    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.listen(config.port, config.host, () => {
          console.log(`Gateway listening on ${config.host}:${config.port}`);
          resolve();
        });
        httpServer.once('error', reject);
      });
    },

    async stop(): Promise<void> {
      clearInterval(heartbeatInterval);

      // 모든 WebSocket 연결 종료
      for (const client of wss.clients) {
        client.close(1001, 'Server shutting down');
      }

      return new Promise((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}
```

### 5.2 HTTP 라우터 (`router.ts`)

간단한 패턴 매칭 기반 라우터. 프레임워크 의존성 없이 순수 Node.js로 구현한다.

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleCors } from './cors.js';
import { dispatchRpc } from './rpc/index.js';

interface Route {
  readonly method: string;
  readonly path: string;
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

const routes: Route[] = [
  { method: 'POST', path: '/rpc', handler: handleRpcRequest },
  { method: 'GET', path: '/health', handler: handleHealthRequest },
  { method: 'GET', path: '/info', handler: handleInfoRequest },
];

export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): Promise<void> {
  // CORS preflight 처리
  if (req.method === 'OPTIONS') {
    handleCors(req, res, config.cors);
    return;
  }

  // CORS 헤더 추가
  handleCors(req, res, config.cors);

  // 라우트 매칭
  const route = routes.find((r) => r.method === req.method && req.url?.startsWith(r.path));

  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  try {
    await route.handler(req, res);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

/** POST /rpc - JSON-RPC 엔드포인트 */
async function handleRpcRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const parsed = JSON.parse(body);

  const response = await dispatchRpc(parsed /* context */);

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

메서드 레지스트리 패턴으로 RPC 호출을 디스패치한다. TypeBox + AJV로 파라미터를 런타임 검증한다.

```typescript
import Ajv from 'ajv';
import type {
  JsonRpcRequest,
  JsonRpcBatchRequest,
  JsonRpcResponse,
  RpcMethodHandler,
  RpcContext,
} from './types.js';
import { RpcErrors, createError } from './errors.js';

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
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
  request: JsonRpcRequest | JsonRpcBatchRequest,
  ctx: Omit<RpcContext, 'requestId'>,
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  // 배치 요청 처리
  if (Array.isArray(request)) {
    return Promise.all(request.map((req) => handleSingleRequest(req, ctx)));
  }

  return handleSingleRequest(request, ctx);
}

/** 단일 RPC 요청 처리 */
async function handleSingleRequest(
  request: JsonRpcRequest,
  ctx: Omit<RpcContext, 'requestId'>,
): Promise<JsonRpcResponse> {
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

  // 4. 파라미터 스키마 검증 (AJV)
  if (handler.schema) {
    const validate = ajv.compile(handler.schema);
    if (!validate(request.params)) {
      return createError(
        request.id,
        RpcErrors.INVALID_PARAMS,
        `Invalid params: ${ajv.errorsText(validate.errors)}`,
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

```typescript
/** JSON-RPC 표준 에러 코드 + FinClaw 커스텀 코드 */
export const RpcErrors = {
  // JSON-RPC 표준
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // FinClaw 커스텀 (범위: -32000 ~ -32099)
  UNAUTHORIZED: -32001,
  SESSION_NOT_FOUND: -32002,
  SESSION_BUSY: -32003,
  RATE_LIMITED: -32004,
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
): JsonRpcError {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined && { data }) },
  };
}
```

### 5.5 RPC 메서드 그룹

각 메서드 그룹의 핵심 메서드와 시그니처:

```typescript
// === rpc/methods/chat.ts ===

/** chat.start - 새 채팅 세션 시작 */
registerMethod({
  method: 'chat.start',
  description: '새 채팅 세션을 시작합니다',
  authLevel: 'token',
  schema: Type.Object({
    agentId: Type.String(),
    model: Type.Optional(Type.String()),
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

/** chat.send - 메시지 전송 */
registerMethod({
  method: 'chat.send',
  description: '활성 세션에 메시지를 전송합니다',
  authLevel: 'session',
  schema: Type.Object({
    sessionId: Type.String(),
    message: Type.String(),
  }),
  async execute(params, ctx): Promise<{ messageId: string }> {
    // 실행 엔진(Phase 9)을 통해 메시지 처리
    // 결과는 WebSocket 알림으로 스트리밍
  },
});

/** chat.stop - 세션 중단 */
registerMethod({
  method: 'chat.stop',
  description: '활성 세션을 중단합니다',
  authLevel: 'session',
  schema: Type.Object({
    sessionId: Type.String(),
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
  schema: Type.Object({
    sessionId: Type.String(),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
    before: Type.Optional(Type.String()),
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
  schema: Type.Object({
    keys: Type.Optional(Type.Array(Type.String())),
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
  schema: Type.Object({}),
  async execute(): Promise<{
    status: 'ok' | 'degraded' | 'error';
    uptime: number;
    activeSessions: number;
    connections: number;
  }> {
    return {
      status: 'ok',
      uptime: process.uptime(),
      activeSessions: registry.activeCount(),
      connections: wss.clients.size,
    };
  },
});

/** system.info - 서버 정보 */
registerMethod({
  method: 'system.info',
  description: '서버 버전 및 기능 정보를 반환합니다',
  authLevel: 'none',
  schema: Type.Object({}),
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
```

### 5.6 4-layer 인증 (`auth/`)

```typescript
// auth/index.ts - 인증 미들웨어 체인
import type { IncomingMessage } from 'node:http';
import type { AuthInfo, AuthLevel, AuthResult, GatewayConfig } from '../types.js';
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
  config: GatewayConfig['auth'],
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
import { createHash } from 'node:crypto';

export function validateApiKey(key: string, allowedKeys: readonly string[]): AuthResult {
  // 타이밍 공격 방지를 위한 해시 비교
  const keyHash = createHash('sha256').update(key).digest('hex');
  const found = allowedKeys.some((allowed) => {
    const allowedHash = createHash('sha256').update(allowed).digest('hex');
    return keyHash === allowedHash;
  });

  if (!found) {
    return { ok: false, error: 'Invalid API key', code: 401 };
  }

  return {
    ok: true,
    info: {
      level: 'api_key',
      clientId: keyHash.slice(0, 8),
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

```typescript
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import type { WsConnection, GatewayConfig } from '../types.js';
import { authenticate } from '../auth/index.js';
import { dispatchRpc } from '../rpc/index.js';

const connections = new Map<string, WsConnection>();

export async function handleWsConnection(
  ws: WebSocket,
  req: IncomingMessage,
  config: GatewayConfig,
): Promise<void> {
  // 인증
  const authResult = await authenticate(req, config.auth);
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

  connections.set(conn.id, conn);

  ws.on('message', async (data: Buffer) => {
    try {
      const request = JSON.parse(data.toString('utf8'));
      const response = await dispatchRpc(request, {
        auth: conn.auth,
        connectionId: conn.id,
        remoteAddress: req.socket.remoteAddress ?? 'unknown',
      });
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
    connections.delete(conn.id);
  });
}

/** 특정 연결에 알림 전송 */
export function sendNotification(
  connectionId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  const conn = connections.get(connectionId);
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

/** 전체 연결 목록 */
export function getConnections(): ReadonlyMap<string, WsConnection> {
  return connections;
}
```

### 5.8 Chat 실행 레지스트리 (`registry.ts`)

```typescript
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ActiveSession, RegistryEvent } from './types.js';

export class ChatRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly emitter = new EventEmitter();

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

  /** 활성 세션 수 */
  activeCount(): number {
    return this.sessions.size;
  }

  /** 이벤트 리스너 등록 */
  on(listener: (event: RegistryEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
```

### 데이터 흐름 다이어그램

```
Client (Web UI / CLI / Mobile)
     │
     ├── HTTP POST /rpc ──────────────────┐
     │                                     │
     └── WebSocket ws://host:port ────┐    │
                                      │    │
                                      ▼    ▼
                              ┌──────────────────┐
                              │   Gateway Server  │
                              │   (server.ts)     │
                              └────────┬─────────┘
                                       │
                          ┌────────────┼───────────┐
                          ▼            ▼            ▼
                    ┌──────────┐ ┌──────────┐ ┌──────────┐
                    │ Auth     │ │ Router   │ │ WS Conn  │
                    │ (4-layer)│ │          │ │ Manager  │
                    └────┬─────┘ └────┬─────┘ └────┬─────┘
                         │            │            │
                         ▼            ▼            ▼
                    ┌─────────────────────────────────────┐
                    │  JSON-RPC Dispatcher                │
                    │  (method registry + schema validate) │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
              ┌──────────┐    ┌──────────┐      ┌──────────┐
              │ chat.*   │    │ config.* │      │ system.* │
              │ methods  │    │ methods  │      │ methods  │
              └────┬─────┘    └──────────┘      └──────────┘
                   │
                   ▼
           ┌──────────────┐
           │ Chat Registry│ → Execution Engine (Phase 9)
           └──────────────┘
```

---

## 6. 선행 조건

| Phase       | 구체적 산출물                                     | 필요 이유                                                |
| ----------- | ------------------------------------------------- | -------------------------------------------------------- |
| **Phase 8** | `src/agents/pipeline.ts` - 자동 응답 파이프라인   | chat.send RPC 메서드가 호출하는 상위 처리 파이프라인     |
| **Phase 9** | `src/execution/runner.ts` - 실행 엔진 메인 runner | chat.send가 실제 LLM 호출을 위임하는 실행 엔진           |
| **Phase 9** | `src/execution/streaming.ts` - 스트리밍 상태 머신 | WebSocket을 통한 실시간 응답 스트리밍에 상태 이벤트 사용 |
| **Phase 4** | `src/config/schema.ts` - 설정 스키마              | config.\* RPC 메서드가 참조하는 설정 구조                |
| **Phase 3** | `src/storage/` - 저장소 모듈                      | chat.history가 대화 이력을 조회하는 데 사용              |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| 산출물            | 검증 방법                                     |
| ----------------- | --------------------------------------------- |
| HTTP 서버 생성    | unit: 서버 시작/종료, 포트 바인딩 확인        |
| HTTP 라우팅       | unit: GET/POST 라우트 매칭, 404 처리, CORS    |
| JSON-RPC 디스패처 | unit: 단일 요청, 배치 요청, 알 수 없는 메서드 |
| 스키마 검증       | unit: 유효/무효 파라미터, AJV 에러 메시지     |
| 4-layer 인증      | unit: 각 레벨 검증, 권한 부족 시 거부         |
| API 키 인증       | unit: 유효/무효 키, 타이밍 안전 비교          |
| JWT 토큰 인증     | unit: 서명 검증, 만료 확인                    |
| WebSocket 연결    | unit: 연결/해제, 메시지 송수신                |
| 하트비트          | unit: ping 전송, pong 타임아웃 감지           |
| Chat 레지스트리   | unit: 세션 시작/종료, 중복 방지               |

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

  await server.stop();
});

it('WebSocket JSON-RPC: chat.start → chat.send → chat.stop', async () => {
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
  // chat.send → 스트리밍 알림 수신
  // chat.stop → 세션 종료 확인

  await server.stop();
});
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                               |
| ----------------- | -------------------------------- |
| **복잡도**        | **XL**                           |
| 소스 파일         | 16                               |
| 테스트 파일       | 9                                |
| **합계**          | **~25 파일**                     |
| 예상 LOC (소스)   | 1,500 ~ 2,000                    |
| 예상 LOC (테스트) | 1,200 ~ 1,500                    |
| 신규 의존성       | `ws`, `@sinclair/typebox`, `ajv` |
| 예상 구현 시간    | 4-5일                            |
