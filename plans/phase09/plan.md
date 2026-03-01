# Phase 9: 실행 엔진 (Execution Engine)

> **복잡도: L** | 소스 6(신규) + 4(수정) | 테스트 4 | 합계 ~14 파일

---

## 1. 목표

LLM 호출 → 도구 실행 → 응답 반환의 전체 실행 루프를 구현한다. OpenClaw의 Pi 실행 엔진(80 파일, 14K LOC)을 금융 도메인에 맞게 경량화하여, 다음 핵심 능력을 확보한다:

- **Main Runner**: 사용자 메시지를 받아 LLM 호출 → tool_use 감지 → 도구 실행 → 후속 LLM 호출을 반복하는 오케스트레이션 루프
- **재시도 로직**: `@finclaw/infra`의 `retry()` + `classifyFallbackError()` 통합
- **스트리밍 상태 머신**: `idle → streaming → tool_use → executing → streaming → done` 상태 전이 관리
- **Provider 스트리밍**: 기존 `ProviderAdapter`에 `streamCompletion()` 메서드 추가
- **도구 실행기**: 등록된 tool handler에 도구 호출을 디스패치
- **동시성 제어**: `@finclaw/infra`의 `ConcurrencyLaneManager` 직접 사용
- **토큰 카운터**: `ModelRef.contextWindow` 기반 동적 컨텍스트 윈도우 관리 + 임계값 경고(80%/95%)
- **Prompt Caching**: 시스템 프롬프트 + 도구 정의에 `cache_control` 적용

---

## 2. OpenClaw 참조

| OpenClaw 경로                                        | 적용 패턴                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `openclaw_review/deep-dive/05-agent-pi-embedding.md` | Main runner 루프, attempt 재시도, 스트리밍 상태 머신 전체 아키텍처 |
| `openclaw_review/deep-dive/05` (streaming 섹션)      | idle → streaming → tool_use → executing → done 상태 전이           |
| `openclaw_review/deep-dive/05` (provider 섹션)       | Anthropic 네이티브 + OpenAI 어댑터 패턴                            |
| `openclaw_review/docs/` (architecture 관련)          | 전체 모듈 간 의존성 구조                                           |

**OpenClaw 차이점:**

- Bash tool의 4가지 호스트 타입(local, Docker, SSH, WebSocket) → FinClaw는 local 전용으로 축소
- Gemini provider → 제외 (Anthropic + OpenAI만 지원)
- 80 파일 규모 → ~14 파일로 경량화, 기존 인프라(`retry`, `ConcurrencyLaneManager`, `classifyFallbackError`) 재사용

---

## 3. 파일 목록

### 신규 소스 파일 (`packages/agent/src/execution/`)

| 파일 경로                                           | 설명                                               |
| --------------------------------------------------- | -------------------------------------------------- |
| `packages/agent/src/execution/index.ts`             | 모듈 public API re-export                          |
| `packages/agent/src/execution/runner.ts`            | Main runner - LLM ↔ tool 오케스트레이션 루프       |
| `packages/agent/src/execution/streaming.ts`         | 스트리밍 상태 머신 + EventEmitter 기반 이벤트 발행 |
| `packages/agent/src/execution/tool-executor.ts`     | 도구 호출 디스패치 및 결과 수집                    |
| `packages/agent/src/execution/tokens.ts`            | 토큰 카운팅 및 컨텍스트 윈도우 관리                |
| `packages/agent/src/execution/tool-input-buffer.ts` | 도구 입력 JSON 스트리밍 조합 버퍼                  |

**삭제된 파일 (기존 인프라로 대체):**

| 원래 계획                | 대체                                                        |
| ------------------------ | ----------------------------------------------------------- |
| `attempts.ts`            | `@finclaw/infra`의 `retry()`                                |
| `lanes.ts`               | `@finclaw/infra`의 `ConcurrencyLaneManager`                 |
| `normalizer.ts`          | `packages/agent/src/models/provider-normalize.ts` 이미 존재 |
| `providers/index.ts`     | `packages/agent/src/providers/adapter.ts` 이미 존재         |
| `providers/anthropic.ts` | 기존 `AnthropicAdapter`에 메서드 추가                       |
| `providers/openai.ts`    | 기존 `OpenAIAdapter`에 메서드 추가                          |
| `providers/types.ts`     | `ProviderAdapter` 인터페이스 확장                           |

### 수정할 파일

