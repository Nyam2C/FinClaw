# Phase 9: 실행 엔진 (Execution Engine)

> **복잡도: XL** | 소스 ~12 파일 | 테스트 ~8 파일 | 합계 ~20 파일

---

## 1. 목표

LLM 호출 → 도구 실행 → 응답 반환의 전체 실행 루프를 구현한다. OpenClaw의 Pi 실행 엔진(80 파일, 14K LOC)을 금융 도메인에 맞게 경량화하여, 다음 핵심 능력을 확보한다:

- **Main Runner**: 사용자 메시지를 받아 LLM 호출 → tool_use 감지 → 도구 실행 → 후속 LLM 호출을 반복하는 오케스트레이션 루프
- **재시도 로직**: 429(Rate Limit), 500, 503 등 일시적 오류에 대한 지수 백오프 재시도
- **스트리밍 상태 머신**: `idle → streaming → tool_use → executing → streaming → done` 상태 전이 관리
- **Provider 어댑터**: Anthropic(네이티브), OpenAI(어댑터 패턴)을 통합 인터페이스로 추상화
- **도구 실행기**: 등록된 tool handler에 도구 호출을 디스패치
- **Lane 관리**: 에이전트 별 동시성 제어를 위한 큐잉 시스템
- **토큰 카운터**: 입출력 토큰 추적으로 비용 관리 및 컨텍스트 윈도우 관리
- **응답 정규화**: Provider 간 응답 포맷 통일

---

## 2. OpenClaw 참조

| OpenClaw 경로                                      | 적용 패턴                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `openclaw_review/deep-dive/05-execution-engine.md` | Main runner 루프, attempt 재시도, 스트리밍 상태 머신 전체 아키텍처 |
| `openclaw_review/deep-dive/05` (streaming 섹션)    | idle → streaming → tool_use → executing → done 상태 전이           |
| `openclaw_review/deep-dive/05` (provider 섹션)     | Anthropic 네이티브 + OpenAI 어댑터 패턴                            |
| `openclaw_review/deep-dive/05` (lane 섹션)         | per-agent 동시성 큐 관리                                           |
| `openclaw_review/docs/` (architecture 관련)        | 전체 모듈 간 의존성 구조                                           |

**OpenClaw 차이점:**

- Bash tool의 4가지 호스트 타입(local, Docker, SSH, WebSocket) → FinClaw는 local 전용으로 축소
- Gemini provider → 제외 (Anthropic + OpenAI만 지원)
- 80 파일 규모 → ~20 파일로 경량화, 금융 도구 실행에 최적화

---

## 3. 생성할 파일

### 소스 파일 (`src/execution/`)

| 파일 경로                              | 설명                                               |
| -------------------------------------- | -------------------------------------------------- |
| `src/execution/index.ts`               | 모듈 public API re-export                          |
| `src/execution/runner.ts`              | Main runner - LLM ↔ tool 오케스트레이션 루프       |
| `src/execution/attempts.ts`            | 재시도 로직 (지수 백오프, 에러 분류)               |
| `src/execution/streaming.ts`           | 스트리밍 상태 머신 + EventEmitter 기반 이벤트 발행 |
| `src/execution/tool-executor.ts`       | 도구 호출 디스패치 및 결과 수집                    |
| `src/execution/lanes.ts`               | per-agent 동시성 lane 큐 관리                      |
| `src/execution/tokens.ts`              | 토큰 카운팅 및 컨텍스트 윈도우 관리                |
| `src/execution/normalizer.ts`          | Provider 간 응답 포맷 정규화                       |
| `src/execution/providers/index.ts`     | Provider 레지스트리 및 팩토리                      |
| `src/execution/providers/anthropic.ts` | Anthropic Claude 네이티브 provider                 |
| `src/execution/providers/openai.ts`    | OpenAI 호환 어댑터 provider                        |
| `src/execution/providers/types.ts`     | Provider 공통 인터페이스 정의                      |

### 테스트 파일

| 파일 경로                                   | 테스트 대상                       |
| ------------------------------------------- | --------------------------------- |
| `src/execution/runner.test.ts`              | runner 오케스트레이션 루프 (unit) |
| `src/execution/attempts.test.ts`            | 재시도 로직, 백오프 계산 (unit)   |
| `src/execution/streaming.test.ts`           | 상태 전이, 이벤트 발행 (unit)     |
| `src/execution/tool-executor.test.ts`       | 도구 디스패치, 병렬 실행 (unit)   |
| `src/execution/lanes.test.ts`               | 동시성 큐, lane 생성/해제 (unit)  |
| `src/execution/tokens.test.ts`              | 토큰 카운팅, 컨텍스트 한도 (unit) |
| `src/execution/normalizer.test.ts`          | 응답 정규화 (unit)                |
| `src/execution/providers/anthropic.test.ts` | Anthropic provider (unit, mock)   |

