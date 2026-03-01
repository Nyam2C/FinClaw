# Phase 9: 실행 엔진 — 상세 구현 TODO

> 코드베이스 실제 시그니처 대조 완료 (2026-02-28 기준)
> 대상 브랜치: `feature/execution-engine`

---

## 목차

| TODO              | 대상 파일                                   | 핵심 내용                                                 |
| ----------------- | ------------------------------------------- | --------------------------------------------------------- |
| [1](#todo-1)      | `provider-normalize.ts`                     | StreamChunk를 interface → discriminated union (6 variant) |
| [2](#todo-2)      | `adapter.ts`                                | ProviderAdapter에 `streamCompletion()` 메서드 추가        |
| [3](#todo-3)      | `execution/tool-input-buffer.ts` (신규)     | tool_use JSON 스트리밍 조합 버퍼                          |
| [4](#todo-4)      | `execution/streaming.ts` (신규)             | 유한 상태 머신 (5 state, 전이 테이블)                     |
| [5](#todo-5)      | `execution/tool-executor.ts` (신규)         | 도구 디스패치, 병렬 실행, 결과 크기 제한                  |
| [6](#todo-6)      | `execution/tokens.ts` (신규)                | 토큰 카운팅, 80%/95% 임계값 경고                          |
| [7](#todo-7)      | `providers/anthropic.ts`                    | streamCompletion() 구현 + cache_control                   |
| [8](#todo-8)      | `providers/openai.ts`                       | streamCompletion() 구현                                   |
| [9](#todo-9)      | `execution/runner.ts` (신규)                | 메인 오케스트레이션 루프                                  |
| [10](#todo-10)    | `provider-normalize.ts` + `events.ts`       | calculateEstimatedCost 캐시 비용 + FinClawEventMap 확장   |
| [부록](#appendix) | `execution/index.ts` + `agent/src/index.ts` | barrel export + 통합 검증                                 |

---

## TODO 1: StreamChunk discriminated union 변환 {#todo-1}

**대상 파일:** `packages/agent/src/models/provider-normalize.ts` (L27-32)

**현재 코드:**

```typescript
// L27-32
/** 스트리밍 청크 (타입만 선언, 구현은 Phase 9) */
export interface StreamChunk {
  readonly type: 'text_delta' | 'tool_use_delta' | 'usage' | 'done';
  readonly text?: string;
  readonly usage?: Partial<NormalizedUsage>;
}
```

**변경 후:**

```typescript
/** 스트리밍 청크 — discriminated union (6 variant) */
export type StreamChunk =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_use_start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool_input_delta'; readonly delta: string }
  | { readonly type: 'tool_use_end' }
  | { readonly type: 'usage'; readonly usage: Partial<NormalizedUsage> }
  | { readonly type: 'done' };
```

**변경 이유:**

- 기존 `interface`는 `type` 필드를 union literal로 가지지만, 각 variant의 payload가 모두 optional이라 타입 안전성이 낮다.
- discriminated union으로 변환하면 `chunk.type`에 따라 자동으로 payload가 narrowing된다.
- `tool_use_delta` → `tool_use_start` + `tool_input_delta` + `tool_use_end` 3개로 분리 (Anthropic 스트리밍 API의 실제 이벤트 시퀀스와 1:1 매칭).

**영향 범위:**

- `StreamChunk`를 참조하는 코드: barrel export (`index.ts` L39) — 타입 export이므로 `type` 키워드 유지, 변경 불필요.
- 현재 `StreamChunk`를 **값으로 사용하는 코드는 없음** (Phase 9 이전, 선언만 존재). 따라서 breaking change 없음.

**검증:**

```bash
pnpm exec tsc --noEmit  # 타입 체크 통과
pnpm test -- packages/agent/test/normalize.test.ts  # 기존 테스트 통과 (StreamChunk 미사용)
```

---

## TODO 2: ProviderAdapter에 streamCompletion() 추가 {#todo-2}

**대상 파일:** `packages/agent/src/providers/adapter.ts` (L18-22)

**현재 코드:**

```typescript
// L18-22
/** 제공자 어댑터 인터페이스 */
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  chatCompletion(params: ProviderRequestParams): Promise<unknown>;
}
```

**변경 후:**

```typescript
/** 제공자 어댑터 인터페이스 */
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  chatCompletion(params: ProviderRequestParams): Promise<unknown>;
  /** 스트리밍 LLM 호출 — Phase 9 실행 엔진용 */
  streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk>;
}
```

**추가 import:**

```typescript
// adapter.ts L1에 추가
import type { StreamChunk } from '../models/provider-normalize.js';
```

**영향 범위:**

- `AnthropicAdapter` (`providers/anthropic.ts`): `streamCompletion()` 구현 필요 → TODO 7
- `OpenAIAdapter` (`providers/openai.ts`): `streamCompletion()` 구현 필요 → TODO 8
- `createProviderAdapter()`: 반환 타입이 `ProviderAdapter`이므로 자동으로 새 시그니처 반영.

**검증:**

```bash
# 이 시점에서는 AnthropicAdapter/OpenAIAdapter가 streamCompletion() 미구현이므로
# 타입 에러 발생이 정상. TODO 7, 8 완료 후 통과.
pnpm exec tsc --noEmit
```

---

## TODO 3: ToolInputBuffer 구현 {#todo-3}

**신규 파일:** `packages/agent/src/execution/tool-input-buffer.ts`

**전체 코드:**

```typescript
// packages/agent/src/execution/tool-input-buffer.ts
import type { ToolCall } from '@finclaw/types';
import type { StreamChunk } from '../models/provider-normalize.js';

/** 진행 중인 도구 호출 버퍼 */
interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  inputJson: string;
}

/**
 * tool_use JSON 스트리밍 조합 버퍼
 *
 * Anthropic 스트리밍 API는 도구 입력을
 * tool_use_start → tool_input_delta* → tool_use_end 시퀀스로 전달한다.
 * JSON 조각을 버퍼링하여 완전한 ToolCall을 조립한다.
 */
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

**테스트 파일:** `packages/agent/test/tool-input-buffer.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolInputBuffer } from '../src/execution/tool-input-buffer.js';
import type { StreamChunk } from '../src/models/provider-normalize.js';

describe('ToolInputBuffer', () => {
  let buffer: ToolInputBuffer;

  beforeEach(() => {
    buffer = new ToolInputBuffer();
  });

  it('tool_use_start → input_delta → tool_use_end 시퀀스로 ToolCall을 조립한다', () => {
    expect(buffer.feed({ type: 'tool_use_start', id: 'call_1', name: 'get_price' })).toBeNull();
    expect(buffer.feed({ type: 'tool_input_delta', delta: '{"tic' })).toBeNull();
    expect(buffer.feed({ type: 'tool_input_delta', delta: 'ker":"AAPL"}' })).toBeNull();

    const result = buffer.feed({ type: 'tool_use_end' });
    expect(result).toEqual({
      id: 'call_1',
      name: 'get_price',
      input: { ticker: 'AAPL' },
    });
  });

  it('빈 input으로 tool_use_end가 오면 빈 객체를 반환한다', () => {
    buffer.feed({ type: 'tool_use_start', id: 'call_2', name: 'list_tools' });
    const result = buffer.feed({ type: 'tool_use_end' });
    expect(result).toEqual({ id: 'call_2', name: 'list_tools', input: {} });
  });

  it('pending 없이 tool_use_end가 오면 null을 반환한다', () => {
    expect(buffer.feed({ type: 'tool_use_end' })).toBeNull();
  });

  it('pending 없이 tool_input_delta가 오면 무시한다', () => {
    expect(buffer.feed({ type: 'tool_input_delta', delta: '{"x":1}' })).toBeNull();
  });

  it('text_delta, usage, done 청크는 null을 반환한다', () => {
    const irrelevant: StreamChunk[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'usage', usage: { inputTokens: 100 } },
      { type: 'done' },
    ];
    for (const chunk of irrelevant) {
      expect(buffer.feed(chunk)).toBeNull();
    }
  });

  it('reset()은 진행 중인 버퍼를 초기화한다', () => {
    buffer.feed({ type: 'tool_use_start', id: 'call_3', name: 'test' });
    buffer.feed({ type: 'tool_input_delta', delta: '{"a":1' });
    buffer.reset();
    // reset 후 tool_use_end는 null (pending 없음)
    expect(buffer.feed({ type: 'tool_use_end' })).toBeNull();
  });

  it('연속 도구 호출을 순차적으로 처리한다', () => {
    buffer.feed({ type: 'tool_use_start', id: 'c1', name: 'tool_a' });
    buffer.feed({ type: 'tool_input_delta', delta: '{}' });
    const r1 = buffer.feed({ type: 'tool_use_end' });
    expect(r1).toEqual({ id: 'c1', name: 'tool_a', input: {} });

    buffer.feed({ type: 'tool_use_start', id: 'c2', name: 'tool_b' });
    buffer.feed({ type: 'tool_input_delta', delta: '{"v":2}' });
    const r2 = buffer.feed({ type: 'tool_use_end' });
    expect(r2).toEqual({ id: 'c2', name: 'tool_b', input: { v: 2 } });
  });
});
```

**검증:**

```bash
pnpm test -- packages/agent/test/tool-input-buffer.test.ts
```

---

## TODO 4: StreamStateMachine 구현 {#todo-4}

**신규 파일:** `packages/agent/src/execution/streaming.ts`

**전체 코드:**

```typescript
// packages/agent/src/execution/streaming.ts
import { EventEmitter } from 'node:events';
import type { ConversationMessage, TokenUsage, ToolCall } from '@finclaw/types';

/** 스트리밍 상태 */
export type StreamState =
  | 'idle' // 대기 중
  | 'streaming' // LLM 응답 스트리밍 중
  | 'tool_use' // tool_use 블록 감지됨
  | 'executing' // 도구 실행 중
  | 'done'; // 실행 완료

/** 도구 실행 결과 (streaming 모듈에서 이벤트용으로 사용) */
export interface ToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

/** 실행 결과 */
export interface ExecutionResult {
  readonly status: 'completed' | 'max_turns' | 'aborted' | 'error';
  readonly messages: readonly ConversationMessage[];
  readonly usage: TokenUsage;
  readonly turns: number;
  readonly durationMs: number;
}

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

/** 허용된 상태 전이 테이블 */
const TRANSITIONS: Record<StreamState, readonly StreamState[]> = {
  idle: ['streaming'],
  streaming: ['tool_use', 'done'],
  tool_use: ['executing'],
  executing: ['streaming', 'done'],
  done: ['idle'], // 리셋용
} as const;

/**
 * 스트리밍 상태 머신
 *
 * 5개 상태의 유한 상태 머신으로 스트리밍 진행 상태를 관리한다.
 * EventEmitter 기반으로 외부 리스너에게 이벤트를 발행한다.
 *
 * 전이 규칙:
 *   idle → streaming
 *   streaming → tool_use | done
 *   tool_use → executing
 *   executing → streaming | done
 *   done → idle (리셋)
 */
export class StreamStateMachine {
  private state: StreamState = 'idle';
  private readonly emitter = new EventEmitter();

  get currentState(): StreamState {
    return this.state;
  }

  /** 이벤트 리스너 등록. 해제 함수 반환. */
  on(listener: StreamEventListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** 상태 전이. 허용되지 않은 전이 시 Error throw. */
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

  /** 상태를 idle로 리셋 */
  reset(): void {
    this.state = 'idle';
  }
}
```

**테스트 파일:** `packages/agent/test/streaming.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamStateMachine } from '../src/execution/streaming.js';
import type { StreamState, StreamEvent } from '../src/execution/streaming.js';

describe('StreamStateMachine', () => {
  let sm: StreamStateMachine;

  beforeEach(() => {
    sm = new StreamStateMachine();
  });

  it('초기 상태는 idle이다', () => {
    expect(sm.currentState).toBe('idle');
  });

  describe('허용된 전이', () => {
    it('idle → streaming', () => {
      sm.transition('streaming');
      expect(sm.currentState).toBe('streaming');
    });

    it('streaming → tool_use', () => {
      sm.transition('streaming');
      sm.transition('tool_use');
      expect(sm.currentState).toBe('tool_use');
    });

    it('streaming → done', () => {
      sm.transition('streaming');
      sm.transition('done');
      expect(sm.currentState).toBe('done');
    });

    it('tool_use → executing', () => {
      sm.transition('streaming');
      sm.transition('tool_use');
      sm.transition('executing');
      expect(sm.currentState).toBe('executing');
    });

    it('executing → streaming (다음 턴)', () => {
      sm.transition('streaming');
      sm.transition('tool_use');
      sm.transition('executing');
      sm.transition('streaming');
      expect(sm.currentState).toBe('streaming');
    });

    it('executing → done', () => {
      sm.transition('streaming');
      sm.transition('tool_use');
      sm.transition('executing');
      sm.transition('done');
      expect(sm.currentState).toBe('done');
    });

    it('done → idle (리셋)', () => {
      sm.transition('streaming');
      sm.transition('done');
      sm.transition('idle');
      expect(sm.currentState).toBe('idle');
    });
  });

  describe('금지된 전이', () => {
    it.each([
      ['idle', 'tool_use'],
      ['idle', 'executing'],
      ['idle', 'done'],
      ['streaming', 'idle'],
      ['streaming', 'executing'],
      ['tool_use', 'idle'],
      ['tool_use', 'streaming'],
      ['tool_use', 'done'],
      ['executing', 'idle'],
      ['executing', 'tool_use'],
      ['done', 'streaming'],
      ['done', 'tool_use'],
      ['done', 'executing'],
      ['done', 'done'],
    ] as [StreamState, StreamState][])('%s → %s는 에러를 던진다', (from, to) => {
      // from 상태까지 이동
      const paths: Record<StreamState, StreamState[]> = {
        idle: [],
        streaming: ['streaming'],
        tool_use: ['streaming', 'tool_use'],
        executing: ['streaming', 'tool_use', 'executing'],
        done: ['streaming', 'done'],
      };
      for (const step of paths[from]) {
        sm.transition(step);
      }
      expect(() => sm.transition(to)).toThrow(/Invalid state transition/);
    });
  });

  describe('이벤트 발행', () => {
    it('전이 시 state_change 이벤트를 발행한다', () => {
      const events: StreamEvent[] = [];
      sm.on((e) => events.push(e));

      sm.transition('streaming');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'state_change', from: 'idle', to: 'streaming' });
    });

    it('emit()으로 임의 이벤트를 발행할 수 있다', () => {
      const events: StreamEvent[] = [];
      sm.on((e) => events.push(e));

      sm.emit({ type: 'text_delta', delta: 'hello' });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text_delta', delta: 'hello' });
    });

    it('on()이 반환한 함수로 리스너를 해제한다', () => {
      const events: StreamEvent[] = [];
      const off = sm.on((e) => events.push(e));

      sm.transition('streaming');
      expect(events).toHaveLength(1);

      off();
      sm.transition('done');
      expect(events).toHaveLength(1); // 추가 이벤트 없음
    });
  });

  describe('reset()', () => {
    it('상태를 idle로 리셋한다', () => {
      sm.transition('streaming');
      sm.transition('done');
      sm.reset();
      expect(sm.currentState).toBe('idle');
    });

    it('리셋 후 idle에서 다시 시작할 수 있다', () => {
      sm.transition('streaming');
      sm.transition('done');
      sm.reset();
      sm.transition('streaming'); // idle → streaming
      expect(sm.currentState).toBe('streaming');
    });
  });
});
```

**검증:**

```bash
pnpm test -- packages/agent/test/streaming.test.ts
```

---

## TODO 5: ToolExecutor 구현 {#todo-5}

**신규 파일:** `packages/agent/src/execution/tool-executor.ts`

> **주의:** `@finclaw/agent`의 Phase 7에 이미 `ToolExecutor` **타입**이 `agents/tools/registry.ts`에 존재한다.
> Phase 9의 `ToolExecutor` **클래스**는 `execution/` 디렉토리 내부 모듈로, 이름 충돌을 피하기 위해
> 클래스명을 `ExecutionToolDispatcher`로 한다. barrel export에서 구분한다.

**전체 코드:**

```typescript
// packages/agent/src/execution/tool-executor.ts
import type { ToolCall } from '@finclaw/types';

/** 도구 핸들러 인터페이스 */
export interface ToolHandler {
  execute(input: unknown, signal?: AbortSignal): Promise<string>;
}

/** 도구 실행 결과 */
export interface ExecutionToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

const MAX_RESULT_CHARS = 10_000;

/**
 * 도구 디스패치 및 병렬 실행
 *
 * - 등록된 ToolHandler에 도구 호출을 디스패치
 * - 미등록 도구는 isError: true로 반환
 * - 결과 크기 제한 (MAX_RESULT_CHARS: 10,000자)
 * - 병렬 실행 (Promise.all)
 */
export class ExecutionToolDispatcher {
  private readonly handlers = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }

  unregister(name: string): boolean {
    return this.handlers.delete(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async executeAll(
    toolCalls: readonly ToolCall[],
    signal?: AbortSignal,
  ): Promise<readonly ExecutionToolResult[]> {
    return Promise.all(toolCalls.map((call) => this.executeSingle(call, signal)));
  }

  private async executeSingle(call: ToolCall, signal?: AbortSignal): Promise<ExecutionToolResult> {
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

**테스트 파일:** `packages/agent/test/execution-tool-executor.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionToolDispatcher } from '../src/execution/tool-executor.js';
import type { ToolHandler } from '../src/execution/tool-executor.js';
import type { ToolCall } from '@finclaw/types';

describe('ExecutionToolDispatcher', () => {
  let dispatcher: ExecutionToolDispatcher;

  beforeEach(() => {
    dispatcher = new ExecutionToolDispatcher();
  });

  describe('register / unregister / has', () => {
    it('핸들러를 등록하고 존재 여부를 확인한다', () => {
      const handler: ToolHandler = { execute: async () => 'ok' };
      dispatcher.register('test_tool', handler);
      expect(dispatcher.has('test_tool')).toBe(true);
      expect(dispatcher.has('unknown')).toBe(false);
    });

    it('핸들러를 해제한다', () => {
      dispatcher.register('test_tool', { execute: async () => 'ok' });
      expect(dispatcher.unregister('test_tool')).toBe(true);
      expect(dispatcher.has('test_tool')).toBe(false);
    });

    it('미등록 핸들러 해제 시 false 반환', () => {
      expect(dispatcher.unregister('nonexistent')).toBe(false);
    });
  });

  describe('executeSingle (executeAll 경유)', () => {
    it('등록된 도구를 실행하고 결과를 반환한다', async () => {
      dispatcher.register('get_price', {
        execute: async (input) => {
          const { ticker } = input as { ticker: string };
          return `${ticker}: 50000`;
        },
      });

      const results = await dispatcher.executeAll([
        { id: 'call_1', name: 'get_price', input: { ticker: 'AAPL' } },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolUseId: 'call_1',
        content: 'AAPL: 50000',
        isError: false,
      });
    });

    it('미등록 도구는 isError: true를 반환한다', async () => {
      const results = await dispatcher.executeAll([
        { id: 'call_2', name: 'unknown_tool', input: {} },
      ]);

      expect(results[0]).toEqual({
        toolUseId: 'call_2',
        content: 'Unknown tool: unknown_tool',
        isError: true,
      });
    });

    it('실행 에러 시 isError: true로 에러 메시지를 반환한다', async () => {
      dispatcher.register('failing_tool', {
        execute: async () => {
          throw new Error('API unavailable');
        },
      });

      const results = await dispatcher.executeAll([
        { id: 'call_3', name: 'failing_tool', input: {} },
      ]);

      expect(results[0]).toEqual({
        toolUseId: 'call_3',
        content: 'Tool execution error: API unavailable',
        isError: true,
      });
    });
  });

  describe('결과 크기 제한', () => {
    it('10,000자 초과 결과를 절삭한다', async () => {
      const longResult = 'x'.repeat(15_000);
      dispatcher.register('verbose_tool', {
        execute: async () => longResult,
      });

      const results = await dispatcher.executeAll([
        { id: 'call_4', name: 'verbose_tool', input: {} },
      ]);

      expect(results[0]!.content.length).toBeLessThanOrEqual(10_000 + 20); // + '\n... [truncated]'
      expect(results[0]!.content).toContain('... [truncated]');
      expect(results[0]!.isError).toBe(false);
    });

    it('정확히 10,000자는 절삭하지 않는다', async () => {
      const exactResult = 'y'.repeat(10_000);
      dispatcher.register('exact_tool', {
        execute: async () => exactResult,
      });

      const results = await dispatcher.executeAll([
        { id: 'call_5', name: 'exact_tool', input: {} },
      ]);

      expect(results[0]!.content).toBe(exactResult);
    });
  });

  describe('병렬 실행', () => {
    it('여러 도구를 병렬로 실행한다', async () => {
      const order: string[] = [];

      dispatcher.register('slow', {
        execute: async () => {
          await new Promise((r) => setTimeout(r, 50));
          order.push('slow');
          return 'slow done';
        },
      });
      dispatcher.register('fast', {
        execute: async () => {
          order.push('fast');
          return 'fast done';
        },
      });

      const calls: ToolCall[] = [
        { id: 'c1', name: 'slow', input: {} },
        { id: 'c2', name: 'fast', input: {} },
      ];

      const results = await dispatcher.executeAll(calls);
      expect(results).toHaveLength(2);
      // fast가 먼저 완료되어야 병렬 실행이 증명됨
      expect(order[0]).toBe('fast');
      expect(results[0]!.content).toBe('slow done');
      expect(results[1]!.content).toBe('fast done');
    });
  });

  describe('AbortSignal', () => {
    it('signal을 핸들러에 전달한다', async () => {
      const receivedSignal = vi.fn();
      dispatcher.register('sig_tool', {
        execute: async (_input, signal) => {
          receivedSignal(signal);
          return 'ok';
        },
      });

      const controller = new AbortController();
      await dispatcher.executeAll([{ id: 'c1', name: 'sig_tool', input: {} }], controller.signal);

      expect(receivedSignal).toHaveBeenCalledWith(controller.signal);
    });
  });
});
```

**검증:**

```bash
pnpm test -- packages/agent/test/execution-tool-executor.test.ts
```

---

## TODO 6: TokenCounter 구현 {#todo-6}

**신규 파일:** `packages/agent/src/execution/tokens.ts`

**전체 코드:**

```typescript
// packages/agent/src/execution/tokens.ts
import type { TokenUsage } from '@finclaw/types';
import type { StreamEventListener } from './streaming.js';

/**
 * 토큰 카운터
 *
 * - 누적 토큰 사용량 관리
 * - contextWindow 기반 사용률 계산
 * - 80%/95% 임계값 경고 (리스너에 usage_update 이벤트 발행)
 */
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

  /** 토큰 사용량 누적 */
  add(delta: TokenUsage): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + delta.inputTokens,
      outputTokens: this.usage.outputTokens + delta.outputTokens,
      cacheReadTokens: (this.usage.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
      cacheWriteTokens: (this.usage.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
    };
  }

  /** 컨텍스트 윈도우 사용률 (0.0 ~ 1.0+) */
  usageRatio(): number {
    return this.usage.inputTokens / this.contextWindow;
  }

  /** 컨텍스트 윈도우 잔여 토큰 수 */
  remaining(): number {
    return Math.max(0, this.contextWindow - this.usage.inputTokens);
  }

  /**
   * 80%/95% 임계값 경고
   *
   * 각 임계값은 최초 1회만 발행한다.
   * 리스너에 usage_update 이벤트를 발행하여 상위 레이어(컴팩션 등)에 알린다.
   */
  checkThresholds(listener?: StreamEventListener): void {
    const ratio = this.usageRatio();
    if (!this.warned80 && ratio >= 0.8) {
      this.warned80 = true;
      listener?.({ type: 'usage_update', usage: this.current });
    }
    if (!this.warned95 && ratio >= 0.95) {
      this.warned95 = true;
      listener?.({ type: 'usage_update', usage: this.current });
    }
  }

  /** 현재 누적 사용량 (읽기 전용) */
  get current(): Readonly<TokenUsage> {
    return this.usage;
  }
}
```

**테스트 파일:** `packages/agent/test/tokens.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TokenCounter } from '../src/execution/tokens.js';
import type { StreamEventListener, StreamEvent } from '../src/execution/streaming.js';
import type { TokenUsage } from '@finclaw/types';

describe('TokenCounter', () => {
  const CONTEXT_WINDOW = 100_000;
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter(CONTEXT_WINDOW);
  });

  describe('add / current', () => {
    it('토큰 사용량을 누적한다', () => {
      counter.add({ inputTokens: 100, outputTokens: 50 });
      counter.add({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 10 });

      expect(counter.current).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
      });
    });

    it('초기 사용량은 모두 0이다', () => {
      expect(counter.current).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it('cacheReadTokens/cacheWriteTokens가 undefined이면 0으로 처리한다', () => {
      counter.add({ inputTokens: 100, outputTokens: 50 }); // cache 필드 없음
      counter.add({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 3 });

      expect(counter.current.cacheReadTokens).toBe(5);
      expect(counter.current.cacheWriteTokens).toBe(3);
    });
  });

  describe('usageRatio', () => {
    it('inputTokens / contextWindow 비율을 반환한다', () => {
      counter.add({ inputTokens: 50_000, outputTokens: 0 });
      expect(counter.usageRatio()).toBeCloseTo(0.5);
    });

    it('0 토큰이면 0을 반환한다', () => {
      expect(counter.usageRatio()).toBe(0);
    });
  });

  describe('remaining', () => {
    it('잔여 토큰 수를 반환한다', () => {
      counter.add({ inputTokens: 30_000, outputTokens: 0 });
      expect(counter.remaining()).toBe(70_000);
    });

    it('초과 시 0을 반환한다 (음수 방지)', () => {
      counter.add({ inputTokens: 120_000, outputTokens: 0 });
      expect(counter.remaining()).toBe(0);
    });
  });

  describe('checkThresholds', () => {
    it('79% → 경고 없음', () => {
      const listener = vi.fn<StreamEventListener>();
      counter.add({ inputTokens: 79_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      expect(listener).not.toHaveBeenCalled();
    });

    it('80% → 경고 1회 발행', () => {
      const listener = vi.fn<StreamEventListener>();
      counter.add({ inputTokens: 80_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        type: 'usage_update',
        usage: expect.objectContaining({ inputTokens: 80_000 }),
      });
    });

    it('80% 경고는 1회만 발행한다', () => {
      const listener = vi.fn<StreamEventListener>();
      counter.add({ inputTokens: 80_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      counter.checkThresholds(listener);
      // 80% 경고 1회만
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('95% → 80% + 95% 경고 모두 발행', () => {
      const listener = vi.fn<StreamEventListener>();
      counter.add({ inputTokens: 95_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      // 80%, 95% 두 번 호출
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('80% 이미 경고 후 95% 도달 시 95%만 추가 발행', () => {
      const listener = vi.fn<StreamEventListener>();
      // 80% 도달
      counter.add({ inputTokens: 80_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      expect(listener).toHaveBeenCalledTimes(1);

      // 95% 도달
      counter.add({ inputTokens: 15_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      expect(listener).toHaveBeenCalledTimes(2); // 80%(기존) + 95%(신규)
    });

    it('리스너가 없으면 에러 없이 무시한다', () => {
      counter.add({ inputTokens: 95_000, outputTokens: 0 });
      expect(() => counter.checkThresholds()).not.toThrow();
      expect(() => counter.checkThresholds(undefined)).not.toThrow();
    });
  });
});
```

**검증:**

```bash
pnpm test -- packages/agent/test/tokens.test.ts
```

---

## TODO 7: AnthropicAdapter.streamCompletion() 구현 {#todo-7}

**대상 파일:** `packages/agent/src/providers/anthropic.ts`

**현재 코드:** `AnthropicAdapter` 클래스 (L6-42), `chatCompletion()` 메서드만 존재.

**변경 내용:** `streamCompletion()` 메서드 추가 + `mapAnthropicStreamEvent()` private 메서드 추가 + import 추가.

**변경 후 전체 파일:**

```typescript
// packages/agent/src/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages.js';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';
import type { StreamChunk } from '../models/provider-normalize.js';
import { FailoverError } from '../errors.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl });
  }

  // TODO(L3): params.tools를 SDK 호출에 전달해야 함 (Phase 9+ 도구 사용 기능)
  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    const systemMessages = params.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = params.messages.filter((m) => m.role !== 'system');

    const system = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    try {
      return await this.client.messages.create(
        {
          model: params.model,
          max_tokens: params.maxTokens ?? 4096,
          ...(system ? { system } : {}),
          messages: nonSystemMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        },
        { signal: params.abortSignal },
      );
    } catch (error) {
      throw wrapAnthropicError(error);
    }
  }

  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    const systemMessages = params.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = params.messages.filter((m) => m.role !== 'system');
    const system = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    const convertedTools = (params.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    }));

    // 마지막 도구에 cache_control 부착 (prompt caching)
    const toolsWithCache = convertedTools.map((tool, i) =>
      i === convertedTools.length - 1
        ? { ...tool, cache_control: { type: 'ephemeral' as const } }
        : tool,
    );

    try {
      const stream = this.client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        ...(system
          ? {
              system: [
                {
                  type: 'text' as const,
                  text: system,
                  cache_control: { type: 'ephemeral' as const },
                },
              ],
            }
          : {}),
        messages: nonSystemMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
        ...(toolsWithCache.length ? { tools: toolsWithCache } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      });

      for await (const event of stream) {
        yield* this.mapAnthropicStreamEvent(event);
      }
    } catch (error) {
      throw wrapAnthropicError(error);
    }
  }

  private *mapAnthropicStreamEvent(event: RawMessageStreamEvent): Iterable<StreamChunk> {
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          yield {
            type: 'tool_use_start',
            id: event.content_block.id,
            name: event.content_block.name,
          };
        }
        break;

      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          yield { type: 'tool_input_delta', delta: event.delta.partial_json };
        }
        break;

      case 'content_block_stop':
        // tool_use 블록 종료 시 tool_use_end 발행
        // content_block_stop에는 content_block 타입 정보가 없으므로
        // ToolInputBuffer에서 pending 상태 여부로 판단
        yield { type: 'tool_use_end' };
        break;

      case 'message_delta':
        if (event.usage) {
          yield {
            type: 'usage',
            usage: { outputTokens: event.usage.output_tokens },
          };
        }
        break;

      case 'message_start':
        if (event.message.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: event.message.usage.input_tokens,
              outputTokens: event.message.usage.output_tokens,
            },
          };
        }
        break;

      case 'message_stop':
        yield { type: 'done' };
        break;
    }
  }
}

/** Anthropic SDK 에러 → FailoverError 변환 */
function wrapAnthropicError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  if (error.name === 'AbortError') {
    return error;
  }

  const status = (error as { status?: number }).status;
  if (status === 429) {
    return new FailoverError(`Anthropic rate limit: ${error.message}`, 'rate-limit', {
      statusCode: 429,
      cause: error,
    });
  }
  if (status === 529) {
    return new FailoverError(`Anthropic overloaded: ${error.message}`, 'model-unavailable', {
      statusCode: 529,
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new FailoverError(`Anthropic server error: ${error.message}`, 'server-error', {
      statusCode: status,
      cause: error,
    });
  }
  return error;
}
```

> **주의:** `RawMessageStreamEvent` import 경로는 `@anthropic-ai/sdk` 패키지 버전에 따라
> `@anthropic-ai/sdk/resources/messages.js` 또는 `@anthropic-ai/sdk/resources/messages/messages.js`일 수 있다.
> 구현 시 `node_modules/@anthropic-ai/sdk` 내부를 확인하여 정확한 경로를 사용할 것.
> 만약 import가 불가능하면 `unknown` 타입으로 대체하고 `as` 캐스트로 필드 접근한다.

**검증:**

```bash
pnpm exec tsc --noEmit  # 타입 체크 통과
```

---

## TODO 8: OpenAIAdapter.streamCompletion() 구현 {#todo-8}

**대상 파일:** `packages/agent/src/providers/openai.ts`

**변경 내용:** `streamCompletion()` 메서드 추가 + `mapOpenAIStreamChunk()` private 메서드 추가 + import 추가.

**변경 후 전체 파일:**

```typescript
// packages/agent/src/providers/openai.ts
import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions.js';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';
import type { StreamChunk } from '../models/provider-normalize.js';
import { FailoverError } from '../errors.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  // TODO(L3): params.tools를 SDK 호출에 전달해야 함 (Phase 9+ 도구 사용 기능)
  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    try {
      return await this.client.chat.completions.create(
        {
          model: params.model,
          messages: params.messages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        },
        { signal: params.abortSignal },
      );
    } catch (error) {
      throw wrapOpenAIError(error);
    }
  }

  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: params.model,
          messages: params.messages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          ...(params.tools?.length
            ? {
                tools: params.tools.map((t) => ({
                  type: 'function' as const,
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema,
                  },
                })),
              }
            : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: params.abortSignal },
      );

      for await (const chunk of stream) {
        yield* this.mapOpenAIStreamChunk(chunk as ChatCompletionChunk);
      }
    } catch (error) {
      throw wrapOpenAIError(error);
    }
  }

  private *mapOpenAIStreamChunk(chunk: ChatCompletionChunk): Iterable<StreamChunk> {
    const choice = chunk.choices?.[0];

    if (choice?.delta?.content) {
      yield { type: 'text_delta', text: choice.delta.content };
    }

    if (choice?.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        if (tc.function?.name) {
          yield {
            type: 'tool_use_start',
            id: tc.id ?? `tool_${tc.index}`,
            name: tc.function.name,
          };
        }
        if (tc.function?.arguments) {
          yield { type: 'tool_input_delta', delta: tc.function.arguments };
        }
      }
    }

    if (choice?.finish_reason === 'tool_calls') {
      yield { type: 'tool_use_end' };
    }

    if (chunk.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        },
      };
    }

    if (choice?.finish_reason === 'stop') {
      yield { type: 'done' };
    }
  }
}

/** OpenAI SDK 에러 → FailoverError 변환 */
function wrapOpenAIError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  if (error.name === 'AbortError') {
    return error;
  }

  const status = (error as { status?: number }).status;
  if (status === 429) {
    return new FailoverError(`OpenAI rate limit: ${error.message}`, 'rate-limit', {
      statusCode: 429,
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new FailoverError(`OpenAI server error: ${error.message}`, 'server-error', {
      statusCode: status,
      cause: error,
    });
  }
  return error;
}
```

> **주의:** `ChatCompletionChunk` import 경로는 `openai` 패키지 버전에 따라
> `openai/resources/chat/completions.js` 또는 `openai/resources/chat/completions/completions.js`일 수 있다.
> 구현 시 `node_modules/openai` 내부를 확인할 것.
> OpenAI의 `stream_options: { include_usage: true }`는 마지막 청크에 usage를 포함시킨다.

**검증:**

```bash
pnpm exec tsc --noEmit  # 타입 체크 통과
```

---

## TODO 9: Runner 오케스트레이션 루프 구현 {#todo-9}

**신규 파일:** `packages/agent/src/execution/runner.ts`

**참조하는 시그니처:**

| 모듈                                 | 시그니처                                                                         | 출처                                         |
| ------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------- |
| `retry`                              | `retry<T>(fn: (attempt: number) => Promise<T>, opts?: RetryOptions): Promise<T>` | `packages/infra/src/retry.ts:40`             |
| `ConcurrencyLaneManager.acquire`     | `acquire(laneId: LaneId, key: string): Promise<LaneHandle>`                      | `packages/infra/src/concurrency-lane.ts:171` |
| `LaneHandle.release`                 | `release(): void`                                                                | `packages/infra/src/concurrency-lane.ts:24`  |
| `classifyFallbackError`              | `(error: Error) => FallbackReason \| null`                                       | `packages/agent/src/errors.ts:38`            |
| `ProviderAdapter.streamCompletion`   | `(params: ProviderRequestParams) => AsyncIterable<StreamChunk>`                  | TODO 2                                       |
| `ToolInputBuffer.feed`               | `(chunk: StreamChunk) => ToolCall \| null`                                       | TODO 3                                       |
| `StreamStateMachine.transition`      | `(to: StreamState) => void`                                                      | TODO 4                                       |
| `ExecutionToolDispatcher.executeAll` | `(toolCalls, signal?) => Promise<readonly ExecutionToolResult[]>`                | TODO 5                                       |
| `TokenCounter.add/checkThresholds`   | add: `(delta: TokenUsage) => void`, checkThresholds: `(listener?) => void`       | TODO 6                                       |

**전체 코드:**

```typescript
// packages/agent/src/execution/runner.ts
import type { AgentRunParams, ConversationMessage, ToolCall, TokenUsage } from '@finclaw/types';
import { retry, type RetryOptions } from '@finclaw/infra';
import { ConcurrencyLaneManager, type LaneId } from '@finclaw/infra';
import { classifyFallbackError } from '../errors.js';
import type { ProviderAdapter, ProviderRequestParams } from '../providers/adapter.js';
import type { StreamChunk } from '../models/provider-normalize.js';
import { StreamStateMachine } from './streaming.js';
import type { StreamEventListener, ExecutionResult } from './streaming.js';
import { ExecutionToolDispatcher } from './tool-executor.js';
import type { ExecutionToolResult } from './tool-executor.js';
import { TokenCounter } from './tokens.js';
import { ToolInputBuffer } from './tool-input-buffer.js';

export interface RunnerOptions {
  readonly provider: ProviderAdapter;
  readonly toolExecutor: ExecutionToolDispatcher;
  readonly laneManager: ConcurrencyLaneManager;
  readonly laneId?: LaneId;
  readonly maxTurns?: number;
  readonly retryOptions?: RetryOptions;
}

/** streamLLMCall 내부 반환값 */
interface LLMCallResult {
  readonly message: ConversationMessage;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
}

/**
 * 실행 엔진 메인 러너
 *
 * 사용자 메시지를 받아 LLM 호출 → tool_use 감지 → 도구 실행 → 후속 LLM 호출을
 * 반복하는 오케스트레이션 루프.
 *
 * 통합 모듈:
 * - retry() + classifyFallbackError(): 재시도 로직
 * - ConcurrencyLaneManager: 동시성 제어
 * - StreamStateMachine: 상태 전이 관리
 * - ToolInputBuffer: tool_use JSON 조합
 * - ExecutionToolDispatcher: 도구 실행
 * - TokenCounter: 토큰 카운팅 + 임계값 경고
 */
export class Runner {
  private readonly provider: ProviderAdapter;
  private readonly toolExecutor: ExecutionToolDispatcher;
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
   * 1. Lane 핸들 획득
   * 2. Turn 루프:
   *    a. LLM 스트리밍 호출 (retry + classifyFallbackError 통합)
   *    b. tool_use 감지 시 도구 실행
   *    c. 도구 결과를 메시지에 추가
   *    d. maxTurns 도달 또는 tool_use 없으면 종료
   * 3. Lane 핸들 release
   */
  async execute(params: AgentRunParams, listener?: StreamEventListener): Promise<ExecutionResult> {
    const tokenCounter = new TokenCounter(params.model.contextWindow);
    const startTime = Date.now();
    const messages = [...params.messages];

    const handle = await this.laneManager.acquire(this.laneId, params.sessionKey as string);

    try {
      let turns = 0;

      while (turns < this.maxTurns) {
        if (params.abortSignal?.aborted) {
          return buildResult('aborted', messages, tokenCounter, startTime, turns);
        }

        turns++;

        const response = await retry(() => this.streamLLMCall(params, messages, listener), {
          ...this.retryOptions,
          shouldRetry: (error) => {
            const reason = classifyFallbackError(error as Error);
            return reason === 'rate-limit' || reason === 'server-error' || reason === 'timeout';
          },
          signal: params.abortSignal,
        });

        tokenCounter.add(response.usage);
        messages.push(response.message);

        tokenCounter.checkThresholds(listener);

        if (!response.toolCalls.length) {
          return buildResult('completed', messages, tokenCounter, startTime, turns);
        }

        const results = await this.toolExecutor.executeAll(response.toolCalls, params.abortSignal);

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

      return buildResult('max_turns', messages, tokenCounter, startTime, turns);
    } finally {
      handle.release();
    }
  }

  /**
   * 단일 LLM 스트리밍 호출
   *
   * provider.streamCompletion()으로 스트림을 열고,
   * StreamChunk를 소비하면서 텍스트/도구호출/사용량을 수집한다.
   */
  private async streamLLMCall(
    params: AgentRunParams,
    messages: ConversationMessage[],
    listener?: StreamEventListener,
  ): Promise<LLMCallResult> {
    const sm = new StreamStateMachine();
    if (listener) sm.on(listener);

    sm.transition('streaming');

    const buffer = new ToolInputBuffer();
    const toolCalls: ToolCall[] = [];
    let text = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    const requestParams: ProviderRequestParams = {
      model: params.model.model,
      messages,
      tools: params.tools,
      temperature: params.temperature,
      maxTokens: params.maxTokens ?? params.model.maxOutputTokens,
      abortSignal: params.abortSignal,
    };

    for await (const chunk of this.provider.streamCompletion(requestParams)) {
      switch (chunk.type) {
        case 'text_delta':
          text += chunk.text;
          listener?.({ type: 'text_delta', delta: chunk.text });
          break;

        case 'tool_use_start':
        case 'tool_input_delta':
        case 'tool_use_end': {
          const completed = buffer.feed(chunk);
          if (chunk.type === 'tool_use_start' && sm.currentState === 'streaming') {
            sm.transition('tool_use');
          }
          if (completed) {
            toolCalls.push(completed);
            listener?.({ type: 'tool_use_start', toolCall: completed });
          }
          break;
        }

        case 'usage':
          if (chunk.usage.inputTokens !== undefined) {
            usage = {
              ...usage,
              inputTokens: chunk.usage.inputTokens,
            };
          }
          if (chunk.usage.outputTokens !== undefined) {
            usage = {
              ...usage,
              outputTokens: chunk.usage.outputTokens,
            };
          }
          break;

        case 'done':
          break;
      }
    }

    const contentBlocks = [];
    if (text) {
      contentBlocks.push({ type: 'text' as const, text });
    }
    for (const tc of toolCalls) {
      contentBlocks.push({
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    const message: ConversationMessage = {
      role: 'assistant',
      content:
        contentBlocks.length === 1 && contentBlocks[0]!.type === 'text' ? text : contentBlocks,
    };

    // 상태 전이: streaming/tool_use → done
    if (sm.currentState === 'streaming' || sm.currentState === 'tool_use') {
      if (sm.currentState === 'tool_use') {
        sm.transition('executing'); // tool_use → executing
        sm.transition('done'); // executing → done
      } else {
        sm.transition('done'); // streaming → done
      }
    }

    return { message, toolCalls, usage };
  }
}

function buildResult(
  status: ExecutionResult['status'],
  messages: ConversationMessage[],
  tokenCounter: TokenCounter,
  startTime: number,
  turns: number,
): ExecutionResult {
  return {
    status,
    messages,
    usage: tokenCounter.current,
    turns,
    durationMs: Date.now() - startTime,
  };
}

// Re-export for convenience
export type { ExecutionResult, StreamEventListener } from './streaming.js';
```

**테스트 파일:** `packages/agent/test/runner.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Runner } from '../src/execution/runner.js';
import type { RunnerOptions } from '../src/execution/runner.js';
import { ExecutionToolDispatcher } from '../src/execution/tool-executor.js';
import { ConcurrencyLaneManager } from '@finclaw/infra';
import type { AgentRunParams, ConversationMessage } from '@finclaw/types';
import type { ProviderAdapter, ProviderRequestParams } from '../src/providers/adapter.js';
import type { StreamChunk } from '../src/models/provider-normalize.js';
import type { StreamEvent, ExecutionResult } from '../src/execution/streaming.js';

/** mock provider: 미리 정해진 StreamChunk 시퀀스를 반환 */
function createMockProvider(sequences: StreamChunk[][]): ProviderAdapter {
  let callIndex = 0;
  return {
    providerId: 'anthropic',
    chatCompletion: async () => ({}),
    async *streamCompletion(_params: ProviderRequestParams): AsyncIterable<StreamChunk> {
      const seq = sequences[callIndex++] ?? [];
      for (const chunk of seq) {
        yield chunk;
      }
    },
  };
}

function createBaseParams(overrides?: Partial<AgentRunParams>): AgentRunParams {
  return {
    agentId: 'test-agent' as AgentRunParams['agentId'],
    sessionKey: 'test-session' as AgentRunParams['sessionKey'],
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    },
    systemPrompt: '테스트 시스템 프롬프트',
    messages: [{ role: 'user', content: '안녕하세요' }],
    ...overrides,
  };
}

describe('Runner', () => {
  let toolExecutor: ExecutionToolDispatcher;
  let laneManager: ConcurrencyLaneManager;

  beforeEach(() => {
    toolExecutor = new ExecutionToolDispatcher();
    laneManager = new ConcurrencyLaneManager();
  });

  function createRunner(provider: ProviderAdapter, opts?: Partial<RunnerOptions>): Runner {
    return new Runner({
      provider,
      toolExecutor,
      laneManager,
      ...opts,
    });
  }

  describe('단일 턴 실행', () => {
    it('도구 호출 없는 간단한 질의 — completed 반환', async () => {
      const provider = createMockProvider([
        [
          { type: 'text_delta', text: '안녕하세요!' },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
          { type: 'done' },
        ],
      ]);

      const runner = createRunner(provider);
      const result = await runner.execute(createBaseParams());

      expect(result.status).toBe('completed');
      expect(result.turns).toBe(1);
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);
      // 마지막 메시지가 assistant 응답
      const lastMsg = result.messages.at(-1)!;
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toBe('안녕하세요!');
    });
  });

  describe('멀티 턴 실행 (도구 호출)', () => {
    it('LLM → tool_use → LLM 2턴 실행', async () => {
      const provider = createMockProvider([
        // 턴 1: LLM이 도구 호출
        [
          { type: 'tool_use_start', id: 'call_1', name: 'get_price' },
          { type: 'tool_input_delta', delta: '{"ticker":"AAPL"}' },
          { type: 'tool_use_end' },
          { type: 'usage', usage: { inputTokens: 50, outputTokens: 20 } },
          { type: 'done' },
        ],
        // 턴 2: LLM이 텍스트 응답
        [
          { type: 'text_delta', text: 'AAPL 가격은 150입니다.' },
          { type: 'usage', usage: { inputTokens: 80, outputTokens: 15 } },
          { type: 'done' },
        ],
      ]);

      toolExecutor.register('get_price', {
        execute: async (input) => {
          const { ticker } = input as { ticker: string };
          return `${ticker}: $150.00`;
        },
      });

      const runner = createRunner(provider);
      const result = await runner.execute(createBaseParams());

      expect(result.status).toBe('completed');
      expect(result.turns).toBe(2);
      expect(result.usage.inputTokens).toBe(130); // 50 + 80
      expect(result.usage.outputTokens).toBe(35); // 20 + 15

      // 메시지 구조 검증: user → assistant(tool_use) → tool(result) → assistant(text)
      const msgs = result.messages;
      expect(msgs).toHaveLength(4); // 원본 1개 + assistant + tool + assistant
      expect(msgs[1]!.role).toBe('assistant');
      expect(msgs[2]!.role).toBe('tool');
      expect(msgs[3]!.role).toBe('assistant');
      expect(msgs[3]!.content).toBe('AAPL 가격은 150입니다.');
    });
  });

  describe('maxTurns 제한', () => {
    it('maxTurns 도달 시 max_turns 상태를 반환한다', async () => {
      // 매번 도구를 호출하는 무한 루프 시뮬레이션
      const sequences = Array.from({ length: 5 }, () => [
        { type: 'tool_use_start' as const, id: 'call_x', name: 'loop_tool' },
        { type: 'tool_input_delta' as const, delta: '{}' },
        { type: 'tool_use_end' as const },
        { type: 'usage' as const, usage: { inputTokens: 10, outputTokens: 5 } },
        { type: 'done' as const },
      ]);
      const provider = createMockProvider(sequences);

      toolExecutor.register('loop_tool', { execute: async () => 'ok' });

      const runner = createRunner(provider, { maxTurns: 3 });
      const result = await runner.execute(createBaseParams());

      expect(result.status).toBe('max_turns');
      expect(result.turns).toBe(3);
    });
  });

  describe('abort 처리', () => {
    it('abortSignal이 이미 aborted이면 즉시 aborted를 반환한다', async () => {
      const provider = createMockProvider([]);
      const runner = createRunner(provider);

      const controller = new AbortController();
      controller.abort();

      const result = await runner.execute(createBaseParams({ abortSignal: controller.signal }));
      expect(result.status).toBe('aborted');
      expect(result.turns).toBe(0);
    });
  });

  describe('이벤트 리스너', () => {
    it('text_delta 이벤트를 리스너에 전달한다', async () => {
      const provider = createMockProvider([
        [
          { type: 'text_delta', text: '안녕' },
          { type: 'text_delta', text: '하세요' },
          { type: 'done' },
        ],
      ]);

      const events: StreamEvent[] = [];
      const runner = createRunner(provider);
      await runner.execute(createBaseParams(), (e) => events.push(e));

      const textDeltas = events.filter((e) => e.type === 'text_delta');
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0]).toEqual({ type: 'text_delta', delta: '안녕' });
      expect(textDeltas[1]).toEqual({ type: 'text_delta', delta: '하세요' });
    });
  });

  describe('Lane 핸들 release', () => {
    it('정상 완료 시 핸들이 release된다', async () => {
      const provider = createMockProvider([[{ type: 'text_delta', text: 'ok' }, { type: 'done' }]]);

      const runner = createRunner(provider);
      await runner.execute(createBaseParams());

      // release 확인: 같은 키로 다시 acquire 가능해야 함
      const handle = await laneManager.acquire('main', 'test-session');
      handle.release();
    });

    it('에러 시에도 핸들이 release된다 (try/finally)', async () => {
      const provider: ProviderAdapter = {
        providerId: 'anthropic',
        chatCompletion: async () => ({}),
        async *streamCompletion() {
          throw new Error('Provider exploded');
        },
      };

      const runner = createRunner(provider);
      await expect(runner.execute(createBaseParams())).rejects.toThrow('Provider exploded');

      // release 확인
      const handle = await laneManager.acquire('main', 'test-session');
      handle.release();
    });
  });
});
```

**검증:**

```bash
pnpm test -- packages/agent/test/runner.test.ts
```

---

## TODO 10: calculateEstimatedCost 캐시 비용 + FinClawEventMap 확장 {#todo-10}

### 10a. calculateEstimatedCost 캐시 비용 반영

**대상 파일:** `packages/agent/src/models/provider-normalize.ts` (L34-49)

**현재 코드:**

```typescript
// L34-49
/**
 * 비용 계산 헬퍼
 *
 * TODO(L1): cacheReadTokens/cacheWriteTokens 비용 미산정.
 * pricing.cacheReadPerMillion / cacheWritePerMillion 필드를 반영해야 함.
 */
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
```

**변경 후:**

```typescript
/**
 * 비용 계산 헬퍼 (캐시 비용 포함)
 *
 * cacheReadTokens는 캐시 히트된 입력 토큰 (할인 적용).
 * cacheWriteTokens는 캐시에 쓰여진 입력 토큰 (할증 적용).
 * pricing.cacheReadPerMillion / cacheWritePerMillion이 없으면 0으로 처리.
 */
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

**기존 테스트 영향:**

기존 `calculateEstimatedCost` 테스트는 2인자(`inputTokens`, `outputTokens`)만 전달한다.
새 파라미터 `cacheReadTokens`, `cacheWriteTokens`의 기본값이 `0`이므로 **기존 테스트 변경 불필요**.

**추가 테스트** (기존 `packages/agent/test/normalize.test.ts`의 `calculateEstimatedCost` describe에 추가):

```typescript
it('캐시 비용을 포함하여 계산한다', () => {
  const cachePricing: ModelPricing = {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  };
  // 1000 input * $3/1M + 500 output * $15/1M + 200 cacheRead * $0.3/1M + 100 cacheWrite * $3.75/1M
  // = 0.003 + 0.0075 + 0.00006 + 0.000375 = 0.010935
  const cost = calculateEstimatedCost(1000, 500, cachePricing, 200, 100);
  expect(cost).toBeCloseTo(0.010935, 5);
});

it('캐시 가격이 없으면 캐시 비용은 0이다', () => {
  const noCachePricing: ModelPricing = { inputPerMillion: 3, outputPerMillion: 15 };
  const cost = calculateEstimatedCost(1000, 500, noCachePricing, 200, 100);
  // 캐시 비용 0 → 기존과 동일
  expect(cost).toBeCloseTo(0.0105, 4);
});
```

**normalizeAnthropicResponse() 내부 호출 수정:**

```typescript
// L103: 기존
estimatedCostUsd: calculateEstimatedCost(inputTokens, outputTokens, pricing),

// 변경
estimatedCostUsd: calculateEstimatedCost(inputTokens, outputTokens, pricing, cacheReadTokens, cacheWriteTokens),
```

### 10b. FinClawEventMap 확장

**대상 파일:** `packages/infra/src/events.ts` (L91-102 사이에 삽입)

**현재 코드 (L91-102):**

```typescript
  // ── Phase 8: Pipeline events ──
  'pipeline:start': (data: { sessionKey: unknown }) => void;
  'pipeline:complete': (data: {
    sessionKey: unknown;
    success: boolean;
    durationMs: number;
    stagesExecuted: readonly string[];
    abortedAt?: string;
    abortReason?: string;
  }) => void;
  'pipeline:error': (data: { sessionKey: unknown; error: Error }) => void;
}
```

**변경 후:**

```typescript
  // ── Phase 8: Pipeline events ──
  'pipeline:start': (data: { sessionKey: unknown }) => void;
  'pipeline:complete': (data: {
    sessionKey: unknown;
    success: boolean;
    durationMs: number;
    stagesExecuted: readonly string[];
    abortedAt?: string;
    abortReason?: string;
  }) => void;
  'pipeline:error': (data: { sessionKey: unknown; error: Error }) => void;

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
}
```

**검증:**

```bash
pnpm exec tsc --noEmit
pnpm test -- packages/agent/test/normalize.test.ts
```

---

## 부록: barrel export + 통합 검증 {#appendix}

### A1. execution/index.ts (신규)

**신규 파일:** `packages/agent/src/execution/index.ts`

```typescript
// packages/agent/src/execution/index.ts

export { ToolInputBuffer } from './tool-input-buffer.js';

export { StreamStateMachine } from './streaming.js';
export type {
  StreamState,
  StreamEvent,
  StreamEventListener,
  ToolResult,
  ExecutionResult,
} from './streaming.js';

export { ExecutionToolDispatcher } from './tool-executor.js';
export type { ToolHandler, ExecutionToolResult } from './tool-executor.js';

export { TokenCounter } from './tokens.js';

export { Runner } from './runner.js';
export type { RunnerOptions } from './runner.js';
```

### A2. agent/src/index.ts 추가 (barrel)

**대상 파일:** `packages/agent/src/index.ts` (L164 이후에 추가)

```typescript
// ── Phase 9: Execution ──
export {
  ToolInputBuffer,
  StreamStateMachine,
  ExecutionToolDispatcher,
  TokenCounter,
  Runner,
} from './execution/index.js';
export type {
  StreamState,
  StreamEvent,
  StreamEventListener,
  ToolResult,
  ExecutionResult,
  ToolHandler,
  ExecutionToolResult,
  RunnerOptions,
} from './execution/index.js';
```

### A3. 통합 검증

```bash
# 1. 타입 체크
pnpm exec tsc --noEmit

# 2. 전체 에이전트 테스트
pnpm test -- packages/agent/test/

# 3. 실행 엔진 테스트만
pnpm test -- packages/agent/test/tool-input-buffer.test.ts packages/agent/test/streaming.test.ts packages/agent/test/execution-tool-executor.test.ts packages/agent/test/tokens.test.ts packages/agent/test/runner.test.ts

# 4. 기존 테스트 회귀 확인
pnpm test -- packages/agent/test/normalize.test.ts
```

---

## 구현 순서 요약

```
Day 1: 기반 모듈 (TODO 1-3)
  1. StreamChunk 6 variant → tsc --noEmit 통과
  2. ProviderAdapter.streamCompletion() 인터페이스 추가 → (타입 에러 허용, TODO 7-8에서 해소)
  3. ToolInputBuffer → 테스트 통과

Day 2: 핵심 모듈 (TODO 4-6)
  4. StreamStateMachine → 테스트 통과
  5. ExecutionToolDispatcher → 테스트 통과
  6. TokenCounter → 테스트 통과

Day 3: 통합 (TODO 7-10 + 부록)
  7. AnthropicAdapter.streamCompletion() → tsc --noEmit 통과
  8. OpenAIAdapter.streamCompletion() → tsc --noEmit 통과
  9. Runner → 테스트 통과
  10. calculateEstimatedCost 캐시 비용 + FinClawEventMap → 테스트 + tsc 통과
  부록. barrel export → tsc --noEmit + 전체 테스트 통과
```

---

## 파일 체크리스트

| #   | 작업                               | 파일 경로                                             | 유형 |
| --- | ---------------------------------- | ----------------------------------------------------- | ---- |
| 1   | StreamChunk 변환                   | `packages/agent/src/models/provider-normalize.ts`     | 수정 |
| 2   | streamCompletion() 인터페이스      | `packages/agent/src/providers/adapter.ts`             | 수정 |
| 3   | ToolInputBuffer                    | `packages/agent/src/execution/tool-input-buffer.ts`   | 신규 |
| 4   | StreamStateMachine                 | `packages/agent/src/execution/streaming.ts`           | 신규 |
| 5   | ExecutionToolDispatcher            | `packages/agent/src/execution/tool-executor.ts`       | 신규 |
| 6   | TokenCounter                       | `packages/agent/src/execution/tokens.ts`              | 신규 |
| 7   | AnthropicAdapter 수정              | `packages/agent/src/providers/anthropic.ts`           | 수정 |
| 8   | OpenAIAdapter 수정                 | `packages/agent/src/providers/openai.ts`              | 수정 |
| 9   | Runner                             | `packages/agent/src/execution/runner.ts`              | 신규 |
| 10a | calculateEstimatedCost             | `packages/agent/src/models/provider-normalize.ts`     | 수정 |
| 10b | FinClawEventMap                    | `packages/infra/src/events.ts`                        | 수정 |
| A1  | execution barrel                   | `packages/agent/src/execution/index.ts`               | 신규 |
| A2  | agent barrel 추가                  | `packages/agent/src/index.ts`                         | 수정 |
| T1  | ToolInputBuffer 테스트             | `packages/agent/test/tool-input-buffer.test.ts`       | 신규 |
| T2  | StreamStateMachine 테스트          | `packages/agent/test/streaming.test.ts`               | 신규 |
| T3  | ExecutionToolDispatcher 테스트     | `packages/agent/test/execution-tool-executor.test.ts` | 신규 |
| T4  | TokenCounter 테스트                | `packages/agent/test/tokens.test.ts`                  | 신규 |
| T5  | Runner 테스트                      | `packages/agent/test/runner.test.ts`                  | 신규 |
| T6  | calculateEstimatedCost 추가 케이스 | `packages/agent/test/normalize.test.ts`               | 수정 |

**합계:** 소스 6(신규) + 5(수정) = 11, 테스트 5(신규) + 1(수정) = 6 → **총 17 파일**