| 파일 경로                                         | 변경 내용                                        |
| ------------------------------------------------- | ------------------------------------------------ |
| `packages/agent/src/providers/adapter.ts`         | `ProviderAdapter`에 `streamCompletion()` 추가    |
| `packages/agent/src/providers/anthropic.ts`       | `streamCompletion()` 구현 + `cache_control` 지원 |
| `packages/agent/src/providers/openai.ts`          | `streamCompletion()` 구현                        |
| `packages/agent/src/models/provider-normalize.ts` | `StreamChunk` 6 variant 확장 + 캐시 비용 반영    |

### 테스트 파일

| 파일 경로                                            | 테스트 대상                                    |
| ---------------------------------------------------- | ---------------------------------------------- |
| `packages/agent/src/execution/runner.test.ts`        | runner 오케스트레이션 루프, 재시도 통합 (unit) |
| `packages/agent/src/execution/streaming.test.ts`     | 상태 전이, 이벤트 발행 (unit)                  |
| `packages/agent/src/execution/tool-executor.test.ts` | 도구 디스패치, 결과 크기 제한 (unit)           |
| `packages/agent/src/execution/tokens.test.ts`        | 토큰 카운팅, 컨텍스트 임계값 경계값 (unit)     |

---

## 4. 핵심 인터페이스/타입

### 기존 타입 재사용 (`@finclaw/types` — `packages/types/src/agent.ts`)

plan.md 원본에서 `ExecutionRequest`, `Message`를 새로 정의했으나, 기존 타입으로 대체한다:

| 원래 plan.md 타입  | 대체 타입                                | 위치                                         |
| ------------------ | ---------------------------------------- | -------------------------------------------- |
| `ExecutionRequest` | `AgentRunParams`                         | `packages/types/src/agent.ts:32`             |
| `Message`          | `ConversationMessage`                    | `packages/types/src/agent.ts:45`             |
| `ContentBlock`     | `ContentBlock` (기존 그대로)             | `packages/types/src/agent.ts:53`             |
| `ToolCall`         | `ToolCall` (기존 그대로)                 | `packages/types/src/agent.ts:76`             |
| `TokenUsage`       | `TokenUsage` (기존 그대로)               | `packages/types/src/agent.ts:83`             |
| `LLMProvider`      | `ProviderAdapter` + `streamCompletion()` | `packages/agent/src/providers/adapter.ts:19` |
| `LaneManager`      | `ConcurrencyLaneManager`                 | `packages/infra/src/concurrency-lane.ts:161` |

**참고:** `AgentRunParams`는 `ExecutionRequest`의 상위 호환이다. 필드 매핑:

```
ExecutionRequest.agentId       → AgentRunParams.agentId
ExecutionRequest.conversationId → AgentRunParams.sessionKey
ExecutionRequest.messages      → AgentRunParams.messages (ConversationMessage[])
ExecutionRequest.tools         → AgentRunParams.tools (ToolDefinition[])
ExecutionRequest.model         → AgentRunParams.model (ModelRef)
ExecutionRequest.maxTurns      → (Runner 옵션으로 이동)
ExecutionRequest.signal        → AgentRunParams.abortSignal
```

### 실행 결과 타입 (신규 — `packages/agent/src/execution/runner.ts`에 로컬 정의)

```typescript
/** 실행 결과 */
export interface ExecutionResult {
  readonly status: 'completed' | 'max_turns' | 'aborted' | 'error';
  readonly messages: readonly ConversationMessage[];
  readonly usage: TokenUsage;
  readonly turns: number;
  readonly durationMs: number;
}
```

### 스트리밍 상태 머신 타입

```typescript
/** 스트리밍 상태 */
export type StreamState =
  | 'idle' // 대기 중
  | 'streaming' // LLM 응답 스트리밍 중
  | 'tool_use' // tool_use 블록 감지됨
  | 'executing' // 도구 실행 중
  | 'done'; // 실행 완료

/** 스트리밍 이벤트 */
export type StreamEvent =
  | { readonly type: 'state_change'; readonly from: StreamState; readonly to: StreamState }
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'tool_use_start'; readonly toolCall: ToolCall }
  | { readonly type: 'tool_use_end'; readonly result: ToolResult }
  | { readonly type: 'message_complete'; readonly message: ConversationMessage }
  | { readonly type: 'usage_update'; readonly usage: TokenUsage }
  | { readonly type: 'error'; readonly error: Error }
  | { readonly type: 'done'; readonly result: ExecutionResult };

/** 스트림 이벤트 리스너 */
export type StreamEventListener = (event: StreamEvent) => void;
```

### ProviderAdapter 확장 (`packages/agent/src/providers/adapter.ts`)

기존 `ProviderAdapter`에 `streamCompletion()` 메서드를 추가한다:

```typescript
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  chatCompletion(params: ProviderRequestParams): Promise<unknown>;
  /** Phase 9: 스트리밍 LLM 호출 */
  streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk>;
}
```

