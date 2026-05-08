import { beforeEach, describe, expect, it } from 'vitest';
import {
  addAccessLog,
  listAccessLog,
  openDatabase,
  purgeAccessLog,
  type Database,
} from './index.js';

describe('access_log storage', () => {
  let db: Database;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:', enableWAL: false });
  });

  it('inserts and lists rows by filter', () => {
    addAccessLog(db.db, {
      ts: 1000,
      method: 'system.ping',
      paramsHash: 'h1',
      durationMs: 5,
      status: '200',
    });
    addAccessLog(db.db, {
      ts: 2000,
      method: 'audit.list',
      paramsHash: 'h2',
      durationMs: 10,
      status: '200',
    });
    expect(listAccessLog(db.db, { method: 'audit.list' })).toHaveLength(1);
    expect(listAccessLog(db.db)).toHaveLength(2);
  });

  it('orders by ts DESC', () => {
    addAccessLog(db.db, { ts: 1000, method: 'a', paramsHash: 'h', durationMs: 1, status: '200' });
    addAccessLog(db.db, { ts: 3000, method: 'b', paramsHash: 'h', durationMs: 1, status: '200' });
    addAccessLog(db.db, { ts: 2000, method: 'c', paramsHash: 'h', durationMs: 1, status: '200' });
    const rows = listAccessLog(db.db);
    expect(rows.map((r) => r.method)).toEqual(['b', 'c', 'a']);
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
    const remaining = listAccessLog(db.db);
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
    const rows = listAccessLog(db.db);
    expect(rows[0]).toMatchObject({
      method: 'm',
      actor: 'token',
      ip: '127.0.0.1',
      error: 'boom',
      traceId: 'aa'.repeat(16),
    });
  });

  it('clamps limit to MAX_LIMIT (500)', () => {
    for (let i = 0; i < 10; i++) {
      addAccessLog(db.db, {
        ts: i,
        method: 'm',
        paramsHash: 'h',
        durationMs: 1,
        status: '200',
      });
    }
    expect(listAccessLog(db.db, { limit: 99999 })).toHaveLength(10);
    expect(listAccessLog(db.db, { limit: 5 })).toHaveLength(5);
  });
});
