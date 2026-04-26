// packages/server/src/auto-reply/commands/status.ts
import type { ModelStats, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import { modelIdToTier } from '@finclaw/agent';
import type { ModelRef, StorageAdapter } from '@finclaw/types';
import { getAllChannelDocks } from '../../channels/index.js';
import type { CommandExecutor } from './registry.js';

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
    const profileId = deps.profileId ?? 'default';
    const healthLabel = deps.profileHealth?.getHealth(profileId) ?? 'unknown';

    // Phase 24 E: 최근 1시간 모델 분포 + fallback 카운트.
    const breakdown = deps.profileHealth?.getModelBreakdown(profileId, 60 * 60 * 1000);
    const breakdownLines = formatBreakdown(breakdown);

    return {
      content: [
        '**FinClaw 상태**',
        `- 등록 도구: ${toolCount}개`,
        `- 현재 세션 메시지: ${messageCount}건`,
        `- 서버 업타임: ${uptimeMin}분`,
        `- 지원 채널: ${channelIds}`,
        `- 현재 모델: ${modelId}`,
        `- API 상태: ${healthLabel}`,
        ...breakdownLines,
      ].join('\n'),
      ephemeral: false,
    };
  };
}

function formatBreakdown(breakdown: Map<string, ModelStats> | undefined): string[] {
  if (!breakdown || breakdown.size === 0) {
    return [];
  }
  const lines: string[] = ['', '**최근 1시간 모델 분포**'];
  let totalFallbacks = 0;
  // tier 순서대로 (haiku → sonnet → opus) 정렬.
  const tierRank: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 };
  const sorted = [...breakdown.entries()].toSorted(
    ([a], [b]) => tierRank[modelIdToTier(a)] - tierRank[modelIdToTier(b)],
  );
  for (const [modelId, stats] of sorted) {
    const tier = modelIdToTier(modelId);
    const bar = '▓'.repeat(Math.min(10, Math.max(1, Math.round(stats.calls / 5))));
    lines.push(
      `- ${tier.padEnd(7)} ${bar.padEnd(10)} ${stats.calls}회 ($${stats.totalCostUsd.toFixed(4)})`,
    );
    totalFallbacks += stats.fallbacks;
  }
  if (totalFallbacks > 0) {
    lines.push(`- Fallback 발동: ${totalFallbacks}회`);
  }
  return lines;
}