### StreamChunk 확장 (`packages/agent/src/models/provider-normalize.ts`)

기존 4 variant → **6 variant**로 확장. `tool_use_start`, `tool_input_delta`, `tool_use_end` 추가:

```typescript
export type StreamChunk =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_use_start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_input_delta'; readonly delta: string }
  | { readonly type: 'tool_use_end' }
  | { readonly type: 'usage'; readonly usage: Partial<NormalizedUsage> }
  | { readonly type: 'done' };
```

### ToolResult 타입 (신규 — `packages/agent/src/execution/tool-executor.ts`에 로컬 정의)

```typescript
export interface ToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}
```

---

## 5. 구현 상세

### 5.1 Main Runner (`packages/agent/src/execution/runner.ts`)

Runner는 실행 엔진의 핵심 오케스트레이터로, **turn-based 루프**를 관리한다.
기존 인프라를 통합하여 사용한다: `retry()`, `ConcurrencyLaneManager`, `classifyFallbackError()`.

```typescript
import type { AgentRunParams, ConversationMessage, TokenUsage } from '@finclaw/types';
import { retry, type RetryOptions, ConcurrencyLaneManager, type LaneId } from '@finclaw/infra';
import { classifyFallbackError } from '../errors.js';
import type { ProviderAdapter } from '../providers/adapter.js';
import { StreamStateMachine } from './streaming.js';
import { ToolExecutor } from './tool-executor.js';
import { TokenCounter } from './tokens.js';
import type { StreamChunk } from '../models/provider-normalize.js';

export interface ExecutionResult {
  readonly status: 'completed' | 'max_turns' | 'aborted' | 'error';
  readonly messages: readonly ConversationMessage[];
  readonly usage: TokenUsage;
  readonly turns: number;
  readonly durationMs: number;
}

export interface RunnerOptions {
  readonly provider: ProviderAdapter;
  readonly toolExecutor: ToolExecutor;
  readonly laneManager: ConcurrencyLaneManager;
  readonly laneId?: LaneId; // 기본 'main'
  readonly maxTurns?: number; // 기본 10
  readonly retryOptions?: RetryOptions;
}

export class Runner {
  private readonly provider: ProviderAdapter;
  private readonly toolExecutor: ToolExecutor;
  private readonly laneManager: ConcurrencyLaneManager;
  private readonly laneId: LaneId;
  private readonly maxTurns: number;
  private readonly retryOptions: RetryOptions;

  constructor(options: RunnerOptions) {
    this.provider = options.provider;
    this.toolExecutor = options.toolExecutor;
    this.laneManager = options.laneManager;
    this.laneId = options.laneId ?? 'main';
    this.maxTurns = options.maxTurns ?? 10;
    this.retryOptions = options.retryOptions ?? {};
  }

  /**
   * 실행 루프 메인 엔트리포인트
   *
   * 흐름:
   * 1. Lane 핸들 획득 (ConcurrencyLaneManager)
   * 2. Turn 루프 시작:
   *    a. LLM 스트리밍 호출 (retry() + classifyFallbackError() 통합)
   *    b. tool_use 감지 시 도구 실행
   *    c. 도구 결과를 메시지에 추가
   *    d. maxTurns 도달 또는 tool_use 없으면 종료
   * 3. Lane 핸들 release
   */
  async execute(params: AgentRunParams, listener?: StreamEventListener): Promise<ExecutionResult> {
    const tokenCounter = new TokenCounter(params.model.contextWindow);
    const startTime = Date.now();
    const messages = [...params.messages];

    // 1. Lane 핸들 획득 (핸들 패턴 — 콜백 아님)
    const handle = await this.laneManager.acquire(this.laneId, params.sessionKey as string);

    try {
      let turns = 0;

      while (turns < this.maxTurns) {
        if (params.abortSignal?.aborted) {
          return this.buildResult('aborted', messages, tokenCounter, startTime, turns);
        }

        turns++;

        // LLM 호출 (retry + classifyFallbackError 통합)
        const response = await retry(() => this.streamLLMCall(params, messages, listener), {
          ...this.retryOptions,
          shouldRetry: (error) => {
            const reason = classifyFallbackError(error as Error);
            // rate-limit, server-error, timeout → 재시도
            return reason === 'rate-limit' || reason === 'server-error' || reason === 'timeout';
          },
          signal: params.abortSignal,
        });

        tokenCounter.add(response.usage);
        messages.push(response.message);

        // 컨텍스트 윈도우 임계값 경고
        tokenCounter.checkThresholds(listener);

        // tool_use가 없으면 완료
        if (!response.toolCalls.length) {
          return this.buildResult('completed', messages, tokenCounter, startTime, turns);
        }

        // 도구 실행
        const results = await this.toolExecutor.executeAll(response.toolCalls, params.abortSignal);

        // 도구 결과를 메시지에 추가
        messages.push({
          role: 'tool',
          content: results.map((r) => ({
            type: 'tool_result' as const,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError,
          })),
        });
      }

      return this.buildResult('max_turns', messages, tokenCounter, startTime, turns);
    } finally {
      // 3. Lane 핸들 release (try/finally로 보장)
      handle.release();
    }
  }
}
```

