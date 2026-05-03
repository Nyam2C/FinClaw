---
name: finclaw-schema-migration
description: FinClaw SQLite 스키마 마이그레이션 작업의 표준 절차. transactions, agent_runs 테이블 신설, v3→v4 마이그레이션, portfolio_holdings 재계산 로직(application-level vs trigger), 인덱스 설계, FK CASCADE 결정에 사용. database.ts SCHEMA_VERSION bump, packages/storage/src/tables/* 모듈 신설/수정, 기존 holdings 의 synthetic transaction 변환이 필요할 때 반드시 이 스킬을 사용할 것.
---

# finclaw-schema-migration

`@finclaw/storage` 패키지의 마이그레이션을 안전하게 추가하는 절차. Phase 26 의 밀스톤 A(transactions) 와 D(agent_runs) 가 주 사용처.

## 1. 마이그레이션 추가 절차

```
1. database.ts 의 SCHEMA_VERSION 을 N → N+1 로 bump
2. runMigrations() 의 if (currentVersion < N+1) 분기에 SQL 추가
3. 새 테이블 모듈 신설: packages/storage/src/tables/{name}.ts
4. packages/storage/src/index.ts 에 barrel export 추가
5. packages/types/src/{domain}.ts 에 row 타입 + 입력 타입 추가
6. 기존 데이터 변환이 필요하면 같은 트랜잭션 안에서 SELECT-INSERT 로 처리
7. 검증: v3 fixture DB 만들어 마이그레이션 후 데이터 보존 확인
```

**현재 상태:** SCHEMA_VERSION = 3. v4 가 본 Phase 의 목표.

## 2. transactions 테이블 (밀스톤 A)

```sql
CREATE TABLE transactions (
  id            TEXT PRIMARY KEY,
  portfolio_id  TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('buy','sell','dividend','fee','split')),
  quantity      REAL NOT NULL,
  price         REAL,
  fee           REAL DEFAULT 0,
  currency      TEXT NOT NULL,
  executed_at   INTEGER NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('manual','import')),
  note          TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
);

CREATE INDEX idx_transactions_portfolio ON transactions(portfolio_id, executed_at DESC);
CREATE INDEX idx_transactions_symbol    ON transactions(portfolio_id, symbol, executed_at DESC);
```

**왜 이 컬럼들?**

- `id` TEXT — UUID 또는 nanoid (sqlite 의 INTEGER PK 는 race 시 재사용 위험)
- `executed_at` 과 `created_at` 분리 — 사용자가 "3월 15일에 산 거" 를 4월에 입력하는 케이스
- `price` nullable — dividend/fee 는 가격 개념 없음
- `source` — 'manual' (사용자 입력) vs 'import' (증권사 API 등 미래 확장)

## 3. holdings 재계산: application-level 권장

`recomputeHoldings(portfolioId, symbol?)` 함수를 transaction CRUD 직후 호출:

```ts
// packages/storage/src/tables/transactions.ts (개념)
export function addTransaction(input) {
  return db.transaction(() => {
    const id = nanoid();
    db.prepare('INSERT INTO transactions ...').run(...);
    recomputeHoldings(input.portfolio_id, input.symbol);
    return id;
  })();
}

function recomputeHoldings(portfolioId, symbol?) {
  // (portfolio_id, symbol) 별로 transactions 합산
  // quantity = Σ(buy.qty) - Σ(sell.qty)  (split 별도)
  // average_cost = Σ(buy.qty × buy.price) / Σ(buy.qty)
  // UPSERT into portfolio_holdings
}
```

**Trigger 안 쓰는 이유:**

- weighted average 를 SQL 만으로 표현하기 까다로움 (재귀 CTE 필요)
- 디버깅·테스트가 함수보다 어려움
- transaction CRUD 가 항상 storage layer 통과한다는 가정이 깨질 일 거의 없음 (Phase 26 범위 안에서는)

**Trigger 로 갈 만한 상황 (지금은 아님):** 외부 도구가 SQLite 파일을 직접 INSERT 할 때.

## 4. 기존 holdings → synthetic transaction 변환

마이그레이션 핵심 부분:

```sql
-- v3 → v4 마이그레이션 안에서
INSERT INTO transactions (id, portfolio_id, symbol, action, quantity, price, currency, executed_at, source, created_at)
SELECT
  lower(hex(randomblob(16))),
  portfolio_id,
  symbol,
  'buy',
  quantity,
  average_cost,
  currency,
  COALESCE(updated_at, strftime('%s','now')*1000),
  'manual',
  strftime('%s','now')*1000
FROM portfolio_holdings
WHERE quantity > 0;
```

이 단계가 빠지면 마이그레이션 후 holdings 재계산 시 모든 보유분이 사라진다.

## 5. agent_runs 테이블 (밀스톤 D)

```sql
CREATE TABLE agent_runs (
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
  memory_id       TEXT,    -- nullable: 저장 실패 또는 길이 미달 시 NULL
  error           TEXT,    -- nullable: 성공 시 NULL
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_agent_runs_created ON agent_runs(created_at DESC);
CREATE INDEX idx_agent_runs_agent   ON agent_runs(agent_id, created_at DESC);
```

**memory_id 는 ON DELETE 정책 없이 nullable** — memory 가 삭제돼도 agent_runs 감사 기록은 남는다. 외부 쿼리 시 LEFT JOIN.

## 6. 마이그레이션 무결성 체크리스트

- [ ] `PRAGMA user_version` 또는 동등한 메커니즘으로 현재 버전 정확히 감지
- [ ] 마이그레이션 SQL 전체를 `BEGIN TRANSACTION ... COMMIT` 으로 감쌈
- [ ] 실패 시 ROLLBACK 으로 v3 상태 보존 (자동)
- [ ] v4 마이그레이션을 두 번 돌려도 안전한가 (`IF NOT EXISTS` 활용)
- [ ] v3 fixture DB (기존 holdings 3건 + portfolios 1건) → v4 후 holdings 동일 수치 검증
- [ ] FK 위반 발생 가능성 검토 (portfolio_id 가 portfolios 에 실제 존재?)

## 7. 작성 후 알릴 곳

- rpc-engineer 에게 `SendMessage`: "transactions/agent_runs 가용. 컬럼 X. RPC 응답 시 직렬화는 JSON.stringify(tool_calls_json) 그대로 노출 vs 파싱 후 노출 합의 필요."
- rag-engineer 에게: "agent_runs.memory_id 링크 의미. memories 삭제 시 agent_runs 의 link 는 NULL 로 cascade?" — 본 Phase 결정: ON DELETE 정책 없이 dangling 허용 (감사 흔적 보존).
- qa-engineer 에게 `TaskCreate`: "v3→v4 마이그레이션 무결성 테스트 추가."

## 참고

- 단위 테스트 패턴: `packages/storage/src/tables/memories.storage.test.ts`, `database.test.ts`
- 기존 마이그레이션 코드 (v2→v3) 가 database.ts 안에 있음 — 동일 스타일 따를 것
