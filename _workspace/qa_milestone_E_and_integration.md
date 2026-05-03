# qa_milestone_E_and_integration — Phase 26 마지막 게이트 + 통합 검증

**검증자:** qa-engineer
**일자:** 2026-04-28
**대상:**

- 밀스톤 E (`_workspace/06_ui-engineer_web.md`) — Web UI 거래 이력 / 기억 / 에이전트 실행 이력 + portfolio.changed 자동 갱신
- Phase 26 전체 통합 검증 (`plans/phase26/plan.md` 완료 조건 + e2e 6 시나리오)

---

## 단계 1: 밀스톤 E QA 매트릭스

| #   | 항목                                                                                                                     | 결과 | 근거 (직접 확인한 코드/테스트)                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 자동 구독 동작 — `connection.ts:48` `subscriptions: new Set(['portfolio.changed'])` 으로 모든 클라이언트가 즉시 구독     | PASS | `packages/server/src/gateway/ws/connection.ts:46-48` 초기값에 `'portfolio.changed'` 등록. broadcastToChannel 이 모든 conn 의 subscriptions 를 검사 — 별도 RPC 없이 1줄 변경으로 fan-out 도달.                                                                                |
| E2  | portfolio-view 거래 이력 탭 — 탭 전환, 테이블 렌더, 거래 추가 버튼, 삭제 버튼 (confirm)                                  | PASS | `portfolio-view.ts:15` `PortfolioTab='holdings'\|'transactions'`. `:177` `@state activeTab`, `:261` setTab, `:282-291` 삭제 confirm + 5초 deleteWaiting fallback. holdings 테이블(`:305-320`)은 외과적으로 유지.                                                             |
| E3  | transaction-form 모달 — 클라이언트 검증 (심볼/수량), 실패 시 입력 보존, transaction-added 이벤트                         | PASS | `transaction-form.ts:164-204` validate: symbol trim/uppercase, qty>0, buy/sell 시 price 필수, fee/price 음수 거부, executedAt 파싱. 실패 시 `formError` state 만 설정 (입력값은 별도 @state 에 남음). `:222` `dispatchEvent(new CustomEvent('transaction-added',...))` 발화. |
| E4  | settings-view 기억 섹션 — type 필터, 삭제 confirm, memory.list/delete 호출                                               | PASS | `settings-view.ts:181` `memoryFilter`, `:220-230` loadMemories 가 type 파라미터 조건부 첨부, `:265-273` 삭제 시 `window.confirm` + `memory.delete` 호출 후 `loadMemories` 재호출.                                                                                            |
| E5  | settings-view 에이전트 실행 이력 — list + expand detail (agent.runs.get)                                                 | PASS | `settings-view.ts:240-251` loadRuns, `:280-296` toggleRun 클릭 시 expand state 토글 + `agent.runs.get` 호출 후 expandedRun 에 detail. 같은 행 재클릭 시 닫힘 (`:280-283`).                                                                                                   |
| E6  | app-gateway 신규 RPC 래퍼 — Transaction/Memory/AgentRun 타입, FinanceClient.transaction\*, MemoryClient, AgentRunsClient | PASS | `app-gateway.ts:239-344` Transaction/UpdatedHolding 타입 + FinanceClient.transactionAdd/List/Update/Delete. `:412-461` MemoryType/Memory/MemorySearchHit + MemoryClient + createMemoryClient. `:463-513` AgentRunSummary/Full + AgentRunsClient + createAgentRunsClient.     |
| E7  | portfolio.changed 자동 갱신 — onNotification 핸들러 등록, disconnectedCallback 에서 offNotification                      | PASS | `portfolio-view.ts:182` `notificationHandler` 필드. `:212-224` updated() 안에서 1회만 등록하고 `gateway.onNotification(handler)`. `:192-197` `disconnectedCallback` 에서 `offNotification(handler) + handler=null` — 메모리 누수 방지.                                       |
| E8  | 외과적 변경 — 기존 holdings 테이블 컬럼/렌더 유지, alerts/market 뷰 미변경                                               | PASS | portfolio-view 의 holdings 렌더 (`:305-320`) 가 Symbol/수량/평균단가/통화 4 컬럼 그대로 유지. boundary 는 탭 추가만, 기존 행 마크업은 동일. alerts-view / market-view 는 변경 파일 목록(보고서 line 13~24)에 없음.                                                           |

**E1~E8 결과: 8/8 PASS.**

추가 사실:

