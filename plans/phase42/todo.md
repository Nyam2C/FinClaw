# Phase 42 todo — 기초 검증 + 재설계 그라운드워크

> 결정 근거·설계는 `plan.md` 참조. 여기는 실행 체크리스트.

## AgentProfile 부활 (type-first)

### 완료 (types 레이어)

- [x] `AgentProfile` 수정 (`packages/types/src/agent.ts`): `systemPrompt`·`skills` 제거, `agentDir` required 승격, `{ id, name, model, maxConcurrent, agentDir }` 로 축소 + 설계 doc 주석.

### deferred — reader 레이어 도달 시 (orphan 금지, `[]` 안은 예상 레이어)

- [ ] `agentDir` 정의 로더 — 정의 파일 frontmatter(skills 허용목록·meta) + body(systemPrompt) 파싱·로드 `[server/agent]`
- [ ] per-worker 도구 스코핑 집행 — skills 허용목록대로 도구 차단 (Seam 3, 신규 레이어) `[agent/gateway]`
- [ ] `maxConcurrent` 런타임 가변 경로 + `ConcurrencyLane` `key=agentId` 배선 (잠든 `subagent` 레인 cap 3 활용) `[infra/agent]`
- [ ] `model` 런타임 가변 — 워커 spawn 에 프로필 model 주입 `[agent]`
- [ ] `binding-matcher` 라우팅 자격 신호 새 집 (agentDir presence-gate 대체) `[server]`
- [ ] `AgentProfile` ↔ `AgentEntry`(config) reconcile + resolver (config→profile) `[types/config]`
- [ ] `provider` 사문화 필드 정리 판단 `[config]`
- [ ] delegate 진입점 — `analyze_market` 클로저 일반화 (orchestrator-worker 기능 phase) `[기능 phase]`

## 결정 2 — ModelRef 슬림 (완료, 미커밋)

- [x] `ModelRef` → `{ provider, model }` + cascade(8 사이트·9 fixture·`maybeCompactMessages` gut·테스트파일 1 삭제). typecheck/lint/test green. 상세 = `plan.md` 결정 2.

## 결정 4 — AgentRunParams/ProviderRequestParams 슬림 (완료, 미커밋)

- [x] `temperature`·`maxTokens`(DEAD) + `tools`(CLI 무시·MCP 대체) 제거 — `AgentRunParams`(types) + `ProviderRequestParams`(adapter.ts) + runner 복사 3줄 + cascade(`exposedTools` 3사이트·`toolDefinitions` destructure 2·`buildRequestDispatcher` 반환). `abortSignal` 만 생존(CLI 도달). typecheck/lint/test **1628 불변**(footprint 0). 6파일 +4 −32. 상세 = `plan.md` 결정 4.

## 결정 5 — routerHelper 폐기 → route_task 도구 (재설계)

> 결정·설계·제거 대상·신규 구조 = `plan.md` 결정 5. 여기는 실행 체크리스트.

### 사전 검증 (완료 — 마일스톤 A 직전)

- [x] `ModelTier` cross-ref grep — 6 곳 사용 식별. **사용자 결정: 다 삭제. downstream 정리는 마일스톤 C cascade 에 포함.** 사용처:
  - `agent/src/models/fallback.ts` (fallback chain 의 `floor`·`modelIdToTier`)
  - `agent/src/execution/chat-execution-port.ts:22` (`userHint?`)
  - `gateway/src/rpc/methods/chat.ts:75` (`modelHint?: ModelTier` — RPC schema 노출)
  - `server/src/auto-reply/execution-adapter.ts:272` (`userHint?`)
  - `server/src/auto-reply/commands/status.ts:68,71` (`modelIdToTier` — status 명령 tier 정렬)
  - `types/src/skill.ts` (import 만 — 실제 필드 사용처 추가 확인 필요)
- [x] `tierToModelId`/`modelIdToTier` — fallback.ts/commands/status.ts 가 사용 → 같이 제거 (사용처에서 model id 문자열 직접 비교로 변경하거나 해당 로직 제거).
- [x] `agent.run` RPC `role` 파라미터 — TUI/Web grep **사용 0**. `agent.ts:211` default 'analysis' + tools.ts 가 박은 'analysis' 가 전부. → 같이 제거.

### 마일스톤 A — 골격 (types only)

> 새 패키지 만들지 않음 (사용자 피드백) — 타입은 `@finclaw/types`, runtime 은 server 내부.

- [x] `packages/types/src/router.ts` — `RouteIntent` · `RouteRequest` · `RouteResult` · `Dispatcher`
- [x] `packages/types/src/index.ts` barrel 추가
- [x] typecheck pass + 소비자 0 검증

### 마일스톤 B — PoC (`intent='market_analysis'`) — 완료

- [x] `packages/server/src/router/sub-agent.ts` — claude CLI 재호출 spawn 유틸 (`runSubAgent`, queueKey 'claude-sub-agent')
- [x] `packages/server/src/router/dispatch.ts` — `buildDispatcher(deps)` 팩토리, `market_analysis` 분기 (analyzeMarket 함수 + runSubAgent 결합)
- [x] `packages/skills-general/src/route-task.ts` — `route_task` 도구 정의 (intent enum + query + symbol). TODO 주석 = .md 이주 자리.
- [x] sub-agent system prompt = 기존 `packages/skills-finance/prompts/news/analyze.*.md` 그대로 활용 (Phase 25 patten 재사용)
- [x] 메인 도구 목록: composition/skills.ts 가 dispatcher 빌드 후 `route_task` 등록 + `analyze_market` unregister
- [x] typecheck pass + 1626 unit test green (이전 baseline 1628 → 1626 은 prompt 통합 commit 9c52582 의 identity.test 4→2 합치기. 이번 변경 footprint 0)
- [ ] 실 smoke 호출 — 운영 환경에서 사용자 검증 시점에

