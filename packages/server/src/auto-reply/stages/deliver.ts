import type { FinClawLogger } from '@finclaw/infra';
// packages/server/src/auto-reply/stages/deliver.ts
import type { OutboundMessage, ReplyPayload, ChannelPlugin } from '@finclaw/types';
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { StageResult } from '../pipeline.js';
import type { ExecuteStageResult } from './execute.js';
import { splitMessage } from '../response-formatter.js';

/**
 * 응답 전송 단계
 *
 * OutboundMessage 구조: { channelId, targetId, payloads: [{ text, replyToId }] }
 * 직렬 디스패치 (Promise chain): 순서 보장 + 개별 실패 격리
 */
export async function deliverResponse(
  executeResult: ExecuteStageResult,
  ctx: PipelineMsgContext,
  channel: Pick<ChannelPlugin, 'send'>,
  logger: FinClawLogger,
): Promise<StageResult<OutboundMessage>> {
  // SILENT_REPLY 처리
  if (executeResult.controlTokens.hasSilentReply) {
    logger.info('Silent reply — logged only', { sessionKey: ctx.sessionKey });
    return { action: 'skip', reason: 'Silent reply (logged only)' };
  }

  let content = executeResult.content;

  // 면책 조항 첨부
  if (executeResult.controlTokens.needsDisclaimer) {
    content +=
      '\n\n---\n' +
      '_본 정보는 투자 조언이 아니며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다._';
  }

  // 메시지 분할
  // channelCapabilities는 PipelineMsgContext에서 non-optional이지만, 방어적 코딩으로 옵셔널 체이닝 유지.
  const parts = splitMessage(content, ctx.channelCapabilities?.maxMessageLength ?? 2000);

  // OutboundMessage 조립
  const payloads: ReplyPayload[] = parts.map((text) => ({
    text,
    replyToId: ctx.messageThreadId,
  }));

  const outbound: OutboundMessage = {
    channelId: ctx.channelId,
    targetId: ctx.senderId,
    payloads,
    replyToMessageId: ctx.messageThreadId,
  };

  // 직렬 전송 — 순서 보장 + 개별 실패 격리
  if (channel.send) {
    for (const [i, payload] of payloads.entries()) {
      try {
        await channel.send({
          channelId: ctx.channelId,
          targetId: ctx.senderId,
          payloads: [payload],
        });
      } catch (error) {
        logger.error(`Deliver failed for part ${i + 1}/${payloads.length}`, { error });
      }
    }
  }

  return { action: 'continue', data: outbound };
}
