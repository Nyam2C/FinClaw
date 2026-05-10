import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

// ─── Public types ───

export interface Database {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly schemaVersion: number;
  /** Phase 29 C1: memory_chunks_vec 의 embedding 컬럼 차원. 부트 시 1회 읽고 캐시. */
  readonly vectorDimension: number;
  close(): void;
}

export interface DatabaseOptions {
  readonly path: string;
  readonly enableWAL?: boolean;
  readonly enableForeignKeys?: boolean;
}

// ─── Schema ───

const SCHEMA_VERSION = 10;

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
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  condition_type    TEXT NOT NULL CHECK(
    condition_type IN ('price', 'change', 'volume', 'news')
  ),
  condition_json    TEXT NOT NULL,
  channels_json     TEXT NOT NULL DEFAULT '["discord","websocket"]',
  cooldown_ms       INTEGER NOT NULL DEFAULT 900000,
  enabled           INTEGER NOT NULL DEFAULT 1,
  trigger_count     INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  expires_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS alert_history (
  id                    TEXT PRIMARY KEY,
  alert_id              TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  triggered_at          INTEGER NOT NULL,
  condition_snapshot    TEXT NOT NULL,
  delivery_results_json TEXT NOT NULL DEFAULT '[]',
  current_value         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at DESC);

CREATE TABLE IF NOT EXISTS market_cache (
  key        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  provider   TEXT NOT NULL,
  ttl_ms     INTEGER NOT NULL,
  cached_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_cache_expires ON market_cache(expires_at);

CREATE TABLE IF NOT EXISTS portfolios (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  portfolio_id TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  quantity     REAL NOT NULL,
  average_cost REAL NOT NULL,
  PRIMARY KEY (portfolio_id, symbol),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  portfolio_id  TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('buy','sell','dividend','fee','split')),
  quantity      REAL NOT NULL,
  price         REAL,
  fee           REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  executed_at   INTEGER NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('manual','import')),
  note          TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_symbol ON transactions(portfolio_id, symbol, executed_at DESC);

