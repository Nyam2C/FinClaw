# Phase 44 킥오프 — dead-code sweep + 서브에이전트 파일 정의(M4)

> 작성 2026-05-29 · base = main `2332e7d` (phase43 머지: thin orchestrator M1~M3)
> 상태: **초안 — plan.md 가 열린 질문 해소 후 사용자 승인 게이트.**
> 선행 입력: `_workspace/phase42-codebase-report/REPORT.md`(감사 77건), `plans/phase43/{plan,todo,review}.md`(M4 명세 + 이연 P1/P2).

## 목표

phase43(라우팅 재설계)에서 이월된 잔여 작업 — **서브에이전트 파일 정의 구조(M4)** + **목표 아키텍처가 불필요하게 만든 dead-code 제거** — 를 마무리한다. = "필요한 거(M4) 만들고, 필요없는 거 정리."

## 작업 4 트랙

### 트랙 A — M4: 서브에이전트 파일 정의 (agentDir 로더)

phase43 todo M4-1~M4-3. `prompts/sub-agents/*.md`(frontmatter id/model/source + body=systemPrompt) 로더 + intent 동적 구성(route-task.ts:4 TODO), market_analysis 를 파일 기반으로 재구성. phase42 `AgentProfile={id,name,model,agentDir}`(현재 dead) 활성화.

### 트랙 B — 부팅 안전장치 4종 (★결정 필요 — 회귀 아님)

`loadDotenv`·`acquireGatewayLock`·`setupUnhandledRejectionHandler`·`assertSupportedRuntime`.

> **교정된 사실(git 이력 실측):** 이 4종은 **회귀가 아니다.** Phase 2(`758a958`/`db115c2`, infra 패키지 초기)에 추가된 이래 **레포 전체에서 호출된 적이 한 번도 없다**(call-site 0). = DOA 추측성 코드(§2 위반 잔재). 감사 REPORT 의 "회귀 의심"은 부정확.

따라서 "배선 복구"가 아니라 **"지금 배선 vs 삭제"의 product 결정**:

- `loadDotenv` — 배선 시 메모리의 ".env 자동 로드 안 됨" 불편 해소. 작고 유용.
- `assertSupportedRuntime` — Node22 가드. 작고 유용.
- `setupUnhandledRejectionHandler` — 크래시 안전. 유용.
- `acquireGatewayLock` — 단일 인스턴스 락. 더 무겁고 1인 환경엔 과할 수 있음.

### 트랙 C — dead-code sweep (감사 77건)

`REPORT.md` §6 우선순위순. 카테고리:

- **확정 dead(A, zero-consumer)** — 안전 제거. 예: `Opaque`/`DeepPartial`(types), `agent-events.ts`/`paths.ts`/env 헬퍼(infra), `tables/messages.ts`, `provider-normalize`, server `services/{hooks,daemon,security}` 배럴 dead 등.
- **vestigial(B, 단일 소비)** — 배럴 over-export 다이어트.
- **orphan-after-phase42/43(E)** — 압축 서브시스템(`agent/agents/context/`), `auth:resolve` 이벤트, `forceToolChoice`/`forceToolName`, phase43 P1/P2(try/catch dedup, `_req`).
- **미완 확장 토대(★결정 필요)** — 플러그인 슬롯·agent 세션 클러스터·`atomicReindex`: 보존(미래 토대) vs 제거(§2).

### 트랙 D — latent bug

`storage/tables/alerts.ts` `createAlert` 가 DDL 에 없는 컬럼 INSERT(파일 전체 dead라 현재 안전). 파일 제거 OR DDL 수선.

## 보존 (불변)

메모리 RAG · cron · read-only · 매수=사람 · 키없이부팅 · thin orchestrator(phase43). X/FinTwit(phasex).

## plan.md 가 해소할 열린 질문

1. **부팅 안전장치(트랙 B)** — (a) 유용한 것 배선(loadDotenv+runtime-guard+unhandled-rejection) + acquireGatewayLock 은 삭제 / (b) 4종 다 배선 / (c) 4종 다 삭제(§2 DOA 정리, 필요 시 후속 재구축).
2. **dead-code 공격성(트랙 C)** — 확정 dead(A)+orphan(E)만 안전 제거 / + 배럴 다이어트(B) / + 미완 확장 토대(플러그인 슬롯·세션 클러스터)까지 제거.
3. **M4 포함 여부** — 트랙 A(M4)를 phase44 에 포함 / M4 는 별도(라우팅 후속)로 두고 phase44 = dead-code 만.
4. **phase 분할** — 4 트랙이 phase44 에 다 들어갈지, 트랙별로 44/45 분할할지.

## 산출물

이 kickoff + `plan.md`(트랙별 마일스톤) → 승인 → `todo.md` → 구현 → `review.md`. (44 초과 시 45 이월 — 사용자 허용.)
