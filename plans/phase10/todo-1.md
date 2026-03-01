# Phase 10 — Todo 1: Foundation

> **타입 + HTTP + 라우터 + RPC 디스패처 + 기본 메서드**
> 파일 수: 소스 10 + 테스트 4 + 기존 수정 2 = **16개**
> 의존성: 없음 (자체 완결)

---

## 1. 개요

모든 후속 파일이 의존하는 기반을 구축한다:

- `@finclaw/types`에 `chat.*` RPC 메서드 4개 추가
- `@finclaw/infra` 이벤트 맵에 `gateway:*` 이벤트 8개 추가
- 게이트웨이 전용 타입, 에러 코드, DI 컨테이너 인터페이스
- HTTP 라우터 + CORS 미들웨어
- JSON-RPC 2.0 디스패처 (메서드 레지스트리, 배치, Zod v4 검증)
- `system.*`, `config.*` 기본 RPC 메서드
- Part 2~3에서 완성할 `registry.ts`, `broadcaster.ts` 스텁

---

## 2. 사전 작업

```bash
# ws 패키지 설치 (Part 2에서 사용하지만 types.ts에서 import 필요)
cd packages/server && pnpm add ws && pnpm add -D @types/ws
```

---

## 3. 기존 파일 수정

### 3.1 `packages/types/src/gateway.ts` — RpcMethod union 확장

`RpcMethod` union에 `chat.*` 4개와 `system.*` 3개, `config.reload` 1개 추가:

```typescript
// 기존 목록에 아래 추가
export type RpcMethod =
  | 'agent.run'
  | 'agent.list'
  | 'agent.status'
  | 'session.get'
  | 'session.reset'
  | 'session.list'
  | 'config.get'
  | 'config.update'
  | 'config.reload' // 신규
  | 'channel.list'
  | 'channel.status'
  | 'health.check'
  | 'skill.execute'
  | 'finance.quote'
  | 'finance.news'
  | 'finance.alert.create'
  | 'finance.alert.list'
  | 'finance.portfolio.get'
  | 'chat.start' // 신규
  | 'chat.send' // 신규
  | 'chat.stop' // 신규
  | 'chat.history' // 신규
  | 'system.health' // 신규
  | 'system.info' // 신규
  | 'system.ping'; // 신규
```

검증: `pnpm typecheck` 통과

### 3.2 `packages/infra/src/events.ts` — gateway 이벤트 8개 추가

`FinClawEventMap` 인터페이스에 다음 이벤트 추가:

```typescript
  // -- Phase 10: Gateway events --
  'gateway:start': (port: number) => void;
  'gateway:stop': () => void;
  'gateway:ws:connect': (connectionId: string, authLevel: string) => void;
  'gateway:ws:disconnect': (connectionId: string, code: number) => void;
  'gateway:rpc:request': (method: string, connectionId: string) => void;
  'gateway:rpc:error': (method: string, errorCode: number) => void;
  'gateway:auth:failure': (ip: string, reason: string) => void;
  'gateway:auth:rate_limit': (ip: string, failures: number) => void;
```

위치: `'execution:context_threshold'` 이벤트 뒤, 인터페이스 닫는 `}` 앞.

검증: `pnpm typecheck` 통과

---

## 4. 신규 소스 파일

### 4.1 `packages/server/src/gateway/rpc/types.ts`

게이트웨이 전용 타입 + `@finclaw/types` re-export.

