// packages/types/src/automation.ts
// Phase 28: 시간 기반 능동 트리거 (scheduled agent runs).

import type { AgentId, Timestamp } from './common.js';

/** 송출 채널: discord DM 또는 web WebSocket. 둘 중 하나만 (단순함). */
export type DeliveryChannel = 'discord' | 'web';

/** 운영 상태. enabled=1 + status='active' 일 때만 트리거. */
export type ScheduleStatus = 'active' | 'failing' | 'disabled';

/** schedules 테이블 1행. */
export interface Schedule {
  readonly id: string;
  readonly name: string;
  /** 5필드 cron (분 시 일 월 요일). */
  readonly cron: string;
  readonly agentId: AgentId;
  readonly prompt: string;
  readonly deliveryChannel: DeliveryChannel;
  /** discord: user_id 또는 channel_id, web: subscription_id (현재 'broadcast'). */
  readonly deliveryTarget: string;
  readonly enabled: boolean;
  /** 실행별 timeout (ms). 미설정 시 기본 60_000. */
  readonly timeoutMs?: number;
  /** 운영 상태. 연속 실패 시 자동 'failing' → 임계 도달 시 'disabled'. */
  readonly status: ScheduleStatus;
  /** 연속 실패 횟수 (성공 시 0 으로 reset). */
  readonly consecutiveFailures: number;
  readonly lastRunAt?: Timestamp;
  /** agent_runs.id (FK ON DELETE SET NULL). */
  readonly lastRunId?: string;
  /** 다음 트리거 예정 (cron 계산 결과). enabled=1 일 때만 의미. */
  readonly nextRunAt?: Timestamp;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}
