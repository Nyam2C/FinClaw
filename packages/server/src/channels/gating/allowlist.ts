// packages/server/src/channels/gating/allowlist.ts
import type { InboundMessage } from '@finclaw/types';
import type { Gate } from './pipeline.js';

/**
 * 발신자 허용 목록 게이트 팩토리.
 * allowedSenderIds에 포함된 발신자만 통과.
 */
// TODO(review): 빈 allowlist = 전부 차단 (deny-by-default). 스펙상 전부 허용이 필요하면
// null/undefined(미설정=허용) vs [](명시적 빈 목록=차단) 분리 권장.
export function createAllowlistGate(allowedSenderIds: readonly string[]): Gate {
  const allowed = new Set(allowedSenderIds);
  return (msg: InboundMessage): boolean => {
    return allowed.has(msg.senderId);
  };
}
