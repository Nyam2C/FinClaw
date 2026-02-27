// packages/server/src/channels/gating/command-gating.ts
import type { InboundMessage } from '@finclaw/types';
import type { Gate } from './pipeline.js';

/**
 * 커맨드 접두사 게이트 팩토리.
 * 메시지가 주어진 접두사로 시작해야 통과.
 */
export function createCommandGate(prefix: string): Gate {
  return (msg: InboundMessage): boolean => {
    return msg.body.startsWith(prefix);
  };
}
