# Phase 11: 게이트웨이 서버 - 고급 기능 (Gateway Server: Advanced)

> **복잡도: L** | 소스 ~8 파일 | 테스트 ~7 파일 | 합계 ~15 파일

---

## 1. 목표

Phase 10에서 구축한 게이트웨이 코어 위에 운영 수준의 고급 기능을 추가한다. OpenClaw 게이트웨이의 프로덕션 기능들을 참조하여, 실제 서비스 운영에 필요한 안정성과 호환성을 확보한다:

- **Config hot-reload**: `chokidar` 파일 감시 → 변경 감지 → 유효성 검증 → 연결된 클라이언트에 브로드캐스트
- **WebSocket 브로드캐스트**: 전체 또는 구독 기반 필터링으로 이벤트를 다수 클라이언트에 팬아웃
- **OpenAI 호환 API**: `/v1/chat/completions` 엔드포인트로 기존 OpenAI 클라이언트와의 호환성 제공
- **Graceful shutdown**: 30초 드레인 기간, 진행 중인 요청 완료 대기, 연결 순차 종료
- **헬스 체크**: `/health` 엔드포인트에 상세 시스템 상태 정보 (DB, LLM provider, 메모리 등)
- **Rate limiting**: 클라이언트 별 요청 제한으로 과부하 방지
- **요청 로깅**: 구조화된 JSON 액세스 로그

---

## 2. OpenClaw 참조

| OpenClaw 경로                                                      | 적용 패턴                                          |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| `openclaw_review/deep-dive/03-gateway-server.md` (hot-reload 섹션) | chokidar 파일 감시 → validate → broadcast 패턴     |
| `openclaw_review/deep-dive/03` (graceful shutdown 섹션)            | 30초 드레인, in-flight 요청 완료 대기, 시그널 처리 |
| `openclaw_review/deep-dive/03` (OpenAI compat 섹션)                | /v1/chat/completions 어댑터 패턴, 요청/응답 변환   |
| `openclaw_review/deep-dive/03` (broadcast 섹션)                    | WebSocket 팬아웃, 구독 기반 필터링                 |
| `openclaw_review/docs/` (서버 설정 관련)                           | 설정 파일 구조, hot-reload 트리거 방식             |

**OpenClaw 차이점:**

- mDNS/Bonjour 서비스 디스커버리 → FinClaw v0.1에서는 제외 (향후 Phase에서 추가 가능)
- OpenAI compat: 전체 API 호환 → 금융 도메인에 필요한 `/v1/chat/completions`만 구현
- Rate limiting: 복잡한 토큰 버킷 → 간단한 슬라이딩 윈도우 방식
- 금융 특화: 시세 데이터 브로드캐스트 채널 추가

---

## 3. 생성할 파일

### 소스 파일 (`src/gateway/`)

| 파일 경로                              | 설명                                             |
| -------------------------------------- | ------------------------------------------------ |
| `src/gateway/hot-reload.ts`            | 설정 파일 감시 + 변경 감지 + 검증 + 브로드캐스트 |
| `src/gateway/broadcast.ts`             | WebSocket 팬아웃 (전체/구독 필터링)              |
| `src/gateway/openai-compat/router.ts`  | `/v1/chat/completions` HTTP 라우트               |
| `src/gateway/openai-compat/adapter.ts` | OpenAI ↔ FinClaw 요청/응답 변환기                |
| `src/gateway/shutdown.ts`              | Graceful shutdown 매니저 (시그널 + 드레인)       |
| `src/gateway/health.ts`                | 상세 헬스 체크 (컴포넌트별 상태)                 |
| `src/gateway/rate-limit.ts`            | 슬라이딩 윈도우 기반 요청 제한                   |
| `src/gateway/access-log.ts`            | 구조화된 JSON 액세스 로그                        |

### 테스트 파일

| 파일 경로                                   | 테스트 대상                                      |
| ------------------------------------------- | ------------------------------------------------ |
| `src/gateway/hot-reload.test.ts`            | 파일 변경 감지, 설정 검증, 브로드캐스트 (unit)   |
| `src/gateway/broadcast.test.ts`             | 전체 팬아웃, 구독 필터, 연결 해제 시 정리 (unit) |
| `src/gateway/openai-compat/adapter.test.ts` | 요청/응답 변환, 스트리밍 SSE 포맷 (unit)         |
| `src/gateway/shutdown.test.ts`              | 드레인 시퀀스, 타임아웃 처리 (unit)              |
| `src/gateway/health.test.ts`                | 컴포넌트 상태 집계, degraded 판정 (unit)         |
| `src/gateway/rate-limit.test.ts`            | 윈도우 계산, 초과 시 거부 (unit)                 |
| `src/gateway/access-log.test.ts`            | 로그 포맷, 민감 정보 마스킹 (unit)               |

