# Phase 44 review — dead-code sweep + 부팅 안전장치 배선 + M4 (전체 M-A~C8)

> 작성 2026-05-29 · 브랜치 `feature/phase44` · base = main `2332e7d` (phase43 머지)
> agent team (phase-qa-engineer + phase-refactor-expert) 병렬 검증 통합.
> 평가 범위: M-A~C8 (10 밀스톤 커밋 `e08e53d`~`7c3fe23` + stale 주석 수정).
> 결론: **merge 가능.** blocker 0. 순삭제 **−3936 LOC**(69파일, −4795/+859 incl. M-A 신규).

## 1. 무엇을 했나

phase43 thin orchestrator 이후, 목표 아키텍처가 불필요하게 만든 dead-code 를 공격적으로 제거하고, DOA 부팅 안전장치를 배선하고, M4(서브에이전트 파일 정의)를 완성했다.

| 밀스톤   | 내용                                                                                                                                        | 커밋      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| M-A      | 서브에이전트 파일 정의 로더(agent-loader.ts, `parsePrompt` 재사용) + `prompts/sub-agents/market_analysis.md` + `AgentProfile`(types) 활성화 | `e08e53d` |
| M-B      | 부팅 안전장치 3종 배선(`loadDotenv`/`assertSupportedRuntime`/`setupUnhandledRejectionHandler`) + `gateway-lock` 삭제                        | `c2c3113` |
| C1       | types dead 제거 (Opaque/DeepPartial/SkillDefinition 구세대/finance 변종)                                                                    | `ed9a202` |
| C2       | infra dead 제거 (agent-events·auth:resolve event)                                                                                           | `7e48595` |
| C3       | storage dead 제거 (messages/alerts 테이블·atomicReindex·rerank 래퍼) + **M-D latent bug 해소**                                              | `eee9e6c` |
| C4       | agent dead 제거 (압축 서브시스템·세션 write-lock/transcript·provider-normalize·forceTool endpoint·maskApiKey)                               | `c7a703f` |
| C5       | skills dead 제거 (analyze_market model plumbing·defaultModel cascade)                                                                       | `fcf080c` |
| C6       | gateway 배럴 over-export 다이어트 + stale 주석                                                                                              | `4736be2` |
| C7       | server dead 제거 (services/{hooks,security,daemon}·DefaultPipelineObserver·chat-type·배럴)                                                  | `a630bd7` |
| C8       | clients dead 제거 (web 관찰성 UI·discord buildErrorEmbed)                                                                                   | `7c3fe23` |
| (review) | stale 주석 수정 (token-fn.ts)                                                                                                               | 본 커밋   |

**부팅 안전장치 = 회귀 아님(교정):** git 이력 실측 — 4종 전부 Phase 2 이래 호출 이력 0(DOA 추측성). "배선 복구"가 아니라 product 결정 → 사용자 결정대로 유용한 3종 배선, gatewayLock 삭제.

## 2. QA 검증 결과 (phase-qa-engineer)

- **자동 게이트:** format 0 · lint 0 · typecheck 0 · **build(tsc --build) 0** · test **1480 pass** (180 files). 외부 키 0(mock 격리).
- **TODO↔구현:** M-A~C8 전부 ✅ (HOLD 는 의도된 보류, deferred 는 phase45).
- **삭제 잔재 0:** 삭제 심볼의 dangling import/배럴/참조 0(build 0 증명). 고아 파일 0. (stale 주석 1건 → 본 커밋서 수정.)
- **HOLD 보존 11/11:** false-positive 로 보류한 심볼 전부 코드에 살아있음 — **실수 삭제 0건**(§4).
- **불변식 회귀 0:** 메모리 RAG(reranker)·cron·thin orchestrator·alerts live(skills-finance/alerts, C3 는 storage alerts.ts 만 삭제)·read-only.
- **M-B 배선 정확:** main.ts loadDotenv(최상단, config 전)→assertSupportedRuntime→setupUnhandledRejectionHandler(logger 후). VITEST 가드로 테스트 부작용 0.

## 3. 리팩토링 검토 (phase-refactor-expert)

