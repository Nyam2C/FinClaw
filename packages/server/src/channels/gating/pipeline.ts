// packages/server/src/channels/gating/pipeline.ts
import type { InboundMessage } from '@finclaw/types';

/**
 * 게이트 함수 — 메시지를 통과시키면 true, 차단하면 false.
 * 비동기 게이트도 허용.
 */
// TODO(review): GatingResult 타입(거부 사유 포함) 미도입. 운영 로깅 시 Gate 반환을
// { passed: boolean; reason?: string } 형태로 확장 필요.
export type Gate = (msg: InboundMessage) => boolean | Promise<boolean>;

/**
 * 게이트를 순차적으로 합성.
 * 하나라도 false를 반환하면 이후 게이트를 실행하지 않고 false 반환.
 */
export function composeGates(...gates: Gate[]): Gate {
  return async (msg: InboundMessage): Promise<boolean> => {
    for (const gate of gates) {
      const passed = await gate(msg);
      if (!passed) {
        return false;
      }
    }
    return true;
  };
}
