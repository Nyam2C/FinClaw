# 밀스톤 D — agent_runs 테이블 + storage CRUD

작업자: schema-architect (1차)
브랜치: `feature/memory-and-transactions`

## 결정 요약

### 옵션 A 선택 (SCHEMA_VERSION = 5)

- **선택 근거**: v4 가 이미 머지된 상태(`packages/storage/src/database.ts` 의 MIGRATIONS[4] 가 transactions 합성 로직을 포함)이고, 로컬 개발 DB 가 v4 로 자리 잡았을 가능성을 차단하기 위함. v5 로 bump 하면 기존 v4 DB 도 자동 마이그레이션된다.
- **옵션 B 기각 사유**: SCHEMA_DDL 의 `CREATE TABLE IF NOT EXISTS` 만으로는 새 DB 에서 테이블이 생성되지만, MIGRATIONS 추적이 끊겨 향후 변경 추적이 모호해진다. 명시적 v5 가 단방향성·감사성 측면에서 깔끔하다.

### memory_id FK 정책: ON DELETE SET NULL

- 사용자가 memory 를 삭제해도 agent_runs 는 보존 (감사용 raw 데이터). `plan.md` 의 "memories 와 agent_runs 는 목적 다름" 정합.
- 스킬 가이드는 dangling 허용을 제안했으나, 본 작업에서는 사용자 지시(`ON DELETE SET NULL`) 가 더 명시적이므로 채택. 무결성을 SQLite FK 가 직접 보장.

### tool_calls 직렬화

- 호출자가 `JSON.stringify` 한 raw 문자열을 `tool_calls_json` 컬럼에 그대로 저장. 파싱은 호출자 책임 (RPC 응답 가공 시 처리). 정규화·검증 안 함 — 단순함 우선.

## 변경 파일

### 신설

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/storage/src/agent-runs.ts` (~165 LOC) — `addAgentRun`, `getAgentRun`, `listAgentRuns`, `linkMemoryToAgentRun`, 타입 export.
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/storage/src/agent-runs.storage.test.ts` — 12 케이스.

### 수정

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/storage/src/database.ts`
  - `SCHEMA_VERSION` : 4 → 5
  - `SCHEMA_DDL` : `agent_runs` 테이블 + 인덱스 2개 추가
  - `MIGRATIONS[5]` : v4 DB 에서 agent_runs 신규 생성 (`IF NOT EXISTS`, idempotent)
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/storage/src/index.ts` — agent-runs barrel export.
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/types/src/agent.ts` — `AgentRun` interface 추가 (camelCase, snake_case → camel 변환은 storage 가 담당).
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/storage/src/database.test.ts` — 회귀 수정 (table 목록에 agent_runs 추가, schema_version '4' → '5').
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/storage/src/transactions.storage.test.ts` — 회귀 수정 (마이그레이션 후 schema_version 기대치 '4' → '5'; 본 테스트는 v3 fixture 로 시작해 최신 SCHEMA_VERSION 까지 연속 적용됨을 검증).

## 스키마 사실 (다른 팀원 참조용)

```sql
CREATE TABLE agent_runs (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  output          TEXT NOT NULL,
  tool_calls_json TEXT,                           -- raw JSON 문자열, nullable
  tokens_input    INTEGER,
  tokens_output   INTEGER,
  duration_ms     INTEGER,
  model_used      TEXT,
  role            TEXT,
  memory_id       TEXT REFERENCES memories(id) ON DELETE SET NULL,
  error           TEXT,
  created_at      INTEGER NOT NULL                -- ms epoch
);
CREATE INDEX idx_agent_runs_created ON agent_runs(created_at DESC);
CREATE INDEX idx_agent_runs_agent   ON agent_runs(agent_id, created_at DESC);
```

- `id` : `randomUUID()` 를 storage CRUD 가 자동 생성.
- `created_at` : `Date.now()` ms epoch.
- `tool_calls_json` : storage 는 JSON 문자열로 저장만 함. RPC 응답 시 파싱 여부는 rpc-engineer 결정.
- `memory_id` 가 NULL → memory 저장 실패/길이 미달/임베딩 실패. `error` 와는 직교.
- `role` (Phase 24 routing role), `model_used` (실제 사용 모델명) — 둘 다 nullable, 미제공 가능.

## storage API (rpc-engineer 가 사용)

```ts
import { addAgentRun, getAgentRun, listAgentRuns, linkMemoryToAgentRun } from '@finclaw/storage';

