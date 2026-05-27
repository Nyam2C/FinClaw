# Phase 41 Plan — Anthropic SDK 전면 제거 + analyze_market CLI 재배선 + KIS→Toss 추상화

> 작성 2026-05-26 · base = main `dea0a0d` (phase40 #75 머지 직후).
> 상류: `plans/phase41/kickoff.md`, `_workspace/phase41-scope.md` (전수 조사).
> 이 plan.md 는 phase-todo-architect 가 todo.md 로 분해할 설계 기준선이다.

---

## 1. 목표

phase40 으로 "키 없이 구독(CLI)+in-process MCP 구동"을 달성하고 Anthropic SDK 를 **휴면 상태로** 남겼다. phase41 은 그 휴면 잔재를 **전면 제거**하여 FinClaw 를 단일 런타임(구독 CLI)로 확정하고, 마지막 SDK 직접 호출(`analyze_market`)을 `runCliAgent` 로 재배선하며, 브로커리지를 KIS 종속에서 벤더 중립 인터페이스로 빼 토스증권 교체 길을 연다(토스 실 구현은 API 발급 후 별 phase).

---

## 2. 확정 결정 (2026-05-26 사용자 승인)

| #   | 항목                       | 결정                                                   | 함의                                                                                                                                                                                                                                                                                |
| --- | -------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **SDK 제거 범위**          | **(b) 전면 제거 (비가역)**                             | `AnthropicAdapter`·`summarizeText`·양 패키지 `@anthropic-ai/sdk` dep·`anthropic-sdk` provider 모드·W2 sdkFallback 전부 삭제. dual-path 안전판 + compaction 요약기 **영구 상실**. 키를 다시 넣어도 SDK 모드 불가.                                                                    |
| D2  | **analyze_market**         | **(a) runCliAgent 재배선**                             | MCP 도구로 유지하되 SDK 직접 호출 → 전용 queueKey(`claude-analysis`) + 세션 비공유 stateless 1-shot `runCliAgent({modelId:'opus'})`. 중첩 spawn 데드락은 queueKey 분리로 회피. 구독 비용·지연은 사용자 수용.                                                                        |
| D3  | **news-brief cron**        | **(a) 현 상태 유지 — 범위 밖**                         | CLI 모드 seed skip 유지. analyze_market 재배선과 무관하게 이미 비활성(brokerage_sync MCP-deny 의존). 별 phase 에서 재설계. review.md 에 deferred 명시.                                                                                                                              |
| D4  | **LLM 라우터 + 토큰 관리** | **(a) 라우터 하위시스템 통째 삭제 + 정적 sonnet 기본** | LLM(Haiku) 라우터는 SDK 의존·CLI 모드에서 이미 죽음(routeToChain→undefined)·OpenClaw 대응물 없는 독자 발명. 새 라우터 X. 토큰 관리는 **정적 기본 모델 sonnet + opus 는 analyze_market 전용 격리**로(요청별 LLM 분류 0). OpenClaw 식 정적 config 선택과 정렬. 상세 §3 '라우터/토큰'. |

---

## 3. 추가 설계 결정 (구현 판단 — plan 리뷰 시 이의 가능)

- **sentiment.ts 통째 삭제** (밀스톤 A): `analyzeSentiment`/`computeLlmSentiment`뿐 아니라 `computeRuleBasedSentiment`/`scoreToLabel` 도 **프로덕션 호출처 0건** (providers 는 각자 로컬 `scoreToLabel` 정의, sentiment.ts import 아님 — 실측 grep 확인). 테스트(`sentiment.test.ts` 11건)만 참조. → 파일 + 테스트 통째 삭제. kickoff §A.5 가 삭제 승인.
- **라우터/토큰 — LLM 라우터 하위시스템 통째 삭제 + 정적 sonnet 기본 모델** (§2 D4 확정 — 밀스톤 D):
  - **근거 (OpenClaw 1:1 조사 + FinClaw CLI 흐름 추적)**:
    - FinClaw 의 LLM 라우터(`createLlmRouter`, 매 메시지 Haiku 1회 호출 → intent 6분류 → modelTier+도구화이트리스트)는 **OpenClaw 에 대응물 없는 독자 발명**. OpenClaw 은 모델 선택=config(`model-selection.ts`), 도구 스코핑=정적 정책(`tool-policy-pipeline.ts`), intent·도구=메인 ReAct 자가선택(`pi-embedded-runner`)이며 **LLM 사전분류 라우터가 전무**. 오히려 도구봇에 Haiku 급 회피 권고(`audit-extra.sync.ts:974`).
    - FinClaw **CLI 모드에선 라우터가 이미 3겹으로 무력**: ① `routeToChain`(execution-adapter.ts:501) routerLlm 없으면 즉시 undefined ② 그 도구필터 결과가 `CliProviderAdapter`(params.tools 무시, 도구는 MCP `mcp__finclaw__*` 전체)에 **전달조차 안 됨** ③ 실질 의도·도구·추론은 claude CLI 자체 ReAct 가 수행. 삭제해도 **런타임 동작 변화 0**.
  - **삭제 (밀스톤 D)**: `packages/agent/src/router/llm-router.ts`(createLlmRouter/LlmRouter/RouterIntent/RouterDecision/RouterInput/ROUTER_MODEL_ID) + `@finclaw/agent` export + `execution-adapter.ts` 의 `routeToChain`/`routeOrFallback`/`keywordFallbackDecision`/`inferRole`/`ModelRole`(전부 내부 전용, 외부 import 0건) + `routed` 분기 + 테스트(`llm-router.test.ts` 9, `routing-accuracy.test.ts` 1, `execution-adapter.test.ts` 의 라우터-폴백 테스트 1).
  - **토큰 관리 (라우터 대체 — 추가 LLM 호출 0)**: 기본 모델 **sonnet** 으로 고정, **opus 는 analyze_market 전용 격리**(밀스톤 B inner runCliAgent modelId='opus'). 메커니즘: `DEFAULT_FALLBACK_CHAIN`(catalog-data.ts:71, 현 `[opus,sonnet,haiku]`)을 **sonnet-primary 로 재정렬** → `[sonnet, haiku]` 권장(토큰 관리 취지상 failover=강등, opus 로 에스컬레이션 안 함). 라우터 삭제 후 `execute`/`applyTuiRouting` 은 `routed` 분기 제거 → 항상 `effectiveChain=fallbackChain`(sonnet 선두) + 전체 도구. ⚠️ failover 정확 순서(sonnet→haiku vs sonnet 단독)는 todo 에서 확정.
- **analyze_market 주입 shape** (밀스톤 B): `deps.client: Anthropic` → **runner 콜백 주입**. skills-finance 가 `@finclaw/agent` 에서 `runCliAgent` 를 import 가능(이미 `index.ts:76` export)하나, 테스트 가능성(mock-only) 위해 `analyzeMarket(client,...)` → `analyzeMarket(runAnalysis,...)` 로 일반화. `runAnalysis: (req:{systemPrompt; prompt; modelId; timeoutMs?}) => Promise<{text:string; usage?:{input:number; output:number}}>`. tools.ts 가 기본 구현(`runCliAgent` + queueKey override + usage 매핑)을 클로저로 주입, 테스트는 mock 주입.
- **runner queueKey override** (밀스톤 B): `RunCliAgentRequest` 에 `queueKey?: string` 추가. `runner.ts:84` 에서 `req.queueKey ?? buildCliQueueKey({backendId:'claude', cliSessionId: useResume ? req.cliSessionId : undefined})`. 기존 호출 무영향(미지정 시 동일). inner analyze 는 `queueKey:'claude-analysis'` + `cliSessionId` 미전달.
- **BrokerageClient 인터페이스 shape** (밀스톤 E): `interface BrokerageClient { fetchHoldings(): Promise<readonly NormalizedHolding[]> }`. normalize 책임을 각 벤더 구현 내부로 흡수(벤더 raw 행 형태가 다르므로 정규화 출력이 깨끗한 경계). `KisClient` 가 `fetchHoldings()` 구현(기존 `fetchBalances()` + `normalizeDomestic/Overseas` 위임). 그 이상 일반화(멀티계좌·멀티통화 추상)는 추측성 과설계 — 금지 (CLAUDE.md §2).

---

## 4. 비결정 사실 (드리프트 정정 — 손대지 않음)

- `defaults.ts:21` / `constants.ts:34` 의 `provider: 'anthropic'` 은 **`ModelRef.provider`(모델 벤더)** 필드이지 런타임 `finclawConfig.provider`(SDK-vs-CLI 선택자) 아님. **정상값, 불변.** 런타임 provider enum 은 `types/src/config.ts:20` + `config/src/zod-schema.ts:196` 두 곳뿐.
- `RouterHelper`(`makeRouterHelper`, analyze_market `deps.router`)는 LlmRouter/sdkAdapter 와 **무관**(키워드·floor 기반). SDK 제거 무영향 — analyze_market 의 opus floor 모델 선택은 그대로 동작.
- compaction 은 summarizer undefined 시 **원본 messages 그대로 반환**(`execution-adapter.ts:686`) → graceful degrade. D1 후 compaction 영구 off (회복 불가).

---

## 5. 밀스톤 분해

각 밀스톤: `pnpm typecheck` + `tsc --build` + `pnpm test --run` + `pnpm lint` green, 밀스톤당 1커밋. 외과적 변경 — 명시 파일 외 인접 코드 비건드림.

### 밀스톤 A — sentiment 죽은 feature 클러스터 삭제 (최저위험, SDK import 1개 제거)

sentiment.ts 가 죽은 코드라 그 전용 prompt 로더·md 도 함께 고아 (실측 grep 확인 — 아래는 모두 sentiment.ts 전용 + 자기 테스트만 참조):

- **DELETE** `packages/skills-finance/src/news/analysis/sentiment.ts`
- **DELETE** `packages/skills-finance/src/news/analysis/__tests__/sentiment.test.ts` (11 tests)
- **EDIT** `packages/skills-finance/src/news/analysis/prompt-loader.ts` — `loadSentimentPrompt`(L44-47) 제거 (sentiment.ts 전용, 다른 호출처 0건). `loadAnalysisPrompt` 등 나머지 불변.
- **EDIT** `packages/skills-finance/src/news/analysis/__tests__/prompt-loader.test.ts` — `loadSentimentPrompt` describe 블록(4 tests) 제거. `loadAnalysisPrompt` 블록 불변.
- **DELETE** `sentiment.system.md` prompt 파일 (loadSentimentPrompt 전용 — readPromptFile 유일 참조). 위치 실측 후 삭제. `package-files.test.ts` 가 이 파일 존재를 단언하면 함께 정정.
- 검증: `grep -rn "analyzeSentiment\|loadSentimentPrompt\|sentiment.system"` src 0건 + typecheck green.
- 커밋: `refactor(phase41): remove dead sentiment feature (no production caller)`

### 밀스톤 B — analyze_market → runCliAgent 재배선 + skills-finance SDK dep 제거

- **EDIT** `packages/agent/src/providers/claude-cli/runner.ts` — `RunCliAgentRequest.queueKey?` 추가, queue 빌드에 override 반영 (§3 runner queueKey override).
- **EDIT** `packages/skills-finance/src/news/analysis/market-analysis.ts` — `analyzeMarket(client:Anthropic,...)` → `analyzeMarket(runAnalysis,...)` (§3 analyze_market 주입 shape). `client.messages.create` 제거, `runAnalysis(...)` 호출 → `JSON.parse(text)` + `AnalysisResponseSchema.safeParse` 유지. usage 회계(`profileHealth.recordResult`)는 `runAnalysis` 응답 usage 로 매핑. `import type Anthropic` 제거.
- **EDIT** `packages/skills-finance/src/news/tools.ts` — `deps.client:Anthropic` → `deps.runAnalysis`. `registerAnalyzeMarketTool` 가 modelRef.model 을 `runAnalysis` 에 전달. `import type Anthropic` 제거.
- **EDIT** `packages/skills-finance/src/news/index.ts` — `if (config.anthropicApiKey) { new Anthropic ... }` 게이트 제거. analyze_market 을 **CLI runner 로 무조건 등록**(기본 `runAnalysis = (req)=>runCliAgent({...req, queueKey:'claude-analysis'})` + usage 매핑). `import Anthropic` 제거, `NewsSkillConfig.anthropicApiKey` 제거(또는 deprecated no-op), `runCliAgent` import 추가.
- **EDIT** `packages/server/src/composition/skills.ts` — `registerNewsTools` 호출의 `anthropicApiKey: anthropicKey` 제거. `NEWS_SKILL_METADATA.requires.optionalEnv` 의 `ANTHROPIC_API_KEY` 제거 검토.
- **EDIT** `packages/skills-finance/package.json` — `@anthropic-ai/sdk` dep 제거 (A+B 후 skills-finance 의 유일 SDK 사용처 소멸).
- 테스트: analyze_market 전용 mock-SDK 테스트 **없음**(analyze-prompts.test.ts 는 스키마 독립 검증, 불변). 선택: `runner.ts` queueKey override 단위 테스트 1건 추가.
- 검증: typecheck + `grep -rn "@anthropic-ai/sdk" packages/skills-finance/src` 0건 + test green. CLI 모드에서 analyze_market 등록되는지 (skills.ts 로깅) 확인.
- 커밋: `refactor(phase41): rewire analyze_market to runCliAgent, drop skills-finance SDK dep`

### 밀스톤 C — Anthropic SDK 전면 제거 (agent + composition) ⚠️ 비가역

- **DELETE** `packages/agent/src/providers/anthropic.ts` (AnthropicAdapter + summarizeText)
- **DELETE** `packages/agent/test/providers/summarize-text.test.ts` (4) · `packages/agent/src/providers/structured-output.test.ts` (2, AnthropicAdapter 전용) · `packages/agent/test/providers/claude-cli/cli-fallback.test.ts` (2, W2 경로)
- **EDIT** `packages/agent/src/index.ts` — `export { AnthropicAdapter }` 제거. (`createLlmRouter`/`LlmRouter` export 제거는 밀스톤 D — 여기선 AnthropicAdapter 만.)
- **EDIT** `packages/agent/src/providers/factory.ts` — `ProviderKind` 에서 `anthropic-sdk` 제거, `case 'anthropic-sdk'` 분기 + `AnthropicAdapter` import 제거, `sdkFallback` 옵션 제거. `ProviderKind = 'claude-cli'` 단일.
- **EDIT** `packages/agent/src/providers/claude-cli/adapter.ts` — `CliProviderAdapterOptions.sdkFallback` 제거 + `streamCompletion` 의 W2 auth 위임 분기(L38-41) 제거. `ProviderAdapter` import 정리.
- **EDIT** `packages/types/src/config.ts:20` — `provider?: 'anthropic-sdk' | 'claude-cli'` → `provider?: 'claude-cli'`.
- **EDIT** `packages/config/src/zod-schema.ts:196` — `z.enum(['anthropic-sdk','claude-cli'])` → `z.enum(['claude-cli'])` (또는 `z.literal('claude-cli')`).
- **EDIT** `packages/server/src/composition/providers.ts` — `sdkAdapter`/`routerLlm` 생성·`ProvidersBundle` 필드·`sdkFallback` 인자·`AnthropicAdapter`/`createLlmRouter` import 제거 (routerLlm 배선 — llm-router.ts 파일 삭제는 밀스톤 D).
- **EDIT** `packages/server/src/composition/runtime.ts` — `sdkAdapter` 파라미터(L128,150)·`summarizer`(L193-195)·`routerLlm`(L54,75,110)·`AnthropicAdapter` import 제거. AutoReplyPipeline 의 `summarizer` 인자 undefined 고정(또는 제거).
- **EDIT** `packages/server/src/main.ts` — `buildProviders` 분해의 `sdkAdapter`/`routerLlm` + 하류 threading(L239,256) 제거.
- **EDIT** `packages/server/src/composition/providers.test.ts` — dual-path 테스트(L31) 삭제, pure-CLI 테스트(L18)를 sdkAdapter/routerLlm 단언 제거하고 providerAdapter/toolRegistry 만 단언하도록 축소.
- **EDIT** `packages/agent/package.json` — `@anthropic-ai/sdk` dep 제거.
- 고아 확인: `grep -rn "@anthropic-ai/sdk\|AnthropicAdapter\|summarizeText\|sdkFallback\|sdkAdapter\|anthropic-sdk" packages/*/src packages/*/test` → src/test 0건 (dist 잔재는 build clean 으로 정리).
- 검증: typecheck + build clean rebuild + test green + lint. 키 없는 부팅 경로(`createProviderAdapter({kind:'claude-cli'})`)만 남는지 확인.
- 커밋: `refactor(phase41)!: remove Anthropic SDK entirely (irreversible — CLI-only)`

### 밀스톤 D — LLM 라우터 하위시스템 제거 + 정적 sonnet 기본 모델 (C 의존)

밀스톤 C 가 routerLlm *배선*을 걷은 뒤, 라우터 *코드 자체*를 삭제하고 토큰 관리를 정적 모델로 전환 (§3 라우터/토큰).

- **DELETE** `packages/agent/src/router/llm-router.ts` (createLlmRouter/LlmRouter/RouterIntent/RouterDecision/RouterInput/ROUTER_MODEL_ID)
- **DELETE** `packages/agent/src/router/__tests__/llm-router.test.ts` (9) · `packages/agent/src/router/__tests__/routing-accuracy.test.ts` (1)
- **EDIT** `packages/agent/src/index.ts` — `createLlmRouter`/`ROUTER_MODEL_ID`/`LlmRouter`/`RouterIntent`/`RouterDecision`/`RouterInput` export 제거.
- **EDIT** `packages/server/src/auto-reply/execution-adapter.ts` — `routeToChain`/`routeOrFallback`/`keywordFallbackDecision`/`inferRole`(L71)/`ModelRole`(전부 내부 전용, 외부 import 0건) 제거. `execute`(L211-222)/`applyTuiRouting`(L393-403)의 `routed` 분기 제거 → `exposedTools = toolDefinitions`(전체), `effectiveChain = fallbackChain` 직결. `LlmRouter`/`RouterDecision` import 제거. `RunnerExecutionAdapterDeps.routerLlm` 필드 제거.
- **EDIT** `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts` — "라우터 실패(throw) 시 inferRole 폴백" 테스트(L521, 1) 제거. routerLlm 주입 단언 있으면 정정.
- **EDIT** `packages/agent/src/models/catalog-data.ts:71` — `DEFAULT_FALLBACK_CHAIN` sonnet-primary 재정렬: `['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']` (opus 격리 — analyze_market 전용). ⚠️ failover 순서는 검증 후 확정.
- 고아 확인: `grep -rn "createLlmRouter\|LlmRouter\|inferRole\|routerLlm\|keywordFallback\|ModelRole"` src/test 0건.
- 검증: typecheck + test green. CLI 부팅 후 기본 모델이 sonnet 으로 spawn 되는지(`provider.initialized`/`--model` 로깅) 확인. analyze_market 만 opus.
- 커밋: `refactor(phase41): remove dead LLM router subsystem, static sonnet default (OpenClaw-aligned)`

### 밀스톤 E — KIS→Toss BrokerageClient 추상화 (경계만, Toss 실구현 X)

- **CREATE/EDIT** `packages/skills-finance/src/brokerage/types.ts` (신규 또는 kis/types 분리) — `interface BrokerageClient { fetchHoldings(): Promise<readonly NormalizedHolding[]> }` + `NormalizedHolding` 를 벤더 중립 위치로(이미 중립). `BrokerageProvider = 'kis' | 'toss'` 타입.
- **EDIT** `packages/skills-finance/src/brokerage/kis/client.ts` — `KisClient implements BrokerageClient`, `fetchHoldings()` 추가(기존 `fetchBalances()` + `fetchNormalizedHoldings` 로직 위임). `fetchNormalizedHoldings`(holdings.ts)는 내부 헬퍼로 유지.
- **EDIT** `packages/skills-finance/src/brokerage/kis/index.ts` + (신규) `brokerage/index.ts` barrel — `BrokerageClient`/`BrokerageProvider` export.
- **EDIT** `packages/server/src/services/brokerage-sync-service.ts` — `deps.client: KisClient` → `deps.client: BrokerageClient`, 본문 `fetchNormalizedHoldings(this.deps.client)` → `this.deps.client.fetchHoldings()`. 나머지(replaceAllHoldings·로깅) 불변.
- **EDIT** `packages/server/src/composition/skills.ts` — KIS env 읽기 + `new KisClient` 배선을 `BROKERAGE_PROVIDER`(기본 `kis`) 분기 뒤로. `toss` 선택 시 명시적 "미구현(API 발급 후)" 로그 + skip (지어내지 않음). KIS 분기는 기존 로직 보존.
- **불변 (이미 중립)**: `registerBrokerageTools`/`brokerage_sync_holdings`(tools.ts), gateway `brokerage.ts` RPC, `replaceAllHoldings`(storage), `NormalizedHolding`. `source='kis'` 컬럼 일반화는 **이번 범위 밖**(KIS 단일 구현이라 의미 없음 — Toss 구현 phase 에서).
- 검증: typecheck + test green. `BrokerageSyncService` 가 인터페이스 타입으로 컴파일되는지, KIS 경로 회귀 없는지.
- 커밋: `refactor(phase41): extract BrokerageClient interface (KIS impl, Toss deferred)`

---

## 6. 테스트 baseline

- 현재(phase40 머지): unit **1700** / storage 154.
- 삭제: (A) sentiment 11 + loadSentimentPrompt 4 · (C) summarize-text 4 + cli-fallback 2 + structured-output 2 + providers dual-path 1 · (D) llm-router 9 + routing-accuracy 1 + execution-adapter 라우터-폴백 1 = **−35**. analyze_market 재배선은 신규 테스트 미요(스키마 테스트 불변), 선택적 runner queueKey 테스트 +1.
- **예상 신 baseline ≈ unit 1665±**(구현 시 실측 재산정). storage 154 불변.
- mock-only 유지 — 실 키/네트워크/라이브 CLI 호출 금지. analyze_market 재배선 테스트는 `runAnalysis` mock 주입.

---

## 7. 리스크

| 리스크                        | 영향                                                                                                                | 완화                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 비가역                     | dual-path 안전판·compaction 요약기 영구 상실. CLI auth 만료 시 SDK 폴백 없음 → 사용자가 `claude login` 재인증 필요. | 사용자 승인됨(D1=b). review.md 에 "CLI auth 만료 = 수동 재로그인" 운영 노트.                                                                 |
| analyze_market 중첩 데드락    | inner/outer 같은 큐 → 영구 대기.                                                                                    | D7 전용 queueKey(`claude-analysis`) + 세션 비공유. 밀스톤 B 검증에 큐 분리 단위 테스트.                                                      |
| 구독 비용·지연                | analyze_market 매 호출 = 추가 CLI spawn(opus).                                                                      | 사용자 수용. opus floor 유지(금융 판단 환각 방지).                                                                                           |
| 토큰 쿼터 (구독 사용량 캡)    | opus-for-everything 면 구독 쿼터 빠르게 소진.                                                                       | 기본 sonnet + opus 는 analyze_market 전용(§2 D4). 추가 LLM 호출 0. compaction 상실은 historyLimit=20 + CLI 자체 컨텍스트 관리로 영향 제한적. |
| 키워드 라우팅 오분류 (미채택) | (Option 2 채택 시) 분석 질문이 약한 모델로.                                                                         | Option 1(정적 sonnet) 채택으로 회피 — 요청별 분기 없음.                                                                                      |
| build dist 잔재               | `anthropic.d.ts` 등 stale.                                                                                          | `tsc --build --clean` 후 재빌드로 정리.                                                                                                      |

---

## 8. 비범위 (deferred)

- **Toss 실 구현**: Open API 미발급/스펙 미공개. BrokerageClient 인터페이스 경계까지만. `TossClient` 구현은 API 발급 후 별 phase.
- **news-brief CLI 모드 재설계**: D3 으로 현 seed skip 유지. brokerage_sync MCP-deny 의존 해소는 별 phase.
- **요청별 모델 분기 (per-request 티어)**: §2 D4 에서 정적 sonnet 기본으로 결정. 단순 LLM(Haiku) 라우터 재건은 영구 비채택(구독 비용·세션 resume 충돌·OpenClaw 부재). 동적 라우팅 수요는 ↓ phase42 로 흡수.
- **orchestrator-worker 에이전트 라우터 (phase42, 신규 기능)**: 2026-05-26 사용자 결정 — phase41 정리 완료 후 `finclaw-feature-plan` 하네스로 리서치·설계. 메인 오케스트레이터가 전문 서브에이전트(news/portfolio/analysis)를 CLI spawn 으로 위임하는 orchestrator-worker 패턴. phase41 의 라우터 *삭제*와 양립(죽은 SDK Haiku 분류기 제거 → 새 CLI-spawn 기반 라우터를 깨끗한 바닥에서; D7 queueKey override 가 토대). 난제: 중첩 spawn 데드락(worker별 queueKey)·요청당 N+1 spawn 구독 비용·서브에이전트 정의(systemPrompt·도구·모델)·결과 종합. 리서치 1번 질문: OpenClaw `src/agents/`(100+ 파일)에 서브에이전트 위임 패턴 존재 여부(있으면 source-of-truth, 없으면 Claude Code Task·Swarm·LangGraph 참조).
- **`source='kis'` 컬럼 일반화**: Toss 구현 phase 로 미룸.

---

## 9. 다음 단계

이 plan.md 승인 후 → `finclaw-phase-execute` (phase-todo-architect 가 todo.md 코드단위 분해 → 승인 → 구현 → finalize). 또는 밀스톤 A 부터 수동 진행.
