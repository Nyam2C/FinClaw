# Phase 42 킥오프 — 기초 검증 + 재설계 그라운드워크

> 작성 2026-05-27 · base = `groundwork` 브랜치 (main `af910b9`, phase41 머지 후) · 산출물: 이 kickoff (+ plan.md 후속)
> 상태: **초안 — 검증 진행 중.** plan.md 가 검증 결과를 받아 재설계 스코프를 확정한다.
> 위치: **'전체적인 재설계'의 1단계.** 기존 phase42(X/FinTwit 소셜 신호)는 `plans/phase43/` 으로 이동됨.

## 목표

코드를 **"직접"** 읽어 현재 아키텍처의 실제 상태를 확정하고(검증), 그 위에서만 재설계 대상을 식별한다. 기능 추가(phase43)나 큰 구조 변경에 들어가기 전에 **바닥이 무엇인지부터 못박는다.**

두 축으로 분리:

- **검증(verify):** `_workspace/codebase-read/` 의 서브에이전트 정독 분석(SUMMARY 의 P0 6건·P1 3건·P2 죽은코드)이 실제 코드와 맞는지 **1차 출처(소스)로 직접 대조** → `맞음 / 틀림 / 뉘앙스` 판정. 서브에이전트 환각 가능성 때문에, 재설계를 그 위에 쌓기 전에 메인이 직접 재확인하는 것이 선결.
- **재설계(redesign):** 검증으로 **확정된 진짜 문제만** 재설계/수정 후보로 승격. 노이즈(dead 라서 무해한 것, 의도된 스코프 밖, 오판)는 강등하거나 기록만 남긴다.

## 왜 지금인가

- phase41 까지 와서 **코어 구조는 건전**하나(MEMORY: ph39 추출 후 "코어 구조 건전"), `_workspace/codebase-read/SUMMARY.md` 가 **정독으로만 드러나는** 문제들을 제기한다 — 정적 grep 으론 안 보이는 것들(예: `StubFinanceContextProvider` 가 금융 컨텍스트를 빈 값으로 주입, `require-approval` 정책이 실행을 안 막음).
- 이 주장들이 **서브에이전트 산출**이라 신뢰도 미확정. "전체적인 재설계"를 검증 안 된 발견 위에 쌓으면 잘못된 곳을 고치게 된다.
- 이번 세션에서 이미 **`AgentProfile` 이 완전 dead** (grep 결과 1줄 = 자기 정의뿐)임을 직접 확인 — SUMMARY 가 잡지 못한 추가 dead 도 있다는 신호이자, 직접 검증의 가치 증명.

## 범위 (한눈에)

- **IN:** SUMMARY P0/P1/P2 항목 직접 검증(소스 대조 + grep), `맞음/틀림/뉘앙스` 판정, 판정 기반 재설계 후보 목록화, **grep=0 으로 확정된 명백한 dead code 제거**, `AgentProfile` 처리 결정.
- **OUT:** X/FinTwit 소셜 신호(→ phase43), orchestrator-worker 라우터(이후), 큰 기능 추가, **검증 안 된 추측성 리팩토링**, 의도된 스코프(예: KR 종목 RAG 미대상)에 대한 "수정".

## 검증 대상 — SUMMARY 주장 vs 실제 코드 (직접 대조)

> 라벨 = SUMMARY 가 매긴 심각도. 검증상태 = 메인이 직접 소스 대조한 결과. 아래는 **검증 백로그**이며, plan.md 가 이를 P-단계로 분해한다.

### P0 — 정확성/보안 (동작 영향, SUMMARY 주장)

| #   | 주장                                                                                                                                           | 근거 위치                                                    | 검증상태                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 1   | `StubFinanceContextProvider` 프로덕션 상주 — context 스테이지가 포트폴리오/알림/뉴스/watchlist 를 빈 값, `marketSession` 항상 `{isOpen:false}` | `composition/runtime.ts:148`, `pipeline-context.ts`          | ⬜ 미검증 (제품 가치 직결 — 의도된 미구현인지 빠진 배선인지 1순위)          |
| 2   | `tables/alerts.ts` ↔ DDL 컬럼 불일치 — `createAlert/getAlert` 가 DDL 에 없는 `symbol/condition_value/condition_field` INSERT/SELECT            | `storage/.../tables/alerts.ts:6-63` vs `database.ts:100-117` | ⬜ 미검증 (호출처 0 이면 dead 강등, 아니면 런타임 SQLite 오류)              |
| 3   | `require-approval` 정책이 실행을 차단 안 함 — registry 9단계가 `deny` 만 막음                                                                  | `agents/tools/registry.ts:318-327`                           | ⬜ 미검증 (보안 갭 — MCP bridge deny + Discord 승인으로 충분한지 판단 필요) |
| 4   | Discord 슬래시 커맨드 4종 deps 미주입 — `setupCommandRouter(client, {})`                                                                       | `channel-discord/.../adapter.ts:58`                          | ⬜ 미검증 (멘션만 쓸 거면 dead, 쓸 거면 배선)                               |
| 5   | finnhub `volume: 0` 하드코딩 → volume 알림 무용                                                                                                | `skills-finance/.../market/normalizer.ts:99`                 | ⬜ 미검증                                                                   |
| 6   | `ackStage` 가 messageId 빈 문자열 전달 → 👀 반응 무효 가능                                                                                     | `auto-reply/pipeline.ts:209`                                 | ⬜ 미검증                                                                   |

