# Phase 44 계획 — dead-code sweep(공격적) + 부팅 안전장치 배선 + 서브에이전트 파일 정의(M4)

> 작성 2026-05-29 · base = main `2332e7d` (phase43 머지) · 선행: `plans/phase44/kickoff.md`, `_workspace/phase42-codebase-report/REPORT.md`(감사 77건 + lane별 상세), `plans/phase43/{todo,review}.md`(M4 명세 + P1/P2).
> 상태: **초안 — 사용자 승인 대기.** 승인 후 todo.md 분해 → 밀스톤 구현 → review.md.

## 0. 확정 결정 (사용자)

- **부팅 안전장치:** `loadDotenv`·`assertSupportedRuntime`·`setupUnhandledRejectionHandler` **배선**(main.ts 부팅), `acquireGatewayLock`(+`gateway-lock.ts`) **삭제**.
- **dead-code 공격성: 스캐폴드까지 전부 제거.** 확정 dead(A) + orphan(E) + 배럴 over-export(B) + **미완 확장 토대(플러그인 슬롯·agent 세션 클러스터·atomicReindex 등)** 까지.
- 44 초과 시 phase45 이월(허용).

## 1. 안전 원칙 (공격적 삭제의 가드)

> 감사(77건)는 sonnet 에이전트 grep 산출 — **false positive(실제 live 인데 dead 라 주장) 가능**. 따라서:

1. **삭제 전 재검증:** 각 심볼 삭제 직전 `rg "\bSYMBOL\b" packages/*/src` 로 비-self·비-test 소비처 0 재확인. 소비처 발견 시 **삭제 보류 + review 에 기록**(감사 오판).
2. **레이어 바텀업 제거:** types → infra → storage → agent → skills → gateway → server → clients 순. 하위 레이어 제거 후 게이트 통과해야 상위로(소비처 cascade 가 즉시 드러남).
3. **밀스톤마다 전체 게이트:** `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test --run` 전부 (build=tsc --build 필수, phase42 교훈).
4. **삭제 동반 정리:** 심볼 삭제 시 배럴 re-export·전용 테스트·import 동반 제거(고아 금지). 단 §3 — 무관 인접 코드 불변.
5. **보존 불변:** 메모리 RAG · cron · read-only · 매수=사람 · thin orchestrator(phase43). 이들이 쓰는 심볼은 "dead 아님" — 재검증으로 확인.

## 2. 마일스톤

### M-A — 서브에이전트 파일 정의 (M4, phase43 이월)

phase43 todo M4-1~M4-3: `packages/server/prompts/sub-agents/market_analysis.md`(frontmatter) + `router/agent-loader.ts`(frontmatter+body 파서, 기존 프롬프트 로더 있으면 재사용) + loader test + `dispatchMarketAnalysis`/route-task intent 를 로더 기반으로 재구성. `AgentProfile`(types, 현재 dead) 활성화.

- 검증: loader unit test, market_analysis smoke(mock runSubAgent), 전체 게이트.
- **범위 주의:** route-task.ts `ROUTE_INTENTS` 동적화는 `registerRouteTaskTool(registry, dispatcher, intents)` 시그니처 변경(server 가 intent 주입 — skills-general→server 의존 불가 제약). 크면 로더 토대만 두고 동적화는 분리.

### M-B — 부팅 안전장치 배선 + gatewayLock 삭제

- `packages/server/src/main.ts` 부팅 진입부에 배선: `loadDotenv()`(최상단, config 로드 전) · `assertSupportedRuntime()`(Node22 가드) · `setupUnhandledRejectionHandler(logger)`(logger 생성 후). 실제 main.ts 부팅 시퀀스 Read 후 정확한 위치 삽입.
- **삭제:** `packages/infra/src/gateway-lock.ts` + `infra/index.ts` 의 `acquireGatewayLock`/관련 export + 전용 테스트.
- 검증: 부팅 smoke(키 없이 `pnpm dev` 가 .env 자동 로드 + Node 가드 통과), 전체 게이트.

### M-C — dead-code sweep (레이어 바텀업, 공격적 — 스캐폴드 포함)

`REPORT.md` §3(A~E) + lane별 상세를 인벤토리로, 레이어별 서브밀스톤. 각 서브밀스톤 = 재검증→삭제→게이트→커밋.

