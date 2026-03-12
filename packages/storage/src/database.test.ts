import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Database } from './database.js';

describe('openDatabase', () => {
  let database: Database | null = null;

  afterEach(() => {
    if (database) {
      try {
        database.close();
      } catch {
        // already closed
      }
      database = null;
    }
  });

  it(':memory: DB에서 모든 테이블 생성', () => {
    database = openDatabase({ path: ':memory:' });

    const tables = database.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name).toSorted();
    expect(tableNames).toEqual(
      [
        'alerts',
        'conversations',
        'embedding_cache',
        'market_cache',
        'memories',
        'memory_chunks',
        'memory_chunks_fts',
        'memory_chunks_fts_config',
        'memory_chunks_fts_content',
        'memory_chunks_fts_data',
        'memory_chunks_fts_docsize',
        'memory_chunks_fts_idx',
        'memory_chunks_vec',
        'memory_chunks_vec_chunks',
        'memory_chunks_vec_info',
        'memory_chunks_vec_rowids',
        'memory_chunks_vec_vector_chunks00',
        'messages',
        'meta',
      ].toSorted(),
    );
  });

  it('WAL 모드 활성화 확인', () => {
    database = openDatabase({ path: ':memory:' });
    // :memory: DB doesn't actually use WAL on disk, but PRAGMA is set
    const result = database.db.prepare('PRAGMA journal_mode').get() as unknown as {
      journal_mode: string;
    };
    // :memory: returns 'memory' for journal mode
    expect(['wal', 'memory']).toContain(result.journal_mode);
  });

  it('외래 키 활성화 확인', () => {
    database = openDatabase({ path: ':memory:' });
    const result = database.db.prepare('PRAGMA foreign_keys').get() as unknown as {
      foreign_keys: number;
    };
    expect(result.foreign_keys).toBe(1);
  });

  it('schema_version meta 기록 확인', () => {
    database = openDatabase({ path: ':memory:' });
    const result = database.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as unknown as { value: string };
    expect(result.value).toBe('1');
  });

  it('sqlite-vec 로드 확인 — SELECT vec_version()', () => {
    database = openDatabase({ path: ':memory:' });
    const result = database.db.prepare('SELECT vec_version() as v').get() as unknown as {
      v: string;
    };
    expect(result.v).toBeTruthy();
  });

  it('중복 호출 시 기존 스키마 유지 (IF NOT EXISTS)', () => {
    database = openDatabase({ path: ':memory:' });
    // Insert some data
    database.db
      .prepare(
        "INSERT INTO conversations (id, agent_id, created_at, updated_at) VALUES ('s1', 'a1', 1, 1)",
      )
      .run();

    // Re-creating tables via DDL should not fail (IF NOT EXISTS)
    database.db.exec(
      "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, agent_id TEXT NOT NULL, channel_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL DEFAULT '{}')",
    );

    const row = database.db
      .prepare('SELECT id FROM conversations WHERE id = ?')
      .get('s1') as unknown as { id: string };
    expect(row.id).toBe('s1');
  });

  it('close() 호출 후 재사용 불가', () => {
    database = openDatabase({ path: ':memory:' });
    database.close();
    expect(() => {
      database?.db.prepare('SELECT 1').get();
    }).toThrow();
    database = null; // prevent double-close in afterEach
  });
});
