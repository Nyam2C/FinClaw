// packages/server/src/auto-reply/commands/reset.ts
import type { StorageAdapter } from '@finclaw/types';
import type { CommandExecutor } from './registry.js';

export interface ResetCommandDeps {
  readonly storage: StorageAdapter;
}

/** `!finclaw reset` — 현재 세션 대화를 DB에서 삭제한다 */
export function createResetCommand(deps: ResetCommandDeps): CommandExecutor {
  return async (_args, ctx) => {
    const deleted = await deps.storage.deleteConversation(ctx.sessionKey).catch(() => false);
    return {
      content: deleted
        ? '대화 세션을 초기화했다. 이전 맥락은 사라졌고 새 대화를 시작한다.'
        : '초기화할 대화가 없다. 바로 새 대화를 시작한다.',
      ephemeral: false,
    };
  };
}
