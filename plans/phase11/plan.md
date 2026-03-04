# Phase 11: 게이트웨이 서버 - 고급 기능 (Gateway Server: Advanced)

> **복잡도: L** | 신규 소스 ~6 파일 | 수정 소스 ~5 파일 | 테스트 ~6 파일 | 합계 ~17 파일

---

## 1. 목표

Phase 10에서 구축한 게이트웨이 코어 위에 운영 수준의 고급 기능을 추가한다. OpenClaw 게이트웨이의 프로덕션 기능들을 참조하여, 실제 서비스 운영에 필요한 안정성과 호환성을 확보한다:

- **Config hot-reload**: `chokidar` 파일 감시 → 변경 감지 → Zod `safeParse` 검증 → `eventBus` emit → `broadcastToChannel`
- **브로드캐스트 확장**: 기존 `GatewayBroadcaster`에 채널 기반 팬아웃 (`broadcastToChannel`) + 구독 관리 (`subscribe`/`unsubscribe`) 메서드 추가
- **OpenAI 호환 API**: feature flag 기반 `/v1/chat/completions` 엔드포인트, SSE keepalive, `@finclaw/agent` 카탈로그 연동
- **Drain 거부**: `isDraining` 플래그 + router 503 응답으로 신규 요청 차단 (별도 `ShutdownManager` 불필요 — `ProcessLifecycle` + `GatewayServer.stop()` 이미 구현됨)
- **헬스 체크**: liveness (`/healthz`) + readiness (`/readyz`) 분리, Provider TTL 캐시, HTTP 상태 코드 전략
- **Rate limiting**: 요청 수준 슬라이딩 윈도우 (`RequestRateLimiter`), `MAX_KEYS` 메모리 상한, `toRateLimitHeaders()`
- **요청 로깅**: `requestId` + `X-Request-Id` 헤더, `createLogger()` 팩토리, `sanitizePath()`

---

## 2. OpenClaw 참조

| OpenClaw 경로                                                      | 적용 패턴                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `openclaw_review/deep-dive/03-gateway-server.md` (hot-reload 섹션) | chokidar 파일 감시 → Zod safeParse → eventBus → broadcast     |
| `openclaw_review/deep-dive/03` (graceful shutdown 섹션)            | isDraining 플래그 + 503 거부 (ProcessLifecycle이 시그널 처리) |
| `openclaw_review/deep-dive/03` (OpenAI compat 섹션)                | /v1/chat/completions 어댑터 패턴, SSE keepalive, feature flag |
| `openclaw_review/deep-dive/03` (broadcast 섹션)                    | 기존 broadcaster 확장, 채널별 팬아웃, 구독 관리               |
| `openclaw_review/docs/` (서버 설정 관련)                           | 설정 파일 구조, hot-reload 트리거 방식                        |

**OpenClaw 차이점:**

- mDNS/Bonjour 서비스 디스커버리 → FinClaw v0.1에서는 제외 (향후 Phase에서 추가 가능)
- OpenAI compat: 전체 API 호환 → 금융 도메인에 필요한 `/v1/chat/completions`만 구현
- Rate limiting: 복잡한 토큰 버킷 → 간단한 슬라이딩 윈도우 방식
- 금융 특화: 시세 데이터 브로드캐스트 채널 추가

---

## 3. 파일 목록

### 3-A. 신규 소스 파일 (`src/gateway/`)

| 파일 경로                              | 설명                                                                |
| -------------------------------------- | ------------------------------------------------------------------- |
| `src/gateway/hot-reload.ts`            | 설정 파일 감시 + Zod safeParse + eventBus emit + broadcastToChannel |
| `src/gateway/openai-compat/router.ts`  | `/v1/chat/completions` HTTP 라우트 (feature flag 게이트)            |
| `src/gateway/openai-compat/adapter.ts` | OpenAI ↔ FinClaw 요청/응답 변환기                                   |
| `src/gateway/health.ts`                | liveness + readiness 헬스 체크, Provider TTL 캐시                   |
| `src/gateway/rate-limit.ts`            | 요청 수준 슬라이딩 윈도우 (`RequestRateLimiter`)                    |
| `src/gateway/access-log.ts`            | requestId 기반 구조화된 JSON 액세스 로그                            |

