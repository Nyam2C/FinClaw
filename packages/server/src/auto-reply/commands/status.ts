// packages/server/src/auto-reply/commands/status.ts
import type { ModelStats, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import { modelIdToTier } from '@finclaw/agent';
import type { MarketSkillHandle, NewsSkillHandle } from '@finclaw/skills-finance';
import type { ModelRef, StorageAdapter } from '@finclaw/types';
import { getAllChannelDocks } from '../../channels/index.js';
import type { CommandExecutor } from './registry.js';

export interface StatusCommandDeps {
  readonly toolRegistry: ToolRegistry;
  readonly storage: StorageAdapter;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly defaultModel?: ModelRef;
  /** Phase 27: provider 한도 표시. */
  readonly marketHandle?: MarketSkillHandle;
  readonly newsHandle?: NewsSkillHandle;
}

/** `!finclaw status` — 서버 상태 + provider 한도. */
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

    const apiLines = formatApiUsage(deps.marketHandle, deps.newsHandle);

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
        ...apiLines,
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

function formatApiUsage(
  market: MarketSkillHandle | undefined,
  news: NewsSkillHandle | undefined,
): string[] {
  if (!market && !news) {
    return [];
  }
  const lines: string[] = ['', '**API 한도 (오늘)**'];

  if (market) {
    const cache = market.cache;
    const rotators = market.keyRotators;
    if (rotators.finnhub) {
      const used = cache.getDailyUsage('finnhub');
      const total = 60 * 60 * 24 * rotators.finnhub.totalCount();
      const avail = rotators.finnhub.availableCount();
      lines.push(
        `- Finnhub:     ${usageBar(used, total)} ${used} / ${total}/day    · 가용 키 ${avail}/${rotators.finnhub.totalCount()}`,
      );
    }
    if (rotators.twelveData) {
      const used = cache.getDailyUsage('twelve-data');
      const total = 800 * rotators.twelveData.totalCount();
      const avail = rotators.twelveData.availableCount();
      lines.push(
        `- Twelve Data: ${usageBar(used, total)} ${used} / ${total}/day      · 가용 키 ${avail}/${rotators.twelveData.totalCount()}`,
      );
    }
    if (rotators.alphaVantage) {
      const used = cache.getDailyUsage('alpha-vantage');
      const total = 25 * rotators.alphaVantage.totalCount();
      const avail = rotators.alphaVantage.availableCount();
      lines.push(
        `- Alpha V:     ${usageBar(used, total)} ${used} / ${total}/day        · 가용 키 ${avail}/${rotators.alphaVantage.totalCount()}`,
      );
    }
  }

  if (news?.keyRotators.newsdata) {
    const r = news.keyRotators.newsdata;
    const total = 200 * r.totalCount();
    // newsdata 는 cache 에 daily counter 미기록 (rateLimit.dailyLimit 미설정). placeholder.
    lines.push(
      `- NewsData.io: ${usageBar(0, total)} ?  / ${total}/day       · 가용 키 ${r.availableCount()}/${r.totalCount()}`,
    );
  }

  if (market?.keyRotators.finnhub) {
    lines.push('- Finnhub News: (시세와 키 공유)');
  }

  return lines;
}

function usageBar(used: number, total: number): string {
  if (total === 0) {
    return '[░░░░░░░░░░]';
  }
  const filled = Math.min(10, Math.max(0, Math.round((used / total) * 10)));
  return `[${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}]`;
}
