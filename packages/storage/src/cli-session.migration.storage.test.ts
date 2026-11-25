import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentId } from '@finclaw/types';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { addAgentRun, getAgentRun } from './agent-runs.js';
import { openDatabase } from './database.js';

const AGENT = 'agent-cli' as AgentId;

function hasColumn(db: DatabaseSync, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

describe('migration v10 → v11 (agent_runs.cli_session_id)', () => {
  it('fresh DB has cli_session_id column + index', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      expect(db.schemaVersion).toBe(12);
      expect(hasColumn(db.db, 'agent_runs', 'cli_session_id')).toBe(true);
      const indexes = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_runs'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((r) => r.name)).toContain('idx_agent_runs_cli_session');
    } finally {
      db.close();
    }
  });

  it('migrates a v10 DB by adding cli_session_id (idempotent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase32-mig-'));
    const path = join(dir, 'db.sqlite');
    try {
      // 1) fresh v11 DB 를 만든 뒤 schema_version 을 10 으로 강제 + 컬럼 제거 시뮬레이션은
      //    SQLite 가 DROP COLUMN 을 제한적으로만 지원하므로, v10 상태를 schema_version meta 로만 표현.
      //    (cli_session_id 는 ALTER ADD COLUMN IF NOT EXISTS 가드로 중복 추가 안 됨 → idempotent 검증)
      {
        const raw = new DatabaseSync(path, { allowExtension: true });
        sqliteVec.load(raw);
        raw.enableLoadExtension(false);
        const seed = openDatabase({ path: ':memory:' });
        seed.close();
        raw.close();
      }
      // 2) v10 meta 로 강제하기 위해 새 DB 를 직접 만들고 schema_version=10 세팅
      {
        const raw = new DatabaseSync(path, { allowExtension: true });
        sqliteVec.load(raw);
        raw.enableLoadExtension(false);
        raw.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
        raw.exec(`
          CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL,
            output TEXT NOT NULL, tool_calls_json TEXT, tokens_input INTEGER,
            tokens_output INTEGER, duration_ms INTEGER, model_used TEXT, role TEXT,
            memory_id TEXT, used_memory_ids TEXT, schedule_id TEXT, trace_id TEXT,
            parent_span_id TEXT, rerank_meta TEXT, error TEXT, created_at INTEGER NOT NULL
          );
        `);
        raw
          .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '10')`)
          .run();
        raw.close();
      }
      // 3) openDatabase → v11 마이그레이션
      const upgraded = openDatabase({ path, enableWAL: false });
      try {
        expect(upgraded.schemaVersion).toBe(12);
        expect(hasColumn(upgraded.db, 'agent_runs', 'cli_session_id')).toBe(true);
        const ver = upgraded.db
          .prepare(`SELECT value FROM meta WHERE key='schema_version'`)
          .get() as { value: string };
        expect(ver.value).toBe('12');
      } finally {
        upgraded.close();
      }
      // 4) idempotent: 재오픈해도 안전
      const reopened = openDatabase({ path, enableWAL: false });
      try {
        expect(reopened.schemaVersion).toBe(12);
        expect(hasColumn(reopened.db, 'agent_runs', 'cli_session_id')).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('addAgentRun persists cliSessionId', () => {
    const db = openDatabase({ path: ':memory:' });
    try {
      const run = addAgentRun(db.db, {
        agentId: AGENT,
        prompt: 'p',
        output: 'o',
        cliSessionId: 'sess1',
      });
      expect(getAgentRun(db.db, run.id)?.cliSessionId).toBe('sess1');
    } finally {
      db.close();
    }
  });
});
