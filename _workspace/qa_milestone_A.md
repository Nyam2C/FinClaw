# qa_milestone_A — Phase 26 밀스톤 A 게이트키퍼 검증

**검증자:** qa-engineer
**일자:** 2026-04-28
**대상:** schema-architect (`01_schema-architect_migration.md`) + rpc-engineer (`02_rpc-engineer_finance.md`)

---

## 1. 검증 매트릭스

| #   | 항목                                                                             | 결과             | 근거 (직접 확인한 코드/테스트)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `transactions` 컬럼 ↔ `Transaction` 타입 ↔ Zod RPC 입력 1:1 매칭                 | PASS             | `database.ts:155-169` (DDL: id/portfolio_id/symbol/action/quantity/price/fee/currency/executed_at/source/note/created_at) ↔ `types/finance.ts:207-223` (camelCase 동치) ↔ `transactions.ts:70-85` rowToTransaction 매핑. Zod 입력 (`finance.ts:412-422`) 은 `portfolioId/symbol/action/quantity/price/fee/currency/executedAt/note` 모두 커버. `source` 는 RPC 가 강제 'manual', `id/createdAt` 은 storage 가 생성.                               |
| 2   | recomputeHoldings 정확도 — buy 10@180 + buy 5@200 → avg ≈ 186.6667               | PASS             | `transactions.storage.test.ts:169-194` 통과. `transactions.ts:127-149` 의 weighted avg 알고리즘: `buyCostSum/buyQtySum`.                                                                                                                                                                                                                                                                                                                          |
| 3   | sell 후 average_cost 유지 (180 유지 또는 186.67 유지)                            | PASS             | `transactions.storage.test.ts:196-231` "+ sell 3@220 → quantity=12, avg 그대로" 통과. `transactions.ts:136-139` 의 `case 'sell'` 은 `acc.qty` 만 감소시키고 `buyQtySum`/`buyCostSum` 은 변경하지 않음 → weighted avg 보존. (참고: 사용자 요청 "buy 10@180 + sell 3@220 → avg=180" 은 plan.md line 131 의 시나리오와 다름 — 실제 시나리오는 buy 두 번 후 sell 이며 avg 는 186.67 유지가 맞음. 단일 buy + sell 인 경우에도 코드 동작상 180 유지됨.) |
| 4   | split 처리 (quantity 만 누적, price 무시)                                        | PASS (코드 일치) | `transactions.ts:140-143` `case 'split'` 은 `acc.qty += r.quantity` 만 수행. price 는 분기 외. 단, **단위 테스트 없음** — plan.md 명세대로 코드는 작성됐으나 split 시나리오의 실제 동작 검증 테스트가 storage 에 없음 (낮은 우선순위, 결함 아님).                                                                                                                                                                                                 |
| 5   | 마이그레이션 v3 → v4 무결성 — 기존 holdings → synthetic transactions 1:1 변환    | PASS             | `transactions.storage.test.ts:53-136` 의 v3 fixture 작성 → openDatabase → schema_version='4' / synthetic transactions 2건 (AAPL/MSFT, action=buy, quantity·price 보존) / holdings 보존 모두 검증. `database.ts:226-268` 의 MIGRATIONS[4] 가 `JOIN portfolios p ON p.id = h.portfolio_id` 로 currency 채움.                                                                                                                                        |
| 6   | 마이그레이션 idempotent                                                          | PASS             | `transactions.storage.test.ts:127-135` 동일 DB 재오픈 시 transactions COUNT=2 유지 검증. `database.ts:267` 의 `WHERE NOT EXISTS (SELECT 1 FROM transactions LIMIT 1)` 가드 확인.                                                                                                                                                                                                                                                                  |
| 7   | portfolio.get 응답 호환성 — 기존 holdings/summary 보존 + recentTransactions 추가 | PASS             | `finance.ts:349-392` 응답 형태 유지 + `recentTransactions: Transaction[]` 신규. `finance.test.ts:323-378` 기존 holdings/summary 테스트 + `recentTransactions: []` 보강 모두 통과. db 미주입 시 빈 배열 (`finance.ts:373-375`).                                                                                                                                                                                                                    |
| 8   | portfolio.changed broadcast 페이로드                                             | PASS             | `finance.ts:84-105` `tryBroadcastPortfolioChanged`. 페이로드: `{portfolioId, updatedAt, reason ∈ {'transaction.add','transaction.update','transaction.delete'}, transactionId}`. broadcast 시점은 storage 변경 + holdings 재계산 완료 후, RPC return 직전 (`finance.ts:442-446, 543-547, 576-580`). 즉 RPC 응답 성공 직전에만 발화 — 실패 경로(throw) 에서는 호출되지 않음.                                                                       |
| 9   | broadcast best-effort (broadcaster 실패가 RPC 응답에 영향 없음)                  | PASS             | `finance.ts:95-104` try/catch 흡수. `finance.test.ts:649-661` "transaction.add succeeds even when broadcaster is missing" 통과. broadcaster + connections 둘 다 없을 때도 skip (`finance.ts:92-94`).                                                                                                                                                                                                                                              |
| 10  | 외부 API 키 없이 통과 (mock-only 원칙)                                           | PASS             | finance.test.ts 의 모든 transaction.\* 테스트는 `db: database.db` 만 주입. `quoteService/newsAggregator` 는 vi.fn() mock. 임베딩 / 외부 네트워크 호출 0건. transactions.storage.test.ts 도 `:memory:` DB + tmp dir 만 사용. 환경변수 의존 없음.                                                                                                                                                                                                   |