---

## 4. 핵심 인터페이스/타입

### Hot-reload 타입

```typescript
/** 설정 변경 이벤트 */
export interface ConfigChangeEvent {
  readonly path: string; // 변경된 파일 경로
  readonly changeType: 'modified' | 'added' | 'removed';
  readonly timestamp: number;
  readonly previousHash: string; // 변경 전 SHA-256
  readonly currentHash: string; // 변경 후 SHA-256
}

/** Hot-reload 설정 */
export interface HotReloadConfig {
  readonly configPath: string; // 감시할 설정 파일/디렉토리 경로
  readonly debounceMs: number; // 변경 디바운스 (기본 500ms)
  readonly validateBeforeApply: boolean; // 적용 전 유효성 검증 (기본 true)
}

/** Hot-reload 매니저 인터페이스 */
export interface HotReloadManager {
  start(): void;
  stop(): void;
  on(event: 'change', listener: (e: ConfigChangeEvent) => void): void;
  on(event: 'error', listener: (e: Error) => void): void;
}
```

### 브로드캐스트 타입

```typescript
/** 브로드캐스트 채널 */
export type BroadcastChannel =
  | 'config.updated' // 설정 변경 알림
  | 'session.event' // 세션 상태 변경
  | 'system.status' // 시스템 상태 알림
  | 'market.tick'; // 실시간 시세 (금융 특화)

/** 브로드캐스트 메시지 */
export interface BroadcastMessage {
  readonly channel: BroadcastChannel;
  readonly data: unknown;
  readonly timestamp: number;
}

/** 브로드캐스트 옵션 */
export interface BroadcastOptions {
  readonly channel?: BroadcastChannel; // 특정 채널 구독자만
  readonly exclude?: readonly string[]; // 제외할 연결 ID
  readonly filter?: (conn: WsConnection) => boolean; // 커스텀 필터
}
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
```

### Graceful shutdown 타입

```typescript
/** Shutdown 매니저 설정 */
export interface ShutdownConfig {
  readonly drainTimeoutMs: number; // 드레인 대기 시간 (기본 30_000)
  readonly forceTimeoutMs: number; // 강제 종료 시간 (기본 35_000)
  readonly signals: readonly NodeJS.Signals[]; // 감시할 시그널 (기본 ['SIGINT', 'SIGTERM'])
}

/** Shutdown 상태 */
export type ShutdownPhase =
  | 'running' // 정상 운영 중
  | 'draining' // 신규 요청 거부, 진행 중 요청 완료 대기
  | 'closing' // WebSocket 연결 종료 중
  | 'stopped'; // 완전 종료

/** Shutdown 이벤트 */
export type ShutdownEvent =
  | { readonly type: 'phase_change'; readonly from: ShutdownPhase; readonly to: ShutdownPhase }
  | { readonly type: 'request_drained'; readonly remaining: number }
  | { readonly type: 'connection_closed'; readonly connectionId: string }
  | { readonly type: 'force_shutdown'; readonly reason: string };
```

### Rate limit 타입

```typescript
/** Rate limit 설정 */
export interface RateLimitConfig {
  readonly windowMs: number; // 윈도우 크기 (기본 60_000 = 1분)
  readonly maxRequests: number; // 윈도우 내 최대 요청 수 (기본 60)
  readonly keyExtractor: (ctx: RpcContext) => string; // 클라이언트 식별 키
}

/** Rate limit 상태 */
export interface RateLimitInfo {
  readonly remaining: number; // 남은 요청 수
  readonly limit: number; // 최대 요청 수
  readonly resetAt: number; // 윈도우 리셋 시각 (epoch ms)
  readonly retryAfterMs?: number; // 초과 시 재시도까지 대기 시간
}
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

/** 전체 시스템 헬스 */
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
```

---

## 5. 구현 상세

### 5.1 Config Hot-reload (`hot-reload.ts`)

`chokidar`로 설정 파일을 감시하고, 변경 시 유효성 검증 후 활성 클라이언트에 브로드캐스트한다.

