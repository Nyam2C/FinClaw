// packages/server/src/channels/gating/allowlist.ts
import type { InboundMessage } from '@finclaw/types';
import type { Gate } from './pipeline.js';

/**
 * 발신자 허용 목록 게이트 팩토리.
 * allowedSenderIds에 포함된 발신자만 통과.
 */
export function createAllowlistGate(allowedSenderIds: readonly string[]): Gate {
  const allowed = new Set(allowedSenderIds);
  return (msg: InboundMessage): boolean => {
    return allowed.has(msg.senderId);
  };
}
