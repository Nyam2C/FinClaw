// packages/server/src/automation/scheduler.test.ts
// Phase 28 E: SchedulerService 실패 처리 회귀 가드.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryToolRegistry, ProfileHealthMonitor } from '@finclaw/agent';
import { ConcurrencyLane, type FinClawLogger } from '@finclaw/infra';
import { addSchedule, getSchedule, openDatabase, type Database } from '@finclaw/storage';
import { createAgentId, type ModelRef } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchedulerService } from './scheduler.js';

const DEFAULT_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

function makeLogger(): FinClawLogger {
  const noop = (): void => {};
  const logger: FinClawLogger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
    flush: async () => {},
  };
  return logger;
}

describe('SchedulerService.triggerNow', () => {
  let dbDir: string;
  let database: Database;
  let lane: ConcurrencyLane;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'phase28-sched-'));
    database = openDatabase({ path: join(dbDir, 'db.sqlite'), enableWAL: false });
    lane = new ConcurrencyLane({
      maxConcurrent: 1,
      maxQueueSize: 5,
      waitTimeoutMs: 5_000,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('error 시 agent_runs.error 저장 + consecutiveFailures 증가', async () => {
    const s = addSchedule(database.db, {
      name: 't',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    const runner = { execute: vi.fn().mockRejectedValue(new Error('boom')) };
    const sched = new SchedulerService({
      db: database.db,
      toolRegistry: new InMemoryToolRegistry(),
      runnerFactory: () => runner as never,
      lane,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sys',
      logger: makeLogger(),
      profileHealth: new ProfileHealthMonitor(),
    });
    const { runId } = await sched.triggerNow(s.id);
    expect(runId).toBeTruthy();
    const row = database.db
      .prepare('SELECT error, schedule_id FROM agent_runs WHERE id = ?')
      .get(runId) as { error: string; schedule_id: string };
    expect(row.error).toBe('boom');
    expect(row.schedule_id).toBe(s.id);
    const reread = getSchedule(database.db, s.id);
    expect(reread?.consecutiveFailures).toBe(1);
    expect(reread?.status).toBe('failing');
    expect(reread?.enabled).toBe(true);
  });

  it('3회 연속 실패 시 status=disabled + enabled=false', async () => {
    const s = addSchedule(database.db, {
      name: 't',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    const runner = { execute: vi.fn().mockRejectedValue(new Error('boom')) };
    const sched = new SchedulerService({
      db: database.db,
      toolRegistry: new InMemoryToolRegistry(),
      runnerFactory: () => runner as never,
      lane,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sys',
      logger: makeLogger(),
      profileHealth: new ProfileHealthMonitor(),
      maxConsecutiveFailures: 3,
    });
    await sched.triggerNow(s.id);
    await sched.triggerNow(s.id);
    await sched.triggerNow(s.id);
    const reread = getSchedule(database.db, s.id);
    expect(reread?.consecutiveFailures).toBe(3);
    expect(reread?.status).toBe('disabled');
    expect(reread?.enabled).toBe(false);
  });

  it('성공 후 consecutiveFailures 0 으로 리셋', async () => {
    const s = addSchedule(database.db, {
      name: 't',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    // Mock runner: 첫 번째는 실패, 두 번째는 성공.
    let call = 0;
    const runner = {
      execute: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          throw new Error('transient');
        }
        return {
          messages: [{ role: 'assistant', content: 'hello' }],
          usage: { inputTokens: 10, outputTokens: 5 },
          turns: 1,
          status: 'completed',
        };
      }),
    };
    const sched = new SchedulerService({
      db: database.db,
      toolRegistry: new InMemoryToolRegistry(),
      runnerFactory: () => runner as never,
      lane,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sys',
      logger: makeLogger(),
      profileHealth: new ProfileHealthMonitor(),
    });
    await sched.triggerNow(s.id);
    expect(getSchedule(database.db, s.id)?.consecutiveFailures).toBe(1);
    await sched.triggerNow(s.id);
    const reread = getSchedule(database.db, s.id);
    expect(reread?.consecutiveFailures).toBe(0);
    expect(reread?.status).toBe('active');
  });

  it('not_found 시 throw', async () => {
    const sched = new SchedulerService({
      db: database.db,
      toolRegistry: new InMemoryToolRegistry(),
      runnerFactory: () => ({ execute: vi.fn() }) as never,
      lane,
      defaultModel: DEFAULT_MODEL,
      systemPrompt: 'sys',
      logger: makeLogger(),
      profileHealth: new ProfileHealthMonitor(),
    });
    await expect(sched.triggerNow('does-not-exist')).rejects.toThrow(/not_found/);
  });
});
