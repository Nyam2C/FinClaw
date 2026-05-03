# 01_schema-architect — Phase 26 밀스톤 A v4 마이그레이션 + transactions 모듈

## 핵심 결정

- **SCHEMA_VERSION 3 → 4 bump**. `transactions` 테이블 + 인덱스 2개 신설.
- **holdings 재계산은 application-level** (`recomputeHoldings(db, portfolioId)`).
  - 이유: SQLite trigger 에서 weighted average cost 계산은 SQL 만으로 표현이 까다롭고 (재귀 CTE 또는 view 필요), 디버깅·테스트가 함수보다 어렵다.
  - 외부 직접 INSERT 시 holdings 동기화가 깨질 수 있다는 한계는 인지. Phase 26 범위에서는 본 모듈을 통해서만 transactions 변경된다는 가정 유지.
- **Trigger 미사용** — plan.md 의 옵션 중 함수 안 동기 호출 채택.
- **synthetic transaction 발행 idempotent** — `WHERE NOT EXISTS (SELECT 1 FROM transactions LIMIT 1)` 가드. 이미 v4 인 DB 에 다시 마이그레이션 돌려도 중복 발행 안 됨.
- **synthetic transaction 의 currency** — `portfolio_holdings` 에 currency 컬럼이 없어 `portfolios.currency` 를 JOIN 해서 사용.
- **price 처리**:
  - `buy/sell/split` → quantity 누적 (split 의 가격 의미는 본 단계에서 무시).
  - `dividend/fee` → quantity 영향 없음.
  - `average_cost` 는 buy 의 weighted average. `sell` 은 평균 유지.
  - `quantity ≤ 0` 인 (portfolio_id, symbol) 은 holdings 에서 삭제.
- **executed_at / created_at 분리** — 사용자가 과거 거래를 나중에 입력하는 케이스 대응.

## 변경/신설 파일