```typescript
// packages/server/src/gateway/rpc/types.ts
import type { z } from 'zod/v4';
import type { RpcRequest, RpcResponse } from '@finclaw/types';

// === @finclaw/types re-export ===
export type {
  RpcRequest,
  RpcResponse,
  RpcError,
  RpcMethod,
  WsEvent,
  GatewayStatus,
} from '@finclaw/types';
export { RPC_ERROR_CODES } from '@finclaw/types';

// === 인증 타입 ===

/** 인증 레벨 (4-layer) */
export type AuthLevel =
  | 'none' // 공개 (health, info, ping)
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

// === JSON-RPC 프로토콜 확장 ===

/** JSON-RPC 알림 (서버 → 클라이언트, id 없음) */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 배치 요청 */
export type JsonRpcBatchRequest = readonly RpcRequest[];

/** RPC 메서드 핸들러 */
export interface RpcMethodHandler<TParams = unknown, TResult = unknown> {
  readonly method: string;
  readonly description: string;
  readonly authLevel: AuthLevel;
  readonly schema: z.ZodType<TParams>;
  execute(params: TParams, ctx: RpcContext): Promise<TResult>;
}

/** RPC 실행 컨텍스트 */
export interface RpcContext {
  readonly requestId: string | number;
  readonly auth: AuthInfo;
  readonly connectionId?: string;
  readonly remoteAddress: string;
}

// === WebSocket 연결 ===

/** WebSocket 연결 정보 */
export interface WsConnection {
  readonly id: string;
  readonly ws: import('ws').WebSocket;
  readonly auth: AuthInfo;
  readonly connectedAt: number;
  lastPongAt: number;
  readonly subscriptions: Set<string>;
}

/** WebSocket 아웃바운드 메시지 */
export type WsOutboundMessage = RpcResponse | JsonRpcNotification;

// === 서버 설정 ===

/** 게이트웨이 서버 상세 설정 */
export interface GatewayServerConfig {
  readonly host: string;
  readonly port: number;
  readonly tls?: {
    readonly cert: string;
    readonly key: string;
  };
  readonly cors?: {
    readonly origins: readonly string[];
    readonly maxAge?: number;
  };
  readonly auth: {
    readonly apiKeys: readonly string[];
    readonly jwtSecret: string;
    readonly sessionTtlMs: number;
  };
  readonly ws: {
    readonly heartbeatIntervalMs: number;
    readonly heartbeatTimeoutMs: number;
    readonly maxPayloadBytes: number;
    readonly handshakeTimeoutMs: number;
    readonly maxConnections: number;
  };
  readonly rpc: {
    readonly maxBatchSize: number;
    readonly timeoutMs: number;
  };
}

// === Chat Registry 타입 ===

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

### 4.2 `packages/server/src/gateway/rpc/errors.ts`

RPC 에러 코드 확장 + `createError` 헬퍼.

```typescript
// packages/server/src/gateway/rpc/errors.ts
import { RPC_ERROR_CODES } from '@finclaw/types';
import type { RpcResponse } from '@finclaw/types';

/**
 * 게이트웨이 에러 코드
 *
 * @finclaw/types 기준 (불변):
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
 * 게이트웨이 전용 확장 (범위: -32005 ~ -32099):
 */
export const RpcErrors = {
  ...RPC_ERROR_CODES,
  AGENT_NOT_FOUND: -32005,
  EXECUTION_ERROR: -32006,
  CONTEXT_OVERFLOW: -32007,
} as const;

export type RpcErrorCode = (typeof RpcErrors)[keyof typeof RpcErrors];

/** JSON-RPC 에러 응답 생성 */
export function createError(
  id: string | number | null,
  code: RpcErrorCode,
  message: string,
  data?: unknown,
): RpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? (null as unknown as string),
    error: { code, message, ...(data !== undefined && { data }) },
  };
}
```

### 4.3 `packages/server/src/gateway/context.ts`

DI 컨테이너 인터페이스.

```typescript
// packages/server/src/gateway/context.ts
import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';
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

### 4.4 `packages/server/src/gateway/registry.ts` (스텁)

Part 3에서 완성. Part 1에서는 타입 체크와 import가 통과하도록 최소 구현.

```typescript
// packages/server/src/gateway/registry.ts
import type { ActiveSession, RegistryEvent } from './rpc/types.js';

/**
 * Chat 실행 레지스트리 (스텁)
 * Part 3에서 TTL, AbortSignal, 중복 방지, cleanup 포함하여 완성.
 */
export class ChatRegistry {
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(private readonly sessionTtlMs: number) {}

  startSession(_params: { agentId: string; connectionId: string; model?: string }): ActiveSession {
    throw new Error('Not implemented — see Part 3');
  }

  stopSession(_sessionId: string): { stopped: boolean } {
    throw new Error('Not implemented — see Part 3');
  }

  getSession(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
  }

  activeCount(): number {
    return this.sessions.size;
  }

  dispose(): void {
    this.abortAll();
  }

  on(_listener: (event: RegistryEvent) => void): () => void {
    return () => {};
  }
}
```

