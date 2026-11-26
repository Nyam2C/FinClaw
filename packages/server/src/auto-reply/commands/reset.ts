// packages/server/src/auto-reply/commands/reset.ts
import type { SessionKey } from '@finclaw/types';
import type { CommandExecutor } from './registry.js';

export interface ResetCommandDeps {
  /** 대화 삭제. 운영에서는 `runtime.reset` — 세션 lane 을 거쳐, 진행 중 run 이 행을 덧붙이는 도중에 지워지지 않는다. */
  readonly reset: (sessionKey: SessionKey) => Promise<boolean>;
}

/** `!finclaw reset` — 현재 세션 대화를 DB에서 삭제한다 */
export function createResetCommand(deps: ResetCommandDeps): CommandExecutor {
  return async (_args, ctx) => {
    const deleted = await deps.reset(ctx.sessionKey).catch(() => false);
    return {
      content: deleted
        ? '대화 세션을 초기화했다. 이전 맥락은 사라졌고 새 대화를 시작한다.'
        : '초기화할 대화가 없다. 바로 새 대화를 시작한다.',
      ephemeral: false,
    };
  };
}