**LaneManager 콜백 패턴 → 핸들 패턴 변경 이유:**

기존 plan.md에서는 `laneManager.acquire(agentId, async () => { ... })` 콜백 패턴을 사용했으나,
실제 `ConcurrencyLaneManager.acquire()`는 `Promise<LaneHandle>` 핸들 패턴이다:

```typescript
// 기존 plan.md (콜백 패턴 — 실제 API와 불일치)
return this.laneManager.acquire(request.agentId, async () => { ... });

// 수정 (핸들 패턴 — 실제 API와 일치)
const handle = await this.laneManager.acquire(laneId, key);
try { ... } finally { handle.release(); }
```

### 5.2 재시도 로직

기존 plan.md에서는 `AttemptManager` 클래스를 별도 파일(`attempts.ts`)로 구현했으나,
`@finclaw/infra`의 `retry()`가 동일 기능을 제공하므로 Runner 내부에서 한 줄로 호출한다:

```typescript
// 기존 plan.md (별도 클래스)
const attempt = new AttemptManager(this.maxAttempts);
const response = await attempt.run(() => this.streamLLMCall(...));

// 수정 (retry() 직접 호출)
const response = await retry(
  () => this.streamLLMCall(params, messages, listener),
  {
    shouldRetry: (error) => {
      const reason = classifyFallbackError(error as Error);
      return reason === 'rate-limit' || reason === 'server-error' || reason === 'timeout';
    },
    signal: params.abortSignal,
  },
);
```

`retry()` 시그니처 참조 (`packages/infra/src/retry.ts`):

```typescript
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T>;

export interface RetryOptions {
  maxAttempts?: number; // 기본: 3
  minDelay?: number; // 기본: 1000
  maxDelay?: number; // 기본: 30000
  jitter?: boolean; // 기본: true
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  signal?: AbortSignal;
  retryAfterMs?: number;
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}
```

### 5.3 스트리밍 상태 머신 (`packages/agent/src/execution/streaming.ts`)

유한 상태 머신으로 스트리밍 진행 상태를 관리한다.