### 마일스톤 C — routerHelper + ModelTier 전체 제거 (cascade, "냉정 삭제")

> 사용자 스탠스: 다 삭제하고 typecheck 깨지는 곳마다 그때그때 가장 단순한 방식으로 정리. compatibility seam 두지 않음.

**routing 코어:**
- [x] `packages/agent/src/models/routing.ts` 전체 삭제 (tierToModelId/modelIdToTier 포함)
- [x] `packages/server/src/auto-reply/router-helper.ts` 전체 삭제
- [x] `packages/agent/src/index.ts` — routing/tierToModelId/modelIdToTier re-export 제거
- [x] `packages/agent/test/routing.test.ts` 삭제

**types/config:**
- [x] `packages/types/src/config.ts` — `RoutingConfig`/`RoleProfile`/`ModelTier` 제거
- [x] `packages/types/src/skill.ts` — `ModelTier` import 및 사용 필드(minModel) 제거
- [x] `packages/config/src/defaults.ts` — `DEFAULTS.routing` 블록 제거
- [x] `packages/config/src/zod-schema.ts` — `ModelTierSchema`·`RoleProfileSchema`·routing 스키마 제거
- [x] `packages/config/test/zod-schema.test.ts` — routing 관련 케이스 제거 (+ defaults.test.ts)

**main.ts/composition:**
- [x] `packages/server/src/main.ts` — routing 로드/로그 블록 + `routerHelper` 생성·주입 3 곳 제거
- [x] `packages/server/src/composition/{runtime,skills}.ts` — `routerHelper` deps 필드·생성자 인자 제거
- [x] `packages/skills-finance/src/news/tools.ts` — router 분기 제거 (analyze_market 본문 이미 sub-agent 로 이동) + `news/index.ts` router 주입 제거

**ModelTier downstream (typecheck 따라가며 정리):**
- [x] `packages/agent/src/models/fallback.ts` — `floor: ModelTier` 제거. fallback chain 을 단순 model id 리스트로. `modelIdToTier`·`TIER_RANK` 제거.
- [x] `packages/agent/test/fallback.test.ts` — floor 관련 케이스 정리
- [x] `packages/agent/src/execution/chat-execution-port.ts` — `userHint?: ModelTier` 필드 제거
- [x] `packages/gateway/src/rpc/methods/chat.ts` — `modelHint?: ModelTier` 제거 (RPC schema. TUI/Web 미사용 확인됨)
- [x] `packages/server/src/auto-reply/execution-adapter.ts` — `userHint?: ModelTier` 필드 제거
- [x] `packages/server/src/auto-reply/commands/status.ts` — tier 정렬 로직 제거
- [x] 스킬 메타데이터 `minModel` 필드 제거 (alerts/market/news/general index.ts)

**RPC:**
- [x] `packages/gateway/src/rpc/methods/agent.ts` — `role` 파라미터 제거 (TUI/Web 미사용) + 미사용 `toolDefinitions` destructure 정리 (gateway/agent.ts·automation/scheduler.ts)

**검증:**
- [x] typecheck 통과 (exit 0)
- [x] 기존 unit test 통과 (188 files / 1582 tests green, −46 = 삭제 테스트) + lint 0

### 마일스톤 D — 확장

- [ ] `dispatchRoute('price_lookup')` — 함수 디스패치 (`get_stock_price` 직접 호출)
- [ ] `dispatchRoute('chart_data')` — OSS 디스패치 (pykrx 라이브러리)
- [ ] 메인 에이전트 system prompt 가이드 갱신 — intent 별 사용 시점 명시
- [ ] typecheck + smoke 호출 (price + chart 각각)

## dead-code 백로그

- [x] **AuthProfile + auth 키-로테이션 클러스터 제거 (결정 3)** — `AuthProfile`·`auth/{profiles,resolver}.ts`·`filterHealthy`·죽은 re-export·`resolver.test` 삭제. `ProfileHealthMonitor`·`CooldownTracker` 보존. test 1638→1628(−10). 시세 키는 별개 live `KeyRotator`(skills-finance)가 담당 — 무관 확인.
- [ ] **압축 서브시스템** `agent/src/agents/context/` — `evaluateContextWindow`·`compactContext` 가 결정 2 이후 프로덕션 orphan(런타임 호출 0, 유닛테스트만 + 배럴 export). 제거 시 배럴·테스트 동반 `[agent]`
- [ ] **`auth:resolve` 이벤트 타입** (`infra/events.ts:64`) — 유일 emit 처(resolver) 삭제로 dead(unemitted). 제거 검토 `[infra]`
- [ ] **`forceToolChoice` + `forceToolName` plumbing** (`adapter.ts:20` + `runner.ts` 127·137·244·268) — 결정 4 와 동류 CLI-drop 잔재(CLI adapter 미전달). 별 필드라 독립 제거 가능 `[agent]`

## (기존) 검증 백로그 — kickoff.md P0/P1/dead

> SUMMARY 주장 직접 대조는 `kickoff.md` 표 참조. 착수 시 여기로 단계 분해.
