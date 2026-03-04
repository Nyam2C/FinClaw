# Phase 11 — 상세 구현 TODO

> plan.md 기반 10단계 구현 가이드. 각 단계별 **대상 파일 · 변경 내용 · 코드 · 검증** 포함.

---

## Step 1: GatewayServerConfig 확장 (`rpc/types.ts`)

**파일:** `packages/server/src/gateway/rpc/types.ts`
**목표:** Phase 11 기능에 필요한 설정 필드를 `GatewayServerConfig`에 추가
**검증:** `tsc --build` 통과

### 변경 내용

`GatewayServerConfig` 인터페이스 끝에 3개 선택적 필드 추가:

```typescript
// rpc/types.ts — GatewayServerConfig 인터페이스 (기존 ~65행)
export interface GatewayServerConfig {
  // ... 기존 host, port, tls, cors, auth, ws, rpc 유지 ...

  // ── Phase 11 추가 ──
  readonly openaiCompat?: {
    readonly enabled: boolean; // feature flag (기본 false)
    readonly sseKeepaliveMs: number; // SSE keepalive 간격 (기본 15_000)
  };
  readonly hotReload?: {
    readonly configPath: string;
    readonly debounceMs: number; // 기본 300ms
    readonly validateBeforeApply: boolean; // 기본 true
    readonly mode: 'watch' | 'poll'; // 기본 'watch'
  };
  readonly rateLimit?: {
    readonly windowMs: number; // 기본 60_000
    readonly maxRequests: number; // 기본 60
    readonly maxKeys: number; // 기본 10_000
  };
}
```

### 추가 타입 (같은 파일 하단)

```typescript
// ── Phase 11 타입 ──

/** 설정 변경 이벤트 */
export interface ConfigChangeEvent {
  readonly path: string;
  readonly changeType: 'modified' | 'added' | 'removed';
  readonly timestamp: number;
  readonly previousHash: string;
  readonly currentHash: string;
}

/** 브로드캐스트 채널 */
export type BroadcastChannel = 'config.updated' | 'session.event' | 'system.status' | 'market.tick';

/** Rate limit 상태 */
export interface RateLimitInfo {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: number;
  readonly retryAfterMs?: number;
}

/** 컴포넌트 헬스 */
export interface ComponentHealth {
  readonly name: string;
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly latencyMs?: number;
  readonly message?: string;
  readonly lastCheckedAt: number;
}

/** 시스템 헬스 (readiness 응답) */
export interface SystemHealth {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly uptime: number;
  readonly version: string;
  readonly components: readonly ComponentHealth[];
  readonly memory: {
    readonly heapUsedMB: number;
    readonly heapTotalMB: number;
    readonly rssMB: number;
  };
  readonly activeSessions: number;
  readonly connections: number;
  readonly timestamp: number;
}

/** Liveness 응답 */
export interface LivenessResponse {
  readonly status: 'ok';
  readonly uptime: number;
}

/** 액세스 로그 엔트리 */
export interface AccessLogEntry {
  readonly requestId: string;
  readonly timestamp: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationMs: number;
  readonly remoteAddress: string;
  readonly userAgent: string;
  readonly contentLength: number;
  readonly rpcMethod?: string;
  readonly authLevel?: string;
}

/** OpenAI 호환 타입 */
export interface OpenAIChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
  readonly tools?: readonly OpenAITool[];
}

export interface OpenAIMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly OpenAIToolCall[];
  readonly tool_call_id?: string;
}

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAITool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
}

export interface OpenAIChatResponse {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: OpenAIMessage;
    readonly finish_reason: string;
  }[];
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

export interface OpenAIStreamChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: Partial<OpenAIMessage>;
    readonly finish_reason: string | null;
  }[];
}

export interface OpenAIErrorResponse {
  readonly error: {
    readonly message: string;
    readonly type:
      | 'invalid_request_error'
      | 'authentication_error'
      | 'rate_limit_error'
      | 'server_error';
    readonly code: string | null;
    readonly param: string | null;
  };
}
```

---

## Step 2: isDraining 플래그 (`context.ts`)

**파일:** `packages/server/src/gateway/context.ts`
**목표:** `GatewayServerContext`에 `isDraining` mutable 프로퍼티 추가
**검증:** `tsc --build` 통과

### 변경 내용

```typescript
// context.ts — 기존 인터페이스에 1줄 추가
export interface GatewayServerContext {
  readonly config: GatewayServerConfig;
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  readonly connections: Map<string, WsConnection>;
  readonly registry: ChatRegistry;
  readonly broadcaster: GatewayBroadcaster;
  isDraining: boolean; // ← 추가 (mutable — stop()에서 true로 설정)
}
```

---

## Step 3: stop()에 isDraining 설정 (`server.ts`)

**파일:** `packages/server/src/gateway/server.ts`
**목표:** `stop()` 메서드 첫 줄에서 `ctx.isDraining = true` 설정, DI 컨테이너 초기화에 `isDraining: false` 추가
**검증:** 기존 `server.test.ts` 통과

### 변경 내용

```typescript
// server.ts — ctx 생성 부분 (기존 ~59행)
const ctx: GatewayServerContext = {
  config,
  httpServer,
  wss,
  connections: new Map(),
  registry: new ChatRegistry(config.auth.sessionTtlMs),
  broadcaster: new GatewayBroadcaster(),
  isDraining: false, // ← 추가
};

// server.ts — stop() 메서드 (기존 ~98행)
async stop(): Promise<void> {
  ctx.isDraining = true; // ← 추가 (첫 줄)

  // 1. 활성 세션 abort
  ctx.registry.abortAll();
  // ... 나머지 기존 로직 유지 ...
},
```

---

## Step 4: Drain 503 체크 + 신규 라우트 (`router.ts`)

**파일:** `packages/server/src/gateway/router.ts`
**목표:**

1. `handleHttpRequest()`에서 라우트 매칭 전 `isDraining` 503 체크
2. `/healthz`, `/readyz` 라우트 추가
3. OpenAI compat 라우트 조건부 추가

**검증:** `router.test.ts` 확장 — isDraining=true 시 503

### 변경 내용

