# Phase 43 계획 — 에이전트 라우팅 재설계 (thin orchestrator)

> 작성 2026-05-29 · base = main `e3af851` (phase42 머지) · 선행: `plans/phase43/kickoff.md`, `plans/phase42/review.md`, `_workspace/phase42-codebase-report/REPORT.md`
> 상태: **초안 — 사용자 승인 대기.** 승인 후 todo.md 분해 → 밀스톤 구현 → review.md. (코드 전 plan 승인 게이트.)
> 분석 근거: integration-analyst 통합 컨텍스트 분석(현재→목표 seam 매핑, 코드 실측).

## 0. 목표와 경계

**목표:** 메인 에이전트를 **분류·위임 중심(thin orchestrator)** 으로 재구성한다. read-only 도메인 조회를 `route_task` 함수 dispatch(LLM 0)로 흡수하고, 무거운 분석은 서브에이전트로 위임한다. = "메인은 무엇을 할지 판단·위임하고, 실제 일은 함수/서브에이전트가 한다."

```
Discord → 메인 claude CLI (ReAct=분류기) → route_task → 함수(quoteService 등 직접) / 서브에이전트(좁은 CLI) → 결과
                                          └ 메인 직접 유지: datetime · list_alerts · get_alert_history · schedule_manage
```

**경계:**

- **IN (phase43):** route_task 함수 dispatch 확장(price_lookup/chart_data/news_summary/portfolio_calc), 직접 도구의 메인 노출 정리, system prompt 재작성, 서브에이전트 정의 구조(agentDir/sub-agent 프롬프트), `if(newsHandle)` 결합 분리.
- **OUT → phase44:** dead-code sweep(감사 77건) + 부팅 안전장치 4종 의도성 확인. (라우팅 재설계가 일부 dead-code 를 자연 흡수하므로 sweep 은 그 뒤가 순서상 맞음.)
- **OUT (불변/보존):** 메모리 RAG, cron(설정 `schedule_manage` + 작동 `automation`), read-only 우선, 매수=사람, 키 없이 부팅, X/FinTwit(phasex 파킹).

## 1. ★ 확정 아키텍처 — CLI ReAct 가 분류기, MCP bridge 가 도구 표면

> **이 전제를 놓치면 설계가 통째로 어긋난다 (analyst §0).**

- CLI 모드에서 **in-process `Runner`/`ExecutionToolDispatcher` 는 도구 실행 dead** — 단발 `streamCompletion` 1회 후 종료(`runner.ts:154`). 실제 ReAct·도구 호출은 spawn 된 claude CLI 가 `/mcp` 로 한다.
- **메인 에이전트가 보는 도구 표면 = `gateway/src/mcp/bridge.ts` 가 노출하는 ToolRegistry 도구** (group allowlist + 강제 deny). 이미 상태변경 6도구(`web_fetch`·`read_local_file`·`set_alert`·`remove_alert`·`schedule_manage`·`brokerage_sync_holdings`)를 deny → 메인은 read-only 우선이 강제됨.
- **"분류"는 claude CLI 자신의 ReAct + system prompt** (`prompts/finclaw.system.ko.md`)가 한다. **별도 분류 단계 불필요** (LLM 2회 = 토큰·레이턴시 2배, 단발-CLI 구조와 충돌).

**∴ 재설계 레버 3개 (코드 변경 지점):**

1. **`route_task` 함수 dispatch 확장** — `router/dispatch.ts` 의 not-implemented 분기를 내부 service 직접 호출로 구현 + dispatcher 에 `quoteService`/chart/tracker 주입(`composition/skills.ts` 와이어링).
2. **MCP 노출 도구 조정** — 직접 도메인 도구(시세·차트·뉴스·포트)를 메인 노출에서 제거(unregister 또는 bridge deny), route_task 만 남김. ToolRegistry 에는 유지(route_task 가 내부 service 호출).
3. **system prompt 재작성** — `finclaw.system.ko.md` 의 도구 가이드를 "조회·분석은 route_task 로 위임" 으로.

## 2. 도구 표면 재설계

| 도구                                                                                                 | 현재                       | 목표 분류                                  | 처리                            |
| ---------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------ | ------------------------------- |
| `get_stock_price`/`get_crypto_price`/`get_forex_rate`                                                | 메인 직접                  | **함수** (price_lookup)                    | route_task 흡수, 메인 노출 제거 |
| `get_market_chart`                                                                                   | 메인 직접                  | **함수** (chart_data)                      | route_task 흡수, 메인 노출 제거 |
| `get_financial_news`                                                                                 | 메인 직접                  | **함수** (news_summary)                    | route_task 흡수, 메인 노출 제거 |
| `get_portfolio_summary`                                                                              | 메인 직접                  | **함수** (portfolio_calc, 민감플래그 유지) | route_task 흡수, 메인 노출 제거 |
| `analyze_market`                                                                                     | route_task(이미)           | **서브에이전트** (market_analysis)         | 유지 (phase42 완료)             |
| `get_current_datetime`                                                                               | 메인 직접                  | 메인 직접 유지                             | 순수함수, 위임 오버헤드 불요    |
| `list_alerts`/`get_alert_history`                                                                    | 메인 직접                  | 메인 직접 유지                             | read-only 조회                  |
| `set_alert`/`remove_alert`/`schedule_manage`/`brokerage_sync_holdings`/`web_fetch`/`read_local_file` | MCP deny(이미 메인 비노출) | 메인 직접 유지(노출 안 됨)                 | 현행 deny 유지                  |

