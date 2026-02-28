// packages/server/src/auto-reply/stages/context.ts
import type { MsgContext } from '@finclaw/types';
import type { PipelineMsgContext, EnrichContextDeps } from '../pipeline-context.js';
import type { StageResult } from '../pipeline.js';
import type { NormalizedMessage } from './normalize.js';
import { enrichContext } from '../pipeline-context.js';

/**
 * 컨텍스트 확장 단계
 *
 * MsgContext → PipelineMsgContext 확장.
 * 금융 데이터는 enrichContext() 내부에서 Promise.allSettled로 병렬 로딩한다.
 */
export async function contextStage(
  ctx: MsgContext,
  normalized: NormalizedMessage,
  deps: EnrichContextDeps,
  signal: AbortSignal,
): Promise<StageResult<PipelineMsgContext>> {
  try {
    const enriched = await enrichContext(ctx, deps, signal);

    return {
      action: 'continue',
      data: {
        ...enriched,
        normalizedBody: normalized.normalizedBody,
        mentions: normalized.mentions,
        urls: normalized.urls,
      },
    };
  } catch (error) {
    return {
      action: 'abort',
      reason: `Failed to enrich context: ${(error as Error).message}`,
      error: error as Error,
    };
  }
}