```typescript
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import type { ConfigChangeEvent, HotReloadConfig, HotReloadManager } from './types.js';
import { broadcast } from './broadcast.js';

export function createHotReloader(config: HotReloadConfig): HotReloadManager {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHash = '';

  const listeners = {
    change: new Set<(e: ConfigChangeEvent) => void>(),
    error: new Set<(e: Error) => void>(),
  };

  /** 파일 해시 계산 */
  async function computeHash(filePath: string): Promise<string> {
    const content = await readFile(filePath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  }

  /** 설정 유효성 검증 */
  async function validateConfig(filePath: string): Promise<boolean> {
    try {
      const content = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);
      // Zod 스키마로 검증 (Phase 4의 config 스키마 활용)
      // configSchema.parse(parsed);
      return true;
    } catch (error) {
      for (const listener of listeners.error) {
        listener(new Error(`Config validation failed: ${(error as Error).message}`));
      }
      return false;
    }
  }

  /** 변경 처리 (디바운스 적용) */
  function handleChange(filePath: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(async () => {
      try {
        const currentHash = await computeHash(filePath);

        // 실제 내용이 변경된 경우만 처리
        if (currentHash === lastHash) return;

        // 유효성 검증
        if (config.validateBeforeApply) {
          const valid = await validateConfig(filePath);
          if (!valid) return;
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

        // 연결된 클라이언트에 브로드캐스트
        broadcast({
          channel: 'config.updated',
          data: { path: filePath, timestamp: event.timestamp },
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
    start(): void {
      watcher = watch(config.configPath, {
        persistent: true,
        ignoreInitial: true,
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

    on(event, listener) {
      listeners[event].add(listener as any);
    },
  };
}
```

### 5.2 WebSocket 브로드캐스트 (`broadcast.ts`)

```typescript
import type { BroadcastMessage, BroadcastOptions, WsConnection } from './types.js';
import { getConnections } from './ws/connection.js';

/**
 * WebSocket 연결된 클라이언트에 메시지를 팬아웃한다.
 *
 * 필터링 우선순위:
 * 1. channel 구독 여부
 * 2. exclude 목록
 * 3. 커스텀 filter 함수
 */
export function broadcast(message: BroadcastMessage, options?: BroadcastOptions): number {
  const connections = getConnections();
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: `notification.${message.channel}`,
    params: {
      data: message.data,
      timestamp: message.timestamp,
    },
  });

  let sentCount = 0;
  const excludeSet = new Set(options?.exclude ?? []);

  for (const [id, conn] of connections) {
    // 제외 목록 확인
    if (excludeSet.has(id)) continue;

    // 채널 구독 확인
    if (options?.channel && !conn.subscriptions.has(options.channel)) continue;

    // 커스텀 필터
    if (options?.filter && !options.filter(conn)) continue;

    // 연결 상태 확인 후 전송
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(payload);
      sentCount++;
    }
  }

  return sentCount;
}

/**
 * 특정 연결의 구독 채널 관리
 */
export function subscribe(connectionId: string, channel: string): boolean {
  const connections = getConnections();
  const conn = connections.get(connectionId);
  if (!conn) return false;
  conn.subscriptions.add(channel);
  return true;
}

export function unsubscribe(connectionId: string, channel: string): boolean {
  const connections = getConnections();
  const conn = connections.get(connectionId);
  if (!conn) return false;
  conn.subscriptions.delete(channel);
  return true;
}
```

### 5.3 OpenAI 호환 API (`openai-compat/`)

기존 OpenAI SDK 클라이언트가 FinClaw를 직접 호출할 수 있도록 호환 레이어를 제공한다.