```typescript
import { EventEmitter } from 'node:events';
import type { StreamState, StreamEvent, StreamEventListener } from './types.js';

/** 허용된 상태 전이 테이블 */
const TRANSITIONS: Record<StreamState, readonly StreamState[]> = {
  idle: ['streaming'],
  streaming: ['tool_use', 'done'],
  tool_use: ['executing'],
  executing: ['streaming', 'done'],
  done: ['idle'], // 리셋용
} as const;

export class StreamStateMachine {
  private state: StreamState = 'idle';
  private readonly emitter = new EventEmitter();

  get currentState(): StreamState {
    return this.state;
  }

  on(listener: StreamEventListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  transition(to: StreamState): void {
    const allowed = TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid state transition: ${this.state} → ${to}. Allowed: ${allowed.join(', ')}`,
      );
    }
    const from = this.state;
    this.state = to;
    this.emit({ type: 'state_change', from, to });
  }

  emit(event: StreamEvent): void {
    this.emitter.emit('event', event);
  }

  reset(): void {
    this.state = 'idle';
  }
}
```

### 5.4 Provider 스트리밍 (기존 파일 수정)

신규 파일을 만들지 않고, 기존 `AnthropicAdapter`와 `OpenAIAdapter`에 `streamCompletion()` 메서드를 추가한다.

**`packages/agent/src/providers/anthropic.ts` — 추가 부분:**

```typescript
async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
  const systemMessages = params.messages.filter((m) => m.role === 'system');
  const nonSystemMessages = params.messages.filter((m) => m.role !== 'system');
  const system = systemMessages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');

  const stream = this.client.messages.stream({
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    ...(system ? {
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    } : {}),
    messages: this.convertMessages(nonSystemMessages),
    ...(params.tools?.length ? {
      tools: this.convertTools(params.tools),
    } : {}),
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
  });

  for await (const event of stream) {
    yield* this.mapStreamEvent(event);
  }
}
```

**`packages/agent/src/providers/openai.ts` — 추가 부분:**

```typescript
async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
  const stream = await this.client.chat.completions.create(
    {
      model: params.model,
      messages: params.messages.map((m) => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      ...(params.tools?.length ? { tools: this.convertTools(params.tools) } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      stream: true,
    },
    { signal: params.abortSignal },
  );

  for await (const chunk of stream) {
    yield* this.mapStreamChunk(chunk);
  }
}
```

### 5.5 도구 실행기 (`packages/agent/src/execution/tool-executor.ts`)

등록된 tool handler에 도구 호출을 디스패치하고, 병렬 실행을 지원한다.
**결과 크기 제한** (`maxResultChars: 10_000`)을 추가한다.

```typescript
import type { ToolCall } from '@finclaw/types';

export interface ToolHandler {
  execute(input: unknown, signal?: AbortSignal): Promise<string>;
}

export interface ToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

const MAX_RESULT_CHARS = 10_000;

export class ToolExecutor {
  private readonly handlers = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  async executeAll(
    toolCalls: readonly ToolCall[],
    signal?: AbortSignal,
  ): Promise<readonly ToolResult[]> {
    return Promise.all(toolCalls.map((call) => this.executeSingle(call, signal)));
  }

  private async executeSingle(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return { toolUseId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    }

    try {
      let result = await handler.execute(call.input, signal);
      if (result.length > MAX_RESULT_CHARS) {
        result = result.slice(0, MAX_RESULT_CHARS) + '\n... [truncated]';
      }
      return { toolUseId: call.id, content: result, isError: false };
    } catch (error) {
      return {
        toolUseId: call.id,
        content: `Tool execution error: ${(error as Error).message}`,
        isError: true,
      };
    }
  }
}
```

### 5.6 동시성 제어

기존 plan.md에서는 `LaneManager` 클래스를 별도 파일(`lanes.ts`)로 구현했으나,
`@finclaw/infra`의 `ConcurrencyLaneManager`가 동일 기능을 제공한다.

Runner는 생성 시 주입받은 `ConcurrencyLaneManager`를 직접 사용한다.

```typescript
// Runner constructor에서 주입
constructor(options: RunnerOptions) {
  this.laneManager = options.laneManager;
  this.laneId = options.laneId ?? 'main';
}

// execute() 내부에서 사용
const handle = await this.laneManager.acquire(this.laneId, params.sessionKey as string);
try { ... } finally { handle.release(); }
```

`ConcurrencyLaneManager` 시그니처 참조 (`packages/infra/src/concurrency-lane.ts`):

```typescript
export type LaneId = 'main' | 'cron' | 'subagent';

export interface LaneHandle {
  release(): void;
}

export class ConcurrencyLaneManager {
  constructor(configs: Partial<Record<LaneId, LaneConfig>> = {});
  acquire(laneId: LaneId, key: string): Promise<LaneHandle>;
  resetGeneration(laneId: LaneId): void;
  dispose(): void;
}
```

### 5.7 토큰 카운터 (`packages/agent/src/execution/tokens.ts`)

기존 plan.md에서는 모델 ID를 하드코딩(`MODEL_CONTEXT_LIMITS`)했으나,
`ModelRef.contextWindow` 파라미터를 사용하여 동적으로 조회한다.
**임계값 경고(80%/95%)** 를 추가한다.

```typescript
import type { TokenUsage } from '@finclaw/types';
import type { StreamEventListener } from './streaming.js';

export class TokenCounter {
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  private warned80 = false;
  private warned95 = false;

  constructor(private readonly contextWindow: number) {}

  add(delta: TokenUsage): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + delta.inputTokens,
      outputTokens: this.usage.outputTokens + delta.outputTokens,
      cacheReadTokens: (this.usage.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
      cacheWriteTokens: (this.usage.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
    };
  }

  /** 컨텍스트 윈도우 사용률 */
  usageRatio(): number {
    return this.usage.inputTokens / this.contextWindow;
  }

  /** 컨텍스트 윈도우 잔여량 */
  remaining(): number {
    return Math.max(0, this.contextWindow - this.usage.inputTokens);
  }

  /** 80%/95% 임계값 경고 (리스너에 이벤트 발행) */
  checkThresholds(listener?: StreamEventListener): void {
    const ratio = this.usageRatio();
    if (!this.warned80 && ratio >= 0.8) {
      this.warned80 = true;
      // Phase 7 컴팩션 트리거 포인트
      listener?.({
        type: 'usage_update',
        usage: this.current,
      });
    }
    if (!this.warned95 && ratio >= 0.95) {
      this.warned95 = true;
      listener?.({
        type: 'usage_update',
        usage: this.current,
      });
    }
  }

  get current(): Readonly<TokenUsage> {
    return this.usage;
  }
}
```

### 5.8 도구 입력 JSON 스트리밍 조합 (`packages/agent/src/execution/tool-input-buffer.ts`)

Anthropic 스트리밍 API는 도구 입력을 `tool_use_start → tool_input_delta* → tool_use_end` 시퀀스로 전달한다.
JSON 조각을 버퍼링하여 완전한 `ToolCall`을 조립한다.

```typescript
import type { ToolCall } from '@finclaw/types';
import type { StreamChunk } from '../models/provider-normalize.js';

/** 진행 중인 도구 호출 버퍼 */
interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  inputJson: string;
}