### 4.5 `packages/server/src/gateway/broadcaster.ts` (스텁)

Part 3에서 완성. Part 1에서는 타입 체크와 import가 통과하도록 최소 구현.

```typescript
// packages/server/src/gateway/broadcaster.ts
import type { WsConnection, JsonRpcNotification } from './rpc/types.js';

/**
 * GatewayBroadcaster (스텁)
 * Part 3에서 150ms delta 배치, slow consumer 보호 포함하여 완성.
 */
export class GatewayBroadcaster {
  send(_conn: WsConnection, _sessionId: string, _event: unknown): void {
    // Part 3에서 StreamEvent 기반 구현
  }

  broadcastShutdown(connections: Map<string, WsConnection>): void {
    for (const conn of connections.values()) {
      if (conn.ws.readyState === conn.ws.OPEN) {
        const notification: JsonRpcNotification = {
          jsonrpc: '2.0',
          method: 'system.shutdown',
          params: { reason: 'Server shutting down' },
        };
        conn.ws.send(JSON.stringify(notification));
      }
    }
  }
}
```

### 4.6 `packages/server/src/gateway/cors.ts`

CORS 미들웨어.

```typescript
// packages/server/src/gateway/cors.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayServerConfig } from './rpc/types.js';

type CorsConfig = GatewayServerConfig['cors'];

/** CORS 헤더 설정 + OPTIONS preflight 처리 */
export function handleCors(req: IncomingMessage, res: ServerResponse, config: CorsConfig): void {
  const origin = req.headers.origin;

  if (!origin || !config?.origins.length) {
    return;
  }

  const allowed = config.origins.includes('*') || config.origins.includes(origin);
  if (!allowed) return;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (config.maxAge) {
    res.setHeader('Access-Control-Max-Age', String(config.maxAge));
  }

  // OPTIONS preflight → 204 No Content
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
  }
}
```

### 4.7 `packages/server/src/gateway/router.ts`

HTTP 라우터 (패턴 매칭 + readBody).

```typescript
// packages/server/src/gateway/router.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayServerContext } from './context.js';
import { handleCors } from './cors.js';
import { dispatchRpc } from './rpc/index.js';
import { createError, RpcErrors } from './rpc/errors.js';

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

/** HTTP 요청을 적절한 핸들러로 라우팅 */
export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    handleCors(req, res, ctx.config.cors);
    return;
  }

  // CORS 헤더
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
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

/** POST /rpc — JSON-RPC 엔드포인트 */
async function handleRpcRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    const errResp = createError(null, RpcErrors.PARSE_ERROR, 'Failed to read request body');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errResp));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const errResp = createError(null, RpcErrors.PARSE_ERROR, 'Invalid JSON');
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errResp));
    return;
  }

  const response = await dispatchRpc(
    parsed as Parameters<typeof dispatchRpc>[0],
    {
      auth: { level: 'none', permissions: [] },
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
    },
    ctx,
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/** GET /health — 헬스 체크 shortcut */
async function handleHealthRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      connections: ctx.connections.size,
      activeSessions: ctx.registry.activeCount(),
    }),
  );
}

/** GET /info — 서버 정보 */
async function handleInfoRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: GatewayServerContext,
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      name: 'finclaw-gateway',
      version: '0.1.0',
      capabilities: ['streaming', 'batch', 'subscriptions'],
    }),
  );
}

/** 요청 body 읽기 (스트리밍) */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
```

### 4.8 `packages/server/src/gateway/rpc/index.ts`

JSON-RPC 디스패처 (메서드 레지스트리, 배치, Zod 검증).