```typescript
// openai-compat/router.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticate } from '../auth/index.js';
import { adaptRequest, adaptResponse, adaptStreamChunk } from './adapter.js';

/**
 * POST /v1/chat/completions
 *
 * OpenAI API 호환 엔드포인트.
 * 요청을 FinClaw 내부 포맷으로 변환 → 실행 엔진 호출 → 응답을 OpenAI 포맷으로 변환
 */
export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 인증
  const authResult = await authenticate(req, config.auth);
  if (!authResult.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: authResult.error, type: 'auth_error' } }));
    return;
  }

  const body = await readBody(req);
  const openaiRequest: OpenAIChatRequest = JSON.parse(body);

  // FinClaw 내부 포맷으로 변환
  const internalRequest = adaptRequest(openaiRequest);

  if (openaiRequest.stream) {
    // SSE 스트리밍 응답
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const listener = (event: StreamEvent) => {
      const chunk = adaptStreamChunk(event, openaiRequest.model);
      if (chunk) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    };

    const result = await runner.execute(internalRequest, listener);

    // 마지막 chunk: [DONE]
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    // 동기 응답
    const result = await runner.execute(internalRequest);
    const openaiResponse = adaptResponse(result, openaiRequest.model);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(openaiResponse));
  }
}

// openai-compat/adapter.ts

import { randomUUID } from 'node:crypto';
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIStreamChunk,
  OpenAIMessage,
  ExecutionRequest,
  ExecutionResult,
  StreamEvent,
} from '../types.js';

/**
 * OpenAI 요청 → FinClaw 내부 요청 변환
 */
export function adaptRequest(openai: OpenAIChatRequest): ExecutionRequest {
  // system 메시지를 시스템 프롬프트로 분리
  const systemMessages = openai.messages.filter((m) => m.role === 'system');
  const otherMessages = openai.messages.filter((m) => m.role !== 'system');

  return {
    agentId: 'openai-compat',
    conversationId: randomUUID(),
    messages: otherMessages.map(convertMessage),
    tools: openai.tools?.map(convertTool) ?? [],
    model: {
      modelId: mapModelId(openai.model),
      maxTokens: openai.max_tokens ?? 4096,
      temperature: openai.temperature,
    },
    systemPrompt: systemMessages.map((m) => m.content).join('\n'),
  };
}

/**
 * FinClaw 실행 결과 → OpenAI 응답 변환
 */
export function adaptResponse(result: ExecutionResult, model: string): OpenAIChatResponse {
  const lastAssistantMessage = result.messages.filter((m) => m.role === 'assistant').at(-1);

  return {
    id: `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: extractTextContent(lastAssistantMessage),
          tool_calls: extractToolCalls(lastAssistantMessage),
        },
        finish_reason: result.status === 'completed' ? 'stop' : 'length',
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.totalTokens,
    },
  };
}

/**
 * 스트리밍 이벤트 → OpenAI SSE 청크 변환
 */
export function adaptStreamChunk(event: StreamEvent, model: string): OpenAIStreamChunk | null {
  if (event.type === 'text_delta') {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { content: event.delta },
          finish_reason: null,
        },
      ],
    };
  }

  if (event.type === 'done') {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
    };
  }

  return null;
}

/** OpenAI 모델 ID → FinClaw 모델 ID 매핑 */
function mapModelId(openaiModel: string): string {
  const mapping: Record<string, string> = {
    'gpt-4o': 'claude-sonnet-4-20250514',
    'gpt-4o-mini': 'claude-haiku-4-20250414',
    'gpt-4-turbo': 'claude-sonnet-4-20250514',
  };
  return mapping[openaiModel] ?? openaiModel;
}
```

### 5.4 Graceful Shutdown (`shutdown.ts`)

프로세스 종료 시 진행 중인 요청을 안전하게 완료하고 리소스를 정리한다.

```typescript
import type { GatewayServer } from './server.js';
import type { ShutdownConfig, ShutdownPhase, ShutdownEvent } from './types.js';
import { ChatRegistry } from './registry.js';
import { EventEmitter } from 'node:events';