---

## 4. 핵심 인터페이스/타입

### 실행 관련 핵심 타입 (`src/types/`)

```typescript
// === 실행 엔진 코어 타입 ===

/** 실행 요청 */
export interface ExecutionRequest {
  readonly agentId: string;
  readonly conversationId: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly model: ModelConfig;
  readonly maxTurns?: number; // 기본 10
  readonly signal?: AbortSignal;
}

/** 실행 결과 */
export interface ExecutionResult {
  readonly status: 'completed' | 'max_turns' | 'aborted' | 'error';
  readonly messages: readonly Message[];
  readonly usage: TokenUsage;
  readonly turns: number;
  readonly durationMs: number;
}

/** 메시지 (대화 이력 단위) */
export interface Message {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string | readonly ContentBlock[];
  readonly toolCalls?: readonly ToolCall[];
  readonly toolResults?: readonly ToolResult[];
}

/** 콘텐츠 블록 */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

/** 도구 호출 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** 도구 실행 결과 */
export interface ToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

/** 토큰 사용량 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
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
  | { readonly type: 'message_complete'; readonly message: Message }
  | { readonly type: 'usage_update'; readonly usage: TokenUsage }
  | { readonly type: 'error'; readonly error: ExecutionError }
  | { readonly type: 'done'; readonly result: ExecutionResult };

/** 스트림 이벤트 리스너 */
export type StreamEventListener = (event: StreamEvent) => void;
```

### Provider 인터페이스

```typescript
/** LLM Provider 인터페이스 */
export interface LLMProvider {
  readonly name: string;
  readonly supportedModels: readonly string[];

  /** 스트리밍 LLM 호출 */
  createStream(params: LLMRequestParams): AsyncIterable<LLMStreamChunk>;

  /** 모델 지원 여부 확인 */
  supportsModel(modelId: string): boolean;

  /** 토큰 카운팅 (근사치) */
  estimateTokens(text: string): number;
}

/** LLM 요청 파라미터 */
export interface LLMRequestParams {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
}

/** LLM 스트리밍 청크 */
export type LLMStreamChunk =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_use'; readonly toolCall: ToolCall }
  | { readonly type: 'message_start'; readonly messageId: string }
  | { readonly type: 'message_stop'; readonly usage: TokenUsage }
  | { readonly type: 'error'; readonly error: Error };
```

### Lane 관리 타입

```typescript
/** Lane 설정 */
export interface LaneConfig {
  readonly maxConcurrency: number; // 기본 1
  readonly maxQueueSize: number; // 기본 100
  readonly timeoutMs: number; // 기본 300_000 (5분)
}

/** Lane 상태 */
export interface LaneStatus {
  readonly agentId: string;
  readonly active: number;
  readonly queued: number;
  readonly maxConcurrency: number;
}
```

---

## 5. 구현 상세

### 5.1 Main Runner (`runner.ts`)

Runner는 실행 엔진의 핵심 오케스트레이터로, **turn-based 루프**를 관리한다.

