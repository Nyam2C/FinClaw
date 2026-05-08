import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentId, MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import * as sqliteVec from 'sqlite-vec';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addAgentRun, getAgentRun, linkMemoryToAgentRun, listAgentRuns } from './agent-runs.js';
import { openDatabase, type Database } from './database.js';
import { addMemory } from './tables/memories.js';

const AGENT_A = 'agent-a' as AgentId;
const AGENT_B = 'agent-b' as AgentId;

function makeMemory(id: string, content = 'test content'): MemoryEntry {
  return {
    id,
    sessionKey: 'sess-1' as SessionKey,
    content,
    type: 'financial',
    createdAt: Date.now() as Timestamp,
  };
}

describe('agent_runs CRUD', () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('addAgentRun → getAgentRun roundtrip', () => {
    const run = addAgentRun(database.db, {
      agentId: AGENT_A,
      prompt: 'AAPL 분석',
      output: 'AAPL 은 ...',
      toolCalls: '[{"name":"finance.quote","input":{"symbol":"AAPL"}}]',
      tokensInput: 120,
      tokensOutput: 480,
      durationMs: 1500,
      modelUsed: 'claude-opus-4-7',
      role: 'analyzer',
    });

    expect(run.id).toBeTruthy();
    expect(run.createdAt).toBeGreaterThan(0);
    expect(run.memoryId).toBeUndefined();
    expect(run.error).toBeUndefined();

    const fetched = getAgentRun(database.db, run.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.agentId).toBe(AGENT_A);
    expect(fetched?.prompt).toBe('AAPL 분석');
    expect(fetched?.output).toBe('AAPL 은 ...');
    expect(fetched?.toolCalls).toBe('[{"name":"finance.quote","input":{"symbol":"AAPL"}}]');
    expect(fetched?.tokensInput).toBe(120);
    expect(fetched?.tokensOutput).toBe(480);
    expect(fetched?.durationMs).toBe(1500);
    expect(fetched?.modelUsed).toBe('claude-opus-4-7');
    expect(fetched?.role).toBe('analyzer');
  });

  it('getAgentRun — 미존재 id 면 null', () => {
    expect(getAgentRun(database.db, 'nope')).toBeNull();
  });

  it('addAgentRun — 최소 필드 (optional 모두 미지정)', () => {
    const run = addAgentRun(database.db, {
      agentId: AGENT_A,
      prompt: 'q',
      output: 'a',
    });
    const fetched = getAgentRun(database.db, run.id);
    expect(fetched?.toolCalls).toBeUndefined();
    expect(fetched?.tokensInput).toBeUndefined();
    expect(fetched?.tokensOutput).toBeUndefined();
    expect(fetched?.durationMs).toBeUndefined();
    expect(fetched?.modelUsed).toBeUndefined();
    expect(fetched?.role).toBeUndefined();
    expect(fetched?.memoryId).toBeUndefined();
    expect(fetched?.error).toBeUndefined();
  });

  it('addAgentRun — error 필드 기록', () => {
    const run = addAgentRun(database.db, {
      agentId: AGENT_A,
      prompt: 'q',
      output: '',
      error: 'rate limited',
    });
    expect(getAgentRun(database.db, run.id)?.error).toBe('rate limited');
  });
});

