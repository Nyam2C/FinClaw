// packages/storage/src/access-log.ts
// Phase 30 C2: RPC access log (감사 가능성 — 모든 호출 1행).

import type { DatabaseSync } from 'node:sqlite';

export interface AccessLogEntry {
  readonly ts: number;
  readonly method: string;
  readonly paramsHash: string;
  readonly actor?: string;
  readonly ip?: string;
  readonly durationMs: number;
  readonly status: string;
  readonly error?: string;
  readonly traceId?: string;
}

export function addAccessLog(db: DatabaseSync, entry: AccessLogEntry): void {
  db.prepare(
    `INSERT INTO access_log (ts, method, params_hash, actor, ip, duration_ms, status, error, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.ts,
    entry.method,
    entry.paramsHash,
    entry.actor ?? null,
    entry.ip ?? null,
    entry.durationMs,
    entry.status,
    entry.error ?? null,
    entry.traceId ?? null,
  );
}

/** olderThanDays 보다 오래된 행을 삭제. 삭제된 행 수 반환. */
export function purgeAccessLog(db: DatabaseSync, olderThanDays: number): number {
  const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = db.prepare('DELETE FROM access_log WHERE ts < ?').run(threshold);
  return Number(result.changes);
}