```typescript
// router.ts — import 추가
import { checkLiveness, checkReadiness } from './health.js';
// handleChatCompletions는 Step 10에서 추가

// router.ts — routes 배열 확장
const routes: Route[] = [
  { method: 'POST', path: '/rpc', handler: handleRpcRequest },
  { method: 'GET', path: '/health', handler: handleHealthRequest },
  { method: 'GET', path: '/info', handler: handleInfoRequest },
  { method: 'GET', path: '/healthz', handler: handleLivenessRequest }, // ← 추가
  { method: 'GET', path: '/readyz', handler: handleReadinessRequest }, // ← 추가
];

// router.ts — handleHttpRequest() 수정: CORS 처리 후, 라우트 매칭 전에 drain 체크
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

  // ── Phase 11: Drain 거부 (liveness는 제외) ──
  if (ctx.isDraining && req.url !== '/healthz') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service shutting down' }));
    return;
  }

  // 라우트 매칭
  const route = routes.find((r) => r.method === req.method && req.url?.startsWith(r.path));
  // ... 나머지 기존 로직 ...
}

// ── 신규 핸들러 ──

/** GET /healthz — liveness (프로세스 생존 확인, 항상 200) */
async function handleLivenessRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: GatewayServerContext,
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(checkLiveness()));
}

/** GET /readyz — readiness (전체 시스템 상태, 200 or 503) */
async function handleReadinessRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  const health = await checkReadiness(ctx.registry.activeCount(), ctx.connections.size);
  const status = health.status === 'ok' ? 200 : 503;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(health));
}
```

### 테스트 추가 (`router.test.ts` 확장)

```typescript
// router.test.ts — 기존 describe 안에 추가

describe('Drain 거부', () => {
  it('isDraining=true 시 503 응답', async () => {
    ctx.isDraining = true;
    const { req, res } = createMockHttpPair('POST', '/rpc');
    await handleHttpRequest(req, res, ctx);

    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    const body = JSON.parse(getResponseBody(res));
    expect(body.error).toBe('Service shutting down');
  });

  it('isDraining=true 여도 /healthz는 200 응답', async () => {
    ctx.isDraining = true;
    const { req, res } = createMockHttpPair('GET', '/healthz');
    await handleHttpRequest(req, res, ctx);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it('isDraining=false 시 정상 라우팅', async () => {
    ctx.isDraining = false;
    const { req, res } = createMockHttpPair('GET', '/health');
    await handleHttpRequest(req, res, ctx);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });
});

describe('GET /healthz', () => {
  it('liveness — status ok + uptime', async () => {
    const { req, res } = createMockHttpPair('GET', '/healthz');
    await handleHttpRequest(req, res, ctx);

    const body = JSON.parse(getResponseBody(res));
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });
});

describe('GET /readyz', () => {
  it('readiness — 200 when healthy', async () => {
    const { req, res } = createMockHttpPair('GET', '/readyz');
    await handleHttpRequest(req, res, ctx);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = JSON.parse(getResponseBody(res));
    expect(body.status).toBe('ok');
    expect(body.memory).toBeDefined();
    expect(body.components).toBeInstanceOf(Array);
  });
});
```

---

## Step 5: Rate Limiting (`rate-limit.ts` 신규)

**파일:** `packages/server/src/gateway/rate-limit.ts` (신규)
**목표:** 슬라이딩 윈도우 `RequestRateLimiter` + `toRateLimitHeaders()` 구현
**검증:** `rate-limit.test.ts` 통과

### 전체 코드

```typescript
// packages/server/src/gateway/rate-limit.ts
import type { RateLimitInfo } from './rpc/types.js';

interface WindowEntry {
  timestamps: number[];
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * 요청 수준 슬라이딩 윈도우 rate limiter.
 * MAX_KEYS 초과 시 가장 오래된 키를 evict하여 메모리 누수를 방지한다.
 */
export class RequestRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly cleanupInterval: ReturnType<typeof setInterval>;
  private readonly maxKeys: number;
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(config: { windowMs: number; maxRequests: number; maxKeys?: number }) {
    this.windowMs = config.windowMs;
    this.maxRequests = config.maxRequests;
    this.maxKeys = config.maxKeys ?? DEFAULT_MAX_KEYS;
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60_000);
  }

  check(key: string): { allowed: boolean; info: RateLimitInfo } {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      if (this.windows.size >= this.maxKeys) {
        const oldestKey = this.windows.keys().next().value;
        if (oldestKey !== undefined) this.windows.delete(oldestKey);
      }
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // 윈도우 밖의 timestamp 제거
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const info: RateLimitInfo = {
      remaining: Math.max(0, this.maxRequests - entry.timestamps.length),
      limit: this.maxRequests,
      resetAt: now + this.windowMs,
    };

    if (entry.timestamps.length >= this.maxRequests) {
      const oldestInWindow = entry.timestamps[0]!;
      return {
        allowed: false,
        info: {
          ...info,
          remaining: 0,
          retryAfterMs: oldestInWindow + this.windowMs - now,
        },
      };
    }

    entry.timestamps.push(now);
    return { allowed: true, info };
  }

  /** 표준 rate-limit 응답 헤더 생성 */
  static toRateLimitHeaders(info: RateLimitInfo): Record<string, string> {
    const headers: Record<string, string> = {
      'X-RateLimit-Limit': String(info.limit),
      'X-RateLimit-Remaining': String(info.remaining),
      'X-RateLimit-Reset': String(Math.ceil(info.resetAt / 1000)),
    };
    if (info.retryAfterMs !== undefined) {
      headers['Retry-After'] = String(Math.ceil(info.retryAfterMs / 1000));
    }
    return headers;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > now - this.windowMs);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }

  get size(): number {
    return this.windows.size;
  }

  dispose(): void {
    clearInterval(this.cleanupInterval);
    this.windows.clear();
  }
}
```

### 테스트 (`rate-limit.test.ts` 신규)

```typescript
// packages/server/src/gateway/rate-limit.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RequestRateLimiter } from './rate-limit.js';

describe('RequestRateLimiter', () => {
  let limiter: RequestRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RequestRateLimiter({
      windowMs: 60_000,
      maxRequests: 3,
      maxKeys: 5,
    });
  });

  afterEach(() => {
    limiter.dispose();
    vi.useRealTimers();
  });

  it('윈도우 내 요청 허용', () => {
    const r1 = limiter.check('client-1');
    expect(r1.allowed).toBe(true);
    expect(r1.info.remaining).toBe(2);
    expect(r1.info.limit).toBe(3);
  });

  it('maxRequests 초과 시 거부', () => {
    limiter.check('client-1');
    limiter.check('client-1');
    limiter.check('client-1');

    const r4 = limiter.check('client-1');
    expect(r4.allowed).toBe(false);
    expect(r4.info.remaining).toBe(0);
    expect(r4.info.retryAfterMs).toBeGreaterThan(0);
  });

  it('윈도우 경과 후 다시 허용', () => {
    limiter.check('client-1');
    limiter.check('client-1');
    limiter.check('client-1');

    // 윈도우 경과
    vi.advanceTimersByTime(60_001);

    const result = limiter.check('client-1');
    expect(result.allowed).toBe(true);
    expect(result.info.remaining).toBe(2);
  });

  it('MAX_KEYS 초과 시 가장 오래된 키 evict', () => {
    limiter.check('a');
    limiter.check('b');
    limiter.check('c');
    limiter.check('d');
    limiter.check('e');

    expect(limiter.size).toBe(5);

    // 6번째 키 → 'a' evict
    limiter.check('f');
    expect(limiter.size).toBe(5);
  });

  it('cleanup()으로 만료 키 제거', () => {
    limiter.check('old-client');
    vi.advanceTimersByTime(5 * 60_000 + 1); // cleanup 트리거

    // cleanup interval이 실행되어 빈 entry 제거
    expect(limiter.size).toBe(0);
  });

  describe('toRateLimitHeaders', () => {
    it('표준 rate-limit 헤더 생성', () => {
      const headers = RequestRateLimiter.toRateLimitHeaders({
        remaining: 5,
        limit: 10,
        resetAt: 1700000000_000,
      });

      expect(headers['X-RateLimit-Limit']).toBe('10');
      expect(headers['X-RateLimit-Remaining']).toBe('5');
      expect(headers['X-RateLimit-Reset']).toBe('1700000000');
      expect(headers['Retry-After']).toBeUndefined();
    });

    it('retryAfterMs 존재 시 Retry-After 헤더 포함', () => {
      const headers = RequestRateLimiter.toRateLimitHeaders({
        remaining: 0,
        limit: 10,
        resetAt: 1700000000_000,
        retryAfterMs: 30_000,
      });

      expect(headers['Retry-After']).toBe('30');
    });
  });
});
```

