# Phase 28 — 실행 가능한 TODO

> 본 문서는 [plan.md](./plan.md) 를 그대로 코드로 옮기기 위한 외과적 작업 지시서다. 위에서 아래로 순서대로 실행하면 plan.md 의 완료 조건이 만족된다. 각 밀스톤 끝에 검증 명령이 있으며, 실패 시 다음 밀스톤으로 진행하지 말 것.

브랜치: `feature/automation`
작업 디렉토리: `/mnt/c/Users/박/Desktop/hi/FinClaw`
시작 SHA: `caa318b` (caa318b Merge pull request #49 from Nyam2C/chore/phase26-followup)

## 사전 준비

```sh
git status                              # clean working tree
git branch --show-current               # feature/automation
git rev-parse HEAD                      # 시작 커밋 SHA 기록
```

본 Phase 는 v5 → v6 마이그레이션을 포함한다. 진행 전 dev DB 백업:

```sh
DEV_DB="${HOME}/.finclaw/db.sqlite"
[ -f "$DEV_DB" ] && cp "$DEV_DB" "${DEV_DB}.pre-phase28.bak" && echo "backed up to ${DEV_DB}.pre-phase28.bak"
```

---

## 밀스톤 A — schedules 테이블 + storage CRUD

### A1. CREATE `packages/types/src/automation.ts`

```ts
// packages/types/src/automation.ts
// Phase 28: 시간 기반 능동 트리거 (scheduled agent runs).

import type { AgentId, Timestamp } from './common.js';

/** 송출 채널: discord DM 또는 web WebSocket. 둘 중 하나만 (단순함). */
export type DeliveryChannel = 'discord' | 'web';

/** 운영 상태. enabled=1 + status='active' 일 때만 트리거. */
export type ScheduleStatus = 'active' | 'failing' | 'disabled';

/** schedules 테이블 1행. */
export interface Schedule {
  readonly id: string;
  readonly name: string;
  /** 5필드 cron (분 시 일 월 요일). */
  readonly cron: string;
  readonly agentId: AgentId;
  readonly prompt: string;
  readonly deliveryChannel: DeliveryChannel;
  /** discord: user_id 또는 channel_id, web: subscription_id (현재 'broadcast'). */
  readonly deliveryTarget: string;
  readonly enabled: boolean;
  /** 실행별 timeout (ms). 미설정 시 기본 60_000. */
  readonly timeoutMs?: number;
  /** 운영 상태. 연속 실패 시 자동 'failing' → 임계 도달 시 'disabled'. */
  readonly status: ScheduleStatus;
  /** 연속 실패 횟수 (성공 시 0 으로 reset). */
  readonly consecutiveFailures: number;
  readonly lastRunAt?: Timestamp;
  /** agent_runs.id (FK ON DELETE SET NULL). */
  readonly lastRunId?: string;
  /** 다음 트리거 예정 (cron 계산 결과). enabled=1 일 때만 의미. */
  readonly nextRunAt?: Timestamp;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}
```

**re-export** `packages/types/src/index.ts` 에 한 줄 추가:

```ts
export type * from './automation.js';
```

검증: `pnpm --filter @finclaw/types build`

### A2. EDIT `packages/storage/src/database.ts` — SCHEMA_VERSION=6 + 신규 테이블

`SCHEMA_VERSION = 5` 를 `6` 으로 변경.

`SCHEMA_DDL` 끝(현재 line 190 `agent_runs` 인덱스 다음)에 schedules 블록 추가:

```sql
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
  last_run_id           TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  next_run_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next ON schedules(enabled, next_run_at) WHERE enabled = 1;
```

> agent_runs 의 schedule_id 컬럼은 SCHEMA_DDL 의 agent_runs 정의와 마이그레이션 양쪽에 추가해야 한다. SCHEMA_DDL 은 fresh DB 용 (CREATE), 마이그레이션은 기존 v5 DB 용 (ALTER). v6 에서 fresh DB 가 ALTER 를 두 번 받지 않도록 주의.

SCHEMA_DDL 의 `CREATE TABLE IF NOT EXISTS agent_runs (...)` 블록에 `schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,` 컬럼을 `error TEXT,` 위에 추가. 인덱스도 추가:

```sql
CREATE INDEX IF NOT EXISTS idx_agent_runs_schedule ON agent_runs(schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;
```

`MIGRATIONS` 객체에 `6:` 키 추가:

```ts
6: `
    -- 1) schedules 테이블 신설.
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
      last_run_id           TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
      next_run_at           INTEGER,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled_next ON schedules(enabled, next_run_at) WHERE enabled = 1;

    -- 2) agent_runs 에 schedule_id 컬럼 추가 (FK ON DELETE SET NULL).
    --    sqlite ALTER TABLE 는 inline FK 를 지원한다.
    ALTER TABLE agent_runs ADD COLUMN schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_agent_runs_schedule ON agent_runs(schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;
  `,
```

검증:

```sh
pnpm --filter @finclaw/storage build
node -e "
import('./packages/storage/dist/database.js').then(async (m) => {
  const fs = require('fs'); const path = require('path');
  const tmp = path.join(require('os').tmpdir(), 'phase28-' + Date.now() + '.sqlite');
  const db = m.openDatabase({ path: tmp, enableWAL: false });
  if (db.schemaVersion !== 6) throw new Error('expected v6, got ' + db.schemaVersion);
  // schedules 테이블 존재
  const cols = db.db.prepare(\"PRAGMA table_info('schedules')\").all();
  const required = ['id','name','cron','agent_id','prompt','delivery_channel','delivery_target','enabled','timeout_ms','status','consecutive_failures','last_run_at','last_run_id','next_run_at','created_at','updated_at'];
  for (const c of required) {
    if (!cols.find(x => x.name === c)) throw new Error('missing column: ' + c);
  }
  // agent_runs.schedule_id 존재
  const arCols = db.db.prepare(\"PRAGMA table_info('agent_runs')\").all();
  if (!arCols.find(x => x.name === 'schedule_id')) throw new Error('agent_runs.schedule_id missing');
  db.close(); fs.unlinkSync(tmp);
  console.log('OK fresh v6 schema');
});
"
```

### A3. CREATE `packages/storage/src/schedules.ts` — CRUD

```ts
// packages/storage/src/schedules.ts
// Phase 28 A: schedules CRUD.

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentId, DeliveryChannel, Schedule, ScheduleStatus, Timestamp } from '@finclaw/types';

// ─── Row 타입 ───

interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  agent_id: string;
  prompt: string;
  delivery_channel: string;
  delivery_target: string;
  enabled: number;
  timeout_ms: number | null;
  status: string;
  consecutive_failures: number;
  last_run_at: number | null;
  last_run_id: string | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    agentId: row.agent_id as AgentId,
    prompt: row.prompt,
    deliveryChannel: row.delivery_channel as DeliveryChannel,
    deliveryTarget: row.delivery_target,
    enabled: row.enabled === 1,
    timeoutMs: row.timeout_ms === null ? undefined : row.timeout_ms,
    status: row.status as ScheduleStatus,
    consecutiveFailures: row.consecutive_failures,
    lastRunAt: row.last_run_at === null ? undefined : (row.last_run_at as Timestamp),
    lastRunId: row.last_run_id === null ? undefined : row.last_run_id,
    nextRunAt: row.next_run_at === null ? undefined : (row.next_run_at as Timestamp),
    createdAt: row.created_at as Timestamp,
    updatedAt: row.updated_at as Timestamp,
  };
}

// ─── 입력 타입 ───

export interface AddScheduleInput {
  name: string;
  cron: string;
  agentId: AgentId;
  prompt: string;
  deliveryChannel: DeliveryChannel;
  deliveryTarget: string;
  /** 기본 true (enabled). */
  enabled?: boolean;
  timeoutMs?: number;
  /** scheduler 가 cron 으로 계산한 첫 next_run_at. */
  nextRunAt?: Timestamp;
}

export interface UpdateScheduleInput {
  name?: string;
  cron?: string;
  prompt?: string;
  deliveryChannel?: DeliveryChannel;
  deliveryTarget?: string;
  enabled?: boolean;
  timeoutMs?: number | null;
  status?: ScheduleStatus;
  consecutiveFailures?: number;
  /** cron 변경 시 호출자가 재계산해서 넘긴다. */
  nextRunAt?: Timestamp | null;
}

export interface ListSchedulesOptions {
  enabled?: boolean;
  agentId?: AgentId;
  /** default 100, max 500. */
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

// ─── CRUD ───

export function addSchedule(db: DatabaseSync, input: AddScheduleInput): Schedule {
  const id = randomUUID();
  const now = Date.now();
  const enabled = input.enabled === false ? 0 : 1;

  db.prepare(
    `INSERT INTO schedules (
      id, name, cron, agent_id, prompt, delivery_channel, delivery_target,
      enabled, timeout_ms, status, consecutive_failures,
      last_run_at, last_run_id, next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.cron,
    input.agentId as string,
    input.prompt,
    input.deliveryChannel,
    input.deliveryTarget,
    enabled,
    input.timeoutMs ?? null,
    input.nextRunAt === undefined ? null : (input.nextRunAt as number),
    now,
    now,
  );

  return getSchedule(db, id) as Schedule;
}

export function getSchedule(db: DatabaseSync, id: string): Schedule | null {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

export function listSchedules(db: DatabaseSync, options: ListSchedulesOptions = {}): Schedule[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(options.enabled ? 1 : 0);
  }
  if (options.agentId) {
    clauses.push('agent_id = ?');
    params.push(options.agentId as string);
  }
  let sql = 'SELECT * FROM schedules';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as unknown as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function updateSchedule(
  db: DatabaseSync,
  id: string,
  patch: UpdateScheduleInput,
): Schedule | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.cron !== undefined) {
    sets.push('cron = ?');
    params.push(patch.cron);
  }
  if (patch.prompt !== undefined) {
    sets.push('prompt = ?');
    params.push(patch.prompt);
  }
  if (patch.deliveryChannel !== undefined) {
    sets.push('delivery_channel = ?');
    params.push(patch.deliveryChannel);
  }
  if (patch.deliveryTarget !== undefined) {
    sets.push('delivery_target = ?');
    params.push(patch.deliveryTarget);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.timeoutMs !== undefined) {
    sets.push('timeout_ms = ?');
    params.push(patch.timeoutMs);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.consecutiveFailures !== undefined) {
    sets.push('consecutive_failures = ?');
    params.push(patch.consecutiveFailures);
  }
  if (patch.nextRunAt !== undefined) {
    sets.push('next_run_at = ?');
    params.push(patch.nextRunAt === null ? null : (patch.nextRunAt as number));
  }
  if (sets.length === 0) {
    return getSchedule(db, id);
  }
  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);
  const result = db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (result.changes === 0) {
    return null;
  }
  return getSchedule(db, id);
}

