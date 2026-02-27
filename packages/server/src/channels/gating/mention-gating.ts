// packages/server/src/channels/gating/mention-gating.ts
import type { InboundMessage } from '@finclaw/types';
import type { Gate } from './pipeline.js';

/**
 * 멘션 게이트 팩토리.
 * DM은 무조건 통과, 그 외에는 botMention이 포함된 메시지만 통과.
 */
export function createMentionGate(botMention: string): Gate {
  return (msg: InboundMessage): boolean => {
    // DM은 항상 통과
    if (msg.chatType === 'direct') {
      return true;
    }

    // 본문에 봇 멘션이 포함되어야 통과
    return msg.body.includes(botMention);
  };
}