CREATE TABLE IF NOT EXISTS schedules (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  cron                  TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  delivery_channel      TEXT NOT NULL CHECK (delivery_channel IN ('discord', 'web')),
  delivery_target       TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  timeout_ms            INTEGER,
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','failing','disabled')),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_run_at           INTEGER,
  last_run_id           TEXT,
  next_run_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next ON schedules(enabled, next_run_at) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS agent_runs (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  output           TEXT NOT NULL,
  tool_calls_json  TEXT,
  tokens_input     INTEGER,
  tokens_output    INTEGER,
  duration_ms      INTEGER,
  model_used       TEXT,
  role             TEXT,
  memory_id        TEXT REFERENCES memories(id) ON DELETE SET NULL,
  used_memory_ids  TEXT,
  schedule_id      TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  trace_id         TEXT,
  parent_span_id   TEXT,
  rerank_meta      TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, created_at DESC);
-- idx_agent_runs_trace_id 는 ensurePostMigrationSchema 에서 보장 (v5 DB → v8 마이그레이션 시
-- ALTER TABLE 으로 trace_id 컬럼이 추가된 후에만 인덱스 가능).

CREATE TABLE IF NOT EXISTS spans (
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL PRIMARY KEY,
  parent_span_id  TEXT,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  start_ns        INTEGER NOT NULL,
  end_ns          INTEGER,
  attributes      TEXT NOT NULL DEFAULT '{}',
  events          TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'unset',
  status_message  TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_trace_start ON spans(trace_id, start_ns);

-- Phase 30 C1: access_log — RPC 호출 1건당 1행 (sampling 없음). retention 30 일 default.
CREATE TABLE IF NOT EXISTS access_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  method       TEXT NOT NULL,
  params_hash  TEXT NOT NULL,
  actor        TEXT,
  ip           TEXT,
  duration_ms  INTEGER NOT NULL,
  status       TEXT NOT NULL,
  error        TEXT,
  trace_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_log_ts ON access_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_method_ts ON access_log(method, ts DESC);
`;

type MigrationStep = string | ((db: DatabaseSync) => void);

const MIGRATIONS: Record<number, MigrationStep> = {
  2: `
CREATE TABLE IF NOT EXISTS portfolios (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_holdings (
  portfolio_id TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  quantity     REAL NOT NULL,
  average_cost REAL NOT NULL,
  PRIMARY KEY (portfolio_id, symbol),
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);
`,
  3: `
    DROP TABLE IF EXISTS alerts;

    CREATE TABLE IF NOT EXISTS alerts (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      name              TEXT NOT NULL,
      condition_type    TEXT NOT NULL CHECK(
        condition_type IN ('price', 'change', 'volume', 'news')
      ),
      condition_json    TEXT NOT NULL,
      channels_json     TEXT NOT NULL DEFAULT '["discord","websocket"]',
      cooldown_ms       INTEGER NOT NULL DEFAULT 900000,
      enabled           INTEGER NOT NULL DEFAULT 1,
      trigger_count     INTEGER NOT NULL DEFAULT 0,
      last_triggered_at INTEGER,
      expires_at        INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_enabled ON alerts(enabled) WHERE enabled = 1;

    CREATE TABLE IF NOT EXISTS alert_history (
      id                    TEXT PRIMARY KEY,
      alert_id              TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      triggered_at          INTEGER NOT NULL,
      condition_snapshot    TEXT NOT NULL,
      delivery_results_json TEXT NOT NULL DEFAULT '[]',
      current_value         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id);
    CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at DESC);
  `,
  4: `
    CREATE TABLE IF NOT EXISTS transactions (
      id            TEXT PRIMARY KEY,
      portfolio_id  TEXT NOT NULL,
      symbol        TEXT NOT NULL,
      action        TEXT NOT NULL CHECK (action IN ('buy','sell','dividend','fee','split')),
      quantity      REAL NOT NULL,
      price         REAL,
      fee           REAL NOT NULL DEFAULT 0,
      currency      TEXT NOT NULL,
      executed_at   INTEGER NOT NULL,
      source        TEXT NOT NULL CHECK (source IN ('manual','import')),
      note          TEXT,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_portfolio ON transactions(portfolio_id, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_symbol ON transactions(portfolio_id, symbol, executed_at DESC);

    -- 기존 portfolio_holdings 행 1건당 synthetic transaction 발행.
    -- transactions 가 비어있을 때만 실행 (idempotent: 이미 v4 인 DB 에서 다시 돌아도 안전).
    INSERT INTO transactions (
      id, portfolio_id, symbol, action, quantity, price, fee, currency,
      executed_at, source, note, created_at
    )
    SELECT
      lower(hex(randomblob(16))),
      h.portfolio_id,
      h.symbol,
      'buy',
      h.quantity,
      h.average_cost,
      0,
      p.currency,
      COALESCE(p.updated_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
      'manual',
      'synthetic from v3 holdings',
      CAST(strftime('%s','now') AS INTEGER) * 1000
    FROM portfolio_holdings h
    JOIN portfolios p ON p.id = h.portfolio_id
    WHERE h.quantity > 0
      AND NOT EXISTS (SELECT 1 FROM transactions LIMIT 1);
  `,
  5: `
    CREATE TABLE IF NOT EXISTS agent_runs (
      id              TEXT PRIMARY KEY,
      agent_id        TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      output          TEXT NOT NULL,
      tool_calls_json TEXT,
      tokens_input    INTEGER,
      tokens_output   INTEGER,
      duration_ms     INTEGER,
      model_used      TEXT,
      role            TEXT,
      memory_id       TEXT REFERENCES memories(id) ON DELETE SET NULL,
      error           TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, created_at DESC);
  `,
  6: (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        cron                  TEXT NOT NULL,
        agent_id              TEXT NOT NULL,
        prompt                TEXT NOT NULL,
        delivery_channel      TEXT NOT NULL CHECK (delivery_channel IN ('discord', 'web')),
        delivery_target       TEXT NOT NULL,
        enabled               INTEGER NOT NULL DEFAULT 1,
        timeout_ms            INTEGER,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','failing','disabled')),
        consecutive_failures  INTEGER NOT NULL DEFAULT 0,
        last_run_at           INTEGER,
        last_run_id           TEXT,
        next_run_at           INTEGER,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next ON schedules(enabled, next_run_at) WHERE enabled = 1;
    `);
    // agent_runs.schedule_id 는 SCHEMA_DDL 에 이미 정의되어 있을 수도 있고
    // (fresh DB 또는 v3→ 점프 마이그레이션에서 SCHEMA_DDL 이 먼저 실행됨),
    // 기존 v5 DB 에는 없을 수도 있다. table_info 로 확인 후 없을 때만 ALTER.
    const cols = db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'schedule_id')) {
      db.exec(
        `ALTER TABLE agent_runs ADD COLUMN schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL;`,
      );
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_agent_runs_schedule ON agent_runs(schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;`,
    );
  },
  // Phase 29 B3: agent_runs.used_memory_ids — RAG 인용으로 응답이 의존한 memory.id 배열 (JSON).
  7: (db: DatabaseSync) => {
    const cols = db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'used_memory_ids')) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN used_memory_ids TEXT;`);
    }
  },
  // Phase 30 A3: agent_runs.trace_id / parent_span_id + spans 테이블
  8: (db: DatabaseSync) => {
    const cols = db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'trace_id')) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN trace_id TEXT;`);
    }
    if (!cols.some((c) => c.name === 'parent_span_id')) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN parent_span_id TEXT;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_trace_id ON agent_runs(trace_id);`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS spans (
        trace_id        TEXT NOT NULL,
        span_id         TEXT NOT NULL PRIMARY KEY,
        parent_span_id  TEXT,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        start_ns        INTEGER NOT NULL,
        end_ns          INTEGER,
        attributes      TEXT NOT NULL DEFAULT '{}',
        events          TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'unset',
        status_message  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_spans_trace_start ON spans(trace_id, start_ns);
    `);
  },
  // Phase 30 C1: access_log 테이블 — RPC 호출 1건당 1행 + retention purge 대상.
  9: `
    CREATE TABLE IF NOT EXISTS access_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           INTEGER NOT NULL,
      method       TEXT NOT NULL,
      params_hash  TEXT NOT NULL,
      actor        TEXT,
      ip           TEXT,
      duration_ms  INTEGER NOT NULL,
      status       TEXT NOT NULL,
      error        TEXT,
      trace_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_access_log_ts ON access_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_access_log_method_ts ON access_log(method, ts DESC);
  `,
  // Phase 30 D4: agent_runs.rerank_meta — RAG re-rank 통계 (model/scoresBefore/scoresAfter/swaps JSON).
  10: (db: DatabaseSync) => {
    const cols = db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'rerank_meta')) {
      db.exec(`ALTER TABLE agent_runs ADD COLUMN rerank_meta TEXT;`);
    }
  },
};

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

/**
 * Phase 29 C1: memory_chunks_vec 가상 테이블의 embedding 컬럼 차원을 읽는다.
 *
 * vec0 virtual table 의 PRAGMA table_info 는 type 컬럼이 빈 문자열이라
 * sqlite_master.sql (CREATE 문 원본) 에서 `float[NNNN]` 패턴을 파싱한다.
 * 부트 시 1회만 호출되며 결과가 EmbeddingDimensionMismatchError 검사의 source-of-truth.
 */
function readVectorDimension(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_chunks_vec'`)
    .get() as { sql: string } | undefined;
  if (!row?.sql) {
    throw new Error('memory_chunks_vec table not found in sqlite_master');
  }
  const m = row.sql.match(/float\[(\d+)\]/);
  if (!m) {
    throw new Error(`Cannot parse vector dimension from CREATE SQL: ${row.sql}`);
  }
  return Number(m[1]);
}

