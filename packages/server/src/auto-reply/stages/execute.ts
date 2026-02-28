// packages/server/src/auto-reply/stages/execute.ts
import type { ExecutionAdapter } from '../execution-adapter.js';
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { StageResult } from '../pipeline.js';
import { extractControlTokens, type ControlTokenResult } from '../control-tokens.js';

export interface ExecuteStageResult {
  readonly content: string;
  readonly controlTokens: ControlTokenResult;
  readonly usage?: { inputTokens: number; outputTokens: number };
}

/**
 * AI 실행 단계
 *
 * Phase 8 책임: ExecutionAdapter에 위임 + 제어 토큰 후처리
 * Phase 9 책임: AI API 호출, 도구 루프, 세션 write lock, 스트리밍
 */
export async function executeStage(
  ctx: PipelineMsgContext,
  adapter: ExecutionAdapter,
  signal: AbortSignal,
): Promise<StageResult<ExecuteStageResult>> {
  const raw = await adapter.execute(ctx, signal);

  // 제어 토큰 추출
  const tokenResult = extractControlTokens(raw.content);

  if (tokenResult.hasNoReply) {
    return { action: 'skip', reason: 'AI decided not to reply (NO_REPLY token)' };
  }

  return {
    action: 'continue',
    data: {
      content: tokenResult.cleanContent,
      controlTokens: tokenResult,
      usage: raw.usage,
    },
  };
}
