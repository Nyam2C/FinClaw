import type { ConversationMessage, TokenUsage, ToolCall } from '@finclaw/types';
// packages/agent/src/execution/streaming.ts
import { EventEmitter } from 'node:events';

/** 스트리밍 상태 */
export type StreamState =
  | 'idle' // 대기 중
  | 'streaming' // LLM 응답 스트리밍 중
  | 'tool_use' // tool_use 블록 감지됨
  | 'executing' // 도구 실행 중
  | 'done'; // 실행 완료

/** 도구 실행 결과 */
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