---

## Step 6: 액세스 로그 (`access-log.ts` 신규)

**파일:** `packages/server/src/gateway/access-log.ts` (신규)
**목표:** `requestId` + `X-Request-Id` + `createAccessLogger()` + `sanitizePath()` 구현
**검증:** `access-log.test.ts` 통과

### 전체 코드

```typescript
// packages/server/src/gateway/access-log.ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccessLogEntry } from './rpc/types.js';

/** 민감 쿼리 파라미터 마스킹 */
const SENSITIVE_PARAMS = new Set(['token', 'key', 'secret', 'password', 'api_key']);

export function sanitizePath(url: string): string {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return url;

  const path = url.slice(0, qIdx);
  const search = new URLSearchParams(url.slice(qIdx + 1));

  for (const param of SENSITIVE_PARAMS) {
    if (search.has(param)) {
      search.set(param, '***');
    }
  }

  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

type LogWriter = (entry: AccessLogEntry) => void;

/** 기본 writer: stdout JSON */
const defaultWriter: LogWriter = (entry) => {
  process.stdout.write(JSON.stringify(entry) + '\n');
};

/** 로거 팩토리 */
export function createAccessLogger(writer: LogWriter = defaultWriter) {
  return function logAccess(
    req: IncomingMessage,
    res: ServerResponse,
    extra?: { rpcMethod?: string; authLevel?: string },
  ): string {
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    const startTime = Date.now();

    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      const entry: AccessLogEntry = {
        requestId,
        timestamp: new Date().toISOString(),
        method: req.method ?? 'UNKNOWN',
        path: sanitizePath(req.url ?? '/'),
        statusCode: res.statusCode,
        durationMs: Date.now() - startTime,
        remoteAddress: req.socket.remoteAddress ?? 'unknown',
        userAgent: (req.headers['user-agent'] as string) ?? '',
        contentLength: Number(res.getHeader('content-length') ?? 0),
        rpcMethod: extra?.rpcMethod,
        authLevel: extra?.authLevel,
      };

      writer(entry);
    });

    return requestId;
  };
}
```

### 테스트 (`access-log.test.ts` 신규)

```typescript
// packages/server/src/gateway/access-log.test.ts
import { describe, it, expect, vi } from 'vitest';
import { sanitizePath, createAccessLogger } from './access-log.js';
import { EventEmitter } from 'node:events';

describe('sanitizePath', () => {
  it('쿼리 없는 경로는 그대로 반환', () => {
    expect(sanitizePath('/health')).toBe('/health');
  });

  it('민감 파라미터 마스킹', () => {
    expect(sanitizePath('/api?token=abc123&name=test')).toBe('/api?token=%2A%2A%2A&name=test');
  });

  it('여러 민감 파라미터 동시 마스킹', () => {
    const result = sanitizePath('/api?key=k1&secret=s1&normal=ok');
    expect(result).toContain('key=%2A%2A%2A');
    expect(result).toContain('secret=%2A%2A%2A');
    expect(result).toContain('normal=ok');
  });

  it('민감 파라미터 없으면 그대로', () => {
    expect(sanitizePath('/api?page=1&sort=asc')).toBe('/api?page=1&sort=asc');
  });
});

describe('createAccessLogger', () => {
  function createMockReqRes(method: string, url: string, headers: Record<string, string> = {}) {
    const res = new EventEmitter() as any;
    res.statusCode = 200;
    res.setHeader = vi.fn();
    res.getHeader = vi.fn().mockReturnValue('0');

    const req = {
      method,
      url,
      headers,
      socket: { remoteAddress: '127.0.0.1' },
    } as any;

    return { req, res };
  }

  it('requestId를 반환하고 X-Request-Id 헤더를 설정', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('GET', '/health');

    const requestId = logger(req, res);

    expect(typeof requestId).toBe('string');
    expect(requestId.length).toBeGreaterThan(0);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', requestId);
  });

  it('클라이언트 제공 X-Request-Id 전달', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('POST', '/rpc', {
      'x-request-id': 'client-req-123',
    });

    const requestId = logger(req, res);
    expect(requestId).toBe('client-req-123');
  });

  it('res finish 이벤트 시 로그 writer 호출', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('GET', '/health');

    logger(req, res);

    // finish 이벤트 발생
    res.emit('finish');

    expect(writer).toHaveBeenCalledTimes(1);
    const entry = writer.mock.calls[0][0];
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/health');
    expect(entry.statusCode).toBe(200);
    expect(entry.remoteAddress).toBe('127.0.0.1');
    expect(typeof entry.durationMs).toBe('number');
  });

  it('extra 필드 포함', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('POST', '/rpc');

    logger(req, res, { rpcMethod: 'system.ping', authLevel: 'token' });
    res.emit('finish');

    const entry = writer.mock.calls[0][0];
    expect(entry.rpcMethod).toBe('system.ping');
    expect(entry.authLevel).toBe('token');
  });

  it('sanitizePath 적용 확인', () => {
    const writer = vi.fn();
    const logger = createAccessLogger(writer);
    const { req, res } = createMockReqRes('GET', '/api?token=secret123');

    logger(req, res);
    res.emit('finish');

    const entry = writer.mock.calls[0][0];
    expect(entry.path).not.toContain('secret123');
    expect(entry.path).toContain('***');
  });
});
```

---

## Step 7: 헬스 체크 (`health.ts` 신규)