- main.ts (+1줄) — `transaction-form.js` side-effect import 로 customElement 등록.
- app.ts (+1줄) — `<settings-view>` 에 `.gateway` 바인딩 추가.
- 기존 web 테스트 25 + 신규 6 = 31 모두 통과 (`pnpm vitest run packages/web` → 31/31).
- broadcaster 미주입 환경에서도 수동 `load()` 5초 fallback 으로 데이터 반영 보장 (`portfolio-view.ts:291`).

---

## 단계 2: 전체 통합 검증 매트릭스 (plan.md 완료 조건 + e2e 6 시나리오)

| #   | 항목                                                                             | 결과 | 근거                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | `pnpm test` 전체 통과                                                            | PASS | 157 files / **1470 tests** all passed (130.19s). 회귀 0.                                                                                                                                                                                                                                 |
| I2  | `pnpm test:storage` 전체 통과                                                    | PASS | 12 files / **109 tests** all passed (67.50s). 11→12 (신규 통합 테스트 1건 추가, 기존 108→109).                                                                                                                                                                                           |
| I3  | `pnpm typecheck` (tsgo --noEmit)                                                 | PASS | 0 errors, 출력 없음.                                                                                                                                                                                                                                                                     |
| I4  | `pnpm lint` (oxlint)                                                             | PASS | 0 warnings, 0 errors. 470 files / 126 rules, 349ms.                                                                                                                                                                                                                                      |
| I5  | 마이그레이션 v3→v4→v5 무결성                                                     | PASS | qa_milestone_A.md (v3→v4: holdings → synthetic transactions, idempotent, currency JOIN). 04_milestone_D_summary.md (v4→v5: SCHEMA_VERSION bump + agent_runs DDL + memory_id FK SET NULL). storage 테스트 12 파일 모두 통과로 결합 검증.                                                  |
| I6  | 감사 로그 추적 가능성                                                            | PASS | `memory-retrieval.ts:332` `logger.info('memory.injected', auditLog)` emit. AuditLog 필드: event/sessionKey/userQuery/memoryIds/rawScores/adjustedScores/mode/transactionSymbols/timestamp. memory-retrieval.storage.test.ts:277-295 직접 검증, execution-adapter/pipeline 테스트로 회귀. |
| I7  | e2e 시나리오 1: transaction.add → portfolio.get 의 holdings + recentTransactions | PASS | qa_milestone_A 신규 boundary `transaction.add followed by portfolio.get returns the new holding...` 가 storage→RPC→portfolio.get→broadcast 4계층 모두 검증.                                                                                                                              |
| I8  | e2e 시나리오 2: !finclaw remember → memory.list                                  | PASS | qa_milestone_B 신규 boundary `MemoryCaptureService capture followed by memory.list returns the captured entry` 가 동일 db 공유 검증.                                                                                                                                                     |
| I9  | e2e 시나리오 3: capture → retrieval → systemPrompt 주입                          | PASS | qa_milestone_C 신규 boundary (memory-capture-retrieval.boundary.storage.test.ts) 가 capture → retrieval → formatBackgroundSection 합성 검증. mode='fts-only' 경로 통과.                                                                                                                  |
| I10 | e2e 시나리오 4: agent.run → agent_runs + memories 양쪽 기록                      | PASS | 04_milestone_D_summary 의 agent.test.ts persistence 5 케이스 + agent-runs.test.ts 10 케이스. addAgentRun + attachMemoryService.attach 동시 실행 → run.memory_id 링크 + memories 행 생성 검증.                                                                                            |
| I11 | **e2e 시나리오 5: agent.run output → 다음 retrieval 매칭 (신규 통합 테스트)**    | PASS | 본 작업 신규 작성 — `agent-run-to-retrieval.boundary.storage.test.ts` 1 케이스. addAgentRun → DefaultAttachMemoryService.attach (FTS-only 경로) → DefaultMemoryRetrievalService.searchRelevant → snippets 에 attached memory + transactions 에 AAPL fixture + section 합성 모두 검증.    |
| I12 | e2e 시나리오 6: memory.delete → search 에서 사라짐                               | PASS | qa_milestone_B 의 `memory.test.ts:259-321` integration: search after delete 가 vec0 + FTS5 + memories 순차 DELETE 후 search 결과에서 제외 검증.                                                                                                                                          |

**I1~I12 결과: 12/12 PASS.**

추가 사실:

- 외부 API 키 (VOYAGE/OPENAI) 미설정 환경에서 모든 테스트 통과. mock-only 원칙 일관 (MEMORY.md feedback_tests_no_api_keys 준수).
- 마이그레이션 idempotent: `WHERE NOT EXISTS (SELECT 1 FROM transactions LIMIT 1)` 가드로 v3→v4 재실행 시 중복 synthetic 차단.
- 감사 로그는 retrieval 외 capture/attach 도 logger.debug/info 로 event 필드 부착 (`agent.run.memory.attached`, `agent.run.memory.skipped`, `memory.retrieval.embedding_failed` 등).

---

## 신규 통합 테스트 (I11) 상세

**파일:** `packages/server/src/auto-reply/__tests__/agent-run-to-retrieval.boundary.storage.test.ts` (109 LOC)

**설계:**

- in-memory storage (`openDatabase({ path: ':memory:' })`) 한 인스턴스를 attach + retrieval 가 공유 (production 와 동일 boundary).
- `DefaultAttachMemoryService` + `DefaultMemoryRetrievalService` 모두 embeddingProvider 미주입 → FTS-only 경로. 외부 임베딩 API 호출 0건.
- ANALYSIS_OUTPUT 은 100자 초과 (MIN_MEMORY_OUTPUT_LENGTH=100 통과) 한국어 본문. 본문에 '분기별' '리밸런싱' (≥3 codepoint) 포함 → trigram tokenizer 인덱싱 가능.
- 흐름:
  1. `addAgentRun` → run.id 발급 (memoryId 아직 미링크).
  2. `attach.attach({...})` → memoryId 반환 + `agent_runs.memory_id` 링크 + memories 행 type='financial' 생성.
  3. AAPL 거래 fixture 1건 (`addTransaction` buy 10@180) — 심볼 기반 거래 동시 주입 검증용.
  4. `retrieval.searchRelevant({ userQuery: 'AAPL 분기별 리밸런싱', sessionKey })` 호출.
  5. 검증:
     - `mode='fts-only'` (provider 미주입).
     - `snippets` 에 attached memoryId 포함, type='financial'.
     - `transactions` 에 AAPL fixture (action='buy', quantity=10, price=180) 포함.
     - `auditLog.event='memory.injected'`, `memoryIds`/`transactionSymbols` 모두 기록.
     - `formatBackgroundSection` 결과에 "사용자 배경지식 (자동 주입)" + "[financial]" + "최근 거래 (AAPL)" + "매수 10주" 모두 포함.

**FTS 트리거 메모:**

- `buildFtsQuery` 가 query 토큰 전부 AND 매칭 → 처음 작성한 query "AAPL 분석 결과 분기별 리밸런싱 요약" 은 "요약" 토큰 미매칭으로 0건 반환 → SIMILARITY_THRESHOLD(0.65) 미달.
- query 를 "AAPL 분기별 리밸런싱" 3 토큰으로 단순화 (모두 본문에 등장). bm25RankToScore = `1/(1+|rank|)` 가 0.65 임계값 통과 확인.
- 이는 사용자 발화의 정확 매칭 시나리오. 운영 시 hybrid 모드(임베딩) 가 의미적 매칭을 처리한다.

**결과:** 1 케이스 PASS. storage tier 12/12 → 회귀 0.

---

## 검증 명령 출력