export function deleteSchedule(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  return result.changes > 0;
}

/** scheduler tick: enabled=1 AND next_run_at <= now. */
export function findDueSchedules(db: DatabaseSync, now: number): Schedule[] {
  const rows = db
    .prepare(
      `SELECT * FROM schedules
       WHERE enabled = 1
         AND status != 'disabled'
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    )
    .all(now) as unknown as ScheduleRow[];
  return rows.map(rowToSchedule);
}

/** tick 후 last_run_at/last_run_id/next_run_at 갱신. status reset 은 별도 호출자 책임. */
export function markScheduleRun(
  db: DatabaseSync,
  scheduleId: string,
  runId: string | null,
  ranAt: number,
  nextRunAt: number | null,
): void {
  db.prepare(
    `UPDATE schedules
     SET last_run_at = ?, last_run_id = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(ranAt, runId, nextRunAt, Date.now(), scheduleId);
}
```

### A4. EDIT `packages/storage/src/index.ts` — re-export

`agent-runs` re-export 블록 다음에 추가:

```ts
export {
  addSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  findDueSchedules,
  markScheduleRun,
  type AddScheduleInput,
  type UpdateScheduleInput,
  type ListSchedulesOptions,
} from './schedules.js';
```

`type Schedule` / `DeliveryChannel` / `ScheduleStatus` 는 `@finclaw/types` 의 type-only re-export 가 자동으로 노출하므로 storage 에서 따로 export 하지 않아도 된다.

### A5. CREATE `packages/storage/src/schedules.storage.test.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAgentRun,
  addSchedule,
  deleteSchedule,
  findDueSchedules,
  getSchedule,
  listSchedules,
  markScheduleRun,
  openDatabase,
  type Database,
} from '../src/index.js';
import { createAgentId } from '@finclaw/types';