```typescript
import type { ExecutionRequest, ExecutionResult, StreamEventListener } from '../types/execution.js';
import { AttemptManager } from './attempts.js';
import { StreamStateMachine } from './streaming.js';
import { ToolExecutor } from './tool-executor.js';
import { LaneManager } from './lanes.js';
import { TokenCounter } from './tokens.js';
import { resolveProvider } from './providers/index.js';

export interface RunnerOptions {
  readonly laneManager: LaneManager;
  readonly toolExecutor: ToolExecutor;
  readonly maxAttempts?: number; // 기본 3
  readonly maxTurns?: number; // 기본 10
}

export class Runner {
  private readonly laneManager: LaneManager;
  private readonly toolExecutor: ToolExecutor;
  private readonly maxAttempts: number;
  private readonly defaultMaxTurns: number;

  constructor(options: RunnerOptions) {
    this.laneManager = options.laneManager;
    this.toolExecutor = options.toolExecutor;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.defaultMaxTurns = options.maxTurns ?? 10;
  }

  /**
   * 실행 루프 메인 엔트리포인트
   *
   * 흐름:
   * 1. Lane 슬롯 획득 (동시성 제어)
   * 2. Provider 해석
   * 3. Turn 루프 시작:
   *    a. LLM 스트리밍 호출 (재시도 포함)
   *    b. tool_use 감지 시 도구 실행
   *    c. 도구 결과를 메시지에 추가
   *    d. maxTurns 도달 또는 tool_use 없으면 종료
   * 4. Lane 슬롯 반환
   */
  async execute(
    request: ExecutionRequest,
    listener?: StreamEventListener,
  ): Promise<ExecutionResult> {
    const maxTurns = request.maxTurns ?? this.defaultMaxTurns;
    const provider = resolveProvider(request.model);
    const tokenCounter = new TokenCounter();
    const startTime = Date.now();
    const messages = [...request.messages];

    return this.laneManager.acquire(request.agentId, async () => {
      let turns = 0;

      while (turns < maxTurns) {
        if (request.signal?.aborted) {
          return this.buildResult('aborted', messages, tokenCounter, startTime, turns);
        }

        turns++;

        // LLM 호출 (재시도 포함)
        const attempt = new AttemptManager(this.maxAttempts);
        const response = await attempt.run(() =>
          this.streamLLMCall(provider, request, messages, listener),
        );

        tokenCounter.add(response.usage);
        messages.push(response.message);

        // tool_use가 없으면 완료
        if (!response.toolCalls.length) {
          return this.buildResult('completed', messages, tokenCounter, startTime, turns);
        }

        // 도구 실행
        const results = await this.toolExecutor.executeAll(response.toolCalls, request.signal);

        // 도구 결과를 메시지에 추가
        messages.push({
          role: 'tool' as const,
          content: results.map((r) => ({
            type: 'tool_result' as const,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError,
          })),
        });
      }

      return this.buildResult('max_turns', messages, tokenCounter, startTime, turns);
    });
  }
}
```

### 5.2 재시도 로직 (`attempts.ts`)

지수 백오프 + 지터를 사용한 재시도. 일시적 오류만 재시도한다.

```typescript
export interface AttemptConfig {
  readonly maxAttempts: number; // 기본 3
  readonly baseDelayMs: number; // 기본 1000
  readonly maxDelayMs: number; // 기본 30000
  readonly jitterFactor: number; // 기본 0.2
}

export class AttemptManager {
  constructor(
    private readonly maxAttempts: number = 3,
    private readonly config: Partial<AttemptConfig> = {},
  ) {}

  /** 재시도 가능한 작업 실행 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        if (!this.isRetryable(error) || attempt === this.maxAttempts) {
          throw lastError;
        }
        await this.delay(attempt);
      }
    }

    throw lastError;
  }

  /** 일시적 오류 판별 */
  private isRetryable(error: unknown): boolean {
    if (error instanceof Error) {
      const status = (error as any).status ?? (error as any).statusCode;
      // 429 Rate Limit, 500 Internal, 502 Bad Gateway, 503 Unavailable, 529 Overloaded
      return [429, 500, 502, 503, 529].includes(status);
    }
    return false;
  }

  /** 지수 백오프 + 지터 */
  private delay(attempt: number): Promise<void> {
    const base = this.config.baseDelayMs ?? 1000;
    const max = this.config.maxDelayMs ?? 30_000;
    const jitter = this.config.jitterFactor ?? 0.2;

    const exponential = Math.min(base * 2 ** (attempt - 1), max);
    const jittered = exponential * (1 + jitter * (Math.random() * 2 - 1));

    return new Promise((resolve) => setTimeout(resolve, jittered));
  }
}
```

### 5.3 스트리밍 상태 머신 (`streaming.ts`)

유한 상태 머신으로 스트리밍 진행 상태를 관리한다.

```typescript
import { EventEmitter } from 'node:events';
import type { StreamState, StreamEvent, StreamEventListener } from '../types/execution.js';

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

  /** 리스너 등록 */
  on(listener: StreamEventListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** 상태 전이 */
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

  /** 이벤트 발행 */
  emit(event: StreamEvent): void {
    this.emitter.emit('event', event);
  }

  /** 상태 리셋 */
  reset(): void {
    this.state = 'idle';
  }
}
```

### 5.4 Provider 어댑터 (`providers/`)