### 3-B. 수정 소스 파일

| 파일 경로                    | 변경 내용                                                                  |
| ---------------------------- | -------------------------------------------------------------------------- |
| `src/gateway/broadcaster.ts` | `broadcastToChannel()` + `subscribe()` + `unsubscribe()` 추가              |
| `src/gateway/context.ts`     | `isDraining` 프로퍼티 추가                                                 |
| `src/gateway/router.ts`      | drain 503 체크 + `/v1/chat/completions`, `/healthz`, `/readyz` 라우트 추가 |
| `src/gateway/server.ts`      | `stop()` 시 `isDraining = true` 설정                                       |
| `src/gateway/rpc/types.ts`   | `GatewayServerConfig` 확장 (openaiCompat, hotReload, rateLimit 옵션)       |

### 3-C. 테스트 파일

| 파일 경로                                   | 테스트 대상                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `src/gateway/hot-reload.test.ts`            | 파일 변경 감지, Zod safeParse, 초기 해시, eventBus emit                |
| `src/gateway/openai-compat/adapter.test.ts` | 요청/응답 변환, SSE 청크, 모델 매핑, 에러 포맷                         |
| `src/gateway/health.test.ts`                | liveness/readiness, 컴포넌트 상태 집계, Provider TTL                   |
| `src/gateway/rate-limit.test.ts`            | 윈도우 계산, 초과 시 거부, MAX_KEYS 상한, 헤더 변환                    |
| `src/gateway/access-log.test.ts`            | 로그 포맷, requestId, sanitizePath, 민감 정보 마스킹                   |
| `src/gateway/broadcaster.test.ts`           | (확장) broadcastToChannel, subscribe/unsubscribe, 채널별 slow consumer |

---

## 4. 핵심 인터페이스/타입

### Hot-reload 타입

```typescript
/** 설정 변경 이벤트 */
export interface ConfigChangeEvent {
  readonly path: string;
  readonly changeType: 'modified' | 'added' | 'removed';
  readonly timestamp: number;
  readonly previousHash: string;
  readonly currentHash: string;
}

/** Hot-reload 설정 */
export interface HotReloadConfig {
  readonly configPath: string;
  readonly debounceMs: number; // 기본 300ms (에디터 저장 이중 호출 방지)
  readonly validateBeforeApply: boolean; // 기본 true
  readonly mode: 'watch' | 'poll'; // chokidar 모드 (기본 'watch')
}

/** Hot-reload 매니저 인터페이스 */
export interface HotReloadManager {
  start(): Promise<void>; // async — 초기 해시 계산
  stop(): void;
  on(event: 'change', listener: (e: ConfigChangeEvent) => void): void;
  on(event: 'error', listener: (e: Error) => void): void;
}
```

### 브로드캐스트 타입 (broadcaster.ts 확장)

> 별도 `broadcast.ts` 파일은 생성하지 않는다. `getConnections()` 함수가 존재하지 않으며,
> 연결 목록은 `GatewayServerContext.connections`에서 접근한다.
> 기존 `GatewayBroadcaster`에 메서드를 추가하여 채널 기반 팬아웃을 구현한다.

```typescript
/** 브로드캐스트 채널 (string literal union) */
export type BroadcastChannel = 'config.updated' | 'session.event' | 'system.status' | 'market.tick';

/** 채널 정책 — 채널별 slow consumer 임계값 */
export interface ChannelPolicy {
  readonly maxBufferedBytes: number; // 기본 1MB, market.tick은 256KB
}

// GatewayBroadcaster에 추가되는 메서드 시그니처:
// broadcastToChannel(connections, channel, data): number
// subscribe(connectionId, channel, connections): boolean
// unsubscribe(connectionId, channel, connections): boolean
```

### OpenAI 호환 API 타입