**함수 vs 서브에이전트 기준 = 내부 LLM 호출 필요 여부.** 시세·차트·뉴스fetch·포트계산 = 결정적 함수(`source:'function'`). market_analysis = LLM 서브에이전트(`source:'sub-agent'`).

## 3. 마일스톤 (phase43 = M1–M4)

- **M1 — 도구 인벤토리·경계 확정 + system prompt 재작성.** 코드변경 최소(프롬프트). 검증: `finclaw.system.ko.md` 가 route_task 위임 가이드 반영, 도구 표면 표 확정. typecheck/test 회귀 0.
- **M2 — route_task 함수 dispatch 확장.** `dispatch.ts` 에 price_lookup(quoteService)·chart_data·news_summary·portfolio_calc 구현 + dispatcher 에 market/news handle 주입(skills.ts). 검증: intent별 unit test(mock service) green, `source:'function'`, `isError` 전파.
- **M3 — 직접도구 메인 노출 정리 + `if(newsHandle)` 결합 분리.** 시세·차트·뉴스·포트 도구를 메인 MCP 노출에서 제거, route_task 등록을 newsHandle 결합에서 분리. 검증: MCP `tools/list` 가 route_task + read-only 조회만, 기존 1582 unit 회귀 0, **`pnpm build`+`pnpm format` 포함 전체 게이트**.
- **M4 — 서브에이전트 정의 구조.** `agentDir`/`prompts/sub-agents/*.md` 로더(현재 미구현) + intent 동적 구성(route-task.ts:4 TODO), market_analysis 를 파일 기반으로 재구성. 검증: 로더 unit test, market_analysis smoke. **(범위 큼 — M4 가 43 을 넘기면 44 로.)**

> phase44 = dead-code sweep(감사 §D 직접연관 + 압축/auth:resolve + 배럴) + 부팅 안전장치 4종 의도성 확인(loadDotenv 등 = 제거 아닌 배선 후보) + latent bug(alerts DDL).

## 4. 불변식 보존 + 리스크

| 불변식              | 닿는 지점                                                        | 가드(검증)                                                                             |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| read-only/매수=사람 | MCP deny(bridge.ts:13-20)                                        | route_task 함수가 deny 도구(set_alert/brokerage) 우회 호출 안 함 — 조회만              |
| 메모리 RAG (불변)   | execute stage → system prompt 합성(execution-adapter.ts:159-167) | execute stage 위임·stage 순서 보존, 재설계가 안 깸                                     |
| cron 분리 (보존)    | schedule_manage ↔ automation/scheduler                           | scheduler 도 동일 CLI 단발 — route_task 흡수가 scheduler agent.run 에 영향 없는지 확인 |
| 키 없이 부팅        | route_task `if(newsHandle)` 결합                                 | **M3 에서 결합 분리** — news 키 유무가 메인 도구표면을 바꾸지 않게                     |
| 환각 방지           | route_task isError 전파, 함수 빈/실패 처리                       | 함수 dispatch 가 실패 시 가짜 데이터 안 냄                                             |

**최대 리스크:** (1) §1 전제(도구 표면 = MCP bridge) 오인 시 설계 붕괴. (2) `if(newsHandle)` 결합(skills.ts:139) — M3 필수. (3) M4 `agentDir` 로더는 신규 레이어(미구현) — 범위 큼, 43 못 넘기면 44.

## 5. 열린 질문 해소 (analyst 코드 근거 권고)

1. **분류·위임 경계** → read-only 도메인 조회는 route_task, 알림조회·schedule·datetime 은 메인 직접(이미 MCP deny 가 상태변경 차단과 정합). "거의 0"(datetime 까지 위임)은 오버헤드만 늘어 비채택.
2. **함수 vs 서브에이전트** → 내부 LLM 호출 필요 여부. 조회/계산=함수, 분석=서브에이전트.
3. **분류 방식** → 현행 ReAct 유지(CLI 자체 분류). 별도 단계 = 토큰 2배, 비채택. 레버 = system prompt.
4. **dead-code 공격성** → phase43 은 라우팅 직접연관 정리만. 부팅 안전장치·확장 토대는 phase44 에서 의도성 확인 후(§3, REPORT §6 시급도1, §3 외과적).
5. **phase 분할** → **43 = 라우팅(M1–M4), 44 = dead-code sweep + 부팅 안전장치.** (못 끝내면 M4 도 44 로.)

## 6. 컨벤션 / 검증

- 밀스톤마다 1 커밋, 각 밀스톤 종료 시 **`pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test --run` 전부** (review.md:47 교훈 — tsgo+vitest 만으론 broken build 못 잡음).
- §3 외과적 변경 — todo 가 요구하지 않은 인접 코드 불변. dead-code 제거는 phase44 로 분리.
- 커밋 subject ASCII (lefthook conventional).