```typescript
// providers/anthropic.ts - Anthropic 네이티브 provider
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMRequestParams, LLMStreamChunk } from '../providers/types.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly supportedModels = [
    'claude-sonnet-4-20250514',
    'claude-haiku-4-20250414',
    'claude-opus-4-20250918',
  ] as const;

  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *createStream(params: LLMRequestParams): AsyncIterable<LLMStreamChunk> {
    const stream = this.client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens,
      messages: this.convertMessages(params.messages),
      tools: params.tools ? this.convertTools(params.tools) : undefined,
      system: params.systemPrompt,
    });

    for await (const event of stream) {
      yield this.mapEvent(event);
    }
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('claude-');
  }

  estimateTokens(text: string): number {
    // 근사치: 영어 ~4자/토큰, 한국어 ~2자/토큰
    return Math.ceil(text.length / 3);
  }
}

// providers/openai.ts - OpenAI 어댑터 provider
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly supportedModels = ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'] as const;

  async *createStream(params: LLMRequestParams): AsyncIterable<LLMStreamChunk> {
    // OpenAI API 호출 → LLMStreamChunk로 변환
    // Anthropic 형식의 tool 정의를 OpenAI 형식으로 변환
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3');
  }
}

// providers/index.ts - Provider 레지스트리
const providers = new Map<string, LLMProvider>();

export function registerProvider(provider: LLMProvider): void {
  providers.set(provider.name, provider);
}

export function resolveProvider(model: ModelConfig): LLMProvider {
  for (const provider of providers.values()) {
    if (provider.supportsModel(model.modelId)) {
      return provider;
    }
  }
  throw new Error(`No provider found for model: ${model.modelId}`);
}
```

### 5.5 도구 실행기 (`tool-executor.ts`)

등록된 tool handler에 도구 호출을 디스패치하고, 병렬 실행을 지원한다.

```typescript
import type { ToolCall, ToolResult, ToolHandler } from '../types/index.js';

export class ToolExecutor {
  private readonly handlers = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  /** 모든 도구 호출을 병렬 실행 */
  async executeAll(
    toolCalls: readonly ToolCall[],
    signal?: AbortSignal,
  ): Promise<readonly ToolResult[]> {
    return Promise.all(toolCalls.map((call) => this.executeSingle(call, signal)));
  }

  private async executeSingle(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return {
        toolUseId: call.id,
        content: `Unknown tool: ${call.name}`,
        isError: true,
      };
    }

    try {
      const result = await handler.execute(call.input, signal);
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

### 5.6 Lane 관리 (`lanes.ts`)

에이전트 별 동시성 제어로 과부하를 방지한다.

```typescript
export class LaneManager {
  private readonly lanes = new Map<string, Lane>();
  private readonly defaultConfig: LaneConfig;

  constructor(config?: Partial<LaneConfig>) {
    this.defaultConfig = {
      maxConcurrency: config?.maxConcurrency ?? 1,
      maxQueueSize: config?.maxQueueSize ?? 100,
      timeoutMs: config?.timeoutMs ?? 300_000,
    };
  }

  /** Lane 슬롯 획득 후 작업 실행 */
  async acquire<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const lane = this.getOrCreateLane(agentId);
    return lane.enqueue(fn);
  }

  /** 모든 lane 상태 조회 */
  status(): readonly LaneStatus[] {
    return [...this.lanes.entries()].map(([agentId, lane]) => ({
      agentId,
      active: lane.activeCount,
      queued: lane.queuedCount,
      maxConcurrency: lane.config.maxConcurrency,
    }));
  }

  /** Lane 내부: 세마포어 기반 동시성 큐 */
  private getOrCreateLane(agentId: string): Lane {
    let lane = this.lanes.get(agentId);
    if (!lane) {
      lane = new Lane(this.defaultConfig);
      this.lanes.set(agentId, lane);
    }
    return lane;
  }
}
```

### 5.7 토큰 카운터 (`tokens.ts`)

누적 토큰 사용량을 추적하고 컨텍스트 윈도우 한도를 관리한다.

```typescript
/** 모델별 컨텍스트 윈도우 크기 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4-20250514': 200_000,
  'claude-haiku-4-20250414': 200_000,
  'claude-opus-4-20250918': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
};

export class TokenCounter {
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };

  /** 사용량 누적 */
  add(delta: TokenUsage): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + delta.inputTokens,
      outputTokens: this.usage.outputTokens + delta.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens + delta.cacheReadTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens + delta.cacheWriteTokens,
      totalTokens: this.usage.totalTokens + delta.totalTokens,
    };
  }

  /** 컨텍스트 윈도우 잔여량 확인 */
  remainingContext(modelId: string): number {
    const limit = MODEL_CONTEXT_LIMITS[modelId] ?? 200_000;
    return Math.max(0, limit - this.usage.inputTokens);
  }

  /** 현재 누적 사용량 */
  get current(): Readonly<TokenUsage> {
    return this.usage;
  }
}
```

### 데이터 흐름 다이어그램

```
User Message
     │
     ▼
