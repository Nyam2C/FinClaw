# Phase 42 review — 기초 검증 + 재설계 그라운드워크

> 작성: 2026-05-29. agent team (phase-qa-engineer + phase-refactor-expert) 병렬 검증 통합.
> 평가 범위: `c1a3f8e..HEAD` — 커밋 `91046f0`(A+B), `f74b67b`(C cascade), `2c41ef8`(D 이연 docs), `<rename>`(P0).
> 결론: **main 머지 준비 완료.** blocker 0.

## 1. 무엇을 했나

phase42 = 재설계 그라운드워크. 결정 1~5 중:

| 결정 | 내용 | 상태 |
| ---- | ---- | ---- |
| 1 | `AgentProfile` 재설계 (orchestrator-worker 워커 타입, type-first) | 적용 (이전 커밋) |
| 2 | `ModelRef` 슬림 (`contextWindow`/`maxOutputTokens` 제거) | 적용 (이전 커밋) |
| 3 | `AuthProfile` 제거 (죽은 LLM 키-로테이션 클러스터) | 적용 (이전 커밋) |
| 4 | `AgentRunParams`/`ProviderRequestParams` 슬림 (CLI 무시 SDK-era 필드) | 적용 (이전 커밋) |
| 5-A | `route_task` 타입 골격 (`types/router.ts`) | ✅ `91046f0` |
| 5-B | route_task PoC — `market_analysis` sub-agent dispatch, `analyze_market` 메인 노출 제거 | ✅ `91046f0` |
| 5-C | 구 routing 전체 cascade 삭제 (routerHelper/ModelTier/RoutingConfig…) | ✅ `f74b67b` |
| 5-D | intent 확장 (price_lookup/chart_data) | ⏭️ **phase43 이연** |

**route_task 아키텍처 (현 상태):** 메인 에이전트가 `route_task({intent, query, symbol?})` 호출 → `buildRouteDispatcher`(server/router/dispatch.ts) 가 intent 분기 → `market_analysis` 는 `runSubAgent`(claude CLI 재호출, 좁은 컨텍스트)로 위임. `analyze_market` 직접 도구는 메인에서 unregister. = 사용자 목표 아키텍처(Discord → 메인 → 분류 → 함수/서브에이전트)의 토대.

## 2. QA 검증 결과 (phase-qa-engineer)

- **자동 검증:** typecheck exit 0 · unit **1582 pass** (188 files, 0 fail/skip) · storage **154 pass** (23 files) · lint **0 errors** (581 files). (rename 후 재확인 typecheck 0 / lint 0.)
- **TODO↔구현 1:1:** 마일스톤 A/B/C 전 체크박스 ✅. D 4항목 deferred (의도).
- **경계면 교차 검증 5항목 OK:**
  - route_task inputSchema ↔ dispatcher `RouteRequest` shape 일치
  - dispatch → runSubAgent → runCliAgent 인자/반환 타입 일치 (`prompt`↔`query`, usage `?? 0` 변환)
  - analyzeMarket runner 클로저 ↔ dispatch 주입 클로저 시그니처 일치
  - skills.ts route_task 등록 + analyze_market unregister 배선 정상 (newsHandle 조건 일관)
  - C cascade 일관성: fallback chain(floor 제거 후 단순 model-id 리스트), scheduler/gateway/status 모두 일관
- **mock 격리:** 1582 유닛 전부 외부 키 없이 통과.

## 3. 리팩토링 검토 (phase-refactor-expert)

7 후보. **merge-blocker 0.** P0 만 적용, 나머지 phase43 이연.

| # | 위치 | 내용 | 처리 |
| - | ---- | ---- | ---- |
| P0 | router/dispatch.ts·skills.ts | `buildDispatcher` 이름이 agent(tool-dispatcher) 와 충돌 | ✅ **`buildRouteDispatcher` 로 rename** (적용) |
| P1-2 | router/dispatch.ts:28-35 | not-implemented 4 intent 가 `source:'function'` 오용 + `isError:true` | ⏭️ phase43 (intent 모델 재설계 시) |
| P1-3 | news/index.ts·tools.ts·skills.ts | `defaultModel` dead plumbing — register→즉시 unregister 로 도달 불가 | ⏭️ phase43 dead-code sweep |
| P1-4 | dispatch.ts·sub-agent.ts | `claude-opus-4-7` 모델 ID 상수 중복 | ⏭️ phase43 |
| P2-5 | route-task.ts:59 | `ROUTE_INTENTS.includes` 도달 불가 분기 (zod enum 이 이미 검증) | ⏭️ phase43 |
| P2-6 | news/tools.ts:32 | `ANALYZE_MARKET_FALLBACK_MODEL.provider:'anthropic'` stale (실 경로는 claude-cli) | ⏭️ phase43 |
| P2-7 | route-task.ts:56 | `(input.query as string) ?? ''` 불필요 nullish | ⏭️ phase43 |

**이연 사유:** phase43 이 이 dispatch 계층을 재설계하므로(사용자 목표), 곧 사라질/바뀔 코드 리팩토링은 §2 낭비. refactor-expert 도 P1~P2 전부 "phase43 자연해소"로 동의.

## 4. phase43 으로 넘기는 것 (dead-code 백로그 + 신규)

- **D intent 확장** — price_lookup/chart_data. 단, `get_stock_price`·`get_market_chart` 직접 도구와 중복 해소 + pykrx 스코프(KR 종목, §2) 재검토와 함께 설계.
- **route_task enum 정리** — 현재 5 intent 노출, market_analysis 만 구현.
- **신규 orphan (C 부산물):** `buildDispatcher`(agent) 의 `toolDefinitions` 반환 = production 소비 0 (test-only). `defaultModel`/`ANALYZE_MARKET_FALLBACK_MODEL` dead plumbing. `skill.ts` minModel stale 주석.
- **기존 dead-code 백로그 (todo.md):** 압축 서브시스템(`agent/agents/context/`), `auth:resolve` 이벤트, `forceToolChoice`/`forceToolName` plumbing.
- **전체 레포 감사:** `_workspace/phase42-codebase-report/REPORT.md` (77 finding, net-new 49) — phase43 삭제 스코프의 1차 입력.

## 5. 한 줄 결론

phase42 (그라운드워크: type 슬림화 결정 1~4 + route_task 토대 A/B + routing cascade 삭제 C) 는 typecheck/test/lint green, 경계면 일관, blocker 0 — **main 머지 가능.** intent 확장·dead-code 정리·전체 재설계는 phase43.
