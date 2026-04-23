// packages/server/src/auto-reply/commands/status.ts
import type { ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import type { ModelRef, StorageAdapter } from '@finclaw/types';
import type { CommandExecutor } from './registry.js';
import { getAllChannelDocks } from '../../channels/index.js';

export interface StatusCommandDeps {
  readonly toolRegistry: ToolRegistry;
  readonly storage: StorageAdapter;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly defaultModel?: ModelRef;
}

/** `!finclaw status` — 서버 상태 요약 (도구/세션/업타임/채널/모델/API 건강) */
export function createStatusCommand(deps: StatusCommandDeps): CommandExecutor {
  return async (_args, ctx) => {
    const toolCount = deps.toolRegistry.list().length;
    const conversation = await deps.storage.getConversation(ctx.sessionKey).catch(() => null);
    const messageCount = conversation?.messages.length ?? 0;
    const uptimeMin = Math.round(process.uptime() / 60);

    const channelIds =
      getAllChannelDocks()
        .map((d) => d.id as string)
        .join(', ') || 'none';
    const modelId = deps.defaultModel?.model ?? 'unknown';
    const healthLabel = deps.profileHealth?.getHealth(deps.profileId ?? 'default') ?? 'unknown';

    return {
      content: [
        '**FinClaw 상태**',
        `- 등록 도구: ${toolCount}개`,
        `- 현재 세션 메시지: ${messageCount}건`,
        `- 서버 업타임: ${uptimeMin}분`,
        `- 지원 채널: ${channelIds}`,
        `- 현재 모델: ${modelId}`,
        `- API 상태: ${healthLabel}`,
      ].join('\n'),
      ephemeral: false,
    };
  };
}