┌─────────────┐
│   Runner     │◀── LaneManager (동시성 제어)
│  (루프 제어) │
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│  Attempt     │────▶│ LLM Provider │ (Anthropic / OpenAI)
│  Manager     │     │  (streaming) │
└──────┬──────┘     └──────┬───────┘
       │                   │
       │    ┌──────────────┘
       │    ▼
       │  ┌──────────────┐
       │  │ StreamState   │ idle → streaming → tool_use → executing
       │  │ Machine       │
       │  └──────┬───────┘
       │         │ tool_use 감지
       │         ▼
       │  ┌──────────────┐
       │  │ ToolExecutor │ (병렬 도구 실행)
       │  └──────┬───────┘
       │         │ 도구 결과
       │         ▼
       │  ┌──────────────┐
       ├─▶│ Normalizer   │ → 통합 응답 포맷
       │  └──────┬───────┘
       │         │
       │  ┌──────┴───────┐
       └──│ TokenCounter  │ (누적 사용량 추적)
          └──────────────┘
```

---

## 6. 선행 조건

| Phase       | 구체적 산출물                                                     | 필요 이유                                               |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| **Phase 6** | `src/config/models.ts` - 모델 설정 스키마, API 키 관리            | Provider 초기화 시 API 키와 모델 설정 필요              |
| **Phase 7** | `src/types/tools.ts` - `ToolDefinition`, `ToolHandler` 인터페이스 | ToolExecutor가 도구를 등록하고 실행하기 위한 인터페이스 |
| **Phase 7** | `src/agents/context.ts` - 컨텍스트 빌더                           | Runner가 LLM에 전달할 시스템 프롬프트 및 컨텍스트 구성  |
| **Phase 8** | `src/agents/pipeline.ts` - 자동 응답 파이프라인                   | Runner를 호출하는 상위 레이어, 실행 결과를 채널로 전달  |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| 산출물                     | 검증 방법                                             |
| -------------------------- | ----------------------------------------------------- |
| Runner 오케스트레이션 루프 | unit: mock provider + mock tool → 다중 turn 실행 확인 |
| 재시도 로직                | unit: 429/500 에러 시 재시도 횟수, 백오프 간격 검증   |
| 스트리밍 상태 머신         | unit: 모든 상태 전이 경로 검증, 잘못된 전이 시 에러   |
| 도구 실행기                | unit: 등록/미등록 도구, 병렬 실행, 에러 핸들링        |
| Lane 관리                  | unit: 동시성 1일 때 직렬화 확인, 큐 오버플로 검증     |
| 토큰 카운터                | unit: 누적 계산, 컨텍스트 잔여량 확인                 |
| Anthropic provider         | unit: mock API → 스트림 청크 변환 검증                |
| 응답 정규화                | unit: Anthropic/OpenAI 응답 → 통합 포맷 변환          |

### 검증 기준

```bash
# 단위 테스트 (mock 기반, 외부 API 호출 없음)
pnpm test -- src/execution/

# 커버리지 목표: statements 80%, branches 75%
pnpm test:coverage -- src/execution/
```

### E2E 검증 (Phase 9 완료 후)

```typescript
// test/e2e/execution.e2e.test.ts
it('단일 turn 실행: 도구 호출 없는 간단한 질의', async () => {
  const result = await runner.execute({
    agentId: 'test',
    conversationId: 'test-1',
    messages: [{ role: 'user', content: '안녕하세요' }],
    tools: [],
    model: { modelId: 'claude-sonnet-4-20250514', maxTokens: 1024 },
  });
  expect(result.status).toBe('completed');
  expect(result.turns).toBe(1);
});

it('멀티 turn 실행: 도구 호출 포함', async () => {
  const result = await runner.execute({
    agentId: 'test',
    conversationId: 'test-2',
    messages: [{ role: 'user', content: '삼성전자 현재 주가 알려줘' }],
    tools: [stockPriceTool],
    model: { modelId: 'claude-sonnet-4-20250514', maxTokens: 1024 },
  });
  expect(result.status).toBe('completed');
  expect(result.turns).toBeGreaterThanOrEqual(2); // LLM → tool → LLM
});
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값                                                       |
| ----------------- | -------------------------------------------------------- |
| **복잡도**        | **XL**                                                   |
| 소스 파일         | 12                                                       |
| 테스트 파일       | 8                                                        |
| **합계**          | **~20 파일**                                             |
| 예상 LOC (소스)   | 1,200 ~ 1,500                                            |
| 예상 LOC (테스트) | 1,000 ~ 1,200                                            |
| 신규 의존성       | `@anthropic-ai/sdk` (이미 있을 수 있음), `openai` (선택) |
| 예상 구현 시간    | 3-4일                                                    |