export class ToolInputBuffer {
  private pending: PendingToolCall | null = null;

  /** StreamChunk를 처리하여 완성된 ToolCall을 반환 (미완성이면 null) */
  feed(chunk: StreamChunk): ToolCall | null {
    switch (chunk.type) {
      case 'tool_use_start':
        this.pending = { id: chunk.id, name: chunk.name, inputJson: '' };
        return null;

      case 'tool_input_delta':
        if (this.pending) {
          this.pending.inputJson += chunk.delta;
        }
        return null;

      case 'tool_use_end': {
        if (!this.pending) {
          return null;
        }
        const call: ToolCall = {
          id: this.pending.id,
          name: this.pending.name,
          input: JSON.parse(this.pending.inputJson || '{}'),
        };
        this.pending = null;
        return call;
      }

      default:
        return null;
    }
  }

  /** 미완성 버퍼 초기화 */
  reset(): void {
    this.pending = null;
  }
}
```

### 5.9 Prompt Caching

Anthropic API의 prompt caching을 활용하여 비용을 절감한다.
시스템 프롬프트 + 도구 정의에 `cache_control: { type: 'ephemeral' }` 을 적용한다.

**적용 위치:** `AnthropicAdapter.streamCompletion()`

```typescript
// 시스템 프롬프트 캐싱
system: [{
  type: 'text',
  text: system,
  cache_control: { type: 'ephemeral' },
}],

// 도구 정의 캐싱 (마지막 도구에 cache_control 부착)
tools: convertedTools.map((tool, i) =>
  i === convertedTools.length - 1
    ? { ...tool, cache_control: { type: 'ephemeral' } }
    : tool,
),
```

**비용 절감 효과:**

| 항목       | 일반 입력 | 캐시 쓰기       | 캐시 읽기 (히트) |
| ---------- | --------- | --------------- | ---------------- |
| Sonnet 4.6 | $3/MTok   | $3.75/MTok      | $0.30/MTok       |
| **절감률** |           | +25% (최초 1회) | **-90%** (이후)  |

멀티턴 대화에서 시스템 프롬프트 + 도구 정의는 반복 전송되므로, 캐시 히트 시 약 82% 비용 절감이 가능하다.

### 5.10 `calculateEstimatedCost()` 캐시 비용 반영

기존 `provider-normalize.ts`의 `calculateEstimatedCost()`에 TODO(L1)로 남겨둔 캐시 비용을 반영한다.

```typescript
// 기존 (캐시 비용 미산정)
export function calculateEstimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

// 수정 (캐시 비용 반영)
export function calculateEstimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheReadTokens / 1_000_000) * (pricing.cacheReadPerMillion ?? 0) +
    (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePerMillion ?? 0)
  );
}
```

### 5.11 FinClawEventMap 확장

`packages/infra/src/events.ts`의 `FinClawEventMap`에 5개 실행 이벤트를 추가한다:

```typescript
// ── Phase 9: Execution events ──
'execution:start': (agentId: string, sessionKey: string) => void;
'execution:turn': (agentId: string, sessionKey: string, turn: number) => void;
'execution:tool_use': (agentId: string, toolName: string, durationMs: number) => void;
'execution:complete': (agentId: string, sessionKey: string, result: {
  status: string;
  turns: number;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
}) => void;
'execution:context_threshold': (agentId: string, ratio: number, threshold: 0.8 | 0.95) => void;
```

### 데이터 흐름 다이어그램

```
User Message (via MessageRouter.onProcess)
     │
     ▼