```typescript
// packages/server/src/gateway/rpc/index.ts
import type { RpcRequest, RpcResponse } from '@finclaw/types';
import type {
  JsonRpcBatchRequest,
  RpcMethodHandler,
  RpcContext,
  AuthInfo,
  AuthLevel,
} from './types.js';
import type { GatewayServerContext } from '../context.js';
import { RpcErrors, createError } from './errors.js';
import { getEventBus } from '@finclaw/infra';

const methods = new Map<string, RpcMethodHandler>();

/** 메서드 등록 */
export function registerMethod(handler: RpcMethodHandler): void {
  if (methods.has(handler.method)) {
    throw new Error(`RPC method already registered: ${handler.method}`);
  }
  methods.set(handler.method, handler);
}

/** 등록된 메서드 목록 (system.info 용) */
export function getRegisteredMethods(): string[] {
  return [...methods.keys()];
}

/** 테스트용: 모든 메서드 등록 해제 */
export function clearMethods(): void {
  methods.clear();
}

/** RPC 요청 디스패치 (단일 또는 배치) */
export async function dispatchRpc(
  request: RpcRequest | JsonRpcBatchRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  serverCtx: GatewayServerContext,
): Promise<RpcResponse | RpcResponse[]> {
  // 배치 요청
  if (Array.isArray(request)) {
    if (request.length === 0) {
      return createError(null, RpcErrors.INVALID_REQUEST, 'Empty batch');
    }
    if (request.length > serverCtx.config.rpc.maxBatchSize) {
      return createError(
        null,
        RpcErrors.INVALID_REQUEST,
        `Batch size ${request.length} exceeds limit ${serverCtx.config.rpc.maxBatchSize}`,
      );
    }
    return Promise.all(request.map((req) => handleSingleRequest(req, ctx, serverCtx)));
  }

  return handleSingleRequest(request, ctx, serverCtx);
}

/** 단일 RPC 요청 처리 */
async function handleSingleRequest(
  request: RpcRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  serverCtx: GatewayServerContext,
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

  // 3. 이벤트 발행
  getEventBus().emit('gateway:rpc:request', request.method, ctx.connectionId ?? 'http');

  // 4. 인증 레벨 확인
  if (!hasRequiredAuth(ctx.auth, handler.authLevel)) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.UNAUTHORIZED);
    return createError(request.id, RpcErrors.UNAUTHORIZED, 'Insufficient permissions');
  }

  // 5. 파라미터 스키마 검증 (Zod v4)
  const parseResult = handler.schema.safeParse(request.params ?? {});
  if (!parseResult.success) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.INVALID_PARAMS);
    return createError(
      request.id,
      RpcErrors.INVALID_PARAMS,
      `Invalid params: ${parseResult.error!.message}`,
    );
  }

  // 6. 핸들러 실행
  try {
    const rpcCtx: RpcContext = { ...ctx, requestId: request.id };
    const result = await handler.execute(parseResult.data, rpcCtx);
    return { jsonrpc: '2.0', id: request.id, result };
  } catch (error) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.INTERNAL_ERROR);
    return createError(request.id, RpcErrors.INTERNAL_ERROR, (error as Error).message);
  }
}

/** 필요한 인증 레벨 충족 여부 */
export function hasRequiredAuth(auth: AuthInfo, required: AuthLevel): boolean {
  const levels: AuthLevel[] = ['none', 'api_key', 'token', 'session'];
  return levels.indexOf(auth.level) >= levels.indexOf(required);
}
```

### 4.9 `packages/server/src/gateway/rpc/methods/system.ts`

`system.health`, `system.info`, `system.ping` 메서드.

```typescript
// packages/server/src/gateway/rpc/methods/system.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler, RpcContext } from '../types.js';
import { registerMethod, getRegisteredMethods } from '../index.js';

// -- system.health --

const healthHandler: RpcMethodHandler<
  Record<string, never>,
  {
    status: 'ok' | 'degraded' | 'error';
    uptime: number;
    memoryMB: number;
  }
> = {
  method: 'system.health',
  description: '서버 상태를 확인합니다',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  },
};

// -- system.info --

const infoHandler: RpcMethodHandler<
  Record<string, never>,
  {
    name: string;
    version: string;
    methods: string[];
    capabilities: string[];
  }
> = {
  method: 'system.info',
  description: '서버 버전 및 기능 정보를 반환합니다',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return {
      name: 'finclaw-gateway',
      version: '0.1.0',
      methods: getRegisteredMethods(),
      capabilities: ['streaming', 'batch', 'subscriptions'],
    };
  },
};

// -- system.ping --

const pingHandler: RpcMethodHandler<Record<string, never>, { pong: true; timestamp: number }> = {
  method: 'system.ping',
  description: 'Ping-pong 연결 확인',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return { pong: true, timestamp: Date.now() };
  },
};

/** system.* 메서드 일괄 등록 */
export function registerSystemMethods(): void {
  registerMethod(healthHandler);
  registerMethod(infoHandler);
  registerMethod(pingHandler);
}
```