```typescript
/** OpenAI chat completions 요청 (수신) */
export interface OpenAIChatRequest {
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stream?: boolean;
  readonly tools?: readonly OpenAITool[];
}

/** OpenAI 메시지 포맷 */
export interface OpenAIMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly OpenAIToolCall[];
  readonly tool_call_id?: string;
}

/** OpenAI chat completions 응답 (송신) */
export interface OpenAIChatResponse {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly OpenAIChoice[];
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

/** OpenAI 스트리밍 청크 (SSE) */
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

/** OpenAI 에러 응답 (표준 포맷) */
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

### Drain/Shutdown 타입

> 별도 `shutdown.ts` 파일은 생성하지 않는다.
> `ProcessLifecycle.register(() => gateway.stop())`이 이미 시그널 처리를 담당하며,
> `GatewayServer.stop()`이 세션 abort + WS 종료 + HTTP 종료 시퀀스를 수행한다.
> Phase 11에서 추가하는 것은 `isDraining` 플래그와 router 503 체크뿐이다.

```typescript
// context.ts 확장
export interface GatewayServerContext {
  // ... 기존 필드 ...
  isDraining: boolean; // mutable — stop() 시 true
}
```

### Rate limit 타입

```typescript
/** 요청 수준 rate limit 설정 */
export interface RequestRateLimitConfig {
  readonly windowMs: number; // 기본 60_000 (1분)
  readonly maxRequests: number; // 기본 60
  readonly maxKeys: number; // 메모리 상한 (기본 10_000)
  readonly keyExtractor: (ctx: RpcContext) => string;
}

/** Rate limit 상태 */
export interface RateLimitInfo {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: number;
  readonly retryAfterMs?: number;
}

// RequestRateLimiter에 추가되는 메서드:
// toRateLimitHeaders(info: RateLimitInfo): Record<string, string>
```

### 헬스 체크 타입

```typescript
/** 컴포넌트 상태 */
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

/** Liveness 응답 (최소) */
export interface LivenessResponse {
  readonly status: 'ok';
  readonly uptime: number;
}

