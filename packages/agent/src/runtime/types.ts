// packages/agent/src/runtime/types.ts
// Phase 46 M1: 채널 무관 에이전트 런타임의 이벤트·드라이버·포트 계약 (plan §3-1).
import type { AgentErrorReason, AgentId, SessionKey } from '@finclaw/types';

// 정의는 @finclaw/types (ChatStreamErrorParams.reason 이 공유) — 기존 import 경로 유지용 re-export
export type { AgentErrorReason };

export interface AgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type AgentEvent =
  | {
      readonly type: 'start';
      readonly runId: string;
      readonly cliSessionId: string;
      readonly model: string;
    }
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
      readonly cliSessionId: string;
      readonly text: string; // result.result (G2)
      readonly usage: AgentUsage;
      readonly costUsd?: number; // total_cost_usd (클라이언트 추정치)
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
      readonly message: string; // 드라이버가 만든 짧은 요약. raw stderr 는 로그에만
      readonly usage?: AgentUsage;
    };

export type TerminalEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

export interface DriverRequest {
  readonly runId: string;
  readonly prompt: string; // 조립 완료된 user 메시지 (argv 로 전달)
  readonly systemPrompt: string; // 정적. --system-prompt (교체)
  readonly model: string;
  readonly session:
    | { readonly kind: 'new'; readonly id: string } // --session-id
    | { readonly kind: 'resume'; readonly id: string } // --resume
    | { readonly kind: 'none' }; // --no-session-persistence (1-shot)
  readonly mcp?: { readonly url: string; readonly token: string }; // 없으면 MCP 없음 (서브에이전트)
  readonly maxTurns?: number; // 메인만 10
  readonly autocompact?: boolean; // 메인 chat 만 true → --autocompact 200000
  readonly idleTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly signal: AbortSignal;
}

/** 실 구현 1(createCliDriver) + 테스트 fake 1(async generator). 인터페이스 클래스 없음 (I6). */
export type AgentDriver = (req: DriverRequest) => AsyncIterable<AgentEvent>;

export interface AgentRunRequest {
  readonly sessionKey: SessionKey;
  readonly agentId: AgentId;
  readonly input: string; // 사용자 원문 (컨텍스트 블록 제외)
  readonly mode: 'chat' | 'oneShot'; // chat: 세션 resume + capture·retrieval / oneShot: 비영속, <context> 는 시각만 (cron·agent.run)
  readonly model?: string; // 없으면 runtime 기본 (TUI chat.start 모델 선택 유지)
  readonly runId?: string; // D1
  readonly signal: AbortSignal;
}

/** gateway 가 import 하는 DIP 포트 (ChatExecutionPort 대체). 구현 = server AgentRuntime 1개. */
export interface AgentRunPort {
  run(req: AgentRunRequest): AsyncIterable<AgentEvent>;
  /** per-session lane 경유 conversations 행 삭제. 삭제했으면 true. */
  reset(sessionKey: SessionKey): Promise<boolean>;
}