### P1 — 드리프트/일관성 (선언 vs 실제)

| #   | 주장                                                                                                       | 근거 위치                                   | 검증상태  |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------- |
| 7   | OpenAI embedding fallback 잔존 — ph38 "Claude-only" 선언 후에도 VOYAGE 키 없으면 `OPENAI_API_KEY` fallback | `storage/.../embeddings/provider.ts:31-51`  | ⬜ 미검증 |
| 8   | `RpcMethod` 유니온 ↔ 핸들러 등록 이중 관리 (agent.list 드리프트 발현)                                      | `types/src/gateway.ts:2-48`                 | ⬜ 미검증 |
| 9   | OpenAI-compat 라우터 미구현 — enabled 여도 streaming `[DONE]`만, sync 501                                  | `gateway/.../openai-compat/router.ts:59,67` | ⬜ 미검증 |

### P2 — 죽은 코드 / 유지보수 부채

| 항목                                                                                  | 근거 위치                      | 검증상태                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `AgentProfile` 타입 완전 dead                                                         | `types/src/agent.ts:4`         | ✅ **확정** (grep=1, 자기 정의뿐. import/사용 0. 역할은 `AgentInfo`/`AgentRunParams`/`AgentRun`/`identity.md` 로 분화) |
| web `trace-view.ts`/`audit-view.ts` 데드 (main.ts import·탭 없음)                     | `web/src/views/`               | ⬜ 미검증                                                                                                              |
| `tables/alerts.ts` 함수 dead 의심 (index.ts re-export 는 `updateAlertTrigger` 만)     | `storage/.../tables/alerts.ts` | ⬜ 미검증 (#2 와 연결)                                                                                                 |
| 중복: `callWithRotation` 3파일 / `isTransientError` 6+파일 / `app-gateway.ts` 412 LOC | skills-finance, web            | ⬜ 미검증                                                                                                              |
| `memory_chunks.hash` 컬럼 무용 (addMemory 미설정)                                     | `storage/.../database.ts`      | ⬜ 미검증                                                                                                              |
| plugins `loadPluginModule`/`createPluginBuildApi` unexport 검토                       | `server/src/plugins/`          | ⬜ 미검증                                                                                                              |

## plan.md 가 반드시 결정할 것 (감독 포인트)

- **검증 → 처리 매핑.** 각 항목의 판정(`맞음/틀림/뉘앙스`) 후 처리를 3택으로: **(a) 즉시 수정** / **(b) 재설계 후보로 승격(별도 phase)** / **(c) dead·의도된 스코프 → 제거 또는 기록만**.
- **재설계 스코프 경계.** "전체적인 재설계"의 어디까지가 phase42(기초)이고 어디부터가 후속 phase 인가. phase42 는 **검증 + 명백한 dead 정리 + 재설계 대상 목록**까지로 한정할지.
- **P0 #1 우선순위.** `StubFinanceContextProvider` 가 의도된 미구현(스코프 밖)인지 빠진 배선인지 — 금융 비서의 핵심 가치라 검증 1순위.
- **P0 #3 보안 결정.** `require-approval` 을 registry 레벨에서 막을지, MCP deny + Discord 승인으로 충분하다 볼지.
- **dead code 제거 범위.** `AgentProfile` 처럼 grep=0 확정된 것만 제거할지(외과적), CLAUDE.md §3("요청 안 한 dead code 는 삭제 말고 언급")과 충돌 없도록.

## 컨벤션

- **검증 방법:** 코드 직접 읽기 + `grep` 으로 호출처/import 확인. 서브에이전트는 fan-out 탐색에만 쓰고, 헤드라인 주장은 메인이 1차 출처로 재확인.
- **수정 방법:** 외과적 변경(CLAUDE.md §3). 검증으로 확정된 줄만 건드린다.
- **테스트 baseline:** unit **1641** (phase41 기준 — MEMORY `project_phase41_sdk_removal`), 착수 시 재확인. mock-only 유지(실 키/네트워크 금지).
- **참고 산출물:** `_workspace/codebase-read/{SUMMARY,P1-types~P8-clients}.md`(서브에이전트 정독), `_workspace/codebase-reading-order.md`(읽기 순서 가이드). 이들은 **검증 입력**이지 정답이 아니다.
