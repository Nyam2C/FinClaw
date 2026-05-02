# Phase 26 구현 리뷰

## 개요

Phase 26 은 `plan.md` 5밀스톤 (A 거래·B 기억저장·C RAG·D agent_runs·E Web UI) 으로 구성된 **거래·기억·RAG 3축 완성** 작업. 6 전문 에이전트 + 6 스킬 + 1 오케스트레이터 하네스로 진행.

브랜치 `feature/memory-and-transactions` (base: `main`) 에서 **6 커밋 추가**. 작업 트리 clean.

| Commit                            | 영역                                     |
| --------------------------------- | ---------------------------------------- |
| `78445aa` chore                   | `_workspace/` ignore                     |
| `ebaf12a` feat(storage)           | transactions + agent_runs (v3→v5)        |
| `3e5ad1e` feat(server/auto-reply) | capture / retrieval / agent-memory hook  |
| `b87a5e8` feat(server/rpc)        | transaction._ / memory._ / agent.runs.\* |
| `0038123` feat(web)               | 거래 이력 탭 + 기억·실행이력 UI          |
| `5da8781` docs(claude)            | Phase 26 하네스 변경 이력                |

**검증 결과:** 1470 unit + 109 storage + 31 web = **1610 테스트 통과**, 회귀 0. typecheck/lint 0건. mock-only 외부 API 격리.

---

## 사용자 수동 테스트 시나리오

자동 테스트는 단위·통합 레벨까지. 실제 UX 는 사용자 손으로 확인 필요.

### 사전 준비

```bash
# 빌드 + 서버
pnpm build && tsx packages/server/src/main.ts

# (별도 터미널) Web UI
pnpm --filter @finclaw/web dev
```

**환경변수:**

- `ANTHROPIC_API_KEY` — 필수 (chat / agent.run)
- `VOYAGE_API_KEY` — 권장 (없으면 RAG 가 FTS-only → 한국어 회수율 낮음)
- `ALPHA_VANTAGE_KEY` — 시세/뉴스용 (transactions/memory 와는 무관)
- `FINCLAW_DB_PATH` — 기존 v3/v4 DB → v5 자동 마이그레이션 1회 발생

### 시나리오 1 — 거래 추가 → Portfolio 뷰 반영

1. Web UI Portfolio 탭 → "거래 이력" → "거래 추가"
2. AAPL / buy / 10주 / $180 / USD / 오늘 → 제출
3. **확인:** 거래 이력 테이블에 1행, "보유 종목" 의 AAPL 10주 / avg 180
4. 다시: AAPL / buy / 5주 / $200 → AAPL avg = **186.67** (가중평균)

### 시나리오 2 — !finclaw remember → 기억 저장 + 응답 꼬리표

1. 채팅에서 `!finclaw remember 나는 분기별 리밸런싱 한다`
2. **확인:** 응답 끝 `_기억했습니다 (fact, #xxxxxxxx)_`
3. 같은 문장 재입력 → `_이미 기억 중 (...)_`
4. 다른 패턴: `내 투자 원칙은 배당주 중심`, `메모: 한미 환율 1300원 기준`
5. Settings → "내 기억" 에 저장된 항목 모두 표시

### 시나리오 3 — 새 대화에서 "내 선호" 주입

1. 새 세션 (다른 채널) 에서 `내 투자 선호가 뭐였지?`
2. **확인:** 응답에 "분기별 리밸런싱" / "배당주 중심" 자연스럽게 인용
3. **반증:** `오늘 날씨 어떨까` → 무관 발화 → 서버 로그 `memory.injected` 의 `injected: 0`

### 시나리오 4 — agent.run 결과 저장 + 다음 대화 RAG 매칭

1. `agent.run` 호출 (예: `prompt: "AAPL 최근 분석 요약"` — 100자 초과 결과 prompt)
2. Settings → "에이전트 실행 이력" 에 해당 run 표시 + 클릭 시 detail expand
3. 새 대화에서 `저번 AAPL 분석 요약해줘` → 응답에 ②번 output 핵심 포함

### 시나리오 5 — Settings 에서 기억 삭제 → 검색 제외