### 4.10 `packages/server/src/gateway/rpc/methods/config.ts`

`config.get`, `config.set`, `config.reload` 메서드.

```typescript
// packages/server/src/gateway/rpc/methods/config.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- config.get --

const getHandler: RpcMethodHandler<{ keys?: string[] }, Record<string, unknown>> = {
  method: 'config.get',
  description: '현재 설정을 조회합니다',
  authLevel: 'token',
  schema: z.object({
    keys: z.array(z.string()).optional(),
  }),
  async execute(params) {
    // TODO(Phase 10): @finclaw/config loadConfig() 연동
    // 민감 정보 (apiKeys, jwtSecret) 마스킹 필요
    return { keys: params.keys ?? [], message: 'config.get stub' };
  },
};

// -- config.set --

const setHandler: RpcMethodHandler<{ key: string; value: unknown }, { updated: boolean }> = {
  method: 'config.update',
  description: '설정 값을 변경합니다',
  authLevel: 'token',
  schema: z.object({
    key: z.string(),
    value: z.unknown(),
  }),
  async execute(params) {
    // TODO(Phase 10): @finclaw/config setOverride() 연동
    return { updated: true };
  },
};

// -- config.reload --

const reloadHandler: RpcMethodHandler<Record<string, never>, { reloaded: boolean }> = {
  method: 'config.reload',
  description: '설정 파일을 다시 읽어옵니다',
  authLevel: 'token',
  schema: z.object({}),
  async execute() {
    // TODO(Phase 10): @finclaw/config clearConfigCache() + loadConfig() 연동
    return { reloaded: true };
  },
};

/** config.* 메서드 일괄 등록 */
export function registerConfigMethods(): void {
  registerMethod(getHandler);
  registerMethod(setHandler);
  registerMethod(reloadHandler);
}
```

---

## 5. 테스트 파일

### 5.1 `packages/server/src/gateway/rpc/errors.test.ts`

```typescript
// packages/server/src/gateway/rpc/errors.test.ts
import { describe, it, expect } from 'vitest';
import { RpcErrors, createError, type RpcErrorCode } from './errors.js';
import { RPC_ERROR_CODES } from '@finclaw/types';

describe('RpcErrors', () => {
  it('includes all standard RPC_ERROR_CODES', () => {
    for (const [key, value] of Object.entries(RPC_ERROR_CODES)) {
      expect(RpcErrors).toHaveProperty(key, value);
    }
  });

  it('defines gateway-specific codes in -32005 ~ -32099 range', () => {
    const gatewayOnly = [
      RpcErrors.AGENT_NOT_FOUND,
      RpcErrors.EXECUTION_ERROR,
      RpcErrors.CONTEXT_OVERFLOW,
    ];
    for (const code of gatewayOnly) {
      expect(code).toBeLessThanOrEqual(-32005);
      expect(code).toBeGreaterThanOrEqual(-32099);
    }
  });

  it('has no duplicate codes', () => {
    const codes = Object.values(RpcErrors);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('createError', () => {
  it('creates JSON-RPC 2.0 error response with id', () => {
    const result = createError(1, RpcErrors.PARSE_ERROR, 'bad json');
    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32700, message: 'bad json' },
    });
  });

  it('creates error response with string id', () => {
    const result = createError('abc', RpcErrors.METHOD_NOT_FOUND, 'nope');
    expect(result.id).toBe('abc');
    expect(result.error?.code).toBe(-32601);
  });

  it('uses null id when id is null', () => {
    const result = createError(null, RpcErrors.INTERNAL_ERROR, 'fail');
    expect(result.id).toBeNull();
  });

  it('includes optional data field', () => {
    const result = createError(1, RpcErrors.INVALID_PARAMS, 'bad', { field: 'x' });
    expect(result.error?.data).toEqual({ field: 'x' });
  });

  it('omits data field when undefined', () => {
    const result = createError(1, RpcErrors.INTERNAL_ERROR, 'fail');
    expect(result.error).not.toHaveProperty('data');
  });
});
```