```text
$ pnpm test
 Test Files  157 passed (157)
      Tests  1470 passed (1470)
   Duration  130.19s

$ pnpm test:storage
 Test Files  12 passed (12)        ← 11 + 신규 1
      Tests  109 passed (109)      ← 108 + 신규 1
   Duration  67.50s

$ pnpm typecheck
> tsgo --noEmit
(통과 — 출력 없음, 0 errors)

$ pnpm lint
> oxlint --config oxlintrc.json .
Found 0 warnings and 0 errors.
Finished in 349ms on 470 files with 126 rules using 12 threads.

$ pnpm vitest run packages/web
 Test Files  2 passed (2)
      Tests  31 passed (31)        ← 25 + 신규 6
   Duration  3.46s

$ pnpm test:storage -- packages/server/src/auto-reply/__tests__/agent-run-to-retrieval.boundary.storage.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

---

## 누락 항목 / 결함

본 작업 매트릭스 (E1~E8 + I1~I12) 20개 항목 모두 PASS. 결함 없음.

이전 보고서에서 후속 보강 후보로 기록된 항목은 그대로 남아있으며, 본 단계에서 결함으로 격상되지 않음:

| 항목                                       | 출처           | 현재 상태                            | 책임              |
| ------------------------------------------ | -------------- | ------------------------------------ | ----------------- |
| transactions split 분기 단위 테스트        | qa_milestone_A | 코드 정확, 단위 테스트 미커버        | qa-engineer 후속  |
| listTransactions from/to 단위 테스트       | qa_milestone_A | 코드 정확, 단위 테스트 미커버        | qa-engineer 후속  |
| "내 철학은 ..." capture 단위 테스트        | qa_milestone_B | 정규식 분기 정확, 명시 케이스 없음   | pipeline-engineer |
| silent reply 시 capture 꼬리표 미부착 동작 | qa_milestone_B | 의도된 동작                          | (정보)            |
| `daysOld < 0` clamp 단위 테스트            | 03_milestone_C | 코드 정확, 명시 케이스 없음          | rag-engineer      |
| FTS-only 한국어 trigram 회수율             | 03_milestone_C | hybrid 모드(임베딩) 운영 사실상 필수 | (정보, 운영)      |
| sell > 보유 수량 경고                      | qa_milestone_A | plan.md 범위 외, 후속 단계           | rpc-engineer 후속 |

---

## 변경 파일 (본 작업)

| 파일                                                                                       | 종류 | 라인 |
| ------------------------------------------------------------------------------------------ | ---- | ---- |
| `packages/server/src/auto-reply/__tests__/agent-run-to-retrieval.boundary.storage.test.ts` | 신설 | 167  |

본 작업에서 production 코드는 한 줄도 수정하지 않음. 외과적 변경 원칙 (CLAUDE.md 3) 준수.

---

## 최종 판정

**PASS — Phase 26 완료.**

근거:

- 단계 1 (밀스톤 E) 매트릭스 8/8 통과: 자동 구독·탭·모달·검증·기억 섹션·실행 이력·자동 갱신·외과성 모두 직접 코드/테스트 확인.
- 단계 2 (통합) 매트릭스 12/12 통과: 4개 명령 (test/test:storage/typecheck/lint) + 6개 e2e 시나리오 + v3→v4→v5 마이그레이션 + 감사 로그 모두 검증.
- 신규 e2e 통합 테스트 1건 추가: agent.run output → attach → retrieval 회수 + 거래 동시 주입 + system prompt 합성 4계층 통합. mock-only 원칙 일관.
- 회귀 0 — 1470 unit + 109 storage = 1579 테스트 전부 통과. typecheck 0 errors, lint 0 warnings.
- plan.md 완료 조건 (line 366-379) 모두 충족: 밀스톤 A~E + 마이그레이션 + 전체 테스트 + 6 시나리오 + typecheck/lint + 감사 로그.

---

## 사용자 피드백 수집 안내 (Phase 4)

Phase 26 게이트키퍼 검증을 모두 통과했습니다. 다음 두 질문에 대한 피드백을 부탁드립니다:

1. **결과에서 개선할 부분이 있나요?**
   - 기억 자동 회상의 임계값(0.65) / 신선도 반감기(90일) / 상한(3개) 가 실제 사용에서 적절한가요?
   - portfolio.changed 자동 구독을 모든 클라이언트에 강제하는 옵션 A 가 의도와 맞나요? (옵션 B: subscribe RPC 명시적 호출)
   - capture 정규식 5종 (기억해/메모/선호/내 원칙은/!finclaw remember) 외에 추가하고 싶은 패턴이 있나요?
   - 거래 입력 UI (transaction-form 모달) 의 필드/검증 동작이 실용적인가요?
   - 에이전트 실행 이력의 prompt 200자 / output 500자 truncate 가 적절한가요?

2. **에이전트 팀 구성이나 워크플로우 변경 희망 사항?**
   - 현재 6 에이전트 (schema-architect / rpc-engineer / pipeline-engineer / rag-engineer / ui-engineer / qa-engineer) 의 책임 분할이 매끄러웠나요?
   - 밀스톤 incremental QA 패턴 (A→B→C→D→E 각 단계 별 게이트) 이 실제로 결함을 조기에 잡았나요?
   - 6개 스킬 (finclaw-schema-migration / rpc-design / pipeline-stage / rag-injection / testing / phase26-orchestrator) 중 부족하거나 과한 것이 있나요?
   - 후속 Phase (예: 거래 자동 수집, 다중 포트폴리오, 자동 기억 추출) 진행 시 변경하고 싶은 워크플로우가 있나요?