export class ShutdownManager {
  private phase: ShutdownPhase = 'running';
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly server: GatewayServer,
    private readonly registry: ChatRegistry,
    private readonly config: ShutdownConfig = {
      drainTimeoutMs: 30_000,
      forceTimeoutMs: 35_000,
      signals: ['SIGINT', 'SIGTERM'],
    },
  ) {}

  /** 시그널 핸들러 등록 */
  install(): void {
    const handler = () => this.initiate();
    for (const signal of this.config.signals) {
      process.on(signal, handler);
    }
  }

  /**
   * Graceful shutdown 시퀀스:
   *
   * 1. running → draining: 신규 요청 거부 시작
   * 2. 활성 세션 완료 대기 (최대 drainTimeoutMs)
   * 3. draining → closing: WebSocket 연결 순차 종료
   * 4. closing → stopped: HTTP 서버 종료
   * 5. forceTimeoutMs 초과 시 강제 종료
   */
  async initiate(): Promise<void> {
    if (this.phase !== 'running') return;

    console.log('[shutdown] Initiating graceful shutdown...');

    // Phase 1: draining
    this.transition('draining');

    // 강제 종료 타이머
    const forceTimer = setTimeout(() => {
      console.error('[shutdown] Force shutdown: timeout exceeded');
      this.emitter.emit('event', {
        type: 'force_shutdown',
        reason: `Timeout after ${this.config.forceTimeoutMs}ms`,
      } satisfies ShutdownEvent);
      process.exit(1);
    }, this.config.forceTimeoutMs);

    // Phase 2: 활성 세션 드레인 대기
    await this.drainSessions();

    // Phase 3: WebSocket 연결 종료
    this.transition('closing');
    await this.closeConnections();

    // Phase 4: HTTP 서버 종료
    await this.server.stop();
    this.transition('stopped');

    clearTimeout(forceTimer);
    console.log('[shutdown] Graceful shutdown complete');
    process.exit(0);
  }

  /** 활성 세션 완료 대기 */
  private async drainSessions(): Promise<void> {
    const startTime = Date.now();

    while (this.registry.activeCount() > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.config.drainTimeoutMs) {
        console.warn(`[shutdown] Drain timeout: ${this.registry.activeCount()} sessions remaining`);
        // 남은 세션 강제 중단
        this.registry.stopAll();
        break;
      }

      this.emitter.emit('event', {
        type: 'request_drained',
        remaining: this.registry.activeCount(),
      } satisfies ShutdownEvent);

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** WebSocket 연결 순차 종료 */
  private async closeConnections(): Promise<void> {
    for (const client of this.server.wss.clients) {
      client.close(1001, 'Server shutting down');
      this.emitter.emit('event', {
        type: 'connection_closed',
        connectionId: 'unknown',
      } satisfies ShutdownEvent);
    }

    // 연결 종료 완료 대기 (최대 5초)
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  private transition(to: ShutdownPhase): void {
    const from = this.phase;
    this.phase = to;
    this.emitter.emit('event', { type: 'phase_change', from, to } satisfies ShutdownEvent);
  }

  get currentPhase(): ShutdownPhase {
    return this.phase;
  }

  on(listener: (event: ShutdownEvent) => void): void {
    this.emitter.on('event', listener);
  }
}
```

### 5.5 상세 헬스 체크 (`health.ts`)

```typescript
import type { ComponentHealth, SystemHealth } from './types.js';

type HealthChecker = () => Promise<ComponentHealth>;

const checkers: HealthChecker[] = [];

/** 헬스 체커 등록 */
export function registerHealthChecker(checker: HealthChecker): void {
  checkers.push(checker);
}

/** 전체 시스템 헬스 집계 */
export async function checkHealth(): Promise<SystemHealth> {
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

  // 전체 상태 결정: 하나라도 unhealthy면 error, degraded면 degraded
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
    activeSessions: 0, // ChatRegistry에서 주입
    connections: 0, // WSS에서 주입
    timestamp: Date.now(),
  };
}

// --- 기본 헬스 체커 예시 ---