**파일:** `packages/server/src/gateway/health.ts` (신규)
**목표:** `/healthz` liveness + `/readyz` readiness + Provider TTL 캐시
**검증:** `health.test.ts` 통과

### 전체 코드

```typescript
// packages/server/src/gateway/health.ts
import type { ComponentHealth, SystemHealth, LivenessResponse } from './rpc/types.js';

type HealthChecker = () => Promise<ComponentHealth>;

const checkers: HealthChecker[] = [];

export function registerHealthChecker(checker: HealthChecker): void {
  checkers.push(checker);
}

/** 테스트용: checkers 배열 초기화 */
export function resetHealthCheckers(): void {
  checkers.length = 0;
}

/** GET /healthz — liveness (프로세스 생존 여부만, 항상 200) */
export function checkLiveness(): LivenessResponse {
  return { status: 'ok', uptime: process.uptime() };
}

/** GET /readyz — readiness (전체 시스템 상태) */
export async function checkReadiness(
  activeSessions: number,
  connections: number,
): Promise<SystemHealth> {
  const components = await Promise.all(
    checkers.map(async (checker) => {
      try {
        return await checker();
      } catch (error) {
        return {
          name: 'unknown',
          status: 'unhealthy' as const,
          message: (error as Error).message,
          lastCheckedAt: Date.now(),
        };
      }
    }),
  );

  const hasUnhealthy = components.some((c) => c.status === 'unhealthy');
  const hasDegraded = components.some((c) => c.status === 'degraded');
  const status = hasUnhealthy ? 'error' : hasDegraded ? 'degraded' : 'ok';

  const mem = process.memoryUsage();

  return {
    status,
    uptime: process.uptime(),
    version: '0.1.0',
    components,
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    activeSessions,
    connections,
    timestamp: Date.now(),
  };
}

/** Provider 헬스 체커 팩토리 (TTL 60초 캐시) */
export function createProviderHealthChecker(
  providerName: string,
  checkFn: () => Promise<void>,
): HealthChecker {
  let cache: ComponentHealth | null = null;
  const TTL_MS = 60_000;

  return async () => {
    if (cache && Date.now() - cache.lastCheckedAt < TTL_MS) {
      return cache;
    }

    const start = Date.now();
    try {
      await checkFn();
      cache = {
        name: `provider:${providerName}`,
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    } catch (error) {
      cache = {
        name: `provider:${providerName}`,
        status: 'degraded',
        message: (error as Error).message,
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    }
    return cache;
  };
}

/** DB 헬스 체커 팩토리 */
export function createDbHealthChecker(checkFn: () => Promise<void>): HealthChecker {
  return async () => {
    const start = Date.now();
    try {
      await checkFn();
      return {
        name: 'database',
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    } catch (error) {
      return {
        name: 'database',
        status: 'unhealthy',
        message: (error as Error).message,
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    }
  };
}
```

### 테스트 (`health.test.ts` 신규)

```typescript
// packages/server/src/gateway/health.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkLiveness,
  checkReadiness,
  registerHealthChecker,
  resetHealthCheckers,
  createProviderHealthChecker,
  createDbHealthChecker,
} from './health.js';

describe('Health Check', () => {
  beforeEach(() => {
    resetHealthCheckers();
  });

  describe('checkLiveness', () => {
    it('항상 status ok + uptime 반환', () => {
      const result = checkLiveness();
      expect(result.status).toBe('ok');
      expect(typeof result.uptime).toBe('number');
    });
  });

  describe('checkReadiness', () => {
    it('checker 없으면 ok', async () => {
      const result = await checkReadiness(0, 5);
      expect(result.status).toBe('ok');
      expect(result.components).toHaveLength(0);
      expect(result.connections).toBe(5);
      expect(result.activeSessions).toBe(0);
      expect(result.memory).toBeDefined();
      expect(result.version).toBe('0.1.0');
    });

    it('모든 컴포넌트 healthy → ok', async () => {
      registerHealthChecker(async () => ({
        name: 'test',
        status: 'healthy',
        lastCheckedAt: Date.now(),
      }));

      const result = await checkReadiness(1, 2);
      expect(result.status).toBe('ok');
    });

    it('degraded 컴포넌트 → degraded', async () => {
      registerHealthChecker(async () => ({
        name: 'slow-provider',
        status: 'degraded',
        message: 'High latency',
        lastCheckedAt: Date.now(),
      }));

      const result = await checkReadiness(0, 0);
      expect(result.status).toBe('degraded');
    });

    it('unhealthy 컴포넌트 → error', async () => {
      registerHealthChecker(async () => ({
        name: 'db',
        status: 'unhealthy',
        message: 'Connection refused',
        lastCheckedAt: Date.now(),
      }));

      const result = await checkReadiness(0, 0);
      expect(result.status).toBe('error');
    });

    it('checker 에러 → unhealthy로 처리', async () => {
      registerHealthChecker(async () => {
        throw new Error('Check failed');
      });

      const result = await checkReadiness(0, 0);
      expect(result.status).toBe('error');
      expect(result.components[0].status).toBe('unhealthy');
      expect(result.components[0].message).toBe('Check failed');
    });
  });

  describe('createProviderHealthChecker', () => {
    it('healthy 시 캐시', async () => {
      const checkFn = vi.fn().mockResolvedValue(undefined);
      const checker = createProviderHealthChecker('anthropic', checkFn);

      await checker();
      await checker(); // 캐시 히트

      expect(checkFn).toHaveBeenCalledTimes(1);
    });

    it('TTL 경과 후 재확인', async () => {
      vi.useFakeTimers();
      const checkFn = vi.fn().mockResolvedValue(undefined);
      const checker = createProviderHealthChecker('openai', checkFn);

      await checker();
      vi.advanceTimersByTime(60_001);
      await checker();

      expect(checkFn).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('에러 시 degraded', async () => {
      const checkFn = vi.fn().mockRejectedValue(new Error('Timeout'));
      const checker = createProviderHealthChecker('provider-x', checkFn);

      const result = await checker();
      expect(result.status).toBe('degraded');
      expect(result.name).toBe('provider:provider-x');
    });
  });

  describe('createDbHealthChecker', () => {
    it('성공 → healthy', async () => {
      const checker = createDbHealthChecker(async () => {});
      const result = await checker();
      expect(result.status).toBe('healthy');
      expect(result.name).toBe('database');
    });

    it('실패 → unhealthy', async () => {
      const checker = createDbHealthChecker(async () => {
        throw new Error('SQLITE_BUSY');
      });
      const result = await checker();
      expect(result.status).toBe('unhealthy');
      expect(result.message).toBe('SQLITE_BUSY');
    });
  });
});
```

---

## Step 8: 브로드캐스터 확장 (`broadcaster.ts` 수정)