### 5.2 `packages/server/src/gateway/rpc/index.test.ts`

```typescript
// packages/server/src/gateway/rpc/index.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod/v4';
import {
  registerMethod,
  dispatchRpc,
  clearMethods,
  hasRequiredAuth,
  getRegisteredMethods,
} from './index.js';
import type { RpcMethodHandler, AuthInfo, GatewayServerConfig } from './types.js';
import type { GatewayServerContext } from '../context.js';
import { RpcErrors } from './errors.js';
import { resetEventBus } from '@finclaw/infra';

/** 테스트용 최소 GatewayServerContext */
function makeServerCtx(overrides?: Partial<GatewayServerConfig>): GatewayServerContext {
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
    ...overrides,
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

function makeAuth(level: AuthInfo['level'] = 'none'): AuthInfo {
  return { level, permissions: [] };
}

describe('RPC Dispatcher', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
  });

  describe('registerMethod', () => {
    it('registers a method successfully', () => {
      const handler: RpcMethodHandler = {
        method: 'test.echo',
        description: 'echo',
        authLevel: 'none',
        schema: z.object({ msg: z.string() }),
        async execute(params) {
          return params;
        },
      };
      registerMethod(handler);
      expect(getRegisteredMethods()).toContain('test.echo');
    });

    it('throws on duplicate method registration', () => {
      const handler: RpcMethodHandler = {
        method: 'test.dup',
        description: 'dup',
        authLevel: 'none',
        schema: z.object({}),
        async execute() {
          return {};
        },
      };
      registerMethod(handler);
      expect(() => registerMethod(handler)).toThrow('already registered');
    });
  });

  describe('dispatchRpc — single request', () => {
    it('dispatches to registered handler and returns result', async () => {
      registerMethod({
        method: 'test.add',
        description: 'add',
        authLevel: 'none',
        schema: z.object({ a: z.number(), b: z.number() }),
        async execute(params: { a: number; b: number }) {
          return { sum: params.a + params.b };
        },
      });

      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'test.add', params: { a: 2, b: 3 } },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );

      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { sum: 5 },
      });
    });

    it('returns INVALID_REQUEST for wrong jsonrpc version', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '1.0' as '2.0', id: 1, method: 'x' },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_REQUEST);
    });

    it('returns METHOD_NOT_FOUND for unknown method', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'no.such' },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.METHOD_NOT_FOUND);
    });

    it('returns UNAUTHORIZED when auth level insufficient', async () => {
      registerMethod({
        method: 'test.secret',
        description: 'secret',
        authLevel: 'token',
        schema: z.object({}),
        async execute() {
          return {};
        },
      });

      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'test.secret' },
        { auth: makeAuth('none'), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);
    });

    it('returns INVALID_PARAMS for schema validation failure', async () => {
      registerMethod({
        method: 'test.typed',
        description: 'typed',
        authLevel: 'none',
        schema: z.object({ name: z.string() }),
        async execute(params) {
          return params;
        },
      });

      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'test.typed', params: { name: 123 } },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
    });

    it('returns INTERNAL_ERROR when handler throws', async () => {
      registerMethod({
        method: 'test.fail',
        description: 'fail',
        authLevel: 'none',
        schema: z.object({}),
        async execute() {
          throw new Error('boom');
        },
      });

      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'test.fail' },
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number; message: string } }).error.code).toBe(
        RpcErrors.INTERNAL_ERROR,
      );
      expect((result as { error: { message: string } }).error.message).toBe('boom');
    });
  });

  describe('dispatchRpc — batch', () => {
    it('processes batch requests in parallel', async () => {
      registerMethod({
        method: 'test.id',
        description: 'identity',
        authLevel: 'none',
        schema: z.object({ v: z.number() }),
        async execute(params: { v: number }) {
          return { v: params.v };
        },
      });

      const result = await dispatchRpc(
        [
          { jsonrpc: '2.0', id: 1, method: 'test.id', params: { v: 1 } },
          { jsonrpc: '2.0', id: 2, method: 'test.id', params: { v: 2 } },
        ],
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('rejects empty batch', async () => {
      const result = await dispatchRpc(
        [],
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        makeServerCtx(),
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_REQUEST);
    });

    it('rejects batch exceeding maxBatchSize', async () => {
      const ctx = makeServerCtx({ rpc: { maxBatchSize: 2, timeoutMs: 60_000 } });
      const batch = Array.from({ length: 3 }, (_, i) => ({
        jsonrpc: '2.0' as const,
        id: i,
        method: 'test.x',
      }));

      const result = await dispatchRpc(
        batch,
        { auth: makeAuth(), remoteAddress: '127.0.0.1' },
        ctx,
      );
      expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_REQUEST);
    });
  });

  describe('hasRequiredAuth', () => {
    it('none >= none', () => {
      expect(hasRequiredAuth(makeAuth('none'), 'none')).toBe(true);
    });

    it('token >= api_key', () => {
      expect(hasRequiredAuth(makeAuth('token'), 'api_key')).toBe(true);
    });

    it('api_key < token', () => {
      expect(hasRequiredAuth(makeAuth('api_key'), 'token')).toBe(false);
    });

    it('session >= session', () => {
      expect(hasRequiredAuth(makeAuth('session'), 'session')).toBe(true);
    });
  });
});
```

