import type { FinClawLogger } from '@finclaw/infra';
import type { AlertTriggeredData } from '@finclaw/types';
import type {
  AlertDefinition,
  ConditionEvaluation,
  DeliveryChannel,
  DeliveryResult,
} from './types.js';

// ─── Interfaces ───
export interface DeliveryHandler {
  readonly channel: DeliveryChannel;
  deliver(alert: AlertDefinition, evaluation: ConditionEvaluation): Promise<void>;
}

export interface DeliveryDispatcher {
  dispatch(alert: AlertDefinition, evaluation: ConditionEvaluation): Promise<DeliveryResult[]>;
}

// ─── R6: 메시지 포매터 ───
export function formatAlertMessage(
  alert: AlertDefinition,
  evaluation: ConditionEvaluation,
): string {
  return [
    `**[FinClaw Alert]** ${alert.name}`,
    '',
    evaluation.message,
    '',
    `현재값: ${evaluation.currentValue}`,
    // TODO(R14): new Date() → triggeredAt 파라미터로 통일하여 시각 불일치 해소
    `시각: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
  ].join('\n');
}

// ─── Port Interfaces (외부 패키지 직접 import 회피) ───
export interface DiscordClientPort {
  users: {
    fetch(userId: string): Promise<{
      createDM(): Promise<{ send(content: string): Promise<unknown> }>;
    }>;
  };
}

// ─── Discord Delivery ───
export function createDiscordDeliveryHandler(deps: {
  client: DiscordClientPort;
  /** phase47 Q6: DISCORD_ALERT_USER_ID. RPC 로 만든 알림의 userId 는 'default' 라 DM 대상이 될 수 없다. */
  userId?: string;
}): DeliveryHandler {
  return {
    channel: 'discord',
    async deliver(alert, evaluation) {
      const user = await deps.client.users.fetch(deps.userId ?? alert.userId);
      const dmChannel = await user.createDM();
      await dmChannel.send(formatAlertMessage(alert, evaluation));
    },
  };
}

// ─── WebSocket Delivery (phase47: late-bind — alerts 가 gateway 보다 먼저 생성된다) ───
export function createWebSocketDeliveryHandler(deps: {
  getBroadcast: () => ((data: AlertTriggeredData) => number) | undefined;
}): DeliveryHandler {
  return {
    channel: 'websocket',
    async deliver(alert, evaluation) {
      const broadcast = deps.getBroadcast();
      if (!broadcast) {
        throw new Error('websocket broadcast not bound');
      }
      const sent = broadcast({
        alertId: alert.id,
        name: alert.name,
        message: evaluation.message,
        currentValue: evaluation.currentValue,
        triggeredAt: Date.now(),
      });
      // 받은 연결이 0 이면 실패로 기록 — alert_history 가 "아무도 못 받음" 을 정직하게 남긴다 (Q7)
      if (sent === 0) {
        throw new Error('no websocket subscribers');
      }
    },
  };
}

// ─── Log Delivery ───
export function createLogDeliveryHandler(deps: { logger: FinClawLogger }): DeliveryHandler {
  return {
    channel: 'log',
    async deliver(alert, evaluation) {
      deps.logger.info('ALERT TRIGGERED', {
        alertId: alert.id,
        name: alert.name,
        message: evaluation.message,
        currentValue: evaluation.currentValue,
      });
    },
  };
}

// ─── R2: Promise.allSettled 기반 병렬 전달 ───
export function createDeliveryDispatcher(deps: {
  handlers: DeliveryHandler[];
  logger: FinClawLogger;
}): DeliveryDispatcher {
  const handlerMap = new Map(deps.handlers.map((h) => [h.channel, h]));
  return {
    async dispatch(alert, evaluation) {
      const tasks = alert.channels.map(async (channel) => {
        const handler = handlerMap.get(channel);
        if (!handler) {
          throw new Error(`No handler for channel: ${channel}`);
        }
        await handler.deliver(alert, evaluation);
        return channel;
      });
      const settled = await Promise.allSettled(tasks);
      return alert.channels.map((channel, i) => {
        const result = settled[i];
        return {
          channel,
          success: result?.status === 'fulfilled',
          error: result?.status === 'rejected' ? String(result.reason) : undefined,
          deliveredAt: Date.now(),
        };
      });
    },
  };
}
