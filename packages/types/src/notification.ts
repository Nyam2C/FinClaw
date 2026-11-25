// packages/types/src/notification.ts
import type { AgentErrorReason } from './agent.js';

/** JSON-RPC 2.0 알림 (서버 → 클라이언트, id 없음) */
export interface JsonRpcNotification<T = Record<string, unknown>> {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: T;
}

// ─── 채팅 스트리밍 notification params ───

/** chat.stream.delta — 증분 텍스트 조각 (150ms 배치, += 로 누적) */
export interface ChatStreamDeltaParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly delta: string;
}

/** chat.stream.end — 확정. 클라이언트는 스트림 버퍼를 result.text 로 교체한다 (Q9: 화면 = 저장본). */
export interface ChatStreamEndParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly result: {
    readonly text: string;
    readonly usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    readonly costUsd?: number;
  };
}

/** chat.stream.error — 종료 신호(abort 포함 — reason:'aborted'). raw 메시지가 아니라 드라이버 요약. */
export interface ChatStreamErrorParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly error: string;
  readonly reason: AgentErrorReason;
}

/** chat.stream.tool — 도구 진행 (입력/결과 내용 미포함 — S14). tool_use→start, tool_result→end. */
export interface ChatStreamToolParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly phase: 'start' | 'end';
  readonly isError?: boolean; // end 만
}