### 5.3 `packages/server/src/gateway/router.test.ts`

```typescript
// packages/server/src/gateway/router.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { GatewayServerContext } from './context.js';
import type { GatewayServerConfig } from './rpc/types.js';
import { handleHttpRequest } from './router.js';
import { clearMethods, registerMethod } from './rpc/index.js';
import { z } from 'zod/v4';
import { resetEventBus } from '@finclaw/infra';

/** 최소 ctx 팩토리 */
function makeCtx(overrides?: Partial<GatewayServerConfig>): GatewayServerContext {
  const config: GatewayServerConfig = {
    host: '0.0.0.0',
    port: 0,
    cors: { origins: ['http://localhost:3000'], maxAge: 600 },
    auth: { apiKeys: [], jwtSecret: 'test', sessionTtlMs: 60_000 },
    ws: {
      heartbeatIntervalMs: 30_000,
      heartbeatTimeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      handshakeTimeoutMs: 10_000,
      maxConnections: 100,
    },
    rpc: { maxBatchSize: 10, timeoutMs: 60_000 },
    ...overrides,
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

/** http.IncomingMessage/ServerResponse mock */
function mockReqRes(method: string, url: string, body?: string, headers?: Record<string, string>) {
  const req = {
    method,
    url,
    headers: { ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'data' && body) {
        cb(Buffer.from(body));
      }
      if (event === 'end') {
        cb();
      }
      return req;
    }),
  } as unknown as IncomingMessage;

  let statusCode = 0;
  let responseBody = '';
  const responseHeaders: Record<string, string> = {};

  const res = {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(responseHeaders, hdrs);
      return res;
    }),
    setHeader: vi.fn((key: string, value: string) => {
      responseHeaders[key] = value;
    }),
    end: vi.fn((data?: string) => {
      if (data) responseBody = data;
    }),
    getHeader: vi.fn((key: string) => responseHeaders[key]),
    get statusCode() {
      return statusCode;
    },
    get body() {
      return responseBody;
    },
    get sentHeaders() {
      return responseHeaders;
    },
  } as unknown as ServerResponse & {
    body: string;
    statusCode: number;
    sentHeaders: Record<string, string>;
  };

  return { req, res };
}

describe('HTTP Router', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
  });

  it('returns 404 for unknown routes', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('GET', '/unknown');
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it('GET /health returns status ok', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('GET', '/health');
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.status).toBe('ok');
  });

  it('GET /info returns server info', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('GET', '/info');
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.name).toBe('finclaw-gateway');
  });

  it('POST /rpc dispatches to RPC handler', async () => {
    registerMethod({
      method: 'test.ping',
      description: 'ping',
      authLevel: 'none',
      schema: z.object({}),
      async execute() {
        return { pong: true };
      },
    });

    const ctx = makeCtx();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test.ping', params: {} });
    const { req, res } = mockReqRes('POST', '/rpc', body, {
      'content-type': 'application/json',
    });
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const result = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(result.result).toEqual({ pong: true });
  });

  it('POST /rpc returns parse error for invalid JSON', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('POST', '/rpc', '{bad json}');
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    const result = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(result.error.code).toBe(-32700);
  });

  it('OPTIONS returns CORS preflight with 204', async () => {
    const ctx = makeCtx();
    const { req, res } = mockReqRes('OPTIONS', '/rpc', undefined, {
      origin: 'http://localhost:3000',
    });
    await handleHttpRequest(req, res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(204);
  });
});
```

