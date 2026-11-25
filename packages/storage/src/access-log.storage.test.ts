import { beforeEach, describe, expect, it } from 'vitest';
import { addAccessLog, openDatabase, purgeAccessLog, type Database } from './index.js';

function rows(db: Database): Array<Record<string, unknown>> {
  return db.db.prepare('SELECT * FROM access_log ORDER BY ts DESC').all() as Array<
    Record<string, unknown>
  >;
}

describe('access_log storage', () => {
  let db: Database;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:', enableWAL: false });
  });

  it('inserts rows', () => {
    addAccessLog(db.db, {
      ts: 1000,
      method: 'system.ping',
      paramsHash: 'h1',
      durationMs: 5,
      status: '200',
    });
    addAccessLog(db.db, {
      ts: 2000,
      method: 'agent.run',
      paramsHash: 'h2',
      durationMs: 10,
      status: '200',
    });
    expect(rows(db)).toHaveLength(2);
  });

  it('purges only rows older than retention', () => {
    const now = Date.now();
    addAccessLog(db.db, {
      ts: now - 31 * 24 * 3600 * 1000,
      method: 'old',
      paramsHash: 'h',
      durationMs: 1,
      status: '200',
    });
    addAccessLog(db.db, {
      ts: now - 1 * 24 * 3600 * 1000,
      method: 'recent',
      paramsHash: 'h',
      durationMs: 1,
      status: '200',
    });
    expect(purgeAccessLog(db.db, 30)).toBe(1);
    const remaining = rows(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.method).toBe('recent');
  });

  it('preserves traceId / actor / ip / error fields', () => {
    addAccessLog(db.db, {
      ts: 1,
      method: 'm',
      paramsHash: 'h',
      durationMs: 1,
      status: '500',
      actor: 'token',
      ip: '127.0.0.1',
      error: 'boom',
      traceId: 'aa'.repeat(16),
    });
    expect(rows(db)[0]).toMatchObject({
      method: 'm',
      actor: 'token',
      ip: '127.0.0.1',
      error: 'boom',
      trace_id: 'aa'.repeat(16),
    });
  });
});
