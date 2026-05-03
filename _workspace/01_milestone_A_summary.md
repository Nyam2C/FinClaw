# 밀스톤 A 종합 산출물 — 거래 내역 테이블 & CRUD

## 결과: PASS (밀스톤 B 진입 가능)

전체 테스트 1417/1417 통과. typecheck/lint 0건. mock-only 원칙 준수.

## 변경 파일

**스키마 (schema-architect):**

- `packages/storage/src/database.ts` — SCHEMA_VERSION=4, transactions DDL+인덱스, MIGRATIONS[4] (synthetic transaction 변환, idempotent 가드)
- `packages/storage/src/transactions.ts` (신설) — addTransaction/listTransactions/getTransaction/updateTransaction/deleteTransaction/recomputeHoldings (BEGIN IMMEDIATE 트랜잭션)
- `packages/storage/src/transactions.storage.test.ts` (신설) — v3→v4 마이그레이션 + CRUD 9건
- `packages/storage/src/index.ts` — re-export
- `packages/storage/src/database.test.ts` — schema_version 기대값 4
- `packages/types/src/finance.ts` — TransactionAction/TransactionSource/Transaction 타입

**RPC (rpc-engineer):**

- `packages/server/src/gateway/rpc/methods/finance.ts` — finance.transaction.{add,list,update,delete} 핸들러 + portfolio.get 에 recentTransactions
- `packages/server/src/gateway/rpc/methods/finance.test.ts` — 신규 단위 테스트 10건
- `packages/server/src/gateway/server.ts` — broadcaster/connections spread
- `packages/server/src/main.ts` — financeDeps.db 주입
- `packages/types/src/gateway.ts` — RpcMethod union 확장

**QA (qa-engineer):**

- `packages/server/src/gateway/rpc/methods/finance.test.ts` — 경계면 통합 테스트 1건 추가
- `_workspace/qa_milestone_A.md`

## 핵심 결정

- **Holdings 재계산 = 애플리케이션 레벨** (trigger 미사용). plan.md 오픈질문 #1 의 기본안 채택.
- **synthetic transaction 발행 idempotent** — `WHERE NOT EXISTS` 가드.
- **price NULL 허용 / fee NOT NULL DEFAULT 0** — 평균가 계산 시 NaN 폭발 방지.
- **broadcast best-effort** — broadcaster 미주입 또는 실패해도 RPC 응답은 성공.

## 다음 밀스톤 (B) 가 알아야 할 사실

- `Transaction` 타입은 `@finclaw/types` 에서 import.
- storage 의 transactions API (`addTransaction` 등) 는 `@finclaw/storage` 에서 import.
- portfolio.changed 브로드캐스트는 동작 중. UI 가 구독할 채널명은 정확히 `portfolio.changed`.
- `storage.db` 는 main.ts 에서 RPC deps 로 노출됨 — memory.\* RPC 도 같은 패턴 사용.

## 누락 항목 (결함 아님, 후속 보강 후보)

- listTransactions from/to 필터 단위 테스트 (코드는 정확, 회귀 보호 차원).
- sell > 보유 수량 경고 (plan.md "경고는 옵션, 에러는 아님" 과 정합).