**파일:** `packages/server/src/gateway/broadcaster.ts`
**목표:** `broadcastToChannel()` + `subscribe()` + `unsubscribe()` 메서드 추가
**검증:** `broadcaster.test.ts` 확장 통과

### 변경 내용

기존 `GatewayBroadcaster` 클래스에 3개 메서드 + 채널 정책 상수 추가:

```typescript
// broadcaster.ts — 클래스 상단에 채널별 slow consumer 임계값 추가
export class GatewayBroadcaster {
  private readonly deltaBuffers = new Map<...>(); // 기존
  private static readonly BATCH_INTERVAL_MS = 150; // 기존

  /** 채널별 slow consumer 임계값 (bytes) */
  private static readonly CHANNEL_MAX_BUFFER: Record<string, number> = {
    'market.tick': 256 * 1024,  // 256KB — 고빈도 채널
    default: 1024 * 1024,       // 1MB
  };

  // ... 기존 send(), bufferDelta(), flushDelta(), sendImmediate() 유지 ...

  /**
   * 특정 채널 구독자에게 JSON-RPC notification을 팬아웃한다.
   * @returns 전송 성공 수
   */
  broadcastToChannel(
    connections: Map<string, WsConnection>,
    channel: string,
    data: unknown,
  ): number {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: `notification.${channel}`,
      params: { data, timestamp: Date.now() },
    } satisfies JsonRpcNotification);

    let sent = 0;
    const maxBuffer =
      GatewayBroadcaster.CHANNEL_MAX_BUFFER[channel]
      ?? GatewayBroadcaster.CHANNEL_MAX_BUFFER['default']!;

    for (const conn of connections.values()) {
      if (!conn.subscriptions.has(channel)) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      if (conn.ws.bufferedAmount > maxBuffer) continue;

      conn.ws.send(payload);
      sent++;
    }
    return sent;
  }

  /** 구독 추가 */
  subscribe(
    connectionId: string,
    channel: string,
    connections: Map<string, WsConnection>,
  ): boolean {
    const conn = connections.get(connectionId);
    if (!conn) return false;
    conn.subscriptions.add(channel);
    return true;
  }

  /** 구독 해제 */
  unsubscribe(
    connectionId: string,
    channel: string,
    connections: Map<string, WsConnection>,
  ): boolean {
    const conn = connections.get(connectionId);
    if (!conn) return false;
    conn.subscriptions.delete(channel);
    return true;
  }

  // ... 기존 broadcastShutdown(), flushAll() 유지 ...
}
```

### 테스트 확장 (`broadcaster.test.ts` 추가 describe)

기존 테스트 파일 하단에 추가:

```typescript
// broadcaster.test.ts — 기존 테스트 뒤에 추가

describe('broadcastToChannel', () => {
  it('구독자에게만 전송', () => {
    const broadcaster = new GatewayBroadcaster();
    const connections = new Map<string, WsConnection>();

    const ws1 = createMockWs(); // readyState=OPEN, bufferedAmount=0
    const ws2 = createMockWs();
    connections.set('c1', {
      id: 'c1',
      ws: ws1,
      auth: mockAuth,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
      subscriptions: new Set(['config.updated']),
    });
    connections.set('c2', {
      id: 'c2',
      ws: ws2,
      auth: mockAuth,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
      subscriptions: new Set(),
    });

    const sent = broadcaster.broadcastToChannel(connections, 'config.updated', { key: 'value' });

    expect(sent).toBe(1);
    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).not.toHaveBeenCalled();

    const payload = JSON.parse(ws1.send.mock.calls[0][0]);
    expect(payload.method).toBe('notification.config.updated');
    expect(payload.params.data).toEqual({ key: 'value' });
  });

  it('OPEN 아닌 연결 skip', () => {
    const broadcaster = new GatewayBroadcaster();
    const connections = new Map<string, WsConnection>();

    const ws = createMockWs({ readyState: 3 }); // CLOSED
    connections.set('c1', {
      id: 'c1',
      ws,
      auth: mockAuth,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
      subscriptions: new Set(['config.updated']),
    });

    const sent = broadcaster.broadcastToChannel(connections, 'config.updated', {});
    expect(sent).toBe(0);
  });

  it('market.tick 채널은 256KB 임계값 적용', () => {
    const broadcaster = new GatewayBroadcaster();
    const connections = new Map<string, WsConnection>();

    const ws = createMockWs({ bufferedAmount: 300 * 1024 }); // 300KB > 256KB
    connections.set('c1', {
      id: 'c1',
      ws,
      auth: mockAuth,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
      subscriptions: new Set(['market.tick']),
    });

    const sent = broadcaster.broadcastToChannel(connections, 'market.tick', {});
    expect(sent).toBe(0);
  });
});

describe('subscribe / unsubscribe', () => {
  it('구독 추가 성공', () => {
    const broadcaster = new GatewayBroadcaster();
    const connections = new Map<string, WsConnection>();
    connections.set('c1', {
      id: 'c1',
      ws: createMockWs(),
      auth: mockAuth,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
      subscriptions: new Set(),
    });

    expect(broadcaster.subscribe('c1', 'config.updated', connections)).toBe(true);
    expect(connections.get('c1')!.subscriptions.has('config.updated')).toBe(true);
  });

  it('존재하지 않는 연결 → false', () => {
    const broadcaster = new GatewayBroadcaster();
    const connections = new Map<string, WsConnection>();

    expect(broadcaster.subscribe('nope', 'config.updated', connections)).toBe(false);
  });

  it('구독 해제 성공', () => {
    const broadcaster = new GatewayBroadcaster();
    const connections = new Map<string, WsConnection>();
    connections.set('c1', {
      id: 'c1',
      ws: createMockWs(),
      auth: mockAuth,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
      subscriptions: new Set(['config.updated']),
    });

    expect(broadcaster.unsubscribe('c1', 'config.updated', connections)).toBe(true);
    expect(connections.get('c1')!.subscriptions.has('config.updated')).toBe(false);
  });
});
```

---

## Step 9: Config Hot-reload (`hot-reload.ts` 신규)

**파일:** `packages/server/src/gateway/hot-reload.ts` (신규)
**의존성:** `chokidar` (package.json에 추가 필요)
**목표:** 설정 파일 감시 → Zod safeParse → eventBus emit → broadcastToChannel
**검증:** `hot-reload.test.ts` 통과

### 사전 작업: chokidar 설치

```bash
cd packages/server && pnpm add chokidar
```

### 전체 코드