┌─────────────┐
│   Runner     │◀── ConcurrencyLaneManager.acquire(laneId, key)
│  (루프 제어) │    → LaneHandle (try/finally release)
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│  retry()     │────▶│ ProviderAdapter │ (AnthropicAdapter / OpenAIAdapter)
│  (@finclaw/  │     │ .streamCompletion() │
│   infra)     │     └──────┬───────┘
└──────┬──────┘            │
       │    ┌──────────────┘
       │    ▼
       │  ┌──────────────┐      ┌─────────────────┐
       │  │ StreamState   │      │ ToolInputBuffer  │
       │  │ Machine       │      │ (JSON 조합)      │
       │  └──────┬───────┘      └────────┬────────┘
       │         │ tool_use 감지           │ ToolCall 완성
       │         ▼                         │
       │  ┌──────────────┐◀───────────────┘
       │  │ ToolExecutor │ (병렬 실행, maxResultChars: 10K)
       │  └──────┬───────┘
       │         │ 도구 결과
       │         ▼
       │  ┌──────────────┐
       ├─▶│ TokenCounter  │ (contextWindow 기반 임계값 80%/95%)
       │  └──────────────┘
       │
       ▼
  ExecutionResult
```

---

## 6. Phase 8 MessageRouter 통합 가이드

Runner는 Phase 8의 `MessageRouter`의 `onProcess` 콜백 내부에서 호출된다.

```typescript
// packages/server/src/process/message-router.ts 에서 주입
const router = new MessageRouter({
  config,
  logger,
  onProcess: async (ctx, match, signal) => {
    // 1. 세션에서 대화 이력 로드
    const messages = await sessionStore.getMessages(ctx.sessionKey);

    // 2. Runner 실행
    const result = await runner.execute({
      agentId: match.agentId,
      sessionKey: ctx.sessionKey,
      model: resolveModel(match.agentId),
      systemPrompt: buildSystemPrompt(match.agentId),
      messages,
      tools: resolveTools(match.agentId),
      abortSignal: signal,
    });

    // 3. 응답 전달
    await channel.send(ctx, result.messages.at(-1)?.content ?? '');
  },
});
```

**연동 포인트:**

- `MessageRouter`는 이미 `ConcurrencyLaneManager`를 소유하고 있음 → Runner에 동일 인스턴스 주입
- `MessageRouter`가 `AbortController.signal`을 생성 → `params.abortSignal`로 전달
- `ctx.sessionKey` → `params.sessionKey` 매핑

---

## 7. 선행 조건

| Phase       | 구체적 산출물                                                                          | 필요 이유                                              |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Phase 6** | `packages/agent/src/models/catalog.ts` - `ModelEntry`, `ModelPricing`                  | Provider 스트리밍 시 모델 설정 및 비용 계산 필요       |
| **Phase 6** | `packages/agent/src/providers/adapter.ts` - `ProviderAdapter`, `ProviderRequestParams` | Runner가 Provider를 호출하기 위한 인터페이스           |
| **Phase 7** | `packages/types/src/agent.ts` - `ToolDefinition`, `ToolCall`, `ContentBlock`           | ToolExecutor가 도구를 등록하고 실행하기 위한 타입      |
| **Phase 7** | `packages/agent/src/agents/context.ts` - 컨텍스트 빌더                                 | Runner가 LLM에 전달할 시스템 프롬프트 및 컨텍스트 구성 |
| **Phase 7** | `packages/agent/src/agents/context.ts` - 컴팩션 전략                                   | TokenCounter 80% 임계값 도달 시 컴팩션 트리거          |
| **Phase 8** | `packages/server/src/process/message-router.ts` - `MessageRouter.onProcess` 콜백       | Runner를 호출하는 상위 레이어, 실행 결과를 채널로 전달 |
| **Infra**   | `packages/infra/src/retry.ts` - `retry()`                                              | 재시도 로직                                            |
| **Infra**   | `packages/infra/src/concurrency-lane.ts` - `ConcurrencyLaneManager`                    | 동시성 제어                                            |

---

## 8. 산출물 및 검증

### 테스트 가능한 결과물

| 산출물                             | 검증 방법                                                            |
| ---------------------------------- | -------------------------------------------------------------------- |
| Runner 오케스트레이션 루프         | unit: mock provider + mock tool → 다중 turn 실행 확인                |
| retry() + classifyFallbackError()  | unit: 429/500 에러 시 재시도 횟수, rate-limit/server-error 분류 검증 |
| 스트리밍 상태 머신                 | unit: 모든 상태 전이 경로 검증, 잘못된 전이 시 에러                  |
| 도구 실행기                        | unit: 등록/미등록 도구, 병렬 실행, 결과 크기 제한(>10K 절삭)         |
| 토큰 카운터                        | unit: 누적 계산, 임계값 경계값(79%→미경고, 80%→경고, 95%→경고)       |
| ToolInputBuffer (JSON 조합)        | unit: tool_use_start→input_delta\*→tool_use_end → ToolCall 완성      |
| `calculateEstimatedCost` 캐시 비용 | unit: cacheReadTokens/cacheWriteTokens 반영 검증                     |
| Provider streamCompletion()        | unit: mock API → StreamChunk 6 variant 변환 검증                     |

### 검증 기준

```bash
# 단위 테스트 (mock 기반, 외부 API 호출 없음)
pnpm test -- packages/agent/src/execution/

