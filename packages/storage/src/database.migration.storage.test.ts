import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';

describe('schema migration v5 → v10', () => {
  it('preserves agent_runs and adds schedules + schedule_id + used_memory_ids columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase28-mig-'));
    const path = join(dir, 'db.sqlite');
    try {
      // 1) v5 스키마 수동 생성 + meta 행 삽입
      {
        const db = new DatabaseSync(path, { allowExtension: true });
        sqliteVec.load(db);
        db.enableLoadExtension(false);
        db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
        db.exec(`
          CREATE TABLE agent_runs (
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL,
            output TEXT NOT NULL, tool_calls_json TEXT, tokens_input INTEGER,
            tokens_output INTEGER, duration_ms INTEGER, model_used TEXT,
            role TEXT, memory_id TEXT, error TEXT, created_at INTEGER NOT NULL
          );
        `);
        db.prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run('run-1', 'finclaw-partner', 'p', 'o', Date.now());
        db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '5')`).run();
        db.close();
      }

      // 2) openDatabase 가 v10 으로 마이그레이션 (Phase 30 A3 + C1 + D4)
      const upgraded = openDatabase({ path, enableWAL: false });
      try {
        expect(upgraded.schemaVersion).toBe(10);
        // schedules 테이블 존재
        const tbl = upgraded.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'`)
          .get();
        expect(tbl).toBeTruthy();
        // 기존 agent_runs 행 보존
        const cnt = upgraded.db.prepare(`SELECT COUNT(*) AS c FROM agent_runs`).get() as {
          c: number;
        };
        expect(cnt.c).toBe(1);
        // schedule_id 컬럼 존재 (v6) + used_memory_ids (v7) + trace_id/parent_span_id (v8)
        const cols = upgraded.db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{
          name: string;
        }>;
        expect(cols.find((c) => c.name === 'schedule_id')).toBeTruthy();
        expect(cols.find((c) => c.name === 'used_memory_ids')).toBeTruthy();
        expect(cols.find((c) => c.name === 'trace_id')).toBeTruthy();
        expect(cols.find((c) => c.name === 'parent_span_id')).toBeTruthy();
        // spans 테이블 존재 (v8)
        const spans = upgraded.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='spans'`)
          .get();
        expect(spans).toBeTruthy();
        // access_log 테이블 존재 (v9)
        const accessLog = upgraded.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='access_log'`)
          .get();
        expect(accessLog).toBeTruthy();
        // rerank_meta 컬럼 존재 (v10)
        expect(cols.find((c) => c.name === 'rerank_meta')).toBeTruthy();
        // 마이그레이션 후 schema_version meta 가 10 으로 갱신
        const ver = upgraded.db
          .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
          .get() as { value: string };
        expect(ver.value).toBe('10');
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('idempotent: re-running openDatabase on v10 DB is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase28-mig-idem-'));
    const path = join(dir, 'db.sqlite');
    try {
      const a = openDatabase({ path, enableWAL: false });
      a.close();
      const b = openDatabase({ path, enableWAL: false });
      try {
        expect(b.schemaVersion).toBe(10);
      } finally {
        b.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
