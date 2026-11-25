import type { AgentEvent, AgentRunPort } from '@finclaw/agent';
import { createAgentId } from '@finclaw/types';
import { extractControlTokens, type ControlTokenResult } from '../control-tokens.js';
// packages/server/src/auto-reply/stages/execute.ts
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { StageResult } from '../pipeline.js';

/** 구 RunnerExecutionAdapter.defaultAgentId 와 동일. */
const DISCORD_AGENT_ID = createAgentId('default');

type TerminalEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

export interface ExecuteStageResult {
  readonly content: string;
  readonly controlTokens: ControlTokenResult;
  readonly usage?: { inputTokens: number; outputTokens: number };
  /** Phase 46: runtime prepareTurn 의 capture 결과 → deliver 꼬리표 (deliver.ts:40-46 계약 유지). */
  readonly captured?: PipelineMsgContext['capturedMemory'];
}

/**
 * AI 실행 단계 — AgentRuntime 을 mode:'chat' 으로 끝까지 소비해 done.text 에 제어 토큰 후처리.
 * (capture·retrieval·시각 주입은 runtime.prepareTurn 이 소유.)
 */
export async function executeStage(
  ctx: PipelineMsgContext,
  runtime: AgentRunPort,
  signal: AbortSignal,
): Promise<StageResult<ExecuteStageResult>> {
  let terminal: TerminalEvent | undefined;
  for await (const ev of runtime.run({
    sessionKey: ctx.sessionKey,
    agentId: DISCORD_AGENT_ID,
    input: ctx.normalizedBody,
    mode: 'chat',
    signal,
  })) {
    if (ev.type === 'done' || ev.type === 'error') {
      terminal = ev;
    }
  }

  if (terminal?.type !== 'done') {
    // M7 에서 reason 별 고정 한국어 문구 전송으로 바뀐다 (Q10).
    return {
      action: 'abort',
      reason: terminal ? `agent ${terminal.reason}` : 'agent ended without result',
    };
  }

  const tokenResult = extractControlTokens(terminal.text);
  if (tokenResult.hasNoReply) {
    return { action: 'skip', reason: 'AI decided not to reply (NO_REPLY token)' };
  }

  return {
    action: 'continue',
    data: {
      content: tokenResult.cleanContent,
      controlTokens: tokenResult,
      usage: { inputTokens: terminal.usage.input, outputTokens: terminal.usage.output },
      captured: terminal.captured,
    },
  };
}
