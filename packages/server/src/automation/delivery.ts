// packages/server/src/automation/delivery.ts
// Phase 28 C: schedule 결과 송출 (Discord DM 또는 Web WebSocket).
// 송출 실패 → warn 로그 + agent_runs 보존 (재시도 X — 단순함).

import type { FinClawLogger } from '@finclaw/infra';
import type { Schedule } from '@finclaw/types';
import type { GatewayBroadcaster } from '../gateway/broadcaster.js';
import type { WsConnection } from '../gateway/rpc/types.js';

/**
 * Discord client port — 직접 discord.js 의존을 피하기 위해 최소 인터페이스만 노출.
 * skills-finance/alerts/delivery.ts 의 DiscordClientPort 와 동일 형태.
 */
export interface DiscordClientPort {
  users: {
    fetch(userId: string): Promise<{
      createDM(): Promise<{ send(content: string): Promise<unknown> }>;
    }>;
  };
}

export interface DeliveryDeps {
  /** Discord 클라이언트 포트 — discord 채널 송출 시 필요. */
  readonly discordClient?: DiscordClientPort;
  /** WebSocket broadcaster — web 채널 송출 시 필요. */
  readonly broadcaster?: GatewayBroadcaster;
  readonly connections?: Map<string, WsConnection>;
  readonly logger: FinClawLogger;
}

const DISCORD_MAX_LEN = 2000;

function formatDiscord(
  schedule: Schedule,
  output: string,
  error: string | undefined,
  runId: string | null,
): string {
  const ts = new Date().toLocaleString('ko-KR');
  const head = `**[${schedule.name}]**`;
  const body = error ? `_⚠️ 실행 실패: ${error}_` : output.length === 0 ? '_(빈 응답)_' : output;
  const footer = `_${ts} 자동 실행${runId ? ` · #${runId.slice(0, 8)}` : ''}_`;
  let composed = `${head}\n\n${body}\n\n${footer}`;
  if (composed.length > DISCORD_MAX_LEN) {
    const overflow = composed.length - DISCORD_MAX_LEN + 64;
    const truncated = body.slice(0, Math.max(0, body.length - overflow)) + '\n…(잘림)';
    composed = `${head}\n\n${truncated}\n\n${footer}`;
  }
  return composed;
}

export async function deliverScheduleResult(
  deps: DeliveryDeps,
  args: {
    schedule: Schedule;
    output: string;
    error?: string;
    agentRunId: string | null;
  },
): Promise<void> {
  const { schedule, output, error, agentRunId } = args;
  if (schedule.deliveryChannel === 'discord') {
    if (!deps.discordClient) {
      deps.logger.warn('schedule.delivery.discord_unavailable', {
        event: 'schedule.delivery.discord_unavailable',
        scheduleId: schedule.id,
      });
      return;
    }
    try {
      const user = await deps.discordClient.users.fetch(schedule.deliveryTarget);
      const dm = await user.createDM();
      await dm.send(formatDiscord(schedule, output, error, agentRunId));
      deps.logger.info('schedule.delivered', {
        event: 'schedule.delivered',
        scheduleId: schedule.id,
        channel: 'discord',
      });
    } catch (sendErr) {
      deps.logger.warn('schedule.delivery.discord_failed', {
        event: 'schedule.delivery.discord_failed',
        scheduleId: schedule.id,
        error: (sendErr as Error).message,
      });
    }
    return;
  }
  // web
  if (!deps.broadcaster || !deps.connections) {
    deps.logger.warn('schedule.delivery.web_unavailable', {
      event: 'schedule.delivery.web_unavailable',
      scheduleId: schedule.id,
    });
    return;
  }
  deps.broadcaster.broadcastToChannel(deps.connections, 'schedule.completed', {
    scheduleId: schedule.id,
    name: schedule.name,
    runId: agentRunId,
    output,
    error,
    completedAt: Date.now(),
  });
  deps.logger.info('schedule.delivered', {
    event: 'schedule.delivered',
    scheduleId: schedule.id,
    channel: 'web',
  });
}