1. "내 기억" 항목 옆 "삭제" → confirm
2. **확인:** 목록에서 사라짐, 새 대화에서 그 내용 RAG 미매칭
3. 서버 로그 `memory.injected` 의 ids 에 그 id 더 이상 안 나옴 (vec0 + FTS 동시 cleanup 검증)

### 시나리오 6 — 외부 RPC 거래 추가 → UI 자동 갱신 (핵심)

1. Web UI Portfolio 탭 열어둔 채로,
2. 별도 터미널에서:
   ```bash
   curl -X POST http://localhost:8080/rpc \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"finance.transaction.add","params":{"symbol":"TSLA","action":"buy","quantity":3,"price":250,"currency":"USD","executedAt":'$(date +%s%3N)'}}'
   ```
3. **확인:** 새로고침 **없이** TSLA 가 즉시 추가 (portfolio.changed 자동 구독 동작)

### 추가 점검

- **임베딩 fallback**: `VOYAGE_API_KEY` 빼고 ②~③ → FTS-only. 한국어 회수율 낮을 수 있음, 영어는 OK.
- **DB 마이그레이션**: 기존 v3/v4 DB → 첫 부팅 시 `meta.schema_version='5'`, holdings → synthetic transactions 자동 변환.
- **감사 로그**: stdout / `~/.finclaw/log/` 에서 `event: memory.injected` JSON 한 줄/발화 확인.

---

## 밀스톤별 구현 일치도

| 밀스톤 | 항목                                                                   | 상태 | 커밋      | 비고                                                                  |
| ------ | ---------------------------------------------------------------------- | ---- | --------- | --------------------------------------------------------------------- |
| A.1    | v4 마이그레이션 + transactions 테이블 + recomputeHoldings              | OK   | `ebaf12a` | application-level 재계산, BEGIN IMMEDIATE 트랜잭션                    |
| A.2    | finance.transaction.{add,list,update,delete} + portfolio.get 응답 확장 | OK   | `b87a5e8` | recentTransactions 옵셔널 추가, broadcast best-effort                 |
| A.3    | portfolio.changed WebSocket broadcast                                  | OK   | `b87a5e8` | reason 필드로 add/update/delete 구분                                  |
| B.1    | MemoryCaptureStage + 정규식 5종 + pipeline 끼워넣기                    | OK   | `3e5ad1e` | command 직후, ack 직전 — passthrough 발화만 매칭                      |
| B.2    | DefaultMemoryCaptureService + 임베딩 fallback                          | OK   | `3e5ad1e` | hash dedup + addMemoryWithEmbedding throw → addMemory FTS-only        |
| B.3    | deliver 꼬리표 부착                                                    | OK   | `3e5ad1e` | duplicate 마커 처리 포함                                              |
| B.4    | memory.{list,delete,search} RPC                                        | OK   | `b87a5e8` | search 는 raw top-K (RAG 임계값/신선도는 C 책임)                      |
| C.1    | MemoryRetrievalStage + searchRelevantMemories 알고리즘                 | OK   | `3e5ad1e` | 임계값 0.65 / 신선도 exp(-d/90) / 상한 3 / 심볼 거래 동시             |
| C.2    | RetrievalStage 배선 (Context 직후, Execute 직전)                       | OK   | `3e5ad1e` | best-effort — throw 시 파이프라인 abort X                             |
| C.3    | system prompt "사용자 배경지식" 섹션 빌더                              | OK   | `3e5ad1e` | 빈 결과 시 빈 문자열 (빈 헤더 노출 방지)                              |
| C.4    | 감사 로그 (`memory.injected` JSON)                                     | OK   | `3e5ad1e` | sessionKey/userQuery/ids/scores/mode/timestamp                        |
| D.1    | v5 마이그레이션 + agent_runs 테이블                                    | OK   | `ebaf12a` | memory_id FK ON DELETE SET NULL — 감사용 raw 보존                     |
| D.2    | DefaultAttachMemoryService + skip 정책                                 | OK   | `3e5ad1e` | output ≤ 100자 / error 있음 → skip, 임베딩 fallback 동일              |
| D.3    | agent.run 핸들러 훅 + agent.runs.{list,get} RPC                        | OK   | `b87a5e8` | 성공/실패 양쪽 addAgentRun, runId 옵셔널 응답, list truncate(200/500) |
| E.1    | portfolio-view 거래 이력 탭 + transaction-form 모달                    | OK   | `0038123` | confirm 삭제, 5초 fallback                                            |
| E.2    | settings-view 재작성 (기억 / 실행이력 / 라우팅 placeholder)            | OK   | `0038123` | type 필터 + expand detail                                             |
| E.3    | app-gateway RPC 래퍼 + 자동 구독                                       | OK   | `0038123` | ws/connection.ts 1줄 (subscriptions: new Set(['portfolio.changed']))  |
| E.4    | portfolio.changed 자동 갱신                                            | OK   | `0038123` | onNotification/offNotification cleanup                                |
| QA     | incremental 게이트 + e2e 시나리오 5건                                  | OK   | `3e5ad1e` | qa_milestone_A~E 산출물, 1610 tests                                   |