describe('schedules storage', () => {
  let dbDir: string;
  let database: Database;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'phase28-schedules-'));
    database = openDatabase({ path: join(dbDir, 'db.sqlite'), enableWAL: false });
  });

  afterEach(() => {
    database.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('addSchedule + getSchedule round trip', () => {
    const created = addSchedule(database.db, {
      name: '일일 보고',
      cron: '0 12 * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: '오늘 시장 요약',
      deliveryChannel: 'discord',
      deliveryTarget: '123456',
    });
    expect(created.name).toBe('일일 보고');
    expect(created.enabled).toBe(true);
    expect(created.status).toBe('active');
    expect(created.consecutiveFailures).toBe(0);
    const fetched = getSchedule(database.db, created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it('findDueSchedules respects enabled + next_run_at + status', () => {
    const now = Date.now();
    const a = addSchedule(database.db, {
      name: 'past',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: (now - 10) as never,
    });
    addSchedule(database.db, {
      name: 'future',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: (now + 60_000) as never,
    });
    addSchedule(database.db, {
      name: 'disabled',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      enabled: false,
      nextRunAt: (now - 10) as never,
    });
    const due = findDueSchedules(database.db, now);
    expect(due.map((s) => s.id)).toEqual([a.id]);
  });

  it('markScheduleRun updates last_run_id/next_run_at', () => {
    const s = addSchedule(database.db, {
      name: 's',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      nextRunAt: Date.now() as never,
    });
    const run = addAgentRun(database.db, {
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      output: 'ok',
    });
    markScheduleRun(database.db, s.id, run.id, Date.now(), Date.now() + 60_000);
    const reread = getSchedule(database.db, s.id);
    expect(reread?.lastRunId).toBe(run.id);
    expect(reread?.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('deleteSchedule sets agent_runs.schedule_id to NULL', () => {
    const s = addSchedule(database.db, {
      name: 's',
      cron: '* * * * *',
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    const run = addAgentRun(database.db, {
      agentId: createAgentId('finclaw-partner'),
      prompt: 'p',
      output: 'ok',
    });
    database.db.prepare('UPDATE agent_runs SET schedule_id = ? WHERE id = ?').run(s.id, run.id);
    expect(deleteSchedule(database.db, s.id)).toBe(true);
    const row = database.db
      .prepare('SELECT schedule_id FROM agent_runs WHERE id = ?')
      .get(run.id) as { schedule_id: string | null };
    expect(row.schedule_id).toBeNull();
  });

  it('listSchedules filters by enabled + agentId', () => {
    const ag = createAgentId('finclaw-partner');
    addSchedule(database.db, {
      name: 'a',
      cron: '* * * * *',
      agentId: ag,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
    });
    addSchedule(database.db, {
      name: 'b',
      cron: '* * * * *',
      agentId: ag,
      prompt: 'p',
      deliveryChannel: 'web',
      deliveryTarget: 'broadcast',
      enabled: false,
    });
    expect(listSchedules(database.db).length).toBe(2);
    expect(listSchedules(database.db, { enabled: true }).length).toBe(1);
    expect(listSchedules(database.db, { enabled: false }).length).toBe(1);
  });
});
```

### A6. 마이그레이션 시뮬레이션 테스트

`packages/storage/src/database.test.ts` 가 이미 v3→v4, v4→v5 회귀 테스트를 포함하면 v5→v6 도 같은 패턴으로 추가. 없으면 신규 테스트:

CREATE `packages/storage/src/database.migration.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { openDatabase } from '../src/database.js';

describe('schema migration v5 → v6', () => {
  it('preserves agent_runs and adds schedules + schedule_id column', () => {
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

      // 2) openDatabase 가 v6 으로 마이그레이션
      const upgraded = openDatabase({ path, enableWAL: false });
      try {
        expect(upgraded.schemaVersion).toBe(6);
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
        // schedule_id 컬럼 존재
        const cols = upgraded.db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{
          name: string;
        }>;
        expect(cols.find((c) => c.name === 'schedule_id')).toBeTruthy();
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

### A7. 밀스톤 A 검증

```sh
pnpm --filter @finclaw/types build
pnpm --filter @finclaw/storage build
pnpm --filter @finclaw/storage test -- schedules.storage database.migration
pnpm typecheck
```

기대: 신규 테스트 5+ 통과. typecheck 0 errors.

---

## 밀스톤 B — cron 파서 + SchedulerService

### B1. CREATE `packages/server/src/automation/cron.ts`

순수 함수 5필드 cron 파서. 한 필드당 정렬된 number[] 로 expand. 다음 매칭 시각 계산은 분 단위 brute-force (최대 8년 = 4_204_800 분, 실용상 1년 내 매칭 보장).

```ts
// packages/server/src/automation/cron.ts
// Phase 28 B: 5필드 cron (분 시 일 월 요일).
// 지원: '*', '*/N', 'M-N', 'M,N,O' 단순 조합. 한 필드당 number[].
// 비지원: 'L'(last day), 'W'(weekday), '?'.

export interface CronExpression {
  /** 0-59 */
  readonly minute: readonly number[];
  /** 0-23 */
  readonly hour: readonly number[];
  /** 1-31 */
  readonly dayOfMonth: readonly number[];
  /** 1-12 */
  readonly month: readonly number[];
  /** 0-6 (0=일) */
  readonly dayOfWeek: readonly number[];
}

export class CronParseError extends Error {
  constructor(
    message: string,
    public readonly expr: string,
    public readonly field: string,
  ) {
    super(`cron parse error in ${field}: ${message} (expr='${expr}')`);
    this.name = 'CronParseError';
  }
}

interface FieldRange {
  readonly min: number;
  readonly max: number;
}

const FIELD_RANGES = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 },
} as const;

function expandField(token: string, range: FieldRange, expr: string, field: string): number[] {
  const out = new Set<number>();
  for (const part of token.split(',')) {
    if (part === '*') {
      for (let i = range.min; i <= range.max; i++) out.add(i);
      continue;
    }
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) {
        throw new CronParseError(`invalid step: ${stepStr}`, expr, field);
      }
      let lo = range.min;
      let hi = range.max;
      if (base !== '*') {
        const r = base.split('-');
        lo = Number(r[0]);
        hi = r[1] !== undefined ? Number(r[1]) : range.max;
      }
      for (let i = lo; i <= hi; i += step) out.add(i);
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      if (lo > hi) throw new CronParseError(`reversed range: ${part}`, expr, field);
      for (let i = lo; i <= hi; i++) out.add(i);
      continue;
    }
    if (/^\d+$/.test(part)) {
      out.add(Number(part));
      continue;
    }
    throw new CronParseError(`unrecognized token: ${part}`, expr, field);
  }
  const arr = [...out].sort((a, b) => a - b);
  for (const v of arr) {
    if (v < range.min || v > range.max) {
      throw new CronParseError(`value ${v} out of range [${range.min}, ${range.max}]`, expr, field);
    }
  }
  if (arr.length === 0) {
    throw new CronParseError('empty field', expr, field);
  }
  return arr;
}

export function parseCron(expr: string): CronExpression {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new CronParseError(`expected 5 fields, got ${tokens.length}`, expr, 'all');
  }
  return {
    minute: expandField(tokens[0], FIELD_RANGES.minute, expr, 'minute'),
    hour: expandField(tokens[1], FIELD_RANGES.hour, expr, 'hour'),
    dayOfMonth: expandField(tokens[2], FIELD_RANGES.dayOfMonth, expr, 'dayOfMonth'),
    month: expandField(tokens[3], FIELD_RANGES.month, expr, 'month'),
    dayOfWeek: expandField(tokens[4], FIELD_RANGES.dayOfWeek, expr, 'dayOfWeek'),
  };
}

/** 주어진 시각이 cron 에 매칭되는지 검사. 초/밀리초 무시 (분 단위). */
export function matches(cron: CronExpression, dateMs: number): boolean {
  const d = new Date(dateMs);
  if (!cron.minute.includes(d.getMinutes())) return false;
  if (!cron.hour.includes(d.getHours())) return false;
  if (!cron.month.includes(d.getMonth() + 1)) return false;
  // POSIX cron: dayOfMonth 와 dayOfWeek 모두 비-기본(*아님)인 경우 OR. 둘 중 하나만 비기본이면 그것만.
  const dom = cron.dayOfMonth;
  const dow = cron.dayOfWeek;
  const domAll = dom.length === 31;
  const dowAll = dow.length === 7;
  if (domAll && dowAll) return true;
  if (!domAll && !dowAll) {
    return dom.includes(d.getDate()) || dow.includes(d.getDay());
  }
  if (!domAll) return dom.includes(d.getDate());
  return dow.includes(d.getDay());
}

/** fromMs 보다 엄격히 큰(>) 다음 매칭 시각. 1년 내 매칭 못 찾으면 null (실용상 미발생). */
export function nextRunAt(cron: CronExpression, fromMs: number): number | null {
  // 분 경계로 올림 후 +1분.
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = start.getTime() + 366 * 24 * 60 * 60 * 1000;
  let cursor = start.getTime();
  while (cursor < limit) {
    if (matches(cron, cursor)) return cursor;
    cursor += 60_000;
  }
  return null;
}
```

### B2. CREATE `packages/server/src/automation/cron.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { CronParseError, matches, nextRunAt, parseCron } from './cron.js';

describe('parseCron', () => {
  it('expands * to full range', () => {
    expect(parseCron('* * * * *').minute.length).toBe(60);
    expect(parseCron('* * * * *').hour.length).toBe(24);
    expect(parseCron('* * * * *').dayOfMonth).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(parseCron('* * * * *').dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('handles step', () => {
    expect(parseCron('*/5 * * * *').minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(parseCron('*/15 * * * *').minute).toEqual([0, 15, 30, 45]);
  });

  it('handles range', () => {
    expect(parseCron('0 9-17 * * *').hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('handles list', () => {
    expect(parseCron('0,15,30,45 * * * *').minute).toEqual([0, 15, 30, 45]);
  });

  it('rejects out-of-range', () => {
    expect(() => parseCron('60 * * * *')).toThrow(CronParseError);
    expect(() => parseCron('* 24 * * *')).toThrow(CronParseError);
  });

  it('rejects bad shape', () => {
    expect(() => parseCron('* * * *')).toThrow(/expected 5 fields/);
    expect(() => parseCron('xyz * * * *')).toThrow(CronParseError);
  });
});

describe('matches', () => {
  it('every minute matches', () => {
    const cron = parseCron('* * * * *');
    expect(matches(cron, new Date('2026-05-03T10:00:00').getTime())).toBe(true);
    expect(matches(cron, new Date('2026-05-03T10:00:30').getTime())).toBe(true);
  });

  it('hourly on minute 0', () => {
    const cron = parseCron('0 * * * *');
    expect(matches(cron, new Date('2026-05-03T10:00:00').getTime())).toBe(true);
    expect(matches(cron, new Date('2026-05-03T10:01:00').getTime())).toBe(false);
  });

  it('daily 12:00', () => {
    const cron = parseCron('0 12 * * *');
    expect(matches(cron, new Date('2026-05-03T12:00:00').getTime())).toBe(true);
    expect(matches(cron, new Date('2026-05-03T13:00:00').getTime())).toBe(false);
  });

  it('weekly mon 9:00', () => {
    const cron = parseCron('0 9 * * 1');
    // 2026-05-04 is Monday
    expect(matches(cron, new Date('2026-05-04T09:00:00').getTime())).toBe(true);
    expect(matches(cron, new Date('2026-05-03T09:00:00').getTime())).toBe(false);
  });
});

describe('nextRunAt', () => {
  it('next minute for * * * * *', () => {
    const cron = parseCron('* * * * *');
    const from = new Date('2026-05-03T10:00:30').getTime();
    const next = nextRunAt(cron, from);
    expect(next).toBe(new Date('2026-05-03T10:01:00').getTime());
  });

  it('next 5-step', () => {
    const cron = parseCron('*/5 * * * *');
    const from = new Date('2026-05-03T10:01:00').getTime();
    expect(nextRunAt(cron, from)).toBe(new Date('2026-05-03T10:05:00').getTime());
  });

  it('next daily 12:00 from after 12', () => {
    const cron = parseCron('0 12 * * *');
    const from = new Date('2026-05-03T13:00:00').getTime();
    expect(nextRunAt(cron, from)).toBe(new Date('2026-05-04T12:00:00').getTime());
  });

  it('always strictly after fromMs', () => {
    const cron = parseCron('* * * * *');
    const from = new Date('2026-05-03T10:00:00').getTime();
    expect(nextRunAt(cron, from)).toBe(new Date('2026-05-03T10:01:00').getTime());
  });
});
```

### B3. CREATE `packages/server/src/automation/scheduler.ts`

`SchedulerService` 1분 폴러 + agent.run 직접 호출. delivery 는 밀스톤 C 에서 hook 으로 추가하므로 본 단계에선 onRunComplete callback 으로 노출.

```ts
// packages/server/src/automation/scheduler.ts
// Phase 28 B: 매 분 0초 폴러 → due schedules → agent.run 실행 → agent_runs 영속화.
// delivery 호출은 onRunComplete 콜백으로 외부 주입 (밀스톤 C).

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AliasIndex, ModelCatalog, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import {
  DEFAULT_FALLBACK_TRIGGERS,
  ModelFloorExhaustedError,
  resolveModel,
  runWithModelFallback,
} from '@finclaw/agent';
import type { ConcurrencyLane, FinClawLogger } from '@finclaw/infra';
import {
  addAgentRun,
  findDueSchedules,
  getSchedule,
  markScheduleRun,
  updateSchedule,
} from '@finclaw/storage';
import type {
  AgentRunParams,
  ConversationMessage,
  ModelRef,
  Schedule,
  SessionKey,
} from '@finclaw/types';
import { createAgentId, createSessionKey } from '@finclaw/types';
import {
  collectToolCalls,
  extractAssistantText,
  type RunnerFactory,
} from '../auto-reply/execution-adapter.js';
import type { RouterHelper } from '../auto-reply/router-helper.js';
import { buildDispatcher } from '../auto-reply/tool-dispatcher-adapter.js';
import { nextRunAt as computeNextRunAt, parseCron } from './cron.js';

export interface SchedulerCallbacks {
  /**
   * agent.run 완료 직후 호출 (성공/실패 모두). delivery 모듈에서 이 시점에 송출.
   * 본 함수가 throw 해도 scheduler 는 계속 동작 (best-effort).
   */
  onRunComplete?(args: {
    schedule: Schedule;
    agentRunId: string | null;
    output: string;
    error?: string;
  }): Promise<void>;
}

export interface SchedulerDeps extends SchedulerCallbacks {
  readonly db: DatabaseSync;
  readonly toolRegistry: ToolRegistry;
  readonly runnerFactory: RunnerFactory;
  /** schedule 동시 실행 1개로 제한하는 lane. main.ts 에서 maxConcurrent:1 로 주입. */
  readonly lane: ConcurrencyLane;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly logger: FinClawLogger;
  readonly profileHealth: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly router?: RouterHelper;
  readonly modelCatalog?: ModelCatalog;
  readonly modelAliasIndex?: AliasIndex;
  readonly fallbackChain?: readonly string[];
  /** 연속 실패 임계 (3 = AUTOMATION_MAX_CONSECUTIVE_FAILURES). 기본 3. */
  readonly maxConsecutiveFailures?: number;
  /** 기본 timeout (ms). schedule.timeoutMs 가 우선. 기본 60_000. */
  readonly defaultTimeoutMs?: number;
}

const POLL_INTERVAL_MS = 60_000;

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = new Set<string>();
  private stopping = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** 1분 폴러 시작. 다음 분 경계까지 대기 후 첫 tick. */
  start(): void {
    if (this.timer) return;
    const now = Date.now();
    const nextMinute = Math.ceil(now / POLL_INTERVAL_MS) * POLL_INTERVAL_MS;
    const firstDelay = nextMinute - now;
    setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    }, firstDelay);
    this.deps.logger.info('scheduler.started', {
      event: 'scheduler.started',
      firstTickInMs: firstDelay,
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 현재 진행 중 run 들 완료 대기 — 60초 강제 timeout.
    const deadline = Date.now() + 60_000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.deps.logger.info('scheduler.stopped', {
      event: 'scheduler.stopped',
      forcedExit: this.active.size > 0,
      remaining: this.active.size,
    });
  }

  /** UI 의 schedule.runNow RPC 가 호출. lane 통과 + agent.run 즉시 실행. */
  async triggerNow(scheduleId: string): Promise<{ runId: string | null }> {
    const s = getSchedule(this.deps.db, scheduleId);
    if (!s) {
      throw new Error(`not_found: schedule ${scheduleId}`);
    }
    return this.runOne(s, { manual: true });
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const now = Date.now();
    let due: Schedule[];
    try {
      due = findDueSchedules(this.deps.db, now);
    } catch (err) {
      this.deps.logger.warn('scheduler.tick_failed', {
        event: 'scheduler.tick_failed',
        error: (err as Error).message,
      });
      return;
    }
    for (const s of due) {
      // 이미 진행 중인 schedule 은 lane 으로 직렬화되지만, 같은 schedule 이 다음 tick 까지 안 끝났으면 skip.
      if (this.active.has(s.id)) {
        this.deps.logger.info('scheduler.tick_skipped_active', {
          event: 'scheduler.tick_skipped_active',
          scheduleId: s.id,
          name: s.name,
        });
        // next_run_at 만 한 칸 미루기 — cron 매칭 다음 분 사용.
        try {
          const cron = parseCron(s.cron);
          const next = computeNextRunAt(cron, now);
          markScheduleRun(this.deps.db, s.id, s.lastRunId ?? null, s.lastRunAt ?? now, next);
        } catch {
          /* swallow */
        }
        continue;
      }
      void this.runOne(s, { manual: false });
    }
  }

  private async runOne(s: Schedule, opts: { manual: boolean }): Promise<{ runId: string | null }> {
    if (this.active.has(s.id)) {
      return { runId: null };
    }
    this.active.add(s.id);
    const handle = await this.deps.lane.acquire(s.id);
    const startedAt = Date.now();
    let runId: string | null = null;
    let output = '';
    let error: string | undefined;
    try {
      const sessionKey = createSessionKey(`schedule-${s.id}-${randomUUID()}`);
      const agentIdBrand = createAgentId(s.agentId as string);
      const { dispatcher, toolDefinitions } = buildDispatcher(this.deps.toolRegistry, {
        sessionId: sessionKey as string,
        userId: 'scheduler',
        channelId: 'scheduler',
      });
      const runner = this.deps.runnerFactory(dispatcher);
      const userMsg: ConversationMessage = { role: 'user', content: s.prompt };
      const abortController = new AbortController();
      const timeoutMs = s.timeoutMs ?? this.deps.defaultTimeoutMs ?? 60_000;
      const timer = setTimeout(() => abortController.abort(), timeoutMs);

      const role: 'analysis' = 'analysis';
      const decision = this.deps.router
        ? this.deps.router({ role, toolNames: toolDefinitions.map((t) => t.name) })
        : undefined;
      const exposedTools = decision
        ? toolDefinitions.filter((t) => decision.allowedToolNames.includes(t.name))
        : toolDefinitions;
      const buildParams = (model: ModelRef): AgentRunParams => ({
        agentId: agentIdBrand,
        sessionKey,
        model,
        systemPrompt: this.deps.systemPrompt,
        messages: [userMsg],
        tools: exposedTools.length > 0 ? [...exposedTools] : undefined,
        abortSignal: abortController.signal,
      });

      let usedModelId: string | undefined;
      try {
        let result;
        if (decision && this.deps.modelCatalog && this.deps.modelAliasIndex) {
          const others = (this.deps.fallbackChain ?? []).filter((m) => m !== decision.modelId);
          const chain = [decision.modelId, ...others];
          const fallback = await runWithModelFallback(
            {
              models: chain.map((raw) => ({ raw })),
              maxRetriesPerModel: 1,
              retryBaseDelayMs: 500,
              fallbackOn: DEFAULT_FALLBACK_TRIGGERS,
              abortSignal: abortController.signal,
              floor: decision.decision.floor,
            },
            async (resolved) =>
              runner.execute(
                buildParams({
                  ...this.deps.defaultModel,
                  provider: resolved.provider,
                  model: resolved.modelId,
                  contextWindow: resolved.entry.contextWindow,
                  maxOutputTokens: Math.min(
                    resolved.entry.maxOutputTokens,
                    this.deps.defaultModel.maxOutputTokens,
                  ),
                }),
              ),
            (ref) => resolveModel(ref, this.deps.modelCatalog!, this.deps.modelAliasIndex!),
          );
          result = fallback.result;
          usedModelId = fallback.modelUsed.modelId;
        } else {
          const modelRef: ModelRef = decision
            ? { ...this.deps.defaultModel, model: decision.modelId }
            : this.deps.defaultModel;
          result = await runner.execute(buildParams(modelRef));
        }
        output = extractAssistantText(result.messages);
        const toolCalls = collectToolCalls(result.messages, startedAt);
        const durationMs = Date.now() - startedAt;
        const inserted = addAgentRun(this.deps.db, {
          agentId: agentIdBrand,
          prompt: s.prompt,
          output,
          toolCalls: JSON.stringify(toolCalls),
          tokensInput: result.usage.inputTokens,
          tokensOutput: result.usage.outputTokens,
          durationMs,
          modelUsed: usedModelId ?? this.deps.defaultModel.model,
          role,
        });
        runId = inserted.id;
        // schedule_id 링크.
        this.deps.db.prepare('UPDATE agent_runs SET schedule_id = ? WHERE id = ?').run(s.id, runId);
        this.deps.profileHealth.recordResult(this.deps.profileId ?? 'default', true);
      } catch (runErr) {
        clearTimeout(timer);
        if (runErr instanceof ModelFloorExhaustedError) {
          error = `model_floor_exhausted: ${runErr.floor}`;
        } else {
          error = (runErr as Error).message;
        }
        const durationMs = Date.now() - startedAt;
        const inserted = addAgentRun(this.deps.db, {
          agentId: agentIdBrand,
          prompt: s.prompt,
          output: '',
          durationMs,
          modelUsed: this.deps.defaultModel.model,
          role,
          error,
        });
        runId = inserted.id;
        this.deps.db.prepare('UPDATE agent_runs SET schedule_id = ? WHERE id = ?').run(s.id, runId);
        this.deps.profileHealth.recordResult(this.deps.profileId ?? 'default', false);
      } finally {
        clearTimeout(timer);
      }

      // schedule.last_run + next_run_at 갱신.
      let nextMs: number | null = null;
      try {
        const cron = parseCron(s.cron);
        nextMs = computeNextRunAt(cron, Date.now());
      } catch (cronErr) {
        this.deps.logger.warn('scheduler.cron_invalid', {
          event: 'scheduler.cron_invalid',
          scheduleId: s.id,
          cron: s.cron,
          error: (cronErr as Error).message,
        });
      }
      markScheduleRun(this.deps.db, s.id, runId, Date.now(), nextMs);

      // 연속 실패 추적 + auto-disable.
      const max = this.deps.maxConsecutiveFailures ?? 3;
      const fresh = getSchedule(this.deps.db, s.id);
      if (!fresh) {
        // 레이스: 삭제된 schedule 은 갱신만 skip 후 종료.
      } else if (error) {
        const failures = fresh.consecutiveFailures + 1;
        const next: Parameters<typeof updateSchedule>[2] = {
          consecutiveFailures: failures,
          status: failures >= max ? 'disabled' : 'failing',
        };
        if (failures >= max) {
          next.enabled = false;
        }
        updateSchedule(this.deps.db, s.id, next);
      } else if (fresh.consecutiveFailures > 0 || fresh.status !== 'active') {
        updateSchedule(this.deps.db, s.id, {
          consecutiveFailures: 0,
          status: 'active',
        });
      }

      this.deps.logger.info(error ? 'schedule.failed' : 'schedule.triggered', {
        event: error ? 'schedule.failed' : 'schedule.triggered',
        scheduleId: s.id,
        name: s.name,
        agentRunId: runId,
        durationMs: Date.now() - startedAt,
        manual: opts.manual,
        error,
      });

      if (this.deps.onRunComplete) {
        try {
          await this.deps.onRunComplete({
            schedule: fresh ?? s,
            agentRunId: runId,
            output,
            error,
          });
        } catch (deliveryErr) {
          this.deps.logger.warn('schedule.delivery_failed', {
            event: 'schedule.delivery_failed',
            scheduleId: s.id,
            error: (deliveryErr as Error).message,
          });
        }
      }
      return { runId };
    } finally {
      handle.release();
      this.active.delete(s.id);
    }
  }
}
```

### B4. EDIT `packages/server/src/main.ts` — Scheduler 인스턴스화

import 추가:

```ts
import { SchedulerService } from './automation/scheduler.js';
```

기존 `agentRunLane` 선언 (현 line 385) 다음에 `scheduleLane` 추가하고, gateway 생성 직전 또는 직후 (앞쪽이 자연스럽다) Scheduler 생성:

```ts
const scheduleLane = new ConcurrencyLane({
  maxConcurrent: 1,
  maxQueueSize: 50,
  waitTimeoutMs: 5 * 60_000,
});
const scheduler = new SchedulerService({
  db: storage.db,
  toolRegistry,
  runnerFactory,
  lane: scheduleLane,
  defaultModel: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  logger,
  profileHealth,
  profileId: 'default',
  router: routerHelper,
  modelCatalog,
  modelAliasIndex,
  fallbackChain: DEFAULT_FALLBACK_CHAIN,
  // delivery 는 밀스톤 C 에서 hook 으로 주입.
});
lifecycle.register(() => scheduler.stop());
```

`gateway.start()` 직후 `scheduler.start()` 호출:

```ts
await gateway.start();
scheduler.start();
logger.info(`Gateway listening on ${gatewayConfig.host}:${gatewayConfig.port}`);
```

### B5. 밀스톤 B 검증

```sh
pnpm --filter @finclaw/server build
pnpm --filter @finclaw/server test -- automation/cron
```

기대: cron parser 단위 테스트 통과.

스모크 (수동, 선택): server 기동 → 1분 후 로그에 `scheduler.started` 출력 + 첫 tick 로그.

---

## 밀스톤 C — RPC + 결과 송출

### C1. EDIT `packages/types/src/gateway.ts` — RpcMethod union 확장

`agent.runs.get` 다음에 schedule.\* 추가:

```ts
  | 'schedule.create'
  | 'schedule.list'
  | 'schedule.update'
  | 'schedule.delete'
  | 'schedule.runNow'
  | 'schedule.history'
  | 'schedule.disable'
  | 'schedule.enable'
  | 'schedule.testCron'
```

### C2. CREATE `packages/server/src/automation/delivery.ts`

```ts
// packages/server/src/automation/delivery.ts
// Phase 28 C: schedule 결과 송출 (Discord DM 또는 Web WebSocket).
// 송출 실패 → warn 로그 + agent_runs 보존 (재시도 X — 단순함).

import type { Client } from 'discord.js';
import type { FinClawLogger } from '@finclaw/infra';
import type { Schedule } from '@finclaw/types';
import type { GatewayBroadcaster } from '../gateway/broadcaster.js';
import type { WsConnection } from '../gateway/rpc/types.js';

export interface DeliveryDeps {
  /** Discord 클라이언트 — discord 채널 송출 시 필요. */
  readonly discordClient?: Client;
  /** WebSocket broadcaster — web 채널 송출 시 필요. */
  readonly broadcaster?: GatewayBroadcaster;
  readonly connections?: Map<string, WsConnection>;
  readonly logger: FinClawLogger;
}

const DISCORD_MAX_LEN = 2000;

function formatDiscord(
  schedule: Schedule,
  output: string,
  error?: string,
  runId?: string | null,
): string {
  const ts = new Date().toLocaleString('ko-KR');
  const head = `**[${schedule.name}]**`;
  const body = error ? `_⚠️ 실행 실패: ${error}_` : output.length === 0 ? '_(빈 응답)_' : output;
  const footer = `_${ts} 자동 실행${runId ? ` · #${runId.slice(0, 8)}` : ''}_`;
  let composed = `${head}\n\n${body}\n\n${footer}`;
  if (composed.length > DISCORD_MAX_LEN) {
    const overflow = composed.length - DISCORD_MAX_LEN + 64;
    const truncated = body.slice(0, Math.max(0, body.length - overflow)) + '\n…(잘림)';
    composed = `${head}\n\n${truncated}\n\n${footer}`;
  }
  return composed;
}

export async function deliverScheduleResult(
  deps: DeliveryDeps,
  args: { schedule: Schedule; output: string; error?: string; agentRunId: string | null },
): Promise<void> {
  const { schedule, output, error, agentRunId } = args;
  if (schedule.deliveryChannel === 'discord') {
    if (!deps.discordClient) {
      deps.logger.warn('schedule.delivery.discord_unavailable', {
        event: 'schedule.delivery.discord_unavailable',
        scheduleId: schedule.id,
      });
      return;
    }
    try {
      const user = await deps.discordClient.users.fetch(schedule.deliveryTarget);
      await user.send(formatDiscord(schedule, output, error, agentRunId));
      deps.logger.info('schedule.delivered', {
        event: 'schedule.delivered',
        scheduleId: schedule.id,
        channel: 'discord',
      });
    } catch (sendErr) {
      deps.logger.warn('schedule.delivery.discord_failed', {
        event: 'schedule.delivery.discord_failed',
        scheduleId: schedule.id,
        error: (sendErr as Error).message,
      });
    }
    return;
  }
  // web
  if (!deps.broadcaster || !deps.connections) {
    deps.logger.warn('schedule.delivery.web_unavailable', {
      event: 'schedule.delivery.web_unavailable',
      scheduleId: schedule.id,
    });
    return;
  }
  deps.broadcaster.broadcastToChannel(deps.connections, 'schedule.completed', {
    scheduleId: schedule.id,
    name: schedule.name,
    runId: agentRunId,
    output,
    error,
    completedAt: Date.now(),
  });
  deps.logger.info('schedule.delivered', {
    event: 'schedule.delivered',
    scheduleId: schedule.id,
    channel: 'web',
  });
}
```

### C3. CREATE `packages/server/src/gateway/rpc/methods/schedule.ts`

```ts
// packages/server/src/gateway/rpc/methods/schedule.ts
// Phase 28 C: schedule.* RPC.

import type { DatabaseSync } from 'node:sqlite';
import {
  addSchedule,
  deleteSchedule,
  getSchedule,
  listAgentRuns,
  listSchedules,
  updateSchedule,
} from '@finclaw/storage';
import { createAgentId, type AgentId } from '@finclaw/types';
import { z } from 'zod/v4';
import type { SchedulerService } from '../../../automation/scheduler.js';
import {
  CronParseError,
  nextRunAt as computeNextRunAt,
  parseCron,
} from '../../../automation/cron.js';
import { registerMethod } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

export interface ScheduleRpcDeps {
  readonly db?: DatabaseSync;
  readonly scheduler?: SchedulerService;
}

const MAX_LIMIT = 200;
const MAX_TEST_SAMPLES = 20;

const cronField = z.string().min(1).max(120);
const promptField = z.string().min(1).max(2000);
const nameField = z.string().min(1).max(120);

function requireDb(deps: ScheduleRpcDeps): DatabaseSync {
  if (!deps.db) {
    throw new Error('provider_unavailable: storage db not initialized');
  }
  return deps.db;
}

function requireScheduler(deps: ScheduleRpcDeps): SchedulerService {
  if (!deps.scheduler) {
    throw new Error('provider_unavailable: scheduler not initialized');
  }
  return deps.scheduler;
}

function toResponseSchedule(s: ReturnType<typeof getSchedule>): unknown {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    cron: s.cron,
    agentId: s.agentId,
    prompt: s.prompt,
    deliveryChannel: s.deliveryChannel,
    deliveryTarget: s.deliveryTarget,
    enabled: s.enabled,
    timeoutMs: s.timeoutMs,
    status: s.status,
    consecutiveFailures: s.consecutiveFailures,
    lastRunAt: s.lastRunAt,
    lastRunId: s.lastRunId,
    nextRunAt: s.nextRunAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export function registerScheduleMethods(deps: ScheduleRpcDeps): void {
  // schedule.create
  registerMethod({
    method: 'schedule.create',
    description: '시간 기반 자동 트리거를 등록합니다',
    authLevel: 'token',
    schema: z.object({
      name: nameField,
      cron: cronField,
      agentId: z.string().min(1),
      prompt: promptField,
      deliveryChannel: z.enum(['discord', 'web']),
      deliveryTarget: z.string().min(1).max(120),
      timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
      enabled: z.boolean().optional(),
    }),
    async execute(params) {
      const db = requireDb(deps);
      try {
        const cron = parseCron(params.cron);
        const next = computeNextRunAt(cron, Date.now());
        const created = addSchedule(db, {
          name: params.name,
          cron: params.cron,
          agentId: createAgentId(params.agentId),
          prompt: params.prompt,
          deliveryChannel: params.deliveryChannel,
          deliveryTarget: params.deliveryTarget,
          enabled: params.enabled,
          timeoutMs: params.timeoutMs,
          nextRunAt: next === null ? undefined : (next as never),
        });
        return { scheduleId: created.id, nextRunAt: created.nextRunAt ?? null };
      } catch (err) {
        if (err instanceof CronParseError) {
          throw new Error(`invalid_params: ${err.message}`);
        }
        throw err;
      }
    },
  } satisfies RpcMethodHandler<
    {
      name: string;
      cron: string;
      agentId: string;
      prompt: string;
      deliveryChannel: 'discord' | 'web';
      deliveryTarget: string;
      timeoutMs?: number;
      enabled?: boolean;
    },
    unknown
  >);

  // schedule.list
  registerMethod({
    method: 'schedule.list',
    description: '등록된 자동화 schedule 목록을 조회합니다',
    authLevel: 'token',
    schema: z.object({
      enabled: z.boolean().optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
    async execute(params) {
      const db = requireDb(deps);
      const items = listSchedules(db, { enabled: params.enabled, limit: params.limit });
      return { schedules: items.map(toResponseSchedule) };
    },
  } satisfies RpcMethodHandler<{ enabled?: boolean; limit?: number }, unknown>);

  // schedule.update
  registerMethod({
    method: 'schedule.update',
    description: 'schedule 의 일부 필드를 갱신합니다 (cron 변경 시 next_run_at 재계산)',
    authLevel: 'token',
    schema: z.object({
      scheduleId: z.string().min(1),
      name: nameField.optional(),
      cron: cronField.optional(),
      prompt: promptField.optional(),
      deliveryChannel: z.enum(['discord', 'web']).optional(),
      deliveryTarget: z.string().min(1).max(120).optional(),
      enabled: z.boolean().optional(),
      timeoutMs: z.number().int().min(1_000).max(300_000).nullable().optional(),
    }),
    async execute(params) {
      const db = requireDb(deps);
      const patch: Parameters<typeof updateSchedule>[2] = {};
      if (params.name !== undefined) patch.name = params.name;
      if (params.prompt !== undefined) patch.prompt = params.prompt;
      if (params.deliveryChannel !== undefined) patch.deliveryChannel = params.deliveryChannel;
      if (params.deliveryTarget !== undefined) patch.deliveryTarget = params.deliveryTarget;
      if (params.enabled !== undefined) patch.enabled = params.enabled;
      if (params.timeoutMs !== undefined) {
        patch.timeoutMs = params.timeoutMs ?? (null as never);
      }
      if (params.cron !== undefined) {
        try {
          const cron = parseCron(params.cron);
          patch.cron = params.cron;
          const next = computeNextRunAt(cron, Date.now());
          patch.nextRunAt = next === null ? null : (next as never);
        } catch (err) {
          if (err instanceof CronParseError) {
            throw new Error(`invalid_params: ${err.message}`);
          }
          throw err;
        }
      }
      // re-enable: status/실패 카운터 정리.
      if (params.enabled === true) {
        patch.status = 'active';
        patch.consecutiveFailures = 0;
      }
      const updated = updateSchedule(db, params.scheduleId, patch);
      if (!updated) {
        throw new Error(`not_found: schedule ${params.scheduleId}`);
      }
      return { schedule: toResponseSchedule(updated) };
    },
  } satisfies RpcMethodHandler<
    {
      scheduleId: string;
      name?: string;
      cron?: string;
      prompt?: string;
      deliveryChannel?: 'discord' | 'web';
      deliveryTarget?: string;
      enabled?: boolean;
      timeoutMs?: number | null;
    },
    unknown
  >);

  // schedule.delete
  registerMethod({
    method: 'schedule.delete',
    description: 'schedule 을 삭제합니다 (agent_runs.schedule_id 는 NULL)',
    authLevel: 'token',
    schema: z.object({ scheduleId: z.string().min(1) }),
    async execute(params) {
      const db = requireDb(deps);
      const deleted = deleteSchedule(db, params.scheduleId);
      return { deleted };
    },
  } satisfies RpcMethodHandler<{ scheduleId: string }, unknown>);

  // schedule.runNow
  registerMethod({
    method: 'schedule.runNow',
    description: 'schedule 을 즉시 실행합니다 (수동 트리거)',
    authLevel: 'token',
    schema: z.object({ scheduleId: z.string().min(1) }),
    async execute(params) {
      const sched = requireScheduler(deps);
      const { runId } = await sched.triggerNow(params.scheduleId);
      return { runId };
    },
  } satisfies RpcMethodHandler<{ scheduleId: string }, unknown>);

  // schedule.history
  registerMethod({
    method: 'schedule.history',
    description: '특정 schedule 의 실행 이력 (agent_runs.schedule_id 필터)',
    authLevel: 'token',
    schema: z.object({
      scheduleId: z.string().min(1),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
    async execute(params) {
      const db = requireDb(deps);
      // listAgentRuns 는 schedule_id 필터를 모르므로 직접 SQL.
      const rows = db
        .prepare(
          `SELECT id, agent_id, prompt, output, duration_ms, model_used, role, error, created_at
           FROM agent_runs
           WHERE schedule_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(params.scheduleId, Math.min(params.limit ?? 50, MAX_LIMIT)) as Array<{
        id: string;
        agent_id: string;
        prompt: string;
        output: string;
        duration_ms: number | null;
        model_used: string | null;
        role: string | null;
        error: string | null;
        created_at: number;
      }>;
      return {
        runs: rows.map((r) => ({
          id: r.id,
          agentId: r.agent_id as AgentId,
          prompt: r.prompt.length > 200 ? r.prompt.slice(0, 200) : r.prompt,
          output: r.output.length > 500 ? r.output.slice(0, 500) : r.output,
          durationMs: r.duration_ms,
          modelUsed: r.model_used,
          role: r.role,
          error: r.error,
          createdAt: r.created_at,
        })),
      };
    },
  } satisfies RpcMethodHandler<{ scheduleId: string; limit?: number }, unknown>);

  // schedule.disable / schedule.enable — update 별칭.
  registerMethod({
    method: 'schedule.disable',
    description: 'schedule 을 일시 비활성화합니다',
    authLevel: 'token',
    schema: z.object({ scheduleId: z.string().min(1) }),
    async execute(params) {
      const db = requireDb(deps);
      const updated = updateSchedule(db, params.scheduleId, { enabled: false });
      if (!updated) throw new Error(`not_found: schedule ${params.scheduleId}`);
      return { schedule: toResponseSchedule(updated) };
    },
  } satisfies RpcMethodHandler<{ scheduleId: string }, unknown>);

  registerMethod({
    method: 'schedule.enable',
    description: 'schedule 을 다시 활성화합니다 (status=active, consecutiveFailures=0)',
    authLevel: 'token',
    schema: z.object({ scheduleId: z.string().min(1) }),
    async execute(params) {
      const db = requireDb(deps);
      const existing = getSchedule(db, params.scheduleId);
      if (!existing) throw new Error(`not_found: schedule ${params.scheduleId}`);
      // 다음 트리거 시각 재계산.
      let nextMs: number | null = null;
      try {
        nextMs = computeNextRunAt(parseCron(existing.cron), Date.now());
      } catch {
        /* swallow */
      }
      const updated = updateSchedule(db, params.scheduleId, {
        enabled: true,
        status: 'active',
        consecutiveFailures: 0,
        nextRunAt: nextMs === null ? null : (nextMs as never),
      });
      return { schedule: toResponseSchedule(updated) };
    },
  } satisfies RpcMethodHandler<{ scheduleId: string }, unknown>);

  // schedule.testCron — 미리보기.
  registerMethod({
    method: 'schedule.testCron',
    description: 'cron 표현식의 다음 N회 실행 시각을 미리 계산합니다 (등록 전 검증)',
    authLevel: 'token',
    schema: z.object({
      expr: cronField,
      sampleCount: z.number().int().min(1).max(MAX_TEST_SAMPLES).optional(),
    }),
    async execute(params) {
      try {
        const cron = parseCron(params.expr);
        const samples: number[] = [];
        const count = params.sampleCount ?? 5;
        let cursor = Date.now();
        for (let i = 0; i < count; i++) {
          const next = computeNextRunAt(cron, cursor);
          if (next === null) break;
          samples.push(next);
          cursor = next;
        }
        return { nextRunsAt: samples };
      } catch (err) {
        if (err instanceof CronParseError) {
          throw new Error(`invalid_params: ${err.message}`);
        }
        throw err;
      }
    },
  } satisfies RpcMethodHandler<{ expr: string; sampleCount?: number }, unknown>);
}
```

### C4. EDIT `packages/server/src/gateway/server.ts` — schedule RPC 등록

import 추가:

```ts
import { registerScheduleMethods, type ScheduleRpcDeps } from './rpc/methods/schedule.js';
```

`GatewayServerDeps` 에 필드 추가:

```ts
readonly scheduleDeps?: ScheduleRpcDeps;
```

`registerAgentRunsMethods` 호출 다음에 추가:

```ts
registerScheduleMethods(deps.scheduleDeps ?? {});
```

### C5. EDIT `packages/server/src/main.ts` — Scheduler delivery hook + gateway 주입

(B4 에서 만든 scheduler 의 onRunComplete 를 채운다)

`scheduler` 인스턴스 생성 시 `onRunComplete` 옵션을 빼고 lateinit 패턴으로 가는 대신, gateway 가 만들어진 직후 scheduler 의 deps 를 다시 주입할 수는 없으므로, `scheduler` 생성 전에 `onRunComplete` 의 closure 가 참조할 lateinit 변수를 준비:

```ts
let deliveryReady:
  | ((args: {
      schedule: Schedule;
      agentRunId: string | null;
      output: string;
      error?: string;
    }) => Promise<void>)
  | null = null;
```

그리고 scheduler 생성에 onRunComplete 추가:

```ts
const scheduler = new SchedulerService({
  // ... 기존 deps ...
  onRunComplete: async (args) => {
    if (deliveryReady) await deliveryReady(args);
  },
});
```

`gateway` 가 만들어진 후 (gatewayConfig 와 gateway 사이) deliveryReady 를 주입:

```ts
import { deliverScheduleResult } from './automation/delivery.js';
// ...
deliveryReady = (args) =>
  deliverScheduleResult(
    {
      discordClient: discordAdapter.getClient() ?? undefined,
      broadcaster: gateway.ctx.broadcaster,
      connections: gateway.ctx.connections,
      logger,
    },
    {
      schedule: args.schedule,
      output: args.output,
      error: args.error,
      agentRunId: args.agentRunId,
    },
  );
```

(import { Schedule } 도 main.ts 에 추가: `import type { Schedule } from '@finclaw/types';`)

`createGatewayServer(...)` 호출에 `scheduleDeps` 추가:

```ts
scheduleDeps: { db: storage.db, scheduler },
```

### C6. EDIT `packages/server/src/gateway/ws/connection.ts` — schedule.completed 자동 구독

line 48 의 `subscriptions: new Set(['portfolio.changed'])` 를:

```ts
subscriptions: new Set(['portfolio.changed', 'schedule.completed']),
```

### C7. 밀스톤 C 검증

```sh
pnpm --filter @finclaw/types build
pnpm --filter @finclaw/server build
pnpm typecheck
pnpm lint
pnpm --filter @finclaw/server test
```

수동 (선택):

```sh
# 서버 기동, 별도 셸에서:
curl -s -X POST http://localhost:3000/rpc \
  -H "x-api-key: $FINCLAW_API_KEY" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"schedule.testCron","params":{"expr":"*/5 * * * *","sampleCount":3}}' | jq
```

기대: `{ "result": { "nextRunsAt": [..., ..., ...] } }`

---

## 밀스톤 D — Web UI Settings 자동화 섹션

### D1. EDIT `packages/web/src/app-gateway.ts` — ScheduleClient 추가

`AgentRunsClient` 다음에 추가:

```ts
// ─────────────────────────────────────────────────────────────────────
// Phase 28: schedule.* 자동화 클라이언트
// ─────────────────────────────────────────────────────────────────────

export type DeliveryChannel = 'discord' | 'web';
export type ScheduleStatus = 'active' | 'failing' | 'disabled';

export interface ScheduleSummary {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly deliveryChannel: DeliveryChannel;
  readonly deliveryTarget: string;
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  readonly status: ScheduleStatus;
  readonly consecutiveFailures: number;
  readonly lastRunAt?: number;
  readonly lastRunId?: string;
  readonly nextRunAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ScheduleHistoryRun {
  readonly id: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly output: string;
  readonly durationMs: number | null;
  readonly modelUsed: string | null;
  readonly role: string | null;
  readonly error: string | null;
  readonly createdAt: number;
}

export interface ScheduleClient {
  list(params?: {
    enabled?: boolean;
    limit?: number;
  }): Promise<{ schedules: readonly ScheduleSummary[] }>;
  create(params: {
    name: string;
    cron: string;
    agentId: string;
    prompt: string;
    deliveryChannel: DeliveryChannel;
    deliveryTarget: string;
    timeoutMs?: number;
    enabled?: boolean;
  }): Promise<{ scheduleId: string; nextRunAt: number | null }>;
  update(params: {
    scheduleId: string;
    name?: string;
    cron?: string;
    prompt?: string;
    deliveryChannel?: DeliveryChannel;
    deliveryTarget?: string;
    enabled?: boolean;
    timeoutMs?: number | null;
  }): Promise<{ schedule: ScheduleSummary }>;
  delete(scheduleId: string): Promise<{ deleted: boolean }>;
  runNow(scheduleId: string): Promise<{ runId: string | null }>;
  history(scheduleId: string, limit?: number): Promise<{ runs: readonly ScheduleHistoryRun[] }>;
  disable(scheduleId: string): Promise<{ schedule: ScheduleSummary }>;
  enable(scheduleId: string): Promise<{ schedule: ScheduleSummary }>;
  testCron(expr: string, sampleCount?: number): Promise<{ nextRunsAt: readonly number[] }>;
}

export function createScheduleClient(gateway: AppGateway): ScheduleClient {
  return {
    list: (p = {}) =>
      gateway.send('schedule.list', p as Record<string, unknown>) as Promise<{
        schedules: readonly ScheduleSummary[];
      }>,
    create: (p) =>
      gateway.send('schedule.create', p as unknown as Record<string, unknown>) as Promise<{
        scheduleId: string;
        nextRunAt: number | null;
      }>,
    update: (p) =>
      gateway.send('schedule.update', p as unknown as Record<string, unknown>) as Promise<{
        schedule: ScheduleSummary;
      }>,
    delete: (scheduleId) =>
      gateway.send('schedule.delete', { scheduleId }) as Promise<{ deleted: boolean }>,
    runNow: (scheduleId) =>
      gateway.send('schedule.runNow', { scheduleId }) as Promise<{ runId: string | null }>,
    history: (scheduleId, limit) =>
      gateway.send('schedule.history', { scheduleId, limit }) as Promise<{
        runs: readonly ScheduleHistoryRun[];
      }>,
    disable: (scheduleId) =>
      gateway.send('schedule.disable', { scheduleId }) as Promise<{ schedule: ScheduleSummary }>,
    enable: (scheduleId) =>
      gateway.send('schedule.enable', { scheduleId }) as Promise<{ schedule: ScheduleSummary }>,
    testCron: (expr, sampleCount) =>
      gateway.send('schedule.testCron', { expr, sampleCount }) as Promise<{
        nextRunsAt: readonly number[];
      }>,
  };
}
```

### D2. CREATE `packages/web/src/views/schedule-form.ts`

자동화 등록 모달. preset 버튼 + cron 라이브 미리보기 (testCron RPC).

```ts
// packages/web/src/views/schedule-form.ts
// Phase 28 D: schedule 등록/편집 모달.

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  createScheduleClient,
  type AppGateway,
  type DeliveryChannel,
  type ScheduleClient,
  type ScheduleSummary,
} from '../app-gateway.js';

const PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: '매시간 정각', cron: '0 * * * *' },
  { label: '매일 9시', cron: '0 9 * * *' },
  { label: '매일 12시', cron: '0 12 * * *' },
  { label: '매주 월 9시', cron: '0 9 * * 1' },
];

@customElement('schedule-form')
export class ScheduleForm extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .modal {
      background: var(--bg-secondary, #161b22);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 8px;
      padding: 20px;
      width: 520px;
      max-width: 90vw;
      max-height: 90vh;
      overflow-y: auto;
    }
    h3 {
      margin: 0 0 12px;
    }
    label {
      display: block;
      font-size: 12px;
      color: var(--text-secondary, #8b949e);
      margin-top: 12px;
      margin-bottom: 4px;
    }
    input,
    select,
    textarea {
      width: 100%;
      padding: 6px 10px;
      background: var(--bg-tertiary, #1c2129);
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      box-sizing: border-box;
    }
    textarea {
      min-height: 80px;
      resize: vertical;
    }
    .presets {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .preset {
      padding: 3px 8px;
      font-size: 11px;
      background: transparent;
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 4px;
      cursor: pointer;
    }
    .preset:hover {
      background: var(--bg-tertiary, #1c2129);
    }
    .preview {
      margin-top: 6px;
      font-size: 11px;
      color: var(--text-secondary, #8b949e);
      min-height: 14px;
    }
    .error {
      color: var(--red, #f85149);
      font-size: 12px;
      margin-top: 8px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    button.primary {
      padding: 6px 14px;
      background: var(--blue, #2f81f7);
      color: white;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    button.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.secondary {
      padding: 6px 14px;
      background: transparent;
      color: var(--text-primary, #e6edf3);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
    }
  `;

  @property({ attribute: false }) gateway!: AppGateway;

  @state() private name = '';
  @state() private cron = '0 12 * * *';
  @state() private agentId = 'finclaw-partner';
  @state() private prompt = '';
  @state() private deliveryChannel: DeliveryChannel = 'web';
  @state() private deliveryTarget = 'broadcast';
  @state() private cronPreview = '';
  @state() private cronError = '';
  @state() private submitting = false;
  @state() private error = '';

  private client: ScheduleClient | null = null;
  private cronDebounce: ReturnType<typeof setTimeout> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.client = createScheduleClient(this.gateway);
    void this.refreshPreview();
  }

  private async refreshPreview(): Promise<void> {
    if (!this.client) return;
    try {
      const res = await this.client.testCron(this.cron, 3);
      this.cronPreview = res.nextRunsAt
        .map((ms) => new Date(ms).toLocaleString('ko-KR'))
        .join(' · ');
      this.cronError = '';
    } catch (err) {
      this.cronPreview = '';
      this.cronError = (err as Error).message;
    }
  }

  private onCronChange(e: Event): void {
    this.cron = (e.target as HTMLInputElement).value;
    if (this.cronDebounce) clearTimeout(this.cronDebounce);
    this.cronDebounce = setTimeout(() => void this.refreshPreview(), 250);
  }

  private applyPreset(c: string): void {
    this.cron = c;
    void this.refreshPreview();
  }

  private onChannelChange(e: Event): void {
    this.deliveryChannel = (e.target as HTMLSelectElement).value as DeliveryChannel;
    if (this.deliveryChannel === 'web') this.deliveryTarget = 'broadcast';
  }

  private async onSubmit(): Promise<void> {
    if (!this.client) return;
    if (!this.name.trim() || !this.prompt.trim() || this.cronError) return;
    this.submitting = true;
    this.error = '';
    try {
      await this.client.create({
        name: this.name.trim(),
        cron: this.cron.trim(),
        agentId: this.agentId,
        prompt: this.prompt,
        deliveryChannel: this.deliveryChannel,
        deliveryTarget: this.deliveryChannel === 'web' ? 'broadcast' : this.deliveryTarget.trim(),
      });
      this.dispatchEvent(new CustomEvent('schedule-created', { bubbles: true, composed: true }));
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.submitting = false;
    }
  }

  private onClose(): void {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="modal" role="dialog" aria-label="자동화 추가">
        <h3>자동화 추가</h3>

        <label>이름</label>
        <input
          .value=${this.name}
          @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)}
          placeholder="예: 일일 포트폴리오 보고"
        />

        <label>cron (분 시 일 월 요일)</label>
        <input .value=${this.cron} @input=${this.onCronChange} placeholder="0 12 * * *" />
        <div class="presets">
          ${PRESETS.map(
            (p) =>
              html`<button type="button" class="preset" @click=${() => this.applyPreset(p.cron)}>
                ${p.label}
              </button>`,
          )}
        </div>
        <div class="preview">${this.cronError ? '' : `다음 실행: ${this.cronPreview || '-'}`}</div>
        ${this.cronError ? html`<div class="error">${this.cronError}</div>` : ''}

        <label>agent</label>
        <input
          .value=${this.agentId}
          @input=${(e: Event) => (this.agentId = (e.target as HTMLInputElement).value)}
          placeholder="finclaw-partner"
        />

        <label>prompt</label>
        <textarea
          .value=${this.prompt}
          @input=${(e: Event) => (this.prompt = (e.target as HTMLTextAreaElement).value)}
          placeholder="자동 실행 시 보낼 prompt"
          maxlength="2000"
        ></textarea>

        <label>송출 채널</label>
        <select .value=${this.deliveryChannel} @change=${this.onChannelChange}>
          <option value="web">Web 알림</option>
          <option value="discord">Discord DM</option>
        </select>

        ${this.deliveryChannel === 'discord'
          ? html`
              <label>Discord user_id 또는 channel_id</label>
              <input
                .value=${this.deliveryTarget}
                @input=${(e: Event) => (this.deliveryTarget = (e.target as HTMLInputElement).value)}
                placeholder="123456789012345678"
              />
            `
          : ''}
        ${this.error ? html`<div class="error">${this.error}</div>` : ''}

        <div class="actions">
          <button class="secondary" @click=${this.onClose}>취소</button>
          <button
            class="primary"
            ?disabled=${this.submitting ||
            !this.name.trim() ||
            !this.prompt.trim() ||
            !!this.cronError}
            @click=${this.onSubmit}
          >
            ${this.submitting ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'schedule-form': ScheduleForm;
  }
}
```

### D3. EDIT `packages/web/src/views/settings-view.ts` — 자동화 섹션 추가

import 추가:

```ts
import './schedule-form.js';
import { createScheduleClient, type ScheduleClient, type ScheduleSummary } from '../app-gateway.js';
```

`@state` 블록 (memories / runs 다음) 에 추가:

```ts
// Phase 28 자동화
@state() private schedules: readonly ScheduleSummary[] = [];
@state() private schedulesError = '';
@state() private schedulesLoading = false;
@state() private showScheduleForm = false;
@state() private toastMessage = '';

private scheduleClient: ScheduleClient | null = null;
private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
```

`attach()` 안에서 추가:

```ts
this.scheduleClient = createScheduleClient(this.gateway);
this.notificationHandler = (method, params) => this.onNotification(method, params);
this.gateway.onNotification(this.notificationHandler);
```

`disconnectedCallback` (없으면 추가):

```ts
override disconnectedCallback(): void {
  super.disconnectedCallback();
  if (this.notificationHandler && this.gateway) {
    this.gateway.offNotification(this.notificationHandler);
  }
}
```

기존 attach 안의 `void this.loadRuns()` 다음에 `void this.loadSchedules();` 추가.

신규 메서드:

```ts
private async loadSchedules(): Promise<void> {
  if (!this.scheduleClient || !this.gateway?.isConnected) return;
  this.schedulesLoading = true;
  this.schedulesError = '';
  try {
    const res = await this.scheduleClient.list({ limit: 100 });
    this.schedules = res.schedules;
  } catch (err) {
    this.schedulesError = (err as Error).message;
  } finally {
    this.schedulesLoading = false;
  }
}

private onNotification(method: string, params: Record<string, unknown>): void {
  if (method !== 'notification.schedule.completed') return;
  const data = (params['data'] as { name?: string; error?: string } | undefined) ?? {};
  this.toastMessage = data.error
    ? `자동화 실패: ${data.name ?? ''} — ${data.error}`
    : `자동화 완료: ${data.name ?? ''}`;
  setTimeout(() => {
    this.toastMessage = '';
  }, 4_000);
  void this.loadSchedules();
  void this.loadRuns();
}

private async onScheduleRunNow(s: ScheduleSummary): Promise<void> {
  if (!this.scheduleClient) return;
  try {
    await this.scheduleClient.runNow(s.id);
    this.toastMessage = `${s.name}: 즉시 실행 요청됨`;
    setTimeout(() => (this.toastMessage = ''), 3_000);
    await this.loadSchedules();
  } catch (err) {
    this.schedulesError = (err as Error).message;
  }
}

private async onScheduleToggle(s: ScheduleSummary): Promise<void> {
  if (!this.scheduleClient) return;
  try {
    if (s.enabled) {
      await this.scheduleClient.disable(s.id);
    } else {
      await this.scheduleClient.enable(s.id);
    }
    await this.loadSchedules();
  } catch (err) {
    this.schedulesError = (err as Error).message;
  }
}

private async onScheduleDelete(s: ScheduleSummary): Promise<void> {
  if (!this.scheduleClient) return;
  if (!window.confirm(`삭제하시겠습니까?\n\n${s.name}`)) return;
  try {
    await this.scheduleClient.delete(s.id);
    await this.loadSchedules();
  } catch (err) {
    this.schedulesError = (err as Error).message;
  }
}

private renderAutomationSection() {
  return html`
    <section>
      <div class="section-header">
        <h3>자동화</h3>
        <div class="controls">
          <button class="refresh" @click=${this.loadSchedules} ?disabled=${this.schedulesLoading}>
            ${this.schedulesLoading ? '불러오는 중...' : '새로고침'}
          </button>
          <button class="refresh" @click=${() => (this.showScheduleForm = true)}>
            + 자동화 추가
          </button>
        </div>
      </div>
      ${this.schedulesError
        ? html`<div class="error" role="alert">${this.schedulesError}</div>`
        : ''}
      ${this.schedules.length === 0
        ? html`<div class="empty">등록된 자동화가 없습니다.</div>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>이름</th>
                  <th>cron</th>
                  <th>agent</th>
                  <th>채널</th>
                  <th>다음 실행</th>
                  <th>상태</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${this.schedules.map(
                  (s) => html`
                    <tr>
                      <td>${s.name}</td>
                      <td><code>${s.cron}</code></td>
                      <td>${s.agentId}</td>
                      <td>${s.deliveryChannel}</td>
                      <td>${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '-'}</td>
                      <td>
                        <span class="badge ${s.enabled ? '' : 'error'}">
                          ${s.enabled ? s.status : 'disabled'}
                        </span>
                      </td>
                      <td>
                        <button class="refresh" @click=${() => this.onScheduleRunNow(s)}>
                          즉시 실행
                        </button>
                        <button class="refresh" @click=${() => this.onScheduleToggle(s)}>
                          ${s.enabled ? '비활성' : '활성'}
                        </button>
                        <button class="danger" @click=${() => this.onScheduleDelete(s)}>
                          삭제
                        </button>
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    </section>
  `;
}
```

`render()` 의 connected 분기에 자동화 섹션 추가 + 모달 + toast:

```ts
override render() {
  return html`
    <h2>Settings</h2>
    ${this.toastMessage
      ? html`<div class="badge" style="display:block;margin-bottom:8px;">${this.toastMessage}</div>`
      : ''}
    ${!this.gateway?.isConnected
      ? html`<div class="empty">게이트웨이 연결 대기 중...</div>`
      : html`
          ${this.renderMemoriesSection()}
          ${this.renderAutomationSection()}
          ${this.renderRunsSection()}
          ${this.renderRoutingSection()}
        `}
    ${this.showScheduleForm
      ? html`<schedule-form
          .gateway=${this.gateway}
          @close=${() => (this.showScheduleForm = false)}
          @schedule-created=${async () => {
            this.showScheduleForm = false;
            await this.loadSchedules();
          }}
        ></schedule-form>`
      : ''}
  `;
}
```

### D4. 밀스톤 D 검증

```sh
pnpm --filter @finclaw/web build
pnpm typecheck
pnpm lint
```

수동 (가능한 경우):

```sh
pnpm --filter @finclaw/web dev
# 브라우저에서 Settings 진입 → "자동화" 섹션 확인 → "+ 자동화 추가" 모달 동작 확인.
# preset 버튼 클릭 → cron 필드 갱신 → preview 즉시 갱신 (testCron RPC).
```

---

## 밀스톤 E — 격리·실패 처리·운영성

대부분의 운영성 처리는 이미 밀스톤 B/C 에 포함되었다. 본 밀스톤은 **수동 검증 + 마무리 폴리시**.

### E1. 환경변수 노출 (선택)

`packages/server/src/main.ts` 의 SchedulerService 생성에 env 기반 임계 추가:

```ts
const maxFailRaw = process.env.AUTOMATION_MAX_CONSECUTIVE_FAILURES;
const maxFail = maxFailRaw ? Number(maxFailRaw) : 3;
// ... new SchedulerService 의 deps 에 maxConsecutiveFailures: maxFail 추가.
```

### E2. timeout 시나리오 회귀 가드 (단위 테스트)

CREATE `packages/server/src/automation/scheduler.test.ts` (mocked runner):

```ts
import { describe, expect, it, vi } from 'vitest';
import { ConcurrencyLane } from '@finclaw/infra';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSchedule, getSchedule, openDatabase, type Database } from '@finclaw/storage';
import { createAgentId } from '@finclaw/types';
import { ProfileHealthMonitor, InMemoryToolRegistry } from '@finclaw/agent';
import { SchedulerService } from './scheduler.js';

describe('SchedulerService.triggerNow', () => {
  it('error 시 agent_runs.error 저장 + consecutiveFailures 증가', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase28-sched-'));
    let db: Database | null = null;
    try {
      db = openDatabase({ path: join(dir, 'db.sqlite'), enableWAL: false });
      const s = addSchedule(db.db, {
        name: 't',
        cron: '* * * * *',
        agentId: createAgentId('finclaw-partner'),
        prompt: 'p',
        deliveryChannel: 'web',
        deliveryTarget: 'broadcast',
      });
      const lane = new ConcurrencyLane({ maxConcurrent: 1, maxQueueSize: 1, waitTimeoutMs: 5_000 });
      const runner = { execute: vi.fn().mockRejectedValue(new Error('boom')) };
      const sched = new SchedulerService({
        db: db.db,
        toolRegistry: new InMemoryToolRegistry(),
        runnerFactory: () => runner as never,
        lane,
        defaultModel: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
        },
        systemPrompt: 'sys',
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          child: vi.fn(),
        } as never,
        profileHealth: new ProfileHealthMonitor(),
      });
      const { runId } = await sched.triggerNow(s.id);
      expect(runId).toBeTruthy();
      const row = db.db.prepare('SELECT error FROM agent_runs WHERE id = ?').get(runId) as {
        error: string;
      };
      expect(row.error).toBe('boom');
      const reread = getSchedule(db.db, s.id);
      expect(reread?.consecutiveFailures).toBe(1);
      expect(reread?.status).toBe('failing');
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3회 연속 실패 시 status=disabled + enabled=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase28-sched-'));
    let db: Database | null = null;
    try {
      db = openDatabase({ path: join(dir, 'db.sqlite'), enableWAL: false });
      const s = addSchedule(db.db, {
        name: 't',
        cron: '* * * * *',
        agentId: createAgentId('finclaw-partner'),
        prompt: 'p',
        deliveryChannel: 'web',
        deliveryTarget: 'broadcast',
      });
      const lane = new ConcurrencyLane({ maxConcurrent: 1, maxQueueSize: 1, waitTimeoutMs: 5_000 });
      const runner = { execute: vi.fn().mockRejectedValue(new Error('boom')) };
      const sched = new SchedulerService({
        db: db.db,
        toolRegistry: new InMemoryToolRegistry(),
        runnerFactory: () => runner as never,
        lane,
        defaultModel: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
        },
        systemPrompt: 'sys',
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          child: vi.fn(),
        } as never,
        profileHealth: new ProfileHealthMonitor(),
        maxConsecutiveFailures: 3,
      });
      await sched.triggerNow(s.id);
      await sched.triggerNow(s.id);
      await sched.triggerNow(s.id);
      const reread = getSchedule(db.db, s.id);
      expect(reread?.consecutiveFailures).toBe(3);
      expect(reread?.status).toBe('disabled');
      expect(reread?.enabled).toBe(false);
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

### E3. 밀스톤 E 검증

```sh
pnpm --filter @finclaw/server test -- automation/scheduler
```

---

## 최종 검증

```sh
pnpm typecheck                  # 0 errors
pnpm lint                       # 0 warnings
pnpm test                       # 모두 통과 (cron, schedules.storage, scheduler, migration)
pnpm build                      # 모든 패키지 dist 생성

# 마이그레이션 시뮬레이션 (dev DB 백업본 활용)
DEV_DB_BAK="${HOME}/.finclaw/db.sqlite.pre-phase28.bak"
if [ -f "$DEV_DB_BAK" ]; then
  TMP=$(mktemp)
  cp "$DEV_DB_BAK" "$TMP"
  node -e "
  import('./packages/storage/dist/database.js').then(({ openDatabase }) => {
    const d = openDatabase({ path: process.argv[1], enableWAL: false });
    console.log('post-migration version:', d.schemaVersion);
    d.close();
  });
  " "$TMP"
  rm -f "$TMP"
fi
```

수동 시나리오:

1. 서버 기동 → 1분 후 `scheduler.started` 로그 출력 확인.
2. Settings → 자동화 추가 → cron preset "매시간 정각" 클릭 → preview 표시 확인 → 저장.
3. "즉시 실행" 클릭 → 토스트 + history 행 추가.
4. cron 수정 (update) → next_run_at 재계산 확인 (Settings 자동화 테이블의 "다음 실행" 컬럼).
5. 비활성화 → 다음 분 트리거 스킵 확인 (로그).
6. 서버 재시작 → 누락 없이 다음 트리거.

---

## 정리

```sh
# DB 백업 정리 (검증 끝난 후 선택)
rm -f "${HOME}/.finclaw/db.sqlite.pre-phase28.bak"

git status                       # 변경 파일 일람
git add -A
git commit -m "feat(automation): scheduled agent runs (Phase 28)"
```

---

## 롤백 절차

문제 발생 시:

```sh
# 1) 코드 롤백
git checkout main -- packages/storage/src/database.ts \
  packages/storage/src/index.ts \
  packages/types/src/index.ts \
  packages/server/src/main.ts \
  packages/server/src/gateway/server.ts \
  packages/server/src/gateway/ws/connection.ts \
  packages/web/src/app-gateway.ts \
  packages/web/src/views/settings-view.ts
rm -rf packages/server/src/automation \
  packages/server/src/gateway/rpc/methods/schedule.ts \
  packages/storage/src/schedules.ts \
  packages/storage/src/schedules.storage.test.ts \
  packages/storage/src/database.migration.test.ts \
  packages/types/src/automation.ts \
  packages/web/src/views/schedule-form.ts

# 2) DB 롤백 (백업본이 있으면)
DEV_DB_BAK="${HOME}/.finclaw/db.sqlite.pre-phase28.bak"
[ -f "$DEV_DB_BAK" ] && cp "$DEV_DB_BAK" "${HOME}/.finclaw/db.sqlite"
```