```typescript
// packages/server/src/gateway/hot-reload.ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import { getEventBus } from '@finclaw/infra';
import type { ConfigChangeEvent } from './rpc/types.js';
import type { GatewayServerContext } from './context.js';

export interface HotReloadConfig {
  readonly configPath: string;
  readonly debounceMs: number;
  readonly validateBeforeApply: boolean;
  readonly mode: 'watch' | 'poll';
}

export interface HotReloadManager {
  start(): Promise<void>;
  stop(): void;
  on(event: 'change', listener: (e: ConfigChangeEvent) => void): void;
  on(event: 'error', listener: (e: Error) => void): void;
}

export function createHotReloader(
  config: HotReloadConfig,
  ctx: GatewayServerContext,
  validate: (content: string) => { success: boolean; error?: string },
): HotReloadManager {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHash = '';

  const listeners = {
    change: new Set<(e: ConfigChangeEvent) => void>(),
    error: new Set<(e: Error) => void>(),
  };

  async function computeHash(filePath: string): Promise<string> {
    const content = await readFile(filePath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  }

  function handleChange(filePath: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(async () => {
      try {
        const content = await readFile(filePath, 'utf8');
        const currentHash = createHash('sha256').update(content).digest('hex');

        if (currentHash === lastHash) return;

        if (config.validateBeforeApply) {
          const result = validate(content);
          if (!result.success) {
            for (const listener of listeners.error) {
              listener(new Error(`Config validation failed: ${result.error}`));
            }
            return;
          }
        }

        const event: ConfigChangeEvent = {
          path: filePath,
          changeType: 'modified',
          timestamp: Date.now(),
          previousHash: lastHash,
          currentHash,
        };

        lastHash = currentHash;

        for (const listener of listeners.change) {
          listener(event);
        }

        getEventBus().emit('config:change', [filePath]);

        ctx.broadcaster.broadcastToChannel(ctx.connections, 'config.updated', {
          path: filePath,
          timestamp: event.timestamp,
        });
      } catch (error) {
        for (const listener of listeners.error) {
          listener(error as Error);
        }
      }
    }, config.debounceMs);
  }

  return {
    async start(): Promise<void> {
      try {
        lastHash = await computeHash(config.configPath);
      } catch {
        lastHash = '';
      }

      const usePolling = config.mode === 'poll';

      watcher = watch(config.configPath, {
        persistent: true,
        ignoreInitial: true,
        usePolling,
        awaitWriteFinish: { stabilityThreshold: 200 },
      });

      watcher.on('change', handleChange);
      watcher.on('error', (error) => {
        for (const listener of listeners.error) {
          listener(error);
        }
      });
    },

    stop(): void {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher?.close();
      watcher = null;
    },

    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners as Record<string, Set<(...args: unknown[]) => void>>)[event]?.add(listener);
    },
  };
}
```

### 테스트 (`hot-reload.test.ts` 신규)

```typescript
// packages/server/src/gateway/hot-reload.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// chokidar를 mock
vi.mock('chokidar', () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  return {
    watch: vi.fn().mockReturnValue({
      on(event: string, handler: (...args: any[]) => void) {
        handlers.set(event, handler);
        return this;
      },
      close: vi.fn(),
      // 테스트에서 파일 변경 시뮬레이션
      _trigger(event: string, ...args: any[]) {
        handlers.get(event)?.(...args);
      },
      _handlers: handlers,
    }),
  };
});

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('@finclaw/infra', () => ({
  getEventBus: vi.fn().mockReturnValue({
    emit: vi.fn(),
  }),
}));

import { createHotReloader, type HotReloadConfig } from './hot-reload.js';
import { readFile } from 'node:fs/promises';
import { watch } from 'chokidar';
import { getEventBus } from '@finclaw/infra';
import type { GatewayServerContext } from './context.js';

describe('HotReloadManager', () => {
  const defaultConfig: HotReloadConfig = {
    configPath: '/app/config.json',
    debounceMs: 50,
    validateBeforeApply: true,
    mode: 'watch',
  };

  let ctx: GatewayServerContext;
  let validate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    validate = vi.fn().mockReturnValue({ success: true });

    ctx = {
      broadcaster: { broadcastToChannel: vi.fn().mockReturnValue(1) },
      connections: new Map(),
    } as any;

    (readFile as any).mockResolvedValue('{"port": 3000}');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start()에서 초기 해시 계산', async () => {
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    await reloader.start();

    expect(readFile).toHaveBeenCalledWith('/app/config.json', 'utf8');
    reloader.stop();
  });

  it('파일 변경 시 change 리스너 호출', async () => {
    const onChange = vi.fn();
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    reloader.on('change', onChange);
    await reloader.start();

    // 파일 내용 변경
    (readFile as any).mockResolvedValue('{"port": 4000}');

    // chokidar change 이벤트 시뮬레이션
    const watcher = (watch as any).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');

    // debounce 대기
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({
      path: '/app/config.json',
      changeType: 'modified',
    });

    reloader.stop();
  });

  it('동일 해시면 change 리스너 미호출', async () => {
    const onChange = vi.fn();
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    reloader.on('change', onChange);
    await reloader.start();

    // 동일 내용 (해시 불변)
    const watcher = (watch as any).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(onChange).not.toHaveBeenCalled();
    reloader.stop();
  });

  it('validate 실패 시 error 리스너 호출', async () => {
    validate.mockReturnValue({ success: false, error: 'Invalid port' });
    const onError = vi.fn();

    const reloader = createHotReloader(defaultConfig, ctx, validate);
    reloader.on('error', onError);
    await reloader.start();

    (readFile as any).mockResolvedValue('{"port": "bad"}');
    const watcher = (watch as any).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toContain('Config validation failed');
    reloader.stop();
  });

  it('변경 시 eventBus emit + broadcastToChannel 호출', async () => {
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    await reloader.start();

    (readFile as any).mockResolvedValue('{"port": 5000}');
    const watcher = (watch as any).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(getEventBus().emit).toHaveBeenCalledWith('config:change', ['/app/config.json']);
    expect(ctx.broadcaster.broadcastToChannel).toHaveBeenCalledWith(
      ctx.connections,
      'config.updated',
      expect.objectContaining({ path: '/app/config.json' }),
    );
    reloader.stop();
  });

  it('debounce: 연속 변경 시 마지막 1회만 처리', async () => {
    const onChange = vi.fn();
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    reloader.on('change', onChange);
    await reloader.start();

    let counter = 0;
    (readFile as any).mockImplementation(async () => `{"v": ${++counter}}`);

    const watcher = (watch as any).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(10);
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(10);
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(onChange).toHaveBeenCalledTimes(1);
    reloader.stop();
  });

  it('poll 모드 설정 전달', async () => {
    const pollConfig = { ...defaultConfig, mode: 'poll' as const };
    const reloader = createHotReloader(pollConfig, ctx, validate);
    await reloader.start();

    expect(watch).toHaveBeenCalledWith(
      '/app/config.json',
      expect.objectContaining({
        usePolling: true,
      }),
    );
    reloader.stop();
  });
});
```

---

## Step 10: OpenAI 호환 API (`openai-compat/` 신규)

**파일:**

