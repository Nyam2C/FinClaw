import type { FinClawLogger } from '@finclaw/infra';
// packages/server/src/auto-reply/stages/deliver.ts
import type { OutboundMessage, ReplyPayload, ChannelPlugin } from '@finclaw/types';
import type { ToolCallRecord } from '../execution-adapter.js';
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { StageResult } from '../pipeline.js';
import { splitMessage } from '../response-formatter.js';
import type { ExecuteStageResult } from './execute.js';

const INVESTMENT_DISCLAIMER =
  '_본 정보는 투자 조언이 아니며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다._';

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
    content += '\n\n---\n' + INVESTMENT_DISCLAIMER;
  }

  // Phase 22: 도구 출처 footer 자동 첨부
  content += formatSourceFooter(executeResult.toolCalls);

  // Phase 26 B: 기억 capture 꼬리표
  // capture 가 명시적 선언을 저장(또는 dedup)했으면 응답 끝에 한 줄 부착.
  // 응답 본문(content)이 비어있어도 꼬리표는 부착해야 사용자가 저장 사실을 안다.
  if (ctx.capturedMemory) {
    const shortId = ctx.capturedMemory.memoryId.slice(0, 8);
    const note = ctx.capturedMemory.duplicate
      ? `_이미 기억 중 (${ctx.capturedMemory.type}, #${shortId})_`
      : `_기억했습니다 (${ctx.capturedMemory.type}, #${shortId})_`;
    content += (content.length > 0 ? '\n\n' : '') + note;
  }

  // 메시지 분할
  // channelCapabilities는 PipelineMsgContext에서 non-optional이지만, 방어적 코딩으로 옵셔널 체이닝 유지.
  const parts = splitMessage(content, ctx.channelCapabilities?.maxMessageLength ?? 2000);

  // OutboundMessage 조립
  const payloads: ReplyPayload[] = parts.map((text) => ({
    text,
    replyToId: ctx.messageThreadId,
  }));

  const targetId = ctx.chatId ?? ctx.senderId;
  const outbound: OutboundMessage = {
    channelId: ctx.channelId,
    targetId,
    payloads,
    replyToMessageId: ctx.messageThreadId,
  };

  // 직렬 전송 — 순서 보장 + 개별 실패 격리
  if (channel.send) {
    for (const [i, payload] of payloads.entries()) {
      try {
        await channel.send({
          channelId: ctx.channelId,
          targetId,
          payloads: [payload],
        });
      } catch (error) {
        logger.error(`Deliver failed for part ${i + 1}/${payloads.length}`, { error });
      }
    }
  }

  return { action: 'continue', data: outbound };
}

function formatSourceFooter(toolCalls: readonly ToolCallRecord[] | undefined): string {
  if (!toolCalls || toolCalls.length === 0) {
    return '';
  }
  const formatter = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const displayed = toolCalls.slice(0, 3);
  const lines = displayed.map((tc) => {
    const time = formatter.format(new Date(tc.timestamp));
    const src = tc.source ? `(${tc.source})` : '';
    return `📊 ${tc.name}${src} @ ${time} KST`;
  });
  if (toolCalls.length > 3) {
    lines.push(`… (외 ${toolCalls.length - 3}개 도구)`);
  }
  return '\n\n---\n' + lines.join('\n');
}
