import type { AgentId, Timestamp } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addAgentRun } from './agent-runs.js';
import { openDatabase, type Database } from './database.js';
import {
  addSchedule,
  deleteSchedule,
  findDueSchedules,
  getSchedule,
  listSchedules,
  markScheduleRun,
  updateSchedule,
} from './schedules.js';

const AGENT = 'finclaw-partner' as AgentId;

describe('schedules storage', () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('addSchedule + getSchedule round trip', () => {
    const created = addSchedule(database.db, {
      name: '일일 보고',
      cron: '0 12 * * *',
      agentId: AGENT,
      prompt: '오늘 시장 요약',
      deliveryChannel: 'discord',
      deliveryTarget: '123456',
    });
    expect(created.name).toBe('일일 보고');
    expect(created.enabled).toBe(true);
    expect(created.status).toBe('active');
    expect(created.consecutiveFailures).toBe(0);
    const fetched = getSchedule(database.db, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.deliveryChannel).toBe('discord');
  });

  it('findDueSchedules respects enabled + next_run_at + status', () => {
    const now = Date.now();
    const a = addSchedule(database.db, {
      name: 'past',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: (now - 10) as Timestamp,
    });
    addSchedule(database.db, {
      name: 'future',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: (now + 60_000) as Timestamp,
    });
    addSchedule(database.db, {
      name: 'disabled',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      enabled: false,
      nextRunAt: (now - 10) as Timestamp,
    });
    const due = findDueSchedules(database.db, now);
    expect(due.map((s) => s.id)).toEqual([a.id]);
  });

  it('findDueSchedules ignores status=disabled even when enabled flag is 1', () => {
    const now = Date.now();
    const s = addSchedule(database.db, {
      name: 's',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: (now - 10) as Timestamp,
    });
    updateSchedule(database.db, s.id, { status: 'disabled' });
    expect(findDueSchedules(database.db, now)).toEqual([]);
  });

  it('markScheduleRun updates last_run_id/next_run_at', () => {
    const s = addSchedule(database.db, {
      name: 's',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: Date.now() as Timestamp,
    });
    const run = addAgentRun(database.db, {
      agentId: AGENT,
      prompt: 'p',
      output: 'ok',
    });
    const next = Date.now() + 60_000;
    markScheduleRun(database.db, s.id, run.id, Date.now(), next);
    const reread = getSchedule(database.db, s.id);
    expect(reread?.lastRunId).toBe(run.id);
    expect(reread?.nextRunAt).toBe(next as Timestamp);
  });

  it('deleteSchedule sets agent_runs.schedule_id to NULL', () => {
    const s = addSchedule(database.db, {
      name: 's',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    const run = addAgentRun(database.db, {
      agentId: AGENT,
      prompt: 'p',
      output: 'ok',
    });
    database.db.prepare('UPDATE agent_runs SET schedule_id = ? WHERE id = ?').run(s.id, run.id);
    expect(deleteSchedule(database.db, s.id)).toBe(true);
    const row = database.db
      .prepare('SELECT schedule_id FROM agent_runs WHERE id = ?')
      .get(run.id) as { schedule_id: string | null };
    expect(row.schedule_id).toBeNull();
  });

  it('listSchedules filters by enabled + agentId', () => {
    addSchedule(database.db, {
      name: 'a',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    addSchedule(database.db, {
      name: 'b',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      enabled: false,
    });
    expect(listSchedules(database.db).length).toBe(2);
    expect(listSchedules(database.db, { enabled: true }).length).toBe(1);
    expect(listSchedules(database.db, { enabled: false }).length).toBe(1);
  });

  it('updateSchedule applies partial changes including nextRunAt=null', () => {
    const s = addSchedule(database.db, {
      name: 'orig',
      cron: '* * * * *',
      agentId: AGENT,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: Date.now() as Timestamp,
    });
    const updated = updateSchedule(database.db, s.id, {
      name: 'renamed',
      enabled: false,
      consecutiveFailures: 2,
      status: 'failing',
      nextRunAt: null,
    });
    expect(updated?.name).toBe('renamed');
    expect(updated?.enabled).toBe(false);
    expect(updated?.consecutiveFailures).toBe(2);
    expect(updated?.status).toBe('failing');
    expect(updated?.nextRunAt).toBeUndefined();
  });

  it('updateSchedule returns null for unknown id', () => {
    expect(updateSchedule(database.db, 'no-such', { name: 'x' })).toBeNull();
  });
});