- **C1 types** — `Opaque`/`DeepPartial`/`DeepReadonly`, `SkillDefinition` 구세대 클러스터(8), `TechnicalAnalysisResult`(3)·`MarketDataRequest`/`Response`/`AlertTrigger`, test-only 타입. (전 시스템 cascade — 신중, 재검증 필수.)
- **C2 infra** — `agent-events.ts`(전체)·`paths.ts`(전체, config paths 와 중복)·env 헬퍼 5(server requireEnv 와 중복)·`auth:resolve` 이벤트·각종 test-only 유틸·배럴 over-export. (M-B 가 dotenv/runtime-guard/unhandled-rejection 은 배선하므로 보존 — 삭제 대상에서 제외.)
- **C3 storage** — `tables/messages.ts`(전체)·`tables/alerts.ts`(전체, **트랙 D latent bug 동반 해소**)·`atomicReindex`·`purgeExpiredCache` 등 test-only·배럴 over-export·`rerankResults`(server 인라인과 중복).
- **C4 agent** — 압축 서브시스템(`agents/context/{window-guard,compaction}` + 배럴 + 테스트)·`forceToolChoice`/`forceToolName` plumbing(runner endpoint)·`provider-normalize`(SDK-era)·`FailoverError`/`maskApiKey`·**세션 클러스터**(`agents/session/*` acquireWriteLock/detectCorruption 등)·`BUILT_IN_GROUPS`·`buildDispatcher` 의 `toolDefinitions`(test-only).
- **C5 skills** — `defaultModel`/`ANALYZE_MARKET_FALLBACK_MODEL` dead plumbing(phase43 P1)·`ROUTE_INTENTS.includes` 도달불가(M-A 와 조율)·skill.ts minModel stale 주석.
- **C6 gateway** — OpenAI-compat 미구현 stub(flag off)·배럴 over-export·stale 'main 참조' 주석.
- **C7 server** — **`services/{hooks,security,daemon}`**(daemon 테스트조차 없음)·**플러그인 슬롯 reader**(write-only scaffold)·`DefaultPipelineObserver`·`channels/chat-type`·배럴 dead(services/plugins/cli/auto-reply index)·summarizer/tokenCounter plumbing·`*_SKILL_METADATA` orphan(phase43 P2 try/catch dedup·`_req` 동반).
- **C8 clients** — web 관찰성 UI(`renderTraceView`/`renderAuditView` + `createAgentClient`/`createTraceClient`/`createAuditClient`, ~220 LOC)·channel-discord 승인/embeds/포트 dead-path.

### M-D — latent bug

`storage/tables/alerts.ts` DDL 불일치 — **M-C3 에서 파일 전체 삭제로 자연 해소.** (alerts 기능은 별 경로(skills-finance alerts/)가 live — 이 storage 파일은 구 폐기 구현.) 삭제 후 alerts live 경로 회귀 0 확인.

## 3. 리스크

- **false positive(감사 오판):** 스캐폴드(플러그인 슬롯·세션 클러스터)는 "write-only/미완 토대"라 grep 으론 dead 지만 런타임 동적 참조 가능성 — 삭제 전 재검증 + 게이트로 차단. live 발견 시 보류·기록.
- **types(C1) cascade:** 전 시스템 의존 — 한 타입 제거가 광범위 break 유발 가능. 바텀업 첫 단계라 가장 신중히, 재검증 철저.
- **플러그인 슬롯 제거:** MCP 도구 로딩 경로가 슬롯을 실제 쓰는지(REPORT 가 "MCP 도구 경로만 실효" 언급) 재검증 — live 면 보류.
- **분량:** 8 서브밀스톤 + M-A/M-B. phase44 초과 시 C5~C8 일부를 phase45 로.

## 4. 검증 / 컨벤션

- 밀스톤(서브밀스톤)마다 1 커밋, subject ASCII. 각 종료 시 전체 게이트(format/lint/typecheck/**build**/test).
- 삭제 커밋은 `refactor(phase44): remove dead <area>` 형식 + 본문에 제거 심볼·재검증 근거.
- §3 외과적 — 인벤토리에 없는 코드 불변. false positive 는 삭제 말고 review 기록.
