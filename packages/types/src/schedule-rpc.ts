// packages/types/src/schedule-rpc.ts
// Phase 31 F — agent 도구가 호출할 ScheduleRpc 클라이언트 인터페이스.
// server 측 packages/server/src/main.ts 가 storage + cron 유틸로 구현 (gateway RPC 핸들러와
// 동일 로직을 wrap). agentId/deliveryChannel/deliveryTarget 은 server 가 기본값으로 채운다.

import type { Schedule } from './automation.js';

export interface ScheduleCreateRequest {
  name: string;
  cron: string;
  prompt: string;
  enabled?: boolean;
}

export interface ScheduleCreateResponse {
  id: string;
  nextRunAt: number | null;
}

export interface ScheduleListRequest {
  limit?: number;
}

export interface ScheduleListResponse {
  schedules: ReadonlyArray<
    Pick<
      Schedule,
      'id' | 'name' | 'cron' | 'enabled' | 'status' | 'consecutiveFailures' | 'nextRunAt'
    >
  >;
}

export interface ScheduleDeleteRequest {
  scheduleId: string;
}

export interface TestCronRequest {
  cron: string;
}

export interface TestCronResponse {
  valid: boolean;
  nextRunAt?: number;
  reason?: string;
}

export interface ScheduleRpc {
  create(req: ScheduleCreateRequest): Promise<ScheduleCreateResponse>;
  list(req: ScheduleListRequest): Promise<ScheduleListResponse>;
  delete(req: ScheduleDeleteRequest): Promise<void>;
  testCron(req: TestCronRequest): Promise<TestCronResponse>;
}
