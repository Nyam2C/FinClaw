// packages/storage/src/schedules.ts
// Phase 28 A: schedules CRUD.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentId, DeliveryChannel, Schedule, ScheduleStatus, Timestamp } from '@finclaw/types';

// ─── Row 타입 ───

interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  agent_id: string;
  prompt: string;
  delivery_channel: string;
  delivery_target: string;
  enabled: number;
  timeout_ms: number | null;
  status: string;
  consecutive_failures: number;
  last_run_at: number | null;
  last_run_id: string | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    agentId: row.agent_id as AgentId,
    prompt: row.prompt,
    deliveryChannel: row.delivery_channel as DeliveryChannel,
    deliveryTarget: row.delivery_target,
    enabled: row.enabled === 1,
    timeoutMs: row.timeout_ms === null ? undefined : row.timeout_ms,
    status: row.status as ScheduleStatus,
    consecutiveFailures: row.consecutive_failures,
    lastRunAt: row.last_run_at === null ? undefined : (row.last_run_at as Timestamp),
    lastRunId: row.last_run_id === null ? undefined : row.last_run_id,
    nextRunAt: row.next_run_at === null ? undefined : (row.next_run_at as Timestamp),
    createdAt: row.created_at as Timestamp,
    updatedAt: row.updated_at as Timestamp,
  };
}

// ─── 입력 타입 ───

export interface AddScheduleInput {
  name: string;
  cron: string;
  agentId: AgentId;
  prompt: string;
  deliveryChannel: DeliveryChannel;
  deliveryTarget: string;
  /** 기본 true (enabled). */
  enabled?: boolean;
  timeoutMs?: number;
  /** scheduler 가 cron 으로 계산한 첫 next_run_at. */
  nextRunAt?: Timestamp;
}

export interface UpdateScheduleInput {
  name?: string;
  cron?: string;
  prompt?: string;
  deliveryChannel?: DeliveryChannel;
  deliveryTarget?: string;
  enabled?: boolean;
  timeoutMs?: number | null;
  status?: ScheduleStatus;
  consecutiveFailures?: number;
  /** cron 변경 시 호출자가 재계산해서 넘긴다. */
  nextRunAt?: Timestamp | null;
}

export interface ListSchedulesOptions {
  enabled?: boolean;
  agentId?: AgentId;
  /** default 100, max 500. */
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

// ─── CRUD ───

export function addSchedule(db: DatabaseSync, input: AddScheduleInput): Schedule {
  const id = randomUUID();
  const now = Date.now();
  const enabled = input.enabled === false ? 0 : 1;

  db.prepare(
    `INSERT INTO schedules (
      id, name, cron, agent_id, prompt, delivery_channel, delivery_target,
      enabled, timeout_ms, status, consecutive_failures,
      last_run_at, last_run_id, next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.cron,
    input.agentId as string,
    input.prompt,
    input.deliveryChannel,
    input.deliveryTarget,
    enabled,
    input.timeoutMs ?? null,
    input.nextRunAt === undefined ? null : (input.nextRunAt as number),
    now,
    now,
  );

  return getSchedule(db, id) as Schedule;
}

export function getSchedule(db: DatabaseSync, id: string): Schedule | null {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

export function listSchedules(db: DatabaseSync, options: ListSchedulesOptions = {}): Schedule[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }
  if (options.agentId) {
    clauses.push('agent_id = ?');
    params.push(options.agentId as string);
  }
  let sql = 'SELECT * FROM schedules';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as unknown as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function updateSchedule(
  db: DatabaseSync,
  id: string,
  patch: UpdateScheduleInput,
): Schedule | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.cron !== undefined) {
    sets.push('cron = ?');
    params.push(patch.cron);
  }
  if (patch.prompt !== undefined) {
    sets.push('prompt = ?');
    params.push(patch.prompt);
  }
  if (patch.deliveryChannel !== undefined) {
    sets.push('delivery_channel = ?');
    params.push(patch.deliveryChannel);
  }
  if (patch.deliveryTarget !== undefined) {
    sets.push('delivery_target = ?');
    params.push(patch.deliveryTarget);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.timeoutMs !== undefined) {
    sets.push('timeout_ms = ?');
    params.push(patch.timeoutMs);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.consecutiveFailures !== undefined) {
    sets.push('consecutive_failures = ?');
    params.push(patch.consecutiveFailures);
  }
  if (patch.nextRunAt !== undefined) {
    sets.push('next_run_at = ?');
    params.push(patch.nextRunAt === null ? null : (patch.nextRunAt as number));
  }
  if (sets.length === 0) {
    return getSchedule(db, id);
  }
  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);
  const result = db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (result.changes === 0) {
    return null;
  }
  return getSchedule(db, id);
}

export function deleteSchedule(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  return result.changes > 0;
}

/** scheduler tick: enabled=1 AND next_run_at <= now. */
export function findDueSchedules(db: DatabaseSync, now: number): Schedule[] {
  const rows = db
    .prepare(
      `SELECT * FROM schedules
       WHERE enabled = 1
         AND status != 'disabled'
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    )
    .all(now) as unknown as ScheduleRow[];
  return rows.map(rowToSchedule);
}

/** tick 후 last_run_at/last_run_id/next_run_at 갱신. status reset 은 별도 호출자 책임. */
export function markScheduleRun(
  db: DatabaseSync,
  scheduleId: string,
  runId: string | null,
  ranAt: number,
  nextRunAt: number | null,
): void {
  db.prepare(
    `UPDATE schedules
     SET last_run_at = ?, last_run_id = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(ranAt, runId, nextRunAt, Date.now(), scheduleId);
}