- `packages/server/src/gateway/openai-compat/adapter.ts` (신규)
- `packages/server/src/gateway/openai-compat/router.ts` (신규)
- `packages/server/src/gateway/openai-compat/adapter.test.ts` (신규)

**목표:** `/v1/chat/completions` 엔드포인트 (feature flag) + 요청/응답 변환기
**검증:** `adapter.test.ts` 통과 + `tsc --build` 통과

### adapter.ts

```typescript
// packages/server/src/gateway/openai-compat/adapter.ts
import { randomUUID } from 'node:crypto';
import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIStreamChunk } from '../rpc/types.js';

/** OpenAI 모델 ID → FinClaw 내부 모델 ID 매핑 */
const MODEL_MAP: Record<string, string> = {
  'gpt-4o': 'claude-sonnet-4-20250514',
  'gpt-4o-mini': 'claude-haiku-4-20250414',
  'gpt-4-turbo': 'claude-sonnet-4-20250514',
  'gpt-3.5-turbo': 'claude-haiku-4-20250414',
};

export function mapModelId(openaiModel: string): string | undefined {
  if (MODEL_MAP[openaiModel]) return MODEL_MAP[openaiModel];
  if (openaiModel.startsWith('claude-')) return openaiModel;
  return undefined;
}

/** OpenAI 요청 → FinClaw 내부 요청 변환 */
export function adaptRequest(openai: OpenAIChatRequest, internalModel: string) {
  const systemMessages = openai.messages.filter((m) => m.role === 'system');
  const otherMessages = openai.messages.filter((m) => m.role !== 'system');

  return {
    agentId: 'openai-compat',
    conversationId: randomUUID(),
    messages: otherMessages,
    tools: openai.tools ?? [],
    model: {
      modelId: internalModel,
      maxTokens: openai.max_tokens ?? 4096,
      temperature: openai.temperature,
    },
    systemPrompt: systemMessages.map((m) => m.content).join('\n'),
  };
}

/** FinClaw 실행 결과 → OpenAI 응답 변환 */
export function adaptResponse(
  result: { text: string; usage?: { inputTokens: number; outputTokens: number } },
  model: string,
): OpenAIChatResponse {
  return {
    id: `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: result.usage?.inputTokens ?? 0,
      completion_tokens: result.usage?.outputTokens ?? 0,
      total_tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    },
  };
}

/** 스트리밍 이벤트 → OpenAI SSE 청크 변환 */
export function adaptStreamChunk(
  event: { type: string; delta?: string },
  model: string,
): OpenAIStreamChunk | null {
  if (event.type === 'text_delta') {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
    };
  }
  if (event.type === 'done') {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
  }
  return null;
}
```

### router.ts

```typescript
// packages/server/src/gateway/openai-compat/router.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayServerContext } from '../context.js';
import { readBody } from '../router.js';
import { adaptRequest, mapModelId } from './adapter.js';
import type { OpenAIChatRequest, OpenAIErrorResponse } from '../rpc/types.js';

/**
 * POST /v1/chat/completions
 * Feature flag: config.openaiCompat?.enabled === true
 */
export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 400, 'invalid_request_error', 'Failed to read request body');
    return;
  }

  let openaiRequest: OpenAIChatRequest;
  try {
    openaiRequest = JSON.parse(body);
  } catch {
    sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
    return;
  }

  const internalModel = mapModelId(openaiRequest.model);
  if (!internalModel) {
    sendError(res, 400, 'invalid_request_error', `Unknown model: ${openaiRequest.model}`, 'model');
    return;
  }

  const _internalRequest = adaptRequest(openaiRequest, internalModel);
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  if (openaiRequest.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const keepaliveMs = ctx.config.openaiCompat?.sseKeepaliveMs ?? 15_000;
    const keepalive = setInterval(() => {
      if (!res.destroyed) res.write(':keepalive\n\n');
    }, keepaliveMs);

    try {
      // TODO(Phase 12+): runner.execute(internalRequest, listener, abort.signal)
      res.write('data: [DONE]\n\n');
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  } else {
    // TODO(Phase 12+): 동기 실행 엔진 연동
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'Not implemented', type: 'server_error', code: null, param: null },
      } satisfies OpenAIErrorResponse),
    );
  }
}

function sendError(
  res: ServerResponse,
  status: number,
  type: OpenAIErrorResponse['error']['type'],
  message: string,
  param: string | null = null,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: { message, type, code: null, param },
    } satisfies OpenAIErrorResponse),
  );
}
```

### adapter.test.ts

```typescript
// packages/server/src/gateway/openai-compat/adapter.test.ts
import { describe, it, expect } from 'vitest';
import { mapModelId, adaptRequest, adaptResponse, adaptStreamChunk } from './adapter.js';

describe('mapModelId', () => {
  it('gpt-4o → claude-sonnet-4', () => {
    expect(mapModelId('gpt-4o')).toBe('claude-sonnet-4-20250514');
  });

  it('gpt-4o-mini → claude-haiku-4', () => {
    expect(mapModelId('gpt-4o-mini')).toBe('claude-haiku-4-20250414');
  });

  it('gpt-3.5-turbo → claude-haiku-4', () => {
    expect(mapModelId('gpt-3.5-turbo')).toBe('claude-haiku-4-20250414');
  });

  it('claude-* passthrough', () => {
    expect(mapModelId('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514');
    expect(mapModelId('claude-haiku-4-20250414')).toBe('claude-haiku-4-20250414');
  });

  it('미지원 모델 → undefined', () => {
    expect(mapModelId('unknown-model')).toBeUndefined();
    expect(mapModelId('llama-3')).toBeUndefined();
  });
});

describe('adaptRequest', () => {
  it('system 메시지 분리', () => {
    const result = adaptRequest(
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
  });

  it('기본 max_tokens 4096', () => {
    const result = adaptRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.model.maxTokens).toBe(4096);
  });

  it('사용자 지정 max_tokens', () => {
    const result = adaptRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1024,
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.model.maxTokens).toBe(1024);
  });

  it('temperature 전달', () => {
    const result = adaptRequest(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.7,
      },
      'claude-sonnet-4-20250514',
    );

    expect(result.model.temperature).toBe(0.7);
  });
});

describe('adaptResponse', () => {
  it('OpenAI 응답 포맷 생성', () => {
    const result = adaptResponse(
      { text: 'Hello!', usage: { inputTokens: 10, outputTokens: 5 } },
      'gpt-4o',
    );

    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('gpt-4o');
    expect(result.choices[0].message.content).toBe('Hello!');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
  });

  it('usage 없으면 0', () => {
    const result = adaptResponse({ text: 'Hi' }, 'gpt-4o');
    expect(result.usage.total_tokens).toBe(0);
  });
});