// HTTP 상태 코드 전략:
// /healthz (liveness): 항상 200 (프로세스 생존 여부만)
// /readyz  (readiness): 200 (ok) | 503 (degraded/error)
```

### GatewayServerConfig 확장

```typescript
// rpc/types.ts에 추가되는 설정 필드
export interface GatewayServerConfig {
  // ... 기존 필드 ...
  readonly openaiCompat?: {
    readonly enabled: boolean; // feature flag (기본 false)
    readonly sseKeepaliveMs: number; // SSE keepalive 간격 (기본 15_000)
  };
  readonly hotReload?: HotReloadConfig;
  readonly rateLimit?: {
    readonly windowMs: number;
    readonly maxRequests: number;
    readonly maxKeys: number;
  };
}
```

---

## 5. 구현 상세

### 5.1 Config Hot-reload (`hot-reload.ts`)

`chokidar`로 설정 파일을 감시하고, 변경 시 Zod `safeParse`로 검증한 후 `eventBus`와 `broadcastToChannel`로 전파한다.

**기존 plan 대비 수정 사항:**

- Zod `safeParse` 실연결 (주석 제거)
- `start()` → `async start()`: 초기 해시를 파일 읽기로 계산 (빈 문자열 버그 수정)
- `mode` 체크: `'watch'` | `'poll'`
- `eventBus.emit('config:change', [path])` 호출
- `broadcastToChannel()` 사용 (별도 `broadcast()` 함수 대신)
- `debounceMs` 기본값 300ms (에디터 이중 저장 방지)

```typescript
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import { getEventBus } from '@finclaw/infra';
import type { ConfigChangeEvent, HotReloadConfig } from './types.js';
import type { GatewayServerContext } from './context.js';

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
  let lastHash = ''; // start()에서 초기화

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

        // 실제 내용이 변경된 경우만 처리
        if (currentHash === lastHash) return;

        // Zod safeParse 검증
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

        // 리스너 호출
        for (const listener of listeners.change) {
          listener(event);
        }

        // eventBus emit
        getEventBus().emit('config:change', [filePath]);

        // 연결된 클라이언트에 채널 브로드캐스트
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
      // 초기 해시 계산 (빈 문자열 대비)
      try {
        lastHash = await computeHash(config.configPath);
      } catch {
        // 파일이 아직 없을 수 있음 — 빈 해시로 시작
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

### 5.2 브로드캐스트 확장 (`broadcaster.ts` 수정)

> `broadcast.ts` 신규 파일은 생성하지 않는다.
> `getConnections()` 함수가 존재하지 않으므로, 기존 `GatewayBroadcaster`에
> 채널 기반 팬아웃 메서드를 추가한다. `ctx.connections`를 인자로 받는다.

**기존 클래스에 추가되는 메서드:**

```typescript
// broadcaster.ts에 추가 (기존 send/broadcastShutdown/flushAll 유지)

/** 채널별 slow consumer 임계값 (bytes) */
private static readonly CHANNEL_MAX_BUFFER: Record<string, number> = {
  'market.tick': 256 * 1024,  // 256KB — 고빈도 채널
  default: 1024 * 1024,       // 1MB
};

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
  const maxBuffer = GatewayBroadcaster.CHANNEL_MAX_BUFFER[channel]
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
```

### 5.3 OpenAI 호환 API (`openai-compat/`)

기존 OpenAI SDK 클라이언트가 FinClaw를 직접 호출할 수 있도록 호환 레이어를 제공한다.

**기존 plan 대비 수정 사항:**

- Feature flag (`config.openaiCompat?.enabled`) 게이트
- SSE keepalive 15초 간격
- `X-Accel-Buffering: no` 헤더 (nginx 프록시 대응)
- `AbortController` + 클라이언트 disconnect 시 실행 중단
- `@finclaw/agent` 카탈로그 연동 (하드코딩 3개 모델 → 동적 매핑)
- OpenAI 표준 에러 포맷 (`{ error: { message, type, code, param } }`)

```typescript
// openai-compat/router.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayServerContext } from '../context.js';
import { readBody } from '../router.js';
import { adaptRequest, adaptResponse, adaptStreamChunk, mapModelId } from './adapter.js';
import type { OpenAIChatRequest, OpenAIErrorResponse } from './types.js';

/**
 * POST /v1/chat/completions
 *
 * Feature flag로 활성화: config.openaiCompat.enabled === true
 * 비활성화 시 router에서 이 핸들러 등록을 건너뛴다.
 */
export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  // 요청 파싱
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

  // 모델 매핑 검증
  const internalModel = mapModelId(openaiRequest.model);
  if (!internalModel) {
    sendError(res, 400, 'invalid_request_error', `Unknown model: ${openaiRequest.model}`, 'model');
    return;
  }

  // FinClaw 내부 포맷으로 변환
  const internalRequest = adaptRequest(openaiRequest, internalModel);

  // AbortController — 클라이언트 disconnect 시 실행 중단
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  if (openaiRequest.stream) {
    // SSE 스트리밍 응답
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // SSE keepalive (15초 간격)
    const keepaliveMs = ctx.config.openaiCompat?.sseKeepaliveMs ?? 15_000;
    const keepalive = setInterval(() => {
      if (!res.destroyed) res.write(':keepalive\n\n');
    }, keepaliveMs);

    try {
      // TODO: runner.execute(internalRequest, listener, abort.signal)
      // const listener = (event: StreamEvent) => {
      //   const chunk = adaptStreamChunk(event, openaiRequest.model);
      //   if (chunk) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      // };

      res.write('data: [DONE]\n\n');
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  } else {
    // 동기 응답
    // TODO: const result = await runner.execute(internalRequest, undefined, abort.signal);
    // const openaiResponse = adaptResponse(result, openaiRequest.model);
    // res.writeHead(200, { 'Content-Type': 'application/json' });
    // res.end(JSON.stringify(openaiResponse));

    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'Not implemented', type: 'server_error', code: null, param: null },
      }),
    );
  }
}

/** OpenAI 표준 에러 응답 */
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

```typescript
// openai-compat/adapter.ts
import { randomUUID } from 'node:crypto';
import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIStreamChunk } from './types.js';

/**
 * OpenAI 모델 ID → FinClaw 모델 ID 매핑
 *
 * TODO: @finclaw/agent 카탈로그에서 동적으로 매핑 테이블을 구성한다.
 * 현재는 기본 매핑 + passthrough로 동작한다.
 */
