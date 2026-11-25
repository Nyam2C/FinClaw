// packages/server/src/auto-reply/stages/context.ts
import type { ChannelCapabilities, MsgContext } from '@finclaw/types';
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { StageResult } from '../pipeline.js';
import type { NormalizedMessage } from './normalize.js';

/**
 * 컨텍스트 확장 단계
 *
 * MsgContext → PipelineMsgContext 확장 (정규화 결과 + 채널 capabilities).
 */
export function contextStage(
  ctx: MsgContext,
  normalized: NormalizedMessage,
  channelCapabilities: ChannelCapabilities,
): StageResult<PipelineMsgContext> {
  return {
    action: 'continue',
    data: {
      ...ctx,
      normalizedBody: normalized.normalizedBody,
      mentions: normalized.mentions,
      urls: normalized.urls,
      channelCapabilities,
      userRoles: [],
    },
  };
}