---

## plan.md vs 실제 차이

| 영역                        | 계획                                      | 실제                                                    | 대응                                                                   |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Holdings 재계산 (오픈 #1)   | trigger vs 함수 결정 보류                 | **함수 (recomputeHoldings)**                            | weighted avg SQL 복잡성 회피 + 디버깅 용이성                           |
| SCHEMA_VERSION              | 4 (agent_runs 포함)                       | **5** (A 에서 4, D 에서 5 분리)                         | 마이그레이션 단방향 추적 명시성 — 옵션 A 채택                          |
| transactions 마이그레이션   | 기존 holdings → synthetic transaction 1:1 | OK + `WHERE NOT EXISTS` 가드                            | idempotent 보장                                                        |
| split 처리                  | "quantity 만 누적, price 무시"            | **현재 구현 동일 — 다만 ratio 기반 가격 조정 X**        | 미래 거래 분할 시 average_cost 부정확 (Phase 27+ 보강 후보)            |
| 임베딩 프로바이더 (오픈 #3) | 사용자 config 선택                        | `createEmbeddingProvider('auto')` best-effort           | 키 없으면 silent skip → FTS-only 자동 fallback                         |
| 다국어 임베딩 (오픈 #4)     | "multilingual 모델 필수"                  | hybrid 모드 권장                                        | FTS-only 의 한국어 trigram 회수율 한계 — 운영 가이드 작성 필요         |
| 자동 갱신 메커니즘          | "Web UI 가 portfolio.changed 구독"        | **ws/connection.ts 1줄 자동 구독** (옵션 A)             | RPC subscribe 메서드 신설 회피 — 단순성 우선. 다른 채널 확장 시 재검토 |
| memory.search 임계값        | C 와 같은 임계값 0.65 가정                | **RPC 는 raw top-K, 임계값/신선도는 RetrievalStage 만** | 디버깅용 RPC 와 RAG 주입 분리                                          |
| agent.run 응답              | runId 추가                                | **`runId?` 옵셔널** (db 미주입 시 undefined)            | 옛 클라이언트 호환                                                     |

---

## 코드 리뷰 — 잘 된 점

### 설계

- **3축 분리**: 거래(transactions) · 기억(memories+capture) · RAG(retrieval+attach) · 감사(agent_runs) 각각 독립 모듈. 한 축 장애가 다른 축으로 전파 X (best-effort 패턴 일관).
- **상수 단일 출처**: `memory-retrieval.ts` 의 `SIMILARITY_THRESHOLD/FRESHNESS_HALF_LIFE_DAYS/MAX_INJECTED_MEMORIES/TOP_K_FETCH/SYMBOL_TX_LIMIT` 모두 export. 매직 넘버 산재 X.
- **타입 일관성**: storage row (snake_case) ↔ public 타입 (camelCase) 변환을 storage 모듈이 책임 (`rowToAgentRun`). 다른 레이어는 camelCase 만.
- **embeddingProvider 단일 인스턴스**: main.ts 에서 best-effort 생성 후 capture / retrieval / attach / memory.\* RPC 4개 영역 모두 재사용. 키 1개로 4 service 활성.

### 마이그레이션 안정성

- **idempotent 가드**: v4 의 `WHERE NOT EXISTS (SELECT 1 FROM transactions LIMIT 1)` 로 synthetic 중복 방지. v5 도 `IF NOT EXISTS`. v3→v5 연속 적용 검증.
- **FK 정책**: agent_runs.memory_id `ON DELETE SET NULL` — 사용자가 memory 지워도 감사 raw 보존. 의미 보존 명확.

### 검증 매트릭스

- 5 밀스톤 incremental QA + 경계면 통합 테스트 6건 (qa-engineer 가 매 밀스톤마다 추가). 모듈 단독은 통과해도 경계가 어긋나는 결함을 사전 차단.
- mock-only 원칙 일관 — 1610 tests 가 외부 API 키 없이 통과.

### 감사 가능성

- `memory.injected` JSON 한 줄/발화 — 사용자 쿼리, 주입 ids, raw/adjusted scores, mode, 시각 기록. 추후 SQL 분석 가능.
- `agent_runs` 에 prompt/output/error 모두 raw 저장. 실패 경로도 기록 (`output: ''`, `error: msg`).

---

## 코드 리뷰 — 개선 후보

### 1. main.ts 비대화 (448 LOC, +25 LOC 본 PR 분)

- 본 PR 에서 capture / retrieval / attach + memory RPC deps + agent RPC db 까지 추가.
- `wireMemoryServices(storage.db, embeddingProvider, logger)` helper 1개로 추출 가능 → main.ts ~30 LOC 감소.
- 우선순위: 중. 기능 영향 X, 가독성만.

### 2. agent.ts 핸들러 비대화 (450 LOC)

- agent.run 의 성공/실패 양쪽에 `addAgentRun + attachMemoryService.attach` 블록 ~50 LOC 가 두 번 삽입됨 (try success / catch failure).
- `persistAgentRun(deps, {agentRunId, agentId, prompt, output, error?, ...})` helper 1개로 추출 가능. attach 호출은 success 분기만.
- 우선순위: 높음 — 두 군데 동기화 부담.

### 3. recomputeHoldings 의 split 처리

- 현재 split 의 quantity 만 누적, price 영향 X. 실제 액면분할 (예: 1:4 분할) 은 quantity 4배 + price 1/4 변환이 맞음. plan.md "quantity 만 누적" 결정과 정합하나 미래 거래 분할 시 average_cost 부정확.
- 우선순위: 낮음 — 사용자가 직접 split 거래를 입력할 일이 드묾. 발생 시 수동 보정 가능.

### 4. FTS-only 모드 한국어 회수율

- `memory_chunks_fts` 가 trigram tokenizer. 한글 2 codepoint 토큰 ("분기") 인덱싱 X. ≥3 한글 토큰 정확 매칭 시에만 0.65 임계값 통과.
- 운영자에게 "VOYAGE_API_KEY 또는 OPENAI_API_KEY 권장" 알리는 startup 메시지 추가 가능.
- 우선순위: 중 — 사용자 경험 직결.

### 5. portfolio.changed broadcast 페이로드

- broadcaster 가 `{data, timestamp}` 로 자동 wrap. UI 의 `onNotification` 이 `params` 에서 직접 사용. 페이로드 구조가 명세와 약간 다름 (data 안에 wrap 됨) — 시나리오 6 검증 시 확인 필요.
- 우선순위: 낮음 — UI 가 페이로드 무시하고 portfolioGet 재호출하므로 영향 X.

### 6. ws/connection.ts 자동 구독 확장성

- 현재 `new Set(['portfolio.changed'])` 하드코딩. memory.changed / agent.runs.changed 같은 미래 채널 추가 시 동일 패턴 반복.
- `DEFAULT_AUTO_SUBSCRIBE_CHANNELS = ['portfolio.changed']` 상수 + 향후 RPC `system.subscribe` 추가 시 사용자 명시 구독으로 전환.
- 우선순위: 낮음 — 채널 추가 전까지 보류.

### 7. settings-view 의 라우팅 통계 placeholder

- Phase 24 산출 데이터 미연동. `<div>데이터 없음</div>` placeholder 그대로.
- Phase 24 의 profileHealth 또는 routing decision 로그를 RPC 로 노출 후 연동 (별도 작업).
- 우선순위: 중 — 사용자에게 보이는 UI 잔재.

### 8. listTransactions from/to 필터 단위 테스트 부재

- 코드는 정확 (transactions.ts:231-238). storage.test 에 명시 케이스 없음 — 회귀 보호 차원에서 추가 권장.
- 우선순위: 낮음.

### 9. daysOld < 0 clamp 단위 테스트 부재

- `Math.max(1, daysOld)` 로 미래 createdAt 도 clamp. 명시 단위 테스트 없음.
- 우선순위: 낮음.

### 10. "내 철학은" 한국어 변형 단위 테스트

- 정규식 `/내\s*(?:투자\s*)?(?:기준|원칙|철학)[은는]/i` alternation 으로 동작 보장. 명시 단위 테스트는 "기준" 만.
- 우선순위: 낮음.

### 11. silent reply 시 capture 꼬리표 미부착

- `deliver.ts:26-29` 가 hasSilentReply → skip. 의도된 침묵이지만 사용자 입장에선 "기억됐는지 모름". 시각적 confirm UI (예: Discord reaction) 또는 별도 채널 알림 검토.
- 우선순위: 낮음.

### 12. transaction-form 의 currency hardcoded select

- USD/KRW/EUR/JPY/GBP/CNY 6개 하드코딩. 사용자 portfolio.currency 자동 추론 또는 RPC 응답 기반 동적 옵션.
- 우선순위: 낮음.

### 13. agent.runs.list truncate 길이 (200/500)

- prompt 200자 / output 500자. UI 테이블에서 보기엔 적절하나 detail expand 없이 sub 의미 파악 어려운 경우 있음. 사용자 피드백 후 조정.
- 우선순위: 낮음.

---

## 리팩토링 사항 (권장 순서)

| #   | 항목                                                | 우선순위 | 예상 LOC            | 위험                           |
| --- | --------------------------------------------------- | -------- | ------------------- | ------------------------------ |
| 1   | `agent.ts` 의 `persistAgentRun` helper 추출         | 높음     | -50 / +30           | 낮음 (테스트 회귀 0 보장 가능) |
| 2   | `main.ts` 의 `wireMemoryServices` helper 추출       | 중       | -30 / +20           | 낮음                           |
| 3   | settings-view 라우팅 통계 실데이터 연동             | 중       | +60 (RPC 신설 포함) | 중 (Phase 24 산출 의존)        |
| 4   | startup 시 임베딩 미설정 경고 메시지                | 중       | +5                  | 낮음                           |
| 5   | listTransactions/clamp/한국어 변형 단위 테스트 보강 | 낮음     | +40                 | 낮음                           |
| 6   | recomputeHoldings 의 split ratio 처리               | 낮음     | +30                 | 중 (기존 거래 데이터 영향)     |
| 7   | DEFAULT_AUTO_SUBSCRIBE_CHANNELS 상수화              | 낮음     | +5                  | 낮음                           |
| 8   | transaction-form currency 동적화                    | 낮음     | +20                 | 낮음                           |
| 9   | silent reply capture 알림 채널                      | 낮음     | +30                 | 낮음 (UX 정책 결정 필요)       |
| 10  | agent.runs.list truncate 길이 조정                  | 낮음     | +5                  | 낮음 (사용자 피드백 후)        |

**1~2번** 은 본 PR 직후 별도 commit 으로 처리 가능 (외과적, 회귀 0). **3~5번** 은 Phase 27 진입 전 정리 권장. **6~10번** 은 Phase 27+ 또는 사용자 피드백 기반.

---

## 누락 항목 (결함 아님, 후속 보강 후보)

- `listTransactions` from/to 필터 단위 테스트.
- `daysOld < 0` clamp 명시 단위 테스트.
- "내 철학은" / "내 원칙은" 한국어 변형 정규식 명시 단위 테스트.
- silent reply 시 capture 꼬리표 정책 재검토.
- routing 통계 placeholder → 실제 데이터 연동.
- FTS-only 모드 운영자 가이드 (README 또는 startup 메시지).

---

## 다음 Phase 후보

- **Phase 27 — 다중 포트폴리오 + 성과 분석**: TWR/MWR, 벤치마크 대비 수익률, 계정별/전략별 분리.
- **자동 기억 추출**: LLM 이 대화 보며 "기억할 만한 것" 제안 → 사용자 승인 후 저장 (자동 추출의 보수적 버전).
- **거래 자동 수집**: 증권사 OpenAPI 연동 (한국투자증권 등). 법·보안 검토 선행.
- **기억 클러스터링 / export-import**: 유사 기억 자동 병합, 다른 환경 이관.
