import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

// ─── Public types ───

export interface Database {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly schemaVersion: number;
  close(): void;
}

export interface DatabaseOptions {
  readonly path: string;
  readonly enableWAL?: boolean;
  readonly enableForeignKeys?: boolean;
}

// ─── Schema ───

const SCHEMA_VERSION = 1;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  agent_id   TEXT NOT NULL,
  channel_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content         TEXT NOT NULL DEFAULT '',
  tool_calls      TEXT,
  token_count     INTEGER,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  content     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK(type IN ('fact','preference','summary','financial')),
  hash        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_key);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id         TEXT PRIMARY KEY,
  memory_id  TEXT NOT NULL,
  text       TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  model      TEXT NOT NULL DEFAULT 'pending',
  hash       TEXT, -- NOTE(review-1 I-3): nullable — addMemory에서 chunk hash 미설정. 향후 NOT NULL 마이그레이션 예정
  created_at INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_memory ON memory_chunks(memory_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[1024]
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
  text,
  id UNINDEXED,
  memory_id UNINDEXED,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  hash       TEXT NOT NULL,
  embedding  BLOB NOT NULL,
  dims       INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, hash)
);

CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  symbol            TEXT NOT NULL,
  condition_type    TEXT NOT NULL CHECK(condition_type IN ('above','below','crosses_above','crosses_below','change_percent')),
  condition_value   REAL NOT NULL,
  condition_field   TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  channel_id        TEXT,
  trigger_count     INTEGER NOT NULL DEFAULT 0,
  cooldown_ms       INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(enabled) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS market_cache (
  key        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  ttl_ms     INTEGER NOT NULL,
  cached_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_cache_expires ON market_cache(expires_at);
`;

const MIGRATIONS: Record<number, string> = {};

// ─── Internal helpers ───

function readMetaValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function writeMetaValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

function runMigrations(db: DatabaseSync, from: number, to: number): void {
  for (let v = from + 1; v <= to; v++) {
    const sql = MIGRATIONS[v];
    if (sql) {
      db.exec(sql);
    }
  }
}

// ─── Public API ───

export function openDatabase(options: DatabaseOptions): Database {
  const { path, enableWAL = true, enableForeignKeys = true } = options;

  // allowExtension: true handles enableLoadExtension(true) — explicit call unnecessary
  const db = new DatabaseSync(path, { allowExtension: true });

  // Load sqlite-vec extension
  sqliteVec.load(db);
  db.enableLoadExtension(false);

  // PRAGMAs
  if (enableWAL) {
    db.exec('PRAGMA journal_mode = WAL');
  }
  if (enableForeignKeys) {
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -64000');
  db.exec('PRAGMA mmap_size = 268435456');
  db.exec('PRAGMA temp_store = MEMORY');

  // Create schema
  db.exec(SCHEMA_DDL);

  // Version management
  const stored = readMetaValue(db, 'schema_version');
  if (stored === null) {
    writeMetaValue(db, 'schema_version', String(SCHEMA_VERSION));
  } else {
    const currentVersion = Number(stored);
    if (currentVersion < SCHEMA_VERSION) {
      runMigrations(db, currentVersion, SCHEMA_VERSION);
      writeMetaValue(db, 'schema_version', String(SCHEMA_VERSION));
    }
  }

  let closed = false;

  return {
    db,
    path,
    schemaVersion: SCHEMA_VERSION,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        db.exec('PRAGMA optimize');
      } catch {
        // best-effort
      }
      db.close();
    },
  };
}