function runMigrations(db: DatabaseSync, from: number, to: number): void {
  for (let v = from + 1; v <= to; v++) {
    const step = MIGRATIONS[v];
    if (typeof step === 'string') {
      db.exec(step);
    } else if (typeof step === 'function') {
      step(db);
    }
  }
}

/**
 * 마이그레이션 후 항상 실행되는 idempotent 보정 단계.
 *
 * SCHEMA_DDL 에 둘 수 없는 (마이그레이션으로 추가된 컬럼에 의존하는) 인덱스 등을 여기서 생성한다.
 * fresh DB 든 마이그레이션 DB 든, openDatabase 마지막에 한 번 실행되어 누락을 방지.
 */
function ensurePostMigrationSchema(db: DatabaseSync): void {
  // Phase 28: agent_runs.schedule_id 인덱스 — SCHEMA_DDL 의 CREATE TABLE IF NOT EXISTS 가
  // 기존 v5 DB 의 agent_runs 를 재생성하지 않으므로, 인덱스는 마이그레이션 후 별도로 보장.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_schedule ON agent_runs(schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;`,
  );
  // Phase 30 A3: agent_runs.trace_id 인덱스 — 동일 이유로 마이그레이션 후 보장.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_trace_id ON agent_runs(trace_id);`);
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

  // Idempotent post-migration 보정 (fresh DB 와 마이그레이션 DB 모두 적용).
  ensurePostMigrationSchema(db);

  // Phase 29 C1: vec0 차원을 부트 시 1회 읽고 캐시 (provider mismatch silent corruption 방지).
  const vectorDimension = readVectorDimension(db);

  let closed = false;

  return {
    db,
    path,
    schemaVersion: SCHEMA_VERSION,
    vectorDimension,
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