const MODEL_MAP: Record<string, string> = {
  'gpt-4o': 'claude-sonnet-4-20250514',
  'gpt-4o-mini': 'claude-haiku-4-20250414',
  'gpt-4-turbo': 'claude-sonnet-4-20250514',
  'gpt-3.5-turbo': 'claude-haiku-4-20250414',
};

export function mapModelId(openaiModel: string): string | undefined {
  // 알려진 매핑이 있으면 사용, 없으면 passthrough (claude-* 모델은 그대로)
  if (MODEL_MAP[openaiModel]) return MODEL_MAP[openaiModel];
  if (openaiModel.startsWith('claude-')) return openaiModel;
  return undefined; // 미지원 모델
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
export function adaptResponse(result: unknown, model: string): OpenAIChatResponse {
  return {
    id: `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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

### 5.4 Drain 거부 (기존 파일 수정)

> 별도 `shutdown.ts`는 생성하지 않는다. 이유:
>
> - `ProcessLifecycle`이 SIGINT/SIGTERM 핸들러를 이미 관리
> - `GatewayServer.stop()`이 세션 abort → WS 종료 → HTTP 종료 시퀀스를 이미 수행
> - 추가 `ShutdownManager` 클래스는 책임이 중복됨

**변경 3줄:**

```typescript
// 1. context.ts — isDraining 추가
export interface GatewayServerContext {
  // ... 기존 필드 ...
  isDraining: boolean;
}

// 2. server.ts — stop() 첫 줄에 추가
async stop(): Promise<void> {
  ctx.isDraining = true; // ← 추가
  ctx.registry.abortAll();
  // ... 기존 로직 ...
}

// 3. router.ts — handleHttpRequest() 라우트 매칭 전
if (ctx.isDraining) {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Service shutting down' }));
  return;
}
```

### 5.5 상세 헬스 체크 (`health.ts`)

**기존 plan 대비 수정 사항:**

- `/healthz` (liveness) + `/readyz` (readiness) 분리
- Provider 헬스 캐시 TTL 60초
- HTTP 상태 코드: liveness 항상 200, readiness 200(ok) / 503(degraded/error)

```typescript
import type { ComponentHealth, SystemHealth, LivenessResponse } from './types.js';

type HealthChecker = () => Promise<ComponentHealth>;

const checkers: HealthChecker[] = [];

export function registerHealthChecker(checker: HealthChecker): void {
  checkers.push(checker);
}

/** GET /healthz — liveness (프로세스 생존 여부만) */
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

/** Provider 헬스 체커 (TTL 60초 캐시) */
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

/** SQLite DB 헬스 체커 */
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

### 5.6 Rate Limiting (`rate-limit.ts`)

슬라이딩 윈도우 알고리즘으로 요청 수준 rate limiting을 수행한다.

**기존 plan 대비 수정 사항:**

- 클래스명 `RequestRateLimiter` (기존 `AuthRateLimiter`와 구분)
- `MAX_KEYS` 10,000 — 메모리 무한 증가 방지
- `toRateLimitHeaders()` — 표준 rate-limit 헤더 생성

> 기존 `auth/rate-limit.ts`의 `AuthRateLimiter`는 IP별 인증 실패 차단용이다.
> 이 `RequestRateLimiter`는 인증된 클라이언트의 요청 수를 제한하는 별도 계층이다.

```typescript
import type { RequestRateLimitConfig, RateLimitInfo } from './types.js';

interface WindowEntry {
  timestamps: number[];
}

const DEFAULT_MAX_KEYS = 10_000;

/**
 * 요청 수준 슬라이딩 윈도우 rate limiter.
 *
 * MAX_KEYS 초과 시 가장 오래된 키를 evict하여 메모리 누수를 방지한다.
 */
export class RequestRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly cleanupInterval: ReturnType<typeof setInterval>;
  private readonly maxKeys: number;

  constructor(private readonly config: RequestRateLimitConfig) {
    this.maxKeys = config.maxKeys ?? DEFAULT_MAX_KEYS;
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60_000);
  }

  check(key: string): { allowed: boolean; info: RateLimitInfo } {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      // MAX_KEYS 초과 시 evict
      if (this.windows.size >= this.maxKeys) {
        const oldestKey = this.windows.keys().next().value;
        if (oldestKey !== undefined) this.windows.delete(oldestKey);
      }
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const info: RateLimitInfo = {
      remaining: Math.max(0, this.config.maxRequests - entry.timestamps.length),
      limit: this.config.maxRequests,
      resetAt: now + this.config.windowMs,
    };

    if (entry.timestamps.length >= this.config.maxRequests) {
      const oldestInWindow = entry.timestamps[0]!;
      return {
        allowed: false,
        info: {
          ...info,
          remaining: 0,
          retryAfterMs: oldestInWindow + this.config.windowMs - now,
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
      entry.timestamps = entry.timestamps.filter((t) => t > now - this.config.windowMs);
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

### 5.7 액세스 로그 (`access-log.ts`)

**기존 plan 대비 수정 사항:**

- `requestId` 필드 + `X-Request-Id` 응답 헤더
- `createLogger()` 팩토리 (출력 대상 주입 가능)
- `sanitizePath()` — 쿼리 파라미터 내 민감 정보 제거

```typescript
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 구조화된 액세스 로그 엔트리 */
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

/** 민감 헤더 목록 */
const MASKED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie']);

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

    // 응답에 X-Request-Id 헤더 추가
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

### 데이터 흐름 다이어그램

```
┌────────────────────────────────────────────────────────┐
│              Gateway Server (Phase 10 + 11)             │
│  ┌──────────────────────────────────────────────────┐  │
│  │             Phase 11 고급 기능                    │  │
│  │                                                  │  │
│  │  ┌───────────────────┐  ┌──────────────────────┐│  │
│  │  │ RequestRateLimiter│─▶│ Access Logger         ││  │
│  │  │ (per-client,      │  │ (JSON stdout,         ││  │
│  │  │  MAX_KEYS 10K)    │  │  requestId+X-Req-Id)  ││  │
│  │  └───────────────────┘  └──────────────────────┘│  │
│  │                                                  │  │
│  │  ┌───────────────────┐  ┌──────────────────────┐│  │
│  │  │ Hot Reload        │─▶│ Broadcaster 확장      ││  │
│  │  │ (chokidar+safeParse│  │ broadcastToChannel() ││  │
│  │  │  +eventBus emit)  │  │ subscribe/unsubscribe ││  │
│  │  └───────────────────┘  └──────────────────────┘│  │
│  │                                                  │  │
│  │  ┌───────────────────┐  ┌──────────────────────┐│  │
│  │  │ OpenAI Compat     │  │ Drain (isDraining)   ││  │
│  │  │ /v1/chat/*        │  │ router 503 check     ││  │
│  │  │ (feature flag)    │  │ (ProcessLifecycle가   ││  │
│  │  │                   │  │  시그널 처리)         ││  │
│  │  └───────────────────┘  └──────────────────────┘│  │
│  │                                                  │  │
│  │  ┌──────────────────────────────────────────┐   │  │
│  │  │ Health Check                              │   │  │
│  │  │ /healthz (liveness) + /readyz (readiness) │   │  │
│  │  │ DB ✓ | Provider ✓(TTL 60s) | Memory ✓    │   │  │
│  │  └──────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘

Config File ──(chokidar watch)──▶ Hot Reload
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
             Zod safeParse    eventBus emit   broadcastToChannel
                                ('config:change')      │
                                                       ▼
                                         구독자 WS Clients (config.updated)

SIGINT/SIGTERM ──▶ ProcessLifecycle ──▶ gateway.stop()
                                            │
                                            ├─ ctx.isDraining = true (신규 503)
                                            ├─ registry.abortAll()
                                            ├─ broadcaster.broadcastShutdown()
                                            ├─ broadcaster.flushAll()
                                            ├─ 5s drain 대기
                                            ├─ WS close(1001)
                                            └─ HTTP server close
```

---

## 6. 선행 조건

| Phase              | 구체적 산출물                                       | 필요 이유                                               |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------- |
| **Phase 10**       | `src/gateway/server.ts` — HTTP + WebSocket 서버     | 모든 고급 기능이 서버 인스턴스에 통합                   |
| **Phase 10**       | `src/gateway/rpc/index.ts` — JSON-RPC 디스패처      | OpenAI compat가 내부적으로 실행 엔진 호출 시 사용       |
| **Phase 10**       | `src/gateway/broadcaster.ts` — 스트리밍 broadcaster | 채널 기반 팬아웃 메서드 확장의 기반                     |
| **Phase 10**       | `src/gateway/context.ts` — DI 컨테이너              | `isDraining` 플래그 추가 대상                           |
| **Phase 10**       | `src/gateway/router.ts` — HTTP 라우팅               | drain 503 체크 + 신규 라우트 추가 대상                  |
| **Phase 10**       | `src/gateway/registry.ts` — Chat 레지스트리         | 헬스 체크에서 activeSessions 조회                       |
| **Phase 10**       | `src/process/lifecycle.ts` — ProcessLifecycle       | 시그널 처리 담당 (별도 ShutdownManager 불필요)          |
| **Phase 9**        | `src/execution/runner.ts` — 실행 엔진               | OpenAI compat API가 실행 엔진 호출                      |
| **Phase 9**        | `src/execution/streaming.ts` — 스트리밍 이벤트      | OpenAI SSE 스트리밍 변환에 필요                         |
| **Phase 4**        | `src/config/schema.ts` — Zod 설정 스키마            | Hot-reload 시 `safeParse` 검증에 사용                   |
| **@finclaw/agent** | 모델 카탈로그 (향후)                                | OpenAI compat 모델 매핑 동적화 (현재 하드코딩 fallback) |
| **@finclaw/infra** | `createLogger` + `getEventBus`                      | 액세스 로그 + hot-reload eventBus 연동                  |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| 산출물                       | 테스트 파일                     | 검증 방법                                                                                   |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| Config hot-reload            | `hot-reload.test.ts`            | 파일 변경 mock, Zod safeParse 성공/실패, 초기 해시 계산, eventBus emit 확인, debounce 300ms |
| Broadcaster 채널 팬아웃      | `broadcaster.test.ts` (확장)    | broadcastToChannel 전송 수, subscribe/unsubscribe, 채널별 slow consumer 임계값              |
| OpenAI compat 요청/응답 변환 | `openai-compat/adapter.test.ts` | OpenAI → FinClaw 메시지 변환, 모델 매핑 (passthrough 포함), SSE 청크 포맷, 에러 포맷        |
| Drain 거부                   | `router.test.ts` (확장)         | isDraining=true 시 503 응답, isDraining=false 시 정상 라우팅                                |
| liveness/readiness 헬스 체크 | `health.test.ts`                | liveness 항상 200, readiness 200/503, Provider TTL 캐시, 컴포넌트 집계                      |
| 요청 Rate limiting           | `rate-limit.test.ts`            | 윈도우 내 카운팅, 초과 거부, retryAfterMs, MAX_KEYS evict, toRateLimitHeaders               |
| 액세스 로그                  | `access-log.test.ts`            | JSON 포맷, requestId 생성/전달, sanitizePath, X-Request-Id 헤더                             |

### 검증 커맨드

```bash
# 단위 테스트 (개별)
pnpm vitest run src/gateway/hot-reload.test.ts
pnpm vitest run src/gateway/broadcaster.test.ts
pnpm vitest run src/gateway/openai-compat/adapter.test.ts
pnpm vitest run src/gateway/health.test.ts
pnpm vitest run src/gateway/rate-limit.test.ts
pnpm vitest run src/gateway/access-log.test.ts

# 전체 게이트웨이 테스트
pnpm vitest run src/gateway/

# 타입 체크
pnpm tsc --build

# 커버리지 목표: statements 85%, branches 80%
pnpm vitest run --coverage src/gateway/
```

### 통합 검증 시나리오

```typescript
// E2E: OpenAI 호환 API (feature flag 활성화 시)
it('POST /v1/chat/completions — 동기 응답', async () => {
  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${testToken}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o', // → claude-sonnet-4로 매핑
      messages: [{ role: 'user', content: '삼성전자 주가' }],
    }),
  });

  const data = await res.json();
  expect(data.object).toBe('chat.completion');
  expect(data.choices[0].message.role).toBe('assistant');
});

// E2E: Drain 거부
it('isDraining=true 시 HTTP 503 응답', async () => {
  ctx.isDraining = true;
  const res = await fetch(`http://localhost:${port}/rpc`, { method: 'POST', body: '{}' });
  expect(res.status).toBe(503);
});
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                       |
| ----------------- | ------------------------ |
| **복잡도**        | **L**                    |
| 신규 소스 파일    | 6                        |
| 수정 소스 파일    | 5                        |
| 테스트 파일       | 6 (신규 5 + 기존 확장 1) |
| **합계**          | **~17 파일**             |
| 예상 LOC (소스)   | 600 ~ 800                |
| 예상 LOC (테스트) | 700 ~ 900                |
| 신규 의존성       | `chokidar` (파일 감시)   |

---

## 9. 구현 순서

구현 시 의존 관계를 고려한 권장 순서:

| 단계 | 작업                                         | 검증                                       |
| ---- | -------------------------------------------- | ------------------------------------------ |
| 1    | `rpc/types.ts` — GatewayServerConfig 확장    | `tsc --build`                              |
| 2    | `context.ts` — `isDraining: boolean` 추가    | `tsc --build`                              |
| 3    | `server.ts` — `stop()`에 `isDraining = true` | 기존 `server.test.ts` 통과                 |
| 4    | `router.ts` — drain 503 체크 추가            | `router.test.ts` 확장                      |
| 5    | `rate-limit.ts` + 테스트                     | `rate-limit.test.ts` 통과                  |
| 6    | `access-log.ts` + 테스트                     | `access-log.test.ts` 통과                  |
| 7    | `health.ts` + 테스트 + router 라우트 추가    | `health.test.ts` 통과                      |
| 8    | `broadcaster.ts` 확장 + 테스트 확장          | `broadcaster.test.ts` 통과                 |
| 9    | `hot-reload.ts` + 테스트                     | `hot-reload.test.ts` 통과                  |
| 10   | `openai-compat/` + 테스트                    | `adapter.test.ts` 통과, 전체 `tsc --build` |

---

## 10. 환경 변수

| 변수                      | 용도                            | 기본값          |
| ------------------------- | ------------------------------- | --------------- |
| `GATEWAY_JWT_SECRET`      | JWT 서명 키 (기존 Phase 10)     | `dev-secret`    |
| `OPENAI_COMPAT_ENABLED`   | OpenAI compat 엔드포인트 활성화 | `false`         |
| `HOT_RELOAD_CONFIG_PATH`  | hot-reload 감시 대상 파일 경로  | (없으면 비활성) |
| `RATE_LIMIT_MAX_REQUESTS` | 분당 최대 요청 수               | `60`            |
| `RATE_LIMIT_WINDOW_MS`    | rate limit 윈도우 크기 (ms)     | `60000`         |

---

## 11. 리스크 및 범위 제한

### 리스크

| 리스크                             | 완화 방안                                   |
| ---------------------------------- | ------------------------------------------- |
| chokidar WSL2 cross-fs 이벤트 누락 | `mode: 'poll'` 옵션으로 폴링 모드 전환 가능 |
| rate limiter 메모리 증가           | `MAX_KEYS` 10,000 상한 + 5분 주기 cleanup   |
| Provider 헬스 체크 타임아웃        | TTL 60초 캐시로 빈번한 외부 호출 방지       |
| OpenAI 모델 매핑 불일치            | 미지원 모델은 undefined 반환 → 400 에러     |

### 포함하지 않는 것

- **mDNS/Bonjour 서비스 디스커버리** — 향후 Phase
- **토큰 기반 rate limiting** (요청 수가 아닌 토큰 소비 기반) — 향후 Phase
- **WebSocket rate limiting** — 현재는 HTTP 요청만 대상
- **분산 rate limiting** (Redis 등) — 단일 인스턴스 전제
- **OpenAI API 전체 호환** — `/v1/chat/completions`만 구현
- **Hot-reload 디렉토리 감시** — 단일 파일만 대상 (v0.1)