/** SQLite DB 헬스 체커 */
export function createDbHealthChecker(dbPath: string): HealthChecker {
  return async () => {
    const start = Date.now();
    try {
      // DB 연결 테스트 쿼리
      // await db.exec('SELECT 1');
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

/** LLM Provider 헬스 체커 */
export function createProviderHealthChecker(providerName: string): HealthChecker {
  return async () => {
    const start = Date.now();
    try {
      // Provider 헬스 엔드포인트 호출 또는 간단한 API 테스트
      return {
        name: `provider:${providerName}`,
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    } catch (error) {
      return {
        name: `provider:${providerName}`,
        status: 'degraded',
        message: (error as Error).message,
        latencyMs: Date.now() - start,
        lastCheckedAt: Date.now(),
      };
    }
  };
}
```

### 5.6 Rate Limiting (`rate-limit.ts`)

슬라이딩 윈도우 알고리즘으로 클라이언트별 요청 수를 제한한다.

```typescript
import type { RateLimitConfig, RateLimitInfo } from './types.js';

interface WindowEntry {
  timestamps: number[];
  windowStart: number;
}

/**
 * 슬라이딩 윈도우 rate limiter.
 *
 * 각 클라이언트(키 기준)에 대해 최근 windowMs 동안의 요청 수를 추적한다.
 * 메모리 누수 방지를 위해 만료된 엔트리를 주기적으로 정리한다.
 */
export class RateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor(private readonly config: RateLimitConfig) {
    // 5분마다 만료된 윈도우 정리
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60_000);
  }

  /**
   * 요청 허용 여부 확인 및 카운터 증가
   * @returns 허용 시 { allowed: true, info }, 거부 시 { allowed: false, info }
   */
  check(key: string): { allowed: boolean; info: RateLimitInfo } {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [], windowStart: now };
      this.windows.set(key, entry);
    }

    // 윈도우 밖의 타임스탬프 제거
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const info: RateLimitInfo = {
      remaining: Math.max(0, this.config.maxRequests - entry.timestamps.length),
      limit: this.config.maxRequests,
      resetAt: now + this.config.windowMs,
    };

    if (entry.timestamps.length >= this.config.maxRequests) {
      // 가장 오래된 요청이 만료될 때까지의 시간
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

    // 요청 기록
    entry.timestamps.push(now);

    return { allowed: true, info };
  }

  /** 만료된 윈도우 정리 */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > now - this.config.windowMs);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }

  /** 리소스 해제 */
  dispose(): void {
    clearInterval(this.cleanupInterval);
    this.windows.clear();
  }
}
```

### 5.7 액세스 로그 (`access-log.ts`)

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 구조화된 액세스 로그 엔트리 */
export interface AccessLogEntry {
  readonly timestamp: string; // ISO 8601
  readonly method: string; // HTTP method
  readonly path: string; // 요청 경로
  readonly statusCode: number; // 응답 상태 코드
  readonly durationMs: number; // 요청 처리 시간
  readonly remoteAddress: string; // 클라이언트 IP
  readonly userAgent: string; // User-Agent 헤더
  readonly contentLength: number; // 응답 크기 (bytes)
  readonly rpcMethod?: string; // JSON-RPC 메서드 (해당 시)
  readonly authLevel?: string; // 인증 레벨
}

/** 민감 헤더 마스킹 */
const MASKED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie']);

/**
 * HTTP 요청/응답을 JSON 포맷으로 로깅한다.
 * express 등 프레임워크 없이 순수 Node.js http로 동작한다.
 */
export function logAccess(
  req: IncomingMessage,
  res: ServerResponse,
  extra?: { rpcMethod?: string; authLevel?: string },
): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const entry: AccessLogEntry = {
      timestamp: new Date().toISOString(),
      method: req.method ?? 'UNKNOWN',
      path: req.url ?? '/',
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime,
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
      userAgent: (req.headers['user-agent'] as string) ?? '',
      contentLength: Number(res.getHeader('content-length') ?? 0),
      rpcMethod: extra?.rpcMethod,
      authLevel: extra?.authLevel,
    };

    // stdout에 JSON 형태로 출력 (로그 수집기 연동 용이)
    process.stdout.write(JSON.stringify(entry) + '\n');
  });
}
```

### 데이터 흐름 다이어그램

```
┌────────────────────────────────────────────────────┐
│               Gateway Server (Phase 10)            │
│  ┌──────────────────────────────────────────────┐  │
│  │            Phase 11 고급 기능                  │  │
│  │                                              │  │
│  │  ┌─────────────┐    ┌──────────────────┐    │  │
│  │  │ Rate Limiter │───▶│ Access Logger    │    │  │
│  │  │ (per-client) │    │ (JSON stdout)    │    │  │
│  │  └─────────────┘    └──────────────────┘    │  │
│  │                                              │  │
│  │  ┌─────────────┐    ┌──────────────────┐    │  │
│  │  │ Hot Reload  │───▶│ Broadcast        │    │  │
│  │  │ (chokidar)  │    │ (fan-out to WS)  │    │  │
│  │  └─────────────┘    └──────────────────┘    │  │
│  │                                              │  │
│  │  ┌─────────────┐    ┌──────────────────┐    │  │
│  │  │ OpenAI      │    │ Graceful         │    │  │
│  │  │ Compat API  │    │ Shutdown Mgr     │    │  │
│  │  │ /v1/chat/*  │    │ (drain+close)    │    │  │
│  │  └─────────────┘    └──────────────────┘    │  │
│  │                                              │  │
│  │  ┌──────────────────────────────────────┐   │  │
│  │  │ Health Check                          │   │  │
│  │  │ DB ✓ | Provider ✓ | Memory ✓         │   │  │
│  │  └──────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘

Config File ──(chokidar watch)──▶ Hot Reload ──▶ Validate ──▶ Broadcast
                                                                  │
                                                                  ▼
                                                    All WS Clients (config.updated)

SIGINT/SIGTERM ──▶ Shutdown Manager
                      │
                      ├─ 1. Stop accepting requests (draining)
                      ├─ 2. Wait for active sessions (max 30s)
                      ├─ 3. Close WS connections (closing)
                      └─ 4. Stop HTTP server (stopped)
```