추가 사실:

- `RpcMethod` union (`packages/types/src/gateway.ts:21-24`) 에 `finance.transaction.{add,list,update,delete}` 4개 등록됨 — dispatchRpc 가 인식 가능.
- main.ts (`packages/server/src/main.ts:341-351`) 가 `financeDeps.db = storage.db` 주입.
- server.ts (`packages/server/src/gateway/server.ts:90-93`) 가 `broadcaster`/`connections` 를 `financeDeps` 에 spread 주입.
- `transactions.ts:97-170` recomputeHoldings 는 BEGIN IMMEDIATE / COMMIT/ROLLBACK 으로 감싸 동시성 보호.
- listTransactions 의 from/to 필터 SQL 절은 `transactions.ts:231-238` 에 정확히 구현 (`executed_at >= ?` AND `executed_at <= ?`). 단위 테스트로는 미커버 — 아래 누락 항목 참조.

---

## 2. 경계면 통합 테스트 (신규)

**파일:** `packages/server/src/gateway/rpc/methods/finance.test.ts` (Phase 26 A QA: storage ↔ RPC ↔ portfolio.get 경계면 통합 검증)

**테스트명:** `transaction.add followed by portfolio.get returns the new holding in recentTransactions and updated holdings`

**설계:**

- 기존 `portfolio.get includes recentTransactions when db is provided` 테스트는 `portfolioStore.listPortfolios` 를 `holdings: []` 고정 mock 으로 받고 있어 holdings 갱신 경계는 검증하지 못함.
- 신규 테스트는 `listPortfolios` 를 매 호출마다 `database.db` 의 `portfolio_holdings` 테이블을 SELECT 해 동적으로 변환 (production 의 SQLite 기반 PortfolioStore 와 동일한 boundary).
- transaction.add → broadcast 검증 → portfolio.get → holdings 1건 (`AAPL/qty 10/avgPrice 180`) + recentTransactions 1건 (`symbol AAPL/quantity 10/action buy`) 동시에 보임을 확인.
- mock broadcaster 의 `broadcastToChannel` 호출 1회, channel='portfolio.changed', payload.reason='transaction.add', payload.transactionId 일치 확인.

**결과:** finance.test.ts 30/30 PASS (기존 29 + 신규 1). 회귀 0.

---

## 3. 검증 명령 출력

