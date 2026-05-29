// packages/agent/src/execution/chat-execution-port.ts
// gateway chat.* 가 의존하는 narrow port (DIP). StreamEventListener 가 agent-native 라
// types 가 아닌 @finclaw/agent 에 정의. server RunnerExecutionAdapter 가 구조적 만족.
import type { AgentId, ModelRef, SessionKey } from '@finclaw/types';
import type { StreamEventListener } from './streaming.js';

/** chat.ts 사용면 — executeForTui 반환 3필드 소비. */
export interface TuiExecutionResultLike {
  readonly messageId: string;
  readonly content: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** chat.ts 사용면 — executeForTui 만. */
export interface ChatExecutionPort {
  executeForTui(
    input: {
      readonly sessionKey: SessionKey;
      readonly agentId: AgentId;
      readonly userMessage: string;
      readonly model: ModelRef;
    },
    listener: StreamEventListener | undefined,
    signal: AbortSignal,
  ): Promise<TuiExecutionResultLike>;
}
