// packages/agent/src/execution/streaming.ts
import type { ConversationMessage, TokenUsage } from '@finclaw/types';

/** 실행 결과 */
export interface ExecutionResult {
  readonly status: 'completed' | 'aborted';
  readonly messages: readonly ConversationMessage[];
  readonly usage: TokenUsage;
  readonly durationMs: number;
}

/** 스트리밍 이벤트 — Runner 는 text_delta 만 발행. done/error 는 broadcaster 수신용. */
export type StreamEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'error'; readonly error: Error }
  | { readonly type: 'done'; readonly result: ExecutionResult };

/** 스트림 이벤트 리스너 */
export type StreamEventListener = (event: StreamEvent) => void;
