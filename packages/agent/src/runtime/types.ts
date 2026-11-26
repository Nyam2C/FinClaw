// packages/agent/src/runtime/types.ts
// 채널 무관 에이전트 런타임의 이벤트·드라이버·포트 계약 (plans/agent-core.md §3).
import type { AgentErrorReason, AgentId, SessionKey } from '@finclaw/types';

// 정의는 @finclaw/types (ChatStreamErrorParams.reason 이 공유) — 기존 import 경로 유지용 re-export
export type { AgentErrorReason };

export interface AgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * 트랜스크립트 한 행. `messages` 테이블의 role 그대로다.
 * - `system`: 턴 컨텍스트(시각·기억·거래). API 로는 바로 뒤 user 메시지의 첫 text 블록으로 나간다.
 * - `user`: 사용자 원문.
 * - `assistant`: Anthropic content 블록을 받은 그대로 (thinking·text·tool_use). 편집 금지.
 * - `tool`: tool_result 블록 배열. API 로는 user 메시지로 나간다.
 */
export interface TranscriptMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | readonly unknown[];
}

export type AgentEvent =
  | { readonly type: 'start'; readonly runId: string; readonly model: string }
  /** 트랜스크립트에 덧붙일 행. runtime 이 저장하고 채널로는 내보내지 않는다. 도구 실행보다 먼저 나온다. */
  | { readonly type: 'message'; readonly message: TranscriptMessage }
  | { readonly type: 'text_delta'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: 'tool_result'; readonly id: string; readonly isError: boolean }
  | {
      readonly type: 'done';
      readonly runId: string;
      readonly text: string; // 마지막 assistant 메시지의 text
      readonly usage: AgentUsage;
      /** 마지막 모델 호출의 프롬프트 크기 (입력+캐시). 런타임의 컨텍스트 회전 판정용. */
      readonly contextTokens?: number;
      readonly durationMs: number;
      readonly numTurns: number;
      // ↓ runtime 이 덧붙임
      readonly usedMemoryIds?: readonly string[];
      readonly captured?: {
        readonly memoryId: string;
        readonly type: 'fact' | 'preference';
        readonly content: string;
        readonly duplicate: boolean;
      };
    }
  | {
      readonly type: 'error';
      readonly runId: string;
      readonly reason: AgentErrorReason;
      readonly message: string; // 짧은 요약. 원문 오류는 로그에만
      readonly usage?: AgentUsage;
      readonly contextTokens?: number;
      readonly numTurns?: number;
    };

export type TerminalEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

/** 모델에 보이는 도구 정의. 세션 동안 이름순으로 고정한다 (캐시 프리픽스). */
export interface DriverTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown; // JSON Schema (type: object)
}

export interface DriverToolResult {
  readonly content: string;
  readonly isError: boolean;
}

export interface DriverRequest {
  readonly runId: string;
  readonly systemPrompt: string; // 정적 — 캐시 프리픽스
  /** 이번 턴까지 포함한 트랜스크립트 (회전 지점 이후). 루프가 API 메시지로 변환한다. */
  readonly messages: readonly TranscriptMessage[];
  readonly model: string;
  readonly tools: readonly DriverTool[]; // 빈 배열이면 도구 없이 1회 응답 (서브에이전트)
  /** 도구 1건 실행. throw 하지 않는 것이 계약이지만, throw 해도 루프가 is_error 결과로 바꾼다. */
  readonly runTool: (
    name: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<DriverToolResult>;
  readonly maxTurns: number; // 넘으면 도구 호출을 막은 마무리 호출 1회
  /** run 이 새로 처리한 토큰(입력+캐시 쓰기+출력) 상한. 넘으면 반복 상한과 같이 마무리 호출로 끝낸다. */
  readonly tokenBudget: number;
  readonly overallTimeoutMs: number;
  readonly signal: AbortSignal;
}

/** 실 구현 1(createLoopDriver) + 테스트 fake 1(async generator). */
export type AgentDriver = (req: DriverRequest) => AsyncIterable<AgentEvent>;

export interface AgentRunRequest {
  readonly sessionKey: SessionKey;
  readonly agentId: AgentId;
  readonly input: string; // 사용자 원문 (컨텍스트 블록 제외)
  readonly mode: 'chat' | 'oneShot'; // chat: 트랜스크립트 저장·재개 + capture·retrieval / oneShot: 비영속 (cron·agent.run)
  readonly model?: string; // 없으면 runtime 기본
  readonly runId?: string;
  readonly signal: AbortSignal;
}

/** gateway 가 import 하는 DIP 포트. 구현 = server AgentRuntime 1개. */
export interface AgentRunPort {
  run(req: AgentRunRequest): AsyncIterable<AgentEvent>;
  /** per-session lane 경유 conversations 행 삭제. 삭제했으면 true. */
  reset(sessionKey: SessionKey): Promise<boolean>;
}