| 경로                                                | 변경 종류 | 요약                                                                                                                                                                                          |
| --------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/storage/src/database.ts`                  | 수정      | SCHEMA_VERSION 4. SCHEMA_DDL 에 `transactions` + 인덱스 추가. MIGRATIONS[4] 에 동일 DDL + synthetic transaction 발행 SQL.                                                                     |
| `packages/storage/src/transactions.ts`              | 신설      | `addTransaction`, `getTransaction`, `listTransactions`, `updateTransaction`, `deleteTransaction`, `recomputeHoldings` 공개. CRUD 직후 holdings 동기 재계산. BEGIN IMMEDIATE 로 트랜잭션 보호. |
| `packages/storage/src/index.ts`                     | 수정      | transactions 모듈 public API re-export.                                                                                                                                                       |
| `packages/storage/src/database.test.ts`             | 수정      | 테이블 목록에 `transactions` 추가, schema_version 기대값 `'3'` → `'4'`.                                                                                                                       |
| `packages/storage/src/transactions.storage.test.ts` | 신설      | v3→v4 마이그레이션 시뮬레이션 + addTransaction/recomputeHoldings 단위 테스트 9건.                                                                                                             |
| `packages/types/src/finance.ts`                     | 수정      | `TransactionAction`, `TransactionSource`, `Transaction` 타입 추가. 기존 export 와 충돌 없음.                                                                                                  |

## 다른 팀원이 알아야 할 스키마 사실

- `transactions.id` — TEXT PRIMARY KEY, `crypto.randomUUID()` 로 생성.
- `transactions.executed_at`, `transactions.created_at` — INTEGER ms epoch.
- `transactions.price` — nullable (dividend/fee/split 은 NULL 가능). buy/sell 에서는 RPC 레이어가 enforce.
- `transactions.fee` — REAL NOT NULL DEFAULT 0.
- `transactions.action` — CHECK ('buy','sell','dividend','fee','split'). 그 외 값은 INSERT 거부.
- `transactions.source` — CHECK ('manual','import').
- FK: `portfolios.id` 삭제 시 `transactions` ON DELETE CASCADE.
- 인덱스:
  - `idx_transactions_portfolio (portfolio_id, executed_at DESC)` — 포트폴리오 단위 시계열 조회.
  - `idx_transactions_symbol (portfolio_id, symbol, executed_at DESC)` — 심볼 단위 최근 N건 조회 (예: portfolio.get 의 recentTransactions 또는 RAG 주입 용).
- `recomputeHoldings(db, portfolioId)` 는 BEGIN IMMEDIATE 로 감싸므로 SQLite write lock 잡는다. 동시 실행은 직렬화됨.
- 외부에서 transactions 를 직접 INSERT/UPDATE/DELETE 하면 holdings 가 자동 갱신되지 않음 — 본 모듈의 함수 통해서만 변경할 것.

## RPC 엔지니어를 위한 응답 스키마 가이드

`Transaction` 인터페이스 (camelCase, `@finclaw/types/finance`):

```ts
{
  id: string;
  portfolioId: string;
  symbol: TickerSymbol;
  action: 'buy' | 'sell' | 'dividend' | 'fee' | 'split';
  quantity: number;
  price?: number;          // null DB row → undefined
  fee: number;
  currency: CurrencyCode;
  executedAt: Timestamp;   // ms epoch
  source: 'manual' | 'import';
  note?: string;           // null DB row → undefined
  createdAt: Timestamp;
}
```

storage 함수가 이미 row → camelCase 매핑까지 처리하므로 RPC 레이어는 그대로 직렬화하면 됨.

## v3 → v4 마이그레이션 시뮬레이션 결과

`packages/storage/src/transactions.storage.test.ts > v3 → v4 migration > synthesizes transactions from existing portfolio_holdings and preserves quantities`

- 절차:
  1. `DatabaseSync` 직접 사용해 v3 호환 스키마 + meta='3' + portfolios 1건 + portfolio_holdings 2건(AAPL 10@180, MSFT 5@300) 작성.
  2. `openDatabase(path)` 호출 → 마이그레이션 트리거.
  3. 검증:
     - `meta.schema_version` 이 `'4'`.
     - `transactions` 테이블에 synthetic 행 2건 (AAPL/MSFT, action=buy, source=manual, quantity·price 보존).
     - `portfolio_holdings` 행 보존 (마이그레이션이 holdings 자체를 재작성하지 않음).
  4. 한 번 더 `openDatabase` 호출 → transactions 카운트가 2로 유지 (idempotent guard 동작).

## 테스트 결과

```
pnpm typecheck       # 통과 (tsgo --noEmit)
pnpm lint            # 통과 (oxlint, 0 warnings / 0 errors)
pnpm test:storage    # 6 files / 47 tests passed
pnpm test            # 155 files / 1406 tests passed (전체 unit 회귀)
```

storage 테스트의 신규 9건 모두 통과:

1. v3 → v4 마이그레이션 (synthetic + idempotent)
2. buy 10@180 → quantity=10 / avg=180
3. buy 10@180 + buy 5@200 → avg ≈ 186.6667
4. - sell 3@220 → quantity=12 / avg 그대로
5. 첫 buy 삭제 → quantity=2 / avg=200
6. listTransactions executed_at DESC 정렬
7. recomputeHoldings — quantity 0 시 holdings 행 제거
8. updateTransaction quantity 변경 시 holdings 재계산
9. getTransaction 미존재 id → null

## 다음 단계 위임 포인트

- **rpc-engineer**: `finance.transaction.{add,list,update,delete}` RPC 추가, `finance.portfolio.get` 응답에 `recentTransactions` 필드 확장, `portfolio.changed` WebSocket broadcast. 본 storage 모듈의 함수만 호출하면 holdings 자동 갱신됨.
- **qa-engineer**: 마이그레이션 무결성 통합 시나리오 (디스크 DB 에서 v3 → v4 → v4 재시도 → 외부 sqlite3 cli 로 검증) 추가 가능. 현재는 storage 단위 시뮬레이션 1건만 있음.

## 범위 외 (의도적으로 안 한 것)

- split 의 price 필드 해석 (ratio 등) — 위임 명세대로 본 단계에서는 quantity 만 누적.
- dividend cash flow 추적 — 별도 cash 계좌 모델링 필요. Phase 26 범위 외.
- transactions WebSocket broadcast — rpc-engineer 단계.
- finance.portfolio.get 응답 확장 — rpc-engineer 단계.
- agent_runs 테이블 — 밀스톤 D 에서 다시 schema-architect 호출 시 추가.