### 5.4 `packages/server/src/gateway/rpc/methods/system.test.ts`

```typescript
// packages/server/src/gateway/rpc/methods/system.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { registerMethod, dispatchRpc, clearMethods } from '../index.js';
import { registerSystemMethods } from './system.js';
import type { GatewayServerContext } from '../../context.js';
import type { GatewayServerConfig } from '../types.js';
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

const baseCtx = {
  auth: { level: 'none' as const, permissions: [] as const },
  remoteAddress: '127.0.0.1',
};

describe('system.* RPC methods', () => {
  beforeEach(() => {
    clearMethods();
    resetEventBus();
    registerSystemMethods();
  });

  describe('system.health', () => {
    it('returns ok status with uptime and memory', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 1, method: 'system.health', params: {} },
        baseCtx,
        makeServerCtx(),
      );
      const r = result as { result: { status: string; uptime: number; memoryMB: number } };
      expect(r.result.status).toBe('ok');
      expect(r.result.uptime).toBeGreaterThan(0);
      expect(r.result.memoryMB).toBeGreaterThan(0);
    });
  });

  describe('system.info', () => {
    it('returns server name and registered methods', async () => {
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 2, method: 'system.info', params: {} },
        baseCtx,
        makeServerCtx(),
      );
      const r = result as { result: { name: string; methods: string[]; capabilities: string[] } };
      expect(r.result.name).toBe('finclaw-gateway');
      expect(r.result.methods).toContain('system.health');
      expect(r.result.methods).toContain('system.info');
      expect(r.result.methods).toContain('system.ping');
      expect(r.result.capabilities).toContain('streaming');
    });
  });

  describe('system.ping', () => {
    it('returns pong with timestamp', async () => {
      const before = Date.now();
      const result = await dispatchRpc(
        { jsonrpc: '2.0', id: 3, method: 'system.ping', params: {} },
        baseCtx,
        makeServerCtx(),
      );
      const after = Date.now();
      const r = result as { result: { pong: boolean; timestamp: number } };
      expect(r.result.pong).toBe(true);
      expect(r.result.timestamp).toBeGreaterThanOrEqual(before);
      expect(r.result.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
```

---

## 6. 검증 기준

```bash
# 1. 타입 체크 (기존 수정 포함 전체)
pnpm typecheck

# 2. 게이트웨이 유닛 테스트
pnpm test -- src/gateway/rpc/errors.test
pnpm test -- src/gateway/rpc/index.test
pnpm test -- src/gateway/router.test
pnpm test -- src/gateway/rpc/methods/system.test

# 3. 포맷팅
pnpm format:fix
```

성공 기준:

1. `pnpm typecheck` → 에러 0개
2. 4개 테스트 파일 모두 통과
3. `pnpm format:fix` 후 diff 없음

---

## 7. 파일 생성 순서 (의존성 순)

```
1. packages/types/src/gateway.ts          (기존 수정)
2. packages/infra/src/events.ts           (기존 수정)
3. src/gateway/rpc/types.ts               → 검증: typecheck
4. src/gateway/rpc/errors.ts              → 검증: typecheck + errors.test
5. src/gateway/context.ts
6. src/gateway/registry.ts (스텁)
7. src/gateway/broadcaster.ts (스텁)
8. src/gateway/cors.ts
9. src/gateway/rpc/index.ts               → 검증: typecheck + index.test
10. src/gateway/router.ts                 → 검증: typecheck + router.test
11. src/gateway/rpc/methods/system.ts     → 검증: typecheck + system.test
12. src/gateway/rpc/methods/config.ts     → 검증: typecheck
```