describe('adaptStreamChunk', () => {
  it('text_delta → chunk with content', () => {
    const chunk = adaptStreamChunk({ type: 'text_delta', delta: 'Hello' }, 'gpt-4o');

    expect(chunk).not.toBeNull();
    expect(chunk!.object).toBe('chat.completion.chunk');
    expect(chunk!.choices[0].delta.content).toBe('Hello');
    expect(chunk!.choices[0].finish_reason).toBeNull();
  });

  it('done → chunk with finish_reason stop', () => {
    const chunk = adaptStreamChunk({ type: 'done' }, 'gpt-4o');

    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].finish_reason).toBe('stop');
  });

  it('기타 이벤트 → null', () => {
    expect(adaptStreamChunk({ type: 'tool_use_start' }, 'gpt-4o')).toBeNull();
    expect(adaptStreamChunk({ type: 'state_change' }, 'gpt-4o')).toBeNull();
  });
});
```

---

## Step 11: index.ts 업데이트 + router에 OpenAI compat 라우트 추가

**파일:**

- `packages/server/src/gateway/index.ts` — Phase 11 export 추가
- `packages/server/src/gateway/router.ts` — OpenAI compat 조건부 라우트 등록

### index.ts 추가 export

```typescript
// index.ts — 기존 export 뒤에 추가

// Phase 11: 고급 기능
export { RequestRateLimiter } from './rate-limit.js';
export { createAccessLogger, sanitizePath } from './access-log.js';
export {
  checkLiveness,
  checkReadiness,
  registerHealthChecker,
  createProviderHealthChecker,
  createDbHealthChecker,
} from './health.js';
export { createHotReloader, type HotReloadManager, type HotReloadConfig } from './hot-reload.js';
export { handleChatCompletions } from './openai-compat/router.js';
export {
  mapModelId,
  adaptRequest,
  adaptResponse,
  adaptStreamChunk,
} from './openai-compat/adapter.js';

// Phase 11 타입 추가 export
export type {
  ConfigChangeEvent,
  BroadcastChannel,
  RateLimitInfo,
  ComponentHealth,
  SystemHealth,
  LivenessResponse,
  AccessLogEntry,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIStreamChunk,
  OpenAIErrorResponse,
} from './rpc/types.js';
```

### router.ts — OpenAI compat 조건부 라우트

```typescript
// router.ts — import 추가
import { handleChatCompletions } from './openai-compat/router.js';

// handleHttpRequest() 내부 — 라우트 매칭 전에 OpenAI compat 체크 추가
// (drain 체크 이후, 일반 라우트 매칭 전)
if (
  ctx.config.openaiCompat?.enabled &&
  req.method === 'POST' &&
  req.url?.startsWith('/v1/chat/completions')
) {
  await handleChatCompletions(req, res, ctx);
  return;
}
```

---

## Step 12: 전체 검증

```bash
# 1. 타입 체크
pnpm tsc --build

# 2. 개별 테스트
pnpm vitest run packages/server/src/gateway/rate-limit.test.ts
pnpm vitest run packages/server/src/gateway/access-log.test.ts
pnpm vitest run packages/server/src/gateway/health.test.ts
pnpm vitest run packages/server/src/gateway/broadcaster.test.ts
pnpm vitest run packages/server/src/gateway/hot-reload.test.ts
pnpm vitest run packages/server/src/gateway/openai-compat/adapter.test.ts

# 3. 기존 테스트 회귀 확인
pnpm vitest run packages/server/src/gateway/router.test.ts
pnpm vitest run packages/server/src/gateway/server.test.ts

# 4. 전체 게이트웨이 테스트
pnpm vitest run packages/server/src/gateway/

# 5. 린트/포맷
pnpm lint
pnpm format:fix
```

---

## 파일 요약

| #   | 파일                            | 유형 | 설명                                           |
| --- | ------------------------------- | ---- | ---------------------------------------------- |
| 1   | `rpc/types.ts`                  | 수정 | Config 확장 + Phase 11 타입                    |
| 2   | `context.ts`                    | 수정 | `isDraining: boolean`                          |
| 3   | `server.ts`                     | 수정 | `isDraining` 초기화/설정                       |
| 4   | `router.ts`                     | 수정 | drain 503 + /healthz + /readyz + OpenAI compat |
| 5   | `rate-limit.ts`                 | 신규 | RequestRateLimiter                             |
| 6   | `rate-limit.test.ts`            | 신규 | rate limiter 테스트                            |
| 7   | `access-log.ts`                 | 신규 | 액세스 로거                                    |
| 8   | `access-log.test.ts`            | 신규 | 액세스 로그 테스트                             |
| 9   | `health.ts`                     | 신규 | liveness/readiness 헬스 체크                   |
| 10  | `health.test.ts`                | 신규 | 헬스 체크 테스트                               |
| 11  | `broadcaster.ts`                | 수정 | broadcastToChannel + subscribe/unsubscribe     |
| 12  | `broadcaster.test.ts`           | 수정 | 채널 팬아웃 테스트 추가                        |
| 13  | `hot-reload.ts`                 | 신규 | Config hot-reload                              |
| 14  | `hot-reload.test.ts`            | 신규 | hot-reload 테스트                              |
| 15  | `openai-compat/adapter.ts`      | 신규 | OpenAI ↔ FinClaw 변환                          |
| 16  | `openai-compat/router.ts`       | 신규 | /v1/chat/completions 핸들러                    |
| 17  | `openai-compat/adapter.test.ts` | 신규 | adapter 테스트                                 |
| 18  | `index.ts`                      | 수정 | Phase 11 export 추가                           |
| 19  | `router.test.ts`                | 수정 | drain/healthz/readyz 테스트                    |

---

## 핵심 수정 대상 파일 경로

- `packages/server/src/gateway/rpc/types.ts` — 타입 확장
- `packages/server/src/gateway/context.ts` — isDraining
- `packages/server/src/gateway/server.ts` — isDraining 설정
- `packages/server/src/gateway/router.ts` — 503 + 새 라우트
- `packages/server/src/gateway/broadcaster.ts` — 채널 팬아웃
- `packages/server/src/gateway/index.ts` — 배럴 export
- `packages/server/src/gateway/rate-limit.ts` — 신규
- `packages/server/src/gateway/access-log.ts` — 신규
- `packages/server/src/gateway/health.ts` — 신규
- `packages/server/src/gateway/hot-reload.ts` — 신규
- `packages/server/src/gateway/openai-compat/adapter.ts` — 신규
- `packages/server/src/gateway/openai-compat/router.ts` — 신규

## 검증 방법

1. 각 Step 완료 후 `tsc --build` 통과 확인
2. 각 테스트 파일 `vitest run` 통과 확인
3. 전체 `pnpm vitest run packages/server/src/gateway/` 통과 확인
4. `pnpm lint && pnpm format:fix` 통과 확인