addAgentRun(db, { agentId, prompt, output, toolCalls?, tokensInput?, tokensOutput?, durationMs?, modelUsed?, role?, memoryId?, error? }): AgentRun
getAgentRun(db, id): AgentRun | null
listAgentRuns(db, { agentId?, from?, to?, limit? }): AgentRun[]   // default 50, max 200, created_at DESC
linkMemoryToAgentRun(db, agentRunId, memoryId): boolean           // UPDATE only (INSERT 없음)
```

## v4 → v5 마이그레이션 검증

`agent-runs.storage.test.ts > "v4 → v5 migration"` 테스트가 다음을 확인:

1. v4 raw fixture (meta='4', memories 존재, agent_runs 미존재) 작성.
2. `openDatabase()` 호출 → `runMigrations(4, 5)` 실행.
3. 결과:
   - `meta.schema_version` = '5' ✓
   - `sqlite_master` 에 agent_runs 테이블 존재 ✓
   - `idx_agent_runs_created`, `idx_agent_runs_agent` 인덱스 존재 ✓
   - 실제 `addAgentRun` INSERT 성공 ✓
4. 같은 DB 로 `openDatabase` 재호출 (idempotent) → 여전히 schema_version='5', 오류 없음.

추가로 `transactions.storage.test.ts > "v3 → v4 migration"` 도 v3→v5 연속 적용 후 schema_version='5', synthetic transactions 보존, idempotent 모두 확인.

## 테스트 결과

| 명령                | 결과                                        |
| ------------------- | ------------------------------------------- |
| `pnpm build`        | OK (tsc --build, 에러 없음)                 |
| `pnpm typecheck`    | OK                                          |
| `pnpm lint`         | 0 warnings, 0 errors                        |
| `pnpm test:storage` | 10 files / 101 tests passed (직전 89 → +12) |
| `pnpm test`         | 156 files / 1447 tests passed (회귀 0)      |

신규 12 테스트 (agent-runs.storage.test.ts):

- CRUD: addAgentRun + getAgentRun roundtrip, 미존재 id null, 최소필드 INSERT, error 필드.
- listAgentRuns: created_at DESC, agentId 필터, from/to 필터, limit 클램프 (max 200).
- linkMemoryToAgentRun: 갱신 성공, 미존재 run false, FK ON DELETE SET NULL 동작.
- v4 → v5 마이그레이션.

## 후속 작업 (다른 팀원에게)

- **rpc-engineer**: `agent.runs.list`, `agent.runs.get` RPC 메서드 작성 시 본 storage API 그대로 사용. 응답 직렬화에서 `toolCalls` 는 이미 JSON 문자열이라 그대로 노출하거나 `JSON.parse` 후 객체로 노출 둘 중 선택 — 본 storage 는 양쪽 모두 호환. plan.md line 270 의 `agent-runs.ts` RPC 모듈 신설 권장.
- **agent runner (Phase 23 hook 점)**: 실행 종료 시 `addAgentRun` 호출 → `output.length > 100 && !error` 면 `addMemoryWithEmbedding` 호출 → 성공 시 `linkMemoryToAgentRun(runId, memoryId)`. 실패해도 agent_runs 자체는 보존 (감사 우선).
- **qa-engineer**: 본 작업의 마이그레이션 무결성 테스트는 신규 테스트 안에 포함됨. 추가 시뮬레이션이 필요하면 v3 → v4 → v5 chain 도 가능 (현재 v3 fixture 테스트가 사실상 이를 커버).