**삭제 외과성 우수 — scope creep 0, "통째 삭제 함정" RV+HOLD 가 차단.** 검증된 부분삭제: paths(getLogDir live→전체 HOLD)·provider-normalize(normalize만)·forceToolName(endpoint만, retry 보존)·세션(write-lock만, tool-result-guard 보존)·errors(maskApiKey만, FailoverError 보존). HOLD 판단 전수 타당(과보존/과삭제 0).

| #        | 위치                 | 내용                                                         | 처리                                                                                           |
| -------- | -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| QA-nit   | token-fn.ts:2        | 삭제된 `compactContext` 참조 stale 주석                      | ✅ **수정**                                                                                    |
| P1       | dispatch.ts:44-50    | `AgentProfile` 활성화가 `model`만 읽고 id/name/agentDir dead | ⏭️ phase45 (decision1 토대 — 실 orchestrator-worker spawn 이 id/agentDir 소비, 또는 그때 trim) |
| P2       | agent-loader.ts:30   | model/source frontmatter 누락 시 silent default              | ⏭️ phase45 (현 1파일 환경 무해)                                                                |
| P2       | dispatch.ts:36       | loadSubAgents 매 빌드 I/O                                    | ⏭️ 현 부팅 1회라 무해                                                                          |
| (범위밖) | tool-result-guard.ts | `TRUNCATION_SUFFIX` over-export (기존, phase44 무관)         | phase45 배럴 trim                                                                              |

## 4. HOLD / 감사 false-positive 기록 (★중요)

공격적 삭제의 핵심 — 감사(REPORT.md, sonnet grep)가 "dead"라 한 것 중 **RV 로 live 판명되어 보존한 11종**. `_workspace/phase-execute/phase44-holds.md` 전수 기록.

- **infra:** `paths.ts`(getLogDir ← logger-transports, 전 패키지 logger 체인)·`env.ts`(getEnv ← paths transitive). → whole-file delete 보류, 진짜 dead 형제 6+4는 phase45 외과 trim.
- **agent:** `FailoverError`(classifyFallbackError instanceof)·`tool-result-guard.ts`(runner import)·`NormalizedUsage`(StreamChunk).
- **server:** tokenCounter plumbing(runtime→pipeline, graceful-degrade 설계 = live)·플러그인 슬롯(registerToSlot writer live, getSlot reader-orphan → 전체 HOLD)·channels/registry reader(partial-dead in live module).
- **clients:** channel-discord 대거 오판 — `buildMarketEmbed`/`buildNewsEmbed`/`buildAlertEmbed`·`FinanceServicePort`/`AlertStoragePort`·`SlashCommand`/`DiscordAccount`·`setupApprovalHandler` 전부 **live(command-wired)** → `buildErrorEmbed` 1건만 삭제. approval producer 클러스터 HOLD.

**교훈:** 감사 보고서는 1차 인벤토리일 뿐 — 공격적 삭제엔 삭제 직전 RV 가 필수. 특히 transitive 소비·partial-cluster·write-only-orphan·command-wired UI 에서 grep-only 감사가 오판.

## 5. phase45 이월

- **라우팅 잔여:** M-A-5(b) intent 동적화(`registerRouteTaskTool` 시그니처 주입) + C5 `ROUTE_INTENTS.includes` 도달불가 분기.
- **dead-code 잔여:** C2 paths/env 외과 trim(진짜 dead 형제 10)·C6 OpenAI-compat stub 제거·C7-5 플러그인 슬롯 reader·C7 channels/registry reader·C8 discord approval producer 클러스터 결정·`TRUNCATION_SUFFIX` 배럴.
- **품질:** P1 `AgentProfile` dead 필드(실 spawn 배선 시 해소)·P2 loader default·mcp.test flake 안정화.
- phase43 review P1/P2(try/catch dedup·`_req`)는 dead-code 범위 밖(§2)이라 미착수 — 필요 시 phase45.

## 6. 한 줄 결론

phase44 (dead-code sweep −3936 LOC + 부팅 안전장치 배선 + M4) 는 전 게이트 green, HOLD 11/11 보존(실수 삭제 0), 삭제 외과성·불변식 보존 검증 완료, blocker 0 — **merge 가능.** false-positive 차단(RV+HOLD)이 공격적 삭제를 안전하게 만들었고, 잔여는 phase45 로 명확히 이월.
