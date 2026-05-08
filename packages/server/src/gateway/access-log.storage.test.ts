// packages/server/src/gateway/access-log.storage.test.ts
// Phase 30 C10: createAccessLogger 가 db 옵션 주입 시 SQLite 에 기록.

import { EventEmitter } from 'node:events';
import { listAccessLog, openDatabase } from '@finclaw/storage';
import { describe, expect, it } from 'vitest';
import { createAccessLogger } from './access-log.js';

describe('createAccessLogger SQLite dual-write', () => {
  function createMockReqRes(method: string, url: string) {
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      setHeader: (n: string, v: string) => void;
      getHeader: (n: string) => string;
    };
    res.statusCode = 200;
    res.setHeader = () => {
      // no-op
    };
    res.getHeader = () => '0';

    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as import('node:http').IncomingMessage;

    return { req, res: res as unknown as import('node:http').ServerResponse };
  }

  it('writes to SQLite when db option provided', () => {
    const db = openDatabase({ path: ':memory:', enableWAL: false });
    const log = createAccessLogger({
      db: db.db,
      getTraceId: () => 'aa'.repeat(16),
    });
    const { req, res } = createMockReqRes('POST', '/rpc');
    log(req, res, { rpcMethod: 'system.ping', authLevel: 'token' });
    (res as unknown as EventEmitter).emit('finish');

    const rows = listAccessLog(db.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: 'system.ping',
      actor: 'token',
      ip: '127.0.0.1',
      status: '200',
      traceId: 'aa'.repeat(16),
    });
  });

  it('does not throw when db option is omitted (backward compat)', () => {
    const log = createAccessLogger();
    const { req, res } = createMockReqRes('GET', '/health');
    log(req, res);
    expect(() => (res as unknown as EventEmitter).emit('finish')).not.toThrow();
  });

  it('continues silently if SQLite write fails (best-effort)', () => {
    // 닫힌 db 를 강제로 주입 → addAccessLog 실패해도 finish 처리는 무사 통과해야 함.
    const db = openDatabase({ path: ':memory:', enableWAL: false });
    db.close();
    const log = createAccessLogger({ db: db.db });
    const { req, res } = createMockReqRes('GET', '/health');
    log(req, res);
    expect(() => (res as unknown as EventEmitter).emit('finish')).not.toThrow();
  });
});