# 커버리지 목표: statements 80%, branches 75%
pnpm test:coverage -- packages/agent/src/execution/
```

### E2E 검증 (Phase 9 완료 후)

```typescript
// packages/agent/src/execution/runner.e2e.test.ts
it('단일 turn 실행: 도구 호출 없는 간단한 질의', async () => {
  const result = await runner.execute({
    agentId: 'test' as AgentId,
    sessionKey: 'test-1' as SessionKey,
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    },
    systemPrompt: '당신은 금융 어시스턴트입니다.',
    messages: [{ role: 'user', content: '안녕하세요' }],
    tools: [],
  });
  expect(result.status).toBe('completed');
  expect(result.turns).toBe(1);
});

it('멀티 turn 실행: 도구 호출 포함', async () => {
  const result = await runner.execute({
    agentId: 'test' as AgentId,
    sessionKey: 'test-2' as SessionKey,
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    },
    systemPrompt: '당신은 금융 어시스턴트입니다.',
    messages: [{ role: 'user', content: '삼성전자 현재 주가 알려줘' }],
    tools: [stockPriceTool],
  });
  expect(result.status).toBe('completed');
  expect(result.turns).toBeGreaterThanOrEqual(2); // LLM → tool → LLM
});
```

---

## 9. 구현 순서

의존성 기반 3일 순서:

```
Day 1: 기반 모듈
  1. StreamChunk 6 variant 확장 (provider-normalize.ts 수정)
     → 검증: 기존 normalizer 테스트 통과
  2. ProviderAdapter.streamCompletion() 인터페이스 추가 (adapter.ts 수정)
     → 검증: 타입 체크 통과
  3. ToolInputBuffer 구현 (신규)
     → 검증: tool_use_start → input_delta → tool_use_end 테스트

Day 2: 핵심 모듈
  4. StreamStateMachine 구현 (신규)
     → 검증: 모든 상태 전이 경로 테스트
  5. ToolExecutor 구현 (신규)
     → 검증: 등록/미등록 도구, maxResultChars 테스트
  6. TokenCounter 구현 (신규)
     → 검증: 누적, 임계값 경계값 테스트

Day 3: 통합
  7. AnthropicAdapter.streamCompletion() + cache_control (anthropic.ts 수정)
     → 검증: mock SDK → StreamChunk 변환 테스트
  8. OpenAIAdapter.streamCompletion() (openai.ts 수정)
     → 검증: mock SDK → StreamChunk 변환 테스트
  9. Runner 구현 (신규) — retry() + ConcurrencyLaneManager + 상태 머신 통합
     → 검증: mock provider + mock tool → 다중 turn 실행 테스트
  10. calculateEstimatedCost() 캐시 비용 + FinClawEventMap 확장
     → 검증: 비용 계산 테스트, 타입 체크
```

---

## 10. 과도한 엔지니어링 경계선

**하지 말아야 할 것:**

- Provider 레지스트리/팩토리 패턴 → 기존 `createProviderAdapter()` 사용
- 재시도 클래스 (`AttemptManager`) → `retry()` 한 줄 호출
- Lane 클래스 (`LaneManager`) → `ConcurrencyLaneManager` 직접 사용
- 응답 정규화 파일 (`normalizer.ts`) → 기존 `provider-normalize.ts` 사용
- Provider 타입 파일 (`providers/types.ts`) → 기존 `adapter.ts`에 인터페이스 추가
- 모델 ID 하드코딩 → `ModelRef.contextWindow` 사용
- 커스텀 EventEmitter 구현 → `@finclaw/infra`의 `TypedEmitter` 사용

---

## 11. 복잡도 및 예상 파일 수

| 항목              | 값                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| **복잡도**        | **L**                                                                                                |
| 신규 소스 파일    | 6 (`index.ts`, `runner.ts`, `streaming.ts`, `tool-executor.ts`, `tokens.ts`, `tool-input-buffer.ts`) |
| 수정 소스 파일    | 4 (`adapter.ts`, `anthropic.ts`, `openai.ts`, `provider-normalize.ts`)                               |
| 테스트 파일       | 4                                                                                                    |
| **합계**          | **~14 파일**                                                                                         |
| 예상 LOC (소스)   | 600 ~ 800                                                                                            |
| 예상 LOC (테스트) | 500 ~ 700                                                                                            |
| 신규 의존성       | 없음 (`@anthropic-ai/sdk`, `openai` 이미 존재)                                                       |
