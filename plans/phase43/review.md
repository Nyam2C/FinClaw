# Phase 43 review — 에이전트 라우팅 재설계 (M1~M3)

> 작성 2026-05-29 · 브랜치 `feature/phase43` · base = main `e3af851`
> agent team (phase-qa-engineer + phase-refactor-expert) 병렬 검증 통합.
> 평가 범위: M1~M3 (`95fcf16`·`99c5228`·`d29d2bc` + P0 주석 수정). **M4 는 phase44 이월.**
> 결론: **M1~M3 = thin orchestrator 본체 완료, merge 가능.** blocker 0.

## 1. 무엇을 했나

사용자 목표 아키텍처 — 메인 에이전트를 **분류·위임 중심(thin orchestrator)** 으로 — 의 본체를 구현했다.

| 밀스톤   | 내용                                                                                                                                                                        | 커밋      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| M1       | system prompt(`finclaw.system.ko.md`) → route_task 위임 가이드 재작성                                                                                                       | `95fcf16` |
| M2       | route_task 함수 dispatch 4 intent(price_lookup·chart_data·news_summary·portfolio_calc) — service 직접 호출(LLM 0). market `ChartService` 신설. dispatch.test 신규(8 케이스) | `99c5228` |
| M3       | 직접 도메인 도구 7종(시세3·차트·뉴스·분석·포트) 메인 노출 unregister + `if(newsHandle && marketHandle)` 결합 정합 + 노출 가드 test                                          | `d29d2bc` |
| (review) | P0 stale JSDoc 수정(dispatch.ts — "B 범위 1 intent" → 5 intent 현행)                                                                                                        | 본 커밋   |

**달성 아키텍처:**

```
Discord → 메인 claude CLI (분류·위임 전용) → route_task → 함수(quoteService/chartService/newsAggregator/portfolioTracker 직접) / market_analysis 서브에이전트 → 결과
                                            └ 메인 직접 유지: datetime · list_alerts · get_alert_history (read-only 조회)
```

메인 에이전트는 더 이상 도메인 도구를 직접 들지 않는다. 모든 조회·분석은 route_task 위임.

**M4 (이월):** agentDir/`prompts/sub-agents/*.md` 로더 + intent 동적 구성 = phase44 (신규 레이어, 범위 큼 — plan §3·§4 가 이월 허용).

## 2. QA 검증 결과 (phase-qa-engineer)

- **자동 게이트(독립 재확인):** format 0 · lint 0 · typecheck 0 · **build(tsc --build) 0** · test **1591 pass** (189 files). (phase42 교훈 반영 — build 포함.)
- **TODO↔구현 1:1:** M1/M2/M3 9단계 전부 ✅. M4 4단계 deferred.
- **경계면 교차 검증 전항목 OK:**
  - system prompt(M1) ↔ 도구 표면(M3): 위임 안내 7도구 = unregister 대상과 일치, 메인 직접 유지 도구는 unregister 제외.
  - dispatch(M2) ↔ service 시그니처: getQuote/getChart/fetchNews/summarize 호출 일치, `source:'function'`·`isError` 전파 정확.
  - **M3 unregister 부작용 0:** (a) alerts 모니터는 `cache`/`providers` 직접 받음(도구 미경유) — 영향 없음, (b) scheduler 도 같은 ToolRegistry → 스케줄 실행도 route_task 만 봄(thin orchestrator 일관, 의도됨), (c) status 카운트 반영(의도).
  - chartService ↔ getChartFromState: 동일 헬퍼 공유, 드리프트 0.
  - 결합: route_task 등록·unregister 모두 `if(newsHandle && marketHandle)` → 키 유무가 표면을 모순되게 안 만듦.
- **mock 격리:** dispatch.test 9 케이스 외부 키/네트워크 0.

## 3. 리팩토링 검토 (phase-refactor-expert)

6 후보. blocker 0.

| #         | 위치                              | 내용                                            | 처리                                                                     |
| --------- | --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| P0        | dispatch.ts:13-19                 | stale JSDoc("B 범위 1 intent")가 M2 구현과 모순 | ✅ **수정(현행 5 intent 반영)**                                          |
| P1        | dispatch.ts dispatchPortfolioCalc | `req` 미사용 파라미터                           | ⏭️ phase44 (lint=0 통과 — blocker 아님; M4 시 정리)                      |
| P1        | dispatch.ts 함수 4개              | try/catch error-wrap 4회 반복                   | ⏭️ phase44 (M4 가 intent 추가 시 헬퍼 추출 — 지금 추출은 §3 조기 추상화) |
| P2        | dispatch.test.ts                  | InMemoryToolRegistry import 1곳·캐스팅 주석     | ⏭️ 선택                                                                  |
| P2        | market/index.ts                   | chartService vs quoteService 스타일 비대칭      | ⏭️ 선택                                                                  |
| (범위 밖) | market/index.ts:6                 | market→news 역방향 import(기존, phase43 무관)   | phase44 검토                                                             |

**P1/P2 이연 사유:** phase44 가 M4(intent 확장) + dead-code sweep 으로 이 코드를 곧 확장·정리하므로, 지금 헬퍼 추출/스타일 정리는 §2(조기 추상화)·§3(외과적) 낭비. refactor-expert 도 동의.

## 4. 불변식 보존 확인

- **메모리 RAG:** execute stage·memory-\* stage·storage/search 무변경 — 재설계가 안 건드림. ✅
- **cron:** schedule_manage(설정) + automation/scheduler(작동) 무변경. scheduler 도 thin orchestrator 일관(route_task 만 노출). ✅
- **read-only/매수=사람:** route_task 함수는 read-only service(quote/chart/news/portfolio-read)만 호출, 상태변경 service 미주입. MCP deny 6도구 유지. ✅
- **키 없이 부팅:** 결합 분리로 키 유무가 도구 표면을 일관되게 토글. ✅
- **환각 방지:** 함수 dispatch 실패 시 `isError:true` + 실제 에러 메시지(가짜 데이터 0). ✅

## 5. 한 줄 결론 + 남은 것

phase43 M1~M3 (thin orchestrator 본체) 는 전 게이트 green, 경계면 일관, 불변식 보존, blocker 0 — **merge 가능.**

**남은 것:**

- **M4** (서브에이전트 파일 정의 구조 — agentDir 로더) → phase44.
- **phase44** = M4 + dead-code sweep(감사 77건, `_workspace/phase42-codebase-report/REPORT.md`) + 부팅 안전장치 4종 의도성 확인 + alerts DDL latent bug + 본 review 의 P1/P2 정리.