---

## 6. 선행 조건

| Phase        | 구체적 산출물                                   | 필요 이유                                             |
| ------------ | ----------------------------------------------- | ----------------------------------------------------- |
| **Phase 10** | `src/gateway/server.ts` - HTTP + WebSocket 서버 | 모든 고급 기능이 서버 인스턴스에 통합되어야 함        |
| **Phase 10** | `src/gateway/rpc/index.ts` - JSON-RPC 디스패처  | OpenAI compat가 내부적으로 실행 엔진을 호출할 때 사용 |
| **Phase 10** | `src/gateway/ws/connection.ts` - WS 연결 관리   | 브로드캐스트가 연결 목록에 접근해야 함                |
| **Phase 10** | `src/gateway/registry.ts` - Chat 레지스트리     | Graceful shutdown이 활성 세션을 드레인해야 함         |
| **Phase 9**  | `src/execution/runner.ts` - 실행 엔진           | OpenAI compat API가 실행 엔진을 호출                  |
| **Phase 9**  | `src/execution/streaming.ts` - 스트리밍 이벤트  | OpenAI SSE 스트리밍 변환에 필요                       |
| **Phase 4**  | `src/config/schema.ts` - 설정 스키마            | Hot-reload 시 변경된 설정의 유효성 검증에 사용        |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| 산출물                  | 검증 방법                                                               |
| ----------------------- | ----------------------------------------------------------------------- |
| Config hot-reload       | unit: 파일 변경 감지 mock, 디바운스 동작, 해시 비교, 무효 설정 거부     |
| WebSocket 브로드캐스트  | unit: 전체 팬아웃 수 확인, 구독 필터, exclude 목록, 끊긴 연결 건너뛰기  |
| OpenAI compat 요청 변환 | unit: OpenAI → FinClaw 메시지 변환, 모델 ID 매핑                        |
| OpenAI compat 응답 변환 | unit: FinClaw → OpenAI 응답 변환, SSE 청크 포맷                         |
| Graceful shutdown       | unit: 4단계 전이 (running→draining→closing→stopped), 타임아웃 강제 종료 |
| 상세 헬스 체크          | unit: 컴포넌트 상태 집계, degraded 판정 로직, 메모리 정보               |
| Rate limiting           | unit: 윈도우 내 요청 카운팅, 초과 시 거부, retryAfterMs 계산, 만료 정리 |
| 액세스 로그             | unit: JSON 포맷, 민감 헤더 마스킹, 소요 시간 계산                       |

### 검증 기준

```bash
# 단위 테스트
pnpm test -- src/gateway/hot-reload src/gateway/broadcast src/gateway/openai-compat src/gateway/shutdown src/gateway/health src/gateway/rate-limit src/gateway/access-log

# 커버리지 목표: statements 85%, branches 80%
pnpm test:coverage -- src/gateway/
```

### 통합 검증 시나리오

```typescript
// E2E: OpenAI 호환 API
it('POST /v1/chat/completions - 동기 응답', async () => {
  const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${testToken}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o', // → claude-sonnet-4로 매핑됨
      messages: [{ role: 'user', content: '삼성전자 주가' }],
    }),
  });

  const data = await res.json();
  expect(data.object).toBe('chat.completion');
  expect(data.choices[0].message.role).toBe('assistant');
});

// E2E: Graceful shutdown
it('SIGTERM 시 활성 세션 드레인 후 종료', async () => {
  // 1. 서버 시작 + 활성 세션 생성
  // 2. SIGTERM 전송
  // 3. 진행 중인 요청이 완료될 때까지 대기
  // 4. 서버가 깨끗하게 종료됨을 확인
});
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                     |
| ----------------- | ---------------------- |
| **복잡도**        | **L**                  |
| 소스 파일         | 8                      |
| 테스트 파일       | 7                      |
| **합계**          | **~15 파일**           |
| 예상 LOC (소스)   | 800 ~ 1,000            |
| 예상 LOC (테스트) | 700 ~ 900              |
| 신규 의존성       | `chokidar` (파일 감시) |
| 예상 구현 시간    | 2-3일                  |