```text
$ pnpm typecheck
> finclaw@0.1.0 typecheck /mnt/c/Users/박/Desktop/hi/FinClaw
> tsgo --noEmit
(통과 — 출력 없음)

$ pnpm lint
> finclaw@0.1.0 lint /mnt/c/Users/박/Desktop/hi/FinClaw
> oxlint --config oxlintrc.json .
Found 0 warnings and 0 errors.
Finished in 557ms on 455 files with 126 rules using 12 threads.

$ pnpm test (전체)
 Test Files  155 passed (155)
      Tests  1417 passed (1417)
   Duration  217.10s

$ pnpm vitest run packages/server/src/gateway/rpc/methods/finance.test.ts
 Test Files  1 passed (1)
      Tests  30 passed (30)
```

(이전 통계: storage 47/47, finance 29/29, 전체 1416 → 신규 1 추가로 1417/1417.)

---

## 4. 누락 항목 / 결함 (있을 경우 수정 책임 명시)

본 매트릭스 10개 항목은 모두 PASS 이지만, plan.md 검증 항목 중 **테스트로 직접 커버되지 않은** 항목 2건은 별도 기록한다. 이는 본 단계에서 기능 결함은 아니지만, 추후 사용자 피드백·통합 단계에서 재현 시 즉시 작성해야 할 후보이다.

| 항목                                             | plan.md 라인 | 현재 상태                                                                                                                                                                                                                                                                                                                                                                             | 책임자 (필요 시)                     |
| ------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **`sell > 현재 보유 수량` → 경고 (에러는 아님)** | line 133     | 코드상 short 가 발생하면 `acc.qty < 0` 가 되고 `recomputeHoldings` 의 `if (acc.qty <= 0) continue` 분기가 holdings 행을 삭제만 함. 경고 로그/응답 필드 없음. rpc-engineer 가 보고서 line 211 에서 "short selling / 잔량 음수 경고 — 본 단계 안 함" 으로 명시적으로 범위 외 처리. plan.md 의 "경고는 옵션, 에러는 아님" 과 정합 — **결함 아님**. 후속 밀스톤 또는 사용자 요청 시 추가. | (정보) rpc-engineer 가 추후 도입 시  |
| **listTransactions 의 from/to 필터 동작**        | line 134     | 코드 (`transactions.ts:231-238`) 는 명세대로 작성됨. `finance.ts:472-475` 에 Zod 스키마도 있음. 다만 from/to 가 실제로 결과를 잘라내는지 검증하는 단위 테스트 없음. **결함 아님** (코드 정확). 회귀 보호 차원에서 후속 추가 권장.                                                                                                                                                     | (정보) qa-engineer 가 향후 보강 가능 |

추가 관찰:

- `Transaction` 타입의 RPC 응답은 Zod output schema 가 아니라 storage 가 매핑한 객체를 그대로 직렬화한다. RpcMethodHandler 의 `TResult` 는 generic 으로만 검사되어 런타임 검증이 없다. 본 단계 컨벤션과 일치하므로 결함 아님 (기존 quote/news 도 동일 패턴).
- schema-architect 보고가 언급한 "외부에서 transactions 직접 INSERT 시 holdings 동기화 깨짐" 은 본 모듈 함수 통한 변경만 가정하므로 본 단계 범위 외.

---

## 5. 최종 판정

**PASS — 밀스톤 B 진입 가능.**

근거:

- 검증 매트릭스 10/10 모두 통과 (직접 코드/테스트 확인).
- 경계면 통합 테스트 신규 1건 추가 통과 (storage → RPC → portfolio.get holdings + recentTransactions + broadcast 동시 검증).
- typecheck / lint / 전체 1417 테스트 통과, 회귀 0.
- mock-only 원칙 (외부 API 키·네트워크 호출 0) 준수.
- plan.md 의 명세 외 항목(short 경고, from/to 단위 테스트)은 결함이 아닌 후속 보강 후보.

**다음 단계:** 밀스톤 B (MemoryCaptureStage + memory.\* RPC) 착수. pipeline-engineer / rpc-engineer 동시 호출 가능 (orchestrator 판단).
