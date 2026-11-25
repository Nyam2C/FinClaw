// packages/server/src/automation/scheduler.test.ts
// Phase 28 E: SchedulerService 실패 처리 회귀 가드.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRunPort, AgentRunRequest } from '@finclaw/agent';
import { ConcurrencyLane, type FinClawLogger } from '@finclaw/infra';
import {
  addAgentRun,
  addSchedule,
  getSchedule,
  openDatabase,
  type Database,
} from '@finclaw/storage';
import { createAgentId } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SchedulerService } from './scheduler.js';

/** runtime 계약(D1)을 흉내 — 종료 이벤트 yield 전에 agent_runs 1행. outcomes[i] 가 i번째 호출 결과. */
function fakeRuntime(db: DatabaseSync, outcomes: Array<'ok' | 'fail'>) {
  const calls: AgentRunRequest[] = [];
  const runtime: AgentRunPort = {
    async *run(req) {
      calls.push(req);
      const runId = randomUUID();
      const failed = (outcomes[calls.length - 1] ?? 'ok') === 'fail';
      addAgentRun(db, {
        id: runId,
        agentId: req.agentId,
        prompt: req.input,
        output: failed ? '' : 'hello',
        error: failed ? 'unknown: boom' : undefined,
      });
      yield failed
        ? { type: 'error', runId, reason: 'unknown', message: 'boom' }
        : {
            type: 'done',
            runId,
            cliSessionId: 'c',
            text: 'hello',
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            durationMs: 1,
            numTurns: 1,
          };
    },
    reset: async () => false,
  };
  return { runtime, calls };
}

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
    const { runtime } = fakeRuntime(database.db, ['fail']);
    const sched = new SchedulerService({
      db: database.db,
      runtime,
      lane,
      logger: makeLogger(),
    });
    const { runId } = await sched.triggerNow(s.id);
    expect(runId).toBeTruthy();
    const row = database.db
      .prepare('SELECT error, schedule_id FROM agent_runs WHERE id = ?')
      .get(runId) as { error: string; schedule_id: string };
    expect(row.error).toBe('unknown: boom');
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
    const { runtime } = fakeRuntime(database.db, ['fail', 'fail', 'fail']);
    const sched = new SchedulerService({
      db: database.db,
      runtime,
      lane,
      logger: makeLogger(),
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
    // 첫 번째는 실패, 두 번째는 성공.
    const { runtime } = fakeRuntime(database.db, ['fail', 'ok']);
    const sched = new SchedulerService({
      db: database.db,
      runtime,
      lane,
      logger: makeLogger(),
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
      runtime: fakeRuntime(database.db, []).runtime,
      lane,
      logger: makeLogger(),
    });
    await expect(sched.triggerNow('does-not-exist')).rejects.toThrow(/not_found/);
  });

  it('runtime 에 oneShot · schedule-{id}- sessionKey · prompt 를 넘긴다', async () => {
    const s = addSchedule(database.db, {
      name: 't',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: '아침 브리핑',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    const { runtime, calls } = fakeRuntime(database.db, ['ok']);
    await new SchedulerService({ db: database.db, runtime, lane, logger: makeLogger() }).triggerNow(
      s.id,
    );
    expect(calls[0]).toMatchObject({ mode: 'oneShot', input: '아침 브리핑' });
    expect(String(calls[0]?.sessionKey)).toMatch(new RegExp(`^schedule-${s.id}-`));
  });

  it('agent_runs 는 run 당 1행 (중복 0) + schedule_id 연결', async () => {
    const s = addSchedule(database.db, {
      name: 't',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    const { runtime } = fakeRuntime(database.db, ['ok']);
    const { runId } = await new SchedulerService({
      db: database.db,
      runtime,
      lane,
      logger: makeLogger(),
    }).triggerNow(s.id);
    const rows = database.db.prepare('SELECT id, schedule_id FROM agent_runs').all() as Array<{
      id: string;
      schedule_id: string;
    }>;
    expect(rows).toEqual([{ id: runId, schedule_id: s.id }]);
  });
});
