// packages/storage/src/access-log.ts
// Phase 30 C2: RPC access log (감사 가능성 — 모든 호출 1행).

import type { DatabaseSync } from 'node:sqlite';

export interface AccessLogEntry {
  readonly id?: number;
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

interface AccessLogRow {
  id: number;
  ts: number;
  method: string;
  params_hash: string;
  actor: string | null;
  ip: string | null;
  duration_ms: number;
  status: string;
  error: string | null;
  trace_id: string | null;
}

function rowToEntry(row: AccessLogRow): AccessLogEntry {
  return {
    id: row.id,
    ts: row.ts,
    method: row.method,
    paramsHash: row.params_hash,
    actor: row.actor ?? undefined,
    ip: row.ip ?? undefined,
    durationMs: row.duration_ms,
    status: row.status,
    error: row.error ?? undefined,
    traceId: row.trace_id ?? undefined,
  };
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

export interface ListAccessLogOptions {
  readonly since?: number;
  /** default 100, max 500 */
  readonly limit?: number;
  readonly method?: string;
  readonly actor?: string;
  readonly status?: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function listAccessLog(db: DatabaseSync, opts: ListAccessLogOptions = {}): AccessLogEntry[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.since !== undefined) {
    clauses.push('ts >= ?');
    params.push(opts.since);
  }
  if (opts.method !== undefined) {
    clauses.push('method = ?');
    params.push(opts.method);
  }
  if (opts.actor !== undefined) {
    clauses.push('actor = ?');
    params.push(opts.actor);
  }
  if (opts.status !== undefined) {
    clauses.push('status = ?');
    params.push(opts.status);
  }

  let sql = 'SELECT * FROM access_log';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY ts DESC LIMIT ?';
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as unknown as AccessLogRow[];
  return rows.map(rowToEntry);
}

/** olderThanDays 보다 오래된 행을 삭제. 삭제된 행 수 반환. */
export function purgeAccessLog(db: DatabaseSync, olderThanDays: number): number {
  const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = db.prepare('DELETE FROM access_log WHERE ts < ?').run(threshold);
  return Number(result.changes);
}
