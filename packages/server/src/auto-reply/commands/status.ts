// packages/server/src/auto-reply/commands/status.ts
import type { ToolRegistry } from '@finclaw/agent';
import type { StorageAdapter } from '@finclaw/types';
import type { CommandExecutor } from './registry.js';

export interface StatusCommandDeps {
  readonly toolRegistry: ToolRegistry;
  readonly storage: StorageAdapter;
}

/** `!finclaw status` — 등록 도구 수, 현재 세션 메시지 수, 서버 업타임 요약 */
export function createStatusCommand(deps: StatusCommandDeps): CommandExecutor {
  return async (_args, ctx) => {
    const toolCount = deps.toolRegistry.list().length;
    const conversation = await deps.storage.getConversation(ctx.sessionKey).catch(() => null);
    const messageCount = conversation?.messages.length ?? 0;
    const uptimeMin = Math.round(process.uptime() / 60);
    return {
      content: [
        '**FinClaw 상태**',
        `- 등록 도구: ${toolCount}개`,
        `- 현재 세션 메시지: ${messageCount}건`,
        `- 서버 업타임: ${uptimeMin}분`,
      ].join('\n'),
      ephemeral: false,
    };
  };
}