describe('listAgentRuns', () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('created_at DESC 정렬, default limit 50', () => {
    // 3 건 삽입 — created_at 은 Date.now() 이라 순서를 보장하기 위해 raw 쿼리 사용
    const ids = ['r1', 'r2', 'r3'];
    const times = [1000, 2000, 3000];
    for (let i = 0; i < 3; i++) {
      database.db
        .prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(ids[i], AGENT_A as string, 'p', 'o', times[i]);
    }
    const list = listAgentRuns(database.db);
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe('r3');
    expect(list[1].id).toBe('r2');
    expect(list[2].id).toBe('r1');
  });

  it('agentId 필터', () => {
    addAgentRun(database.db, { agentId: AGENT_A, prompt: 'p', output: 'o' });
    addAgentRun(database.db, { agentId: AGENT_B, prompt: 'p', output: 'o' });
    addAgentRun(database.db, { agentId: AGENT_A, prompt: 'p', output: 'o' });

    const onlyA = listAgentRuns(database.db, { agentId: AGENT_A });
    expect(onlyA).toHaveLength(2);
    onlyA.forEach((r) => expect(r.agentId).toBe(AGENT_A));

    const onlyB = listAgentRuns(database.db, { agentId: AGENT_B });
    expect(onlyB).toHaveLength(1);
  });

  it('from / to 필터', () => {
    const times = [1000, 2000, 3000, 4000];
    times.forEach((t, i) => {
      database.db
        .prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(`r${i}`, AGENT_A as string, 'p', 'o', t);
    });

    const mid = listAgentRuns(database.db, {
      from: 2000 as Timestamp,
      to: 3000 as Timestamp,
    });
    expect(mid).toHaveLength(2);
    expect(mid[0].createdAt).toBe(3000);
    expect(mid[1].createdAt).toBe(2000);
  });

  it('limit 페이지네이션 (max 200 강제)', () => {
    for (let i = 0; i < 5; i++) {
      database.db
        .prepare(
          `INSERT INTO agent_runs (id, agent_id, prompt, output, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(`r${i}`, AGENT_A as string, 'p', 'o', 1000 + i);
    }
    expect(listAgentRuns(database.db, { limit: 2 })).toHaveLength(2);

    // 200 초과는 200 으로 클램프 — 데이터가 5건뿐이라 5 반환
    expect(listAgentRuns(database.db, { limit: 9999 })).toHaveLength(5);
  });
});

describe('linkMemoryToAgentRun + ON DELETE SET NULL', () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('linkMemoryToAgentRun — memory_id 갱신', () => {
    addMemory(database.db, makeMemory('mem-1'));
    const run = addAgentRun(database.db, {
      agentId: AGENT_A,
      prompt: 'p',
      output: 'o',
    });

    const ok = linkMemoryToAgentRun(database.db, run.id, 'mem-1');
    expect(ok).toBe(true);

    expect(getAgentRun(database.db, run.id)?.memoryId).toBe('mem-1');
  });

  it('linkMemoryToAgentRun — 미존재 run 이면 false', () => {
    addMemory(database.db, makeMemory('mem-1'));
    expect(linkMemoryToAgentRun(database.db, 'nope', 'mem-1')).toBe(false);
  });

  it('memory 삭제 시 agent_runs.memory_id → NULL (ON DELETE SET NULL)', () => {
    addMemory(database.db, makeMemory('mem-1'));
    const run = addAgentRun(database.db, {
      agentId: AGENT_A,
      prompt: 'p',
      output: 'o',
      memoryId: 'mem-1',
    });

    expect(getAgentRun(database.db, run.id)?.memoryId).toBe('mem-1');

    database.db.prepare('DELETE FROM memories WHERE id = ?').run('mem-1');

    // FK SET NULL 이 트리거되어 agent_runs 자체는 보존, memory_id 만 NULL
    const after = getAgentRun(database.db, run.id);
    expect(after).not.toBeNull();
    expect(after?.memoryId).toBeUndefined();
  });
});

describe('v4 → v5 migration', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'finclaw-mig-v5-'));
    dbPath = join(tmpDir, 'v4.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('v4 fixture (agent_runs 미존재) → openDatabase → v5 적용 + 테이블 생성', () => {
    // v4 raw fixture — agent_runs 가 아직 없는 상태
    const raw = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(raw);
    raw.enableLoadExtension(false);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE memories (
        id          TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        content     TEXT NOT NULL,
        type        TEXT NOT NULL CHECK(type IN ('fact','preference','summary','financial')),
        hash        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        metadata    TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '4');
    `);
    // agent_runs 테이블이 없는 상태 검증
    const before = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'")
      .all();
    expect(before).toHaveLength(0);
    raw.close();

    // openDatabase → v5 마이그레이션 트리거
    const database = openDatabase({ path: dbPath });
    try {
      const versionRow = database.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as unknown as { value: string };
      expect(versionRow.value).toBe('7');

      // agent_runs 테이블 존재
      const tableExists = database.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'")
        .all();
      expect(tableExists).toHaveLength(1);

      // 인덱스 2개 존재
      const indexes = database.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_runs' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const names = indexes.map((r) => r.name);
      expect(names).toContain('idx_agent_runs_created');
      expect(names).toContain('idx_agent_runs_agent');

      // 실제 INSERT 가능한지 (스키마 정합)
      const run = addAgentRun(database.db, {
        agentId: AGENT_A,
        prompt: 'after migration',
        output: 'ok',
      });
      expect(getAgentRun(database.db, run.id)).not.toBeNull();
    } finally {
      database.close();
    }

    // idempotent: 다시 열어도 안전
    const reopened = openDatabase({ path: dbPath });
    try {
      const versionRow = reopened.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as unknown as { value: string };
      expect(versionRow.value).toBe('7');
    } finally {
      reopened.close();
    }
  });
});
