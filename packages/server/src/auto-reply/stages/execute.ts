import type { AgentErrorReason, AgentRunPort, TerminalEvent } from '@finclaw/agent';
import { createAgentId } from '@finclaw/types';
import { extractControlTokens, type ControlTokenResult } from '../control-tokens.js';
// packages/server/src/auto-reply/stages/execute.ts
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { StageResult } from '../pipeline.js';

/** 구 실행 어댑터의 defaultAgentId 와 동일. */
const DISCORD_AGENT_ID = createAgentId('default');

/** raw message 는 보내지 않는다(credential 섞임 위험). aborted 는 무응답. */
const ERROR_REPLY: Partial<Record<AgentErrorReason, string>> = {
  auth: 'Anthropic API 키가 없거나 맞지 않습니다. 서버의 `ANTHROPIC_API_KEY` 와 크레딧을 확인해 주세요.',
  rate_limit: 'Claude 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
  timeout: '응답 시간이 초과되었습니다. 질문을 나눠서 다시 시도해 주세요.',
  refusal: '이 요청에는 답할 수 없습니다.',
};
const FALLBACK_ERROR_REPLY = '응답 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';

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
    const reason: AgentErrorReason = terminal?.reason ?? 'unknown';
    if (reason === 'aborted') {
      return { action: 'skip', reason: 'agent run aborted' };
    }
    const reply = ERROR_REPLY[reason] ?? FALLBACK_ERROR_REPLY;
    return {
      action: 'continue',
      data: { content: reply, controlTokens: extractControlTokens(reply) },
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
