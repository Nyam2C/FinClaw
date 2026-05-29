# Phase 42 plan — 기초 검증 + 재설계 그라운드워크

> `kickoff.md` 의 검증 백로그(SUMMARY P0/P1/dead)와 별개로, **재설계 축의 구체 결정**을 여기에 기록한다.
> 진행 원칙: 의존 바텀업 읽기 순서(`types` → `infra` → … → `agent` → `server`)에 맞춘 **type-first**. reader 배선은 해당 레이어 도달 시 (orphan 금지 — `todo.md` 가 추적).

---

## 결정 1 — `AgentProfile` 부활: orchestrator-worker 워커 정의 (type-first)

### 배경 (검증 완료)

- `AgentProfile` (`packages/types/src/agent.ts:4`) = **dead-on-arrival**. 정의 이래 소비자 0 (grep=1), git pickaxe 3커밋 전부 비사용(정의·monorepo 이동·문서).
- 죽은 이유: FinClaw 가 **단일 에이전트 + 글로벌 `systemPrompt`/`skills` + 하드코딩 `maxConcurrent:1`** 이라 per-agent 프로필이 불필요했음.
- **제거 대신 살린다.** 명분 = 보류 중인 **orchestrator-worker 라우터**의 "워커 정의" 타입 (워커마다 다른 프롬프트·모델·도구·동시성 필요). 단일 → 멀티 워커로 가는 순간 이 타입이 소비자를 얻는다.

### 설계 원칙

> **런타임 가변 운영 노브 → `interface` (즉시 변경) · 무겁고 구조적인 정의 → `agentDir` 파일.**

- 동기: 로드맵 난제 "요청당 N+1 spawn 구독 쿼터 비용" → **쿼터 압박 시 워커 동시성·모델을 파일 안 고치고 즉시 조절**해야 함 ("언제든 변경가능" = 사용자 결정).
- 정적 정의(프롬프트 본문·도구 허용목록)는 `.claude/agents/*.md` 패턴처럼 파일로.

### 필드 disposition

| 필드                 | 위치                                                   | 사유                                                                      |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `id`, `name`         | interface                                              | 정체성 (레지스트리 키/라벨)                                               |
| `model` (`ModelRef`) | interface                                              | 런타임 가변 — 쿼터 압박 시 opus→sonnet 즉시 강등                          |
| `maxConcurrent`      | interface                                              | 런타임 가변 — 워커 동시성 throttling. `key=agentId` 면 "이 워커 동시 N개" |
| `agentDir`           | interface (포인터, **required 승격**)                  | 정적 정의 파일 폴더를 가리킴                                              |
| ~~`systemPrompt`~~   | → `agentDir` 정의 파일 **body**                        | 무거운 텍스트, 숫자처럼 못 바꿈                                           |
| ~~`skills`~~         | → `agentDir` 정의 파일 **frontmatter** (도구 허용목록) | 구조적·보안성. (라이브 권한조정 원하면 추후 interface 승격 재고)          |

### 결과 타입 (적용됨 — `agent.ts`)

```ts
interface AgentProfile {
  id: AgentId;
  name: string;
  model: ModelRef; // 런타임 가변
  maxConcurrent: number; // 런타임 가변
  agentDir: string; // -> 정의 파일: body=systemPrompt, frontmatter=skills 허용목록
}
```

### deferred — reader 단계 (해당 레이어 도달 시. `todo.md` 가 추적)

1. **`agentDir` 정의 로더** — 폴더 읽기 + frontmatter 파싱 + prompt body 로드 + skill 허용목록 해석. (현재 `agentDir` 값은 아무도 역참조 안 함 — 전부 신규)
2. **per-worker 도구 스코핑 집행** (Seam 3, 신규 레이어) — 오늘 도구 게이팅은 100% 호스트 전역(MCP `--allowedTools` + bridge 필터). 워커별 허용목록 차단부 필요.
3. **`maxConcurrent` 런타임 가변 경로** — (a) config reload vs (b) 라이브 RPC 변경. `ConcurrencyLane` 을 `key=agentId` 로 acquire (선례: `gateway/.../agent.ts:245` `agentRunLane.acquire(agentId)`; 잠든 `subagent` 레인 cap 3 활용).
4. **`model` 런타임 가변** — 워커 spawn 시 프로필 model 주입 (선례: `analyze_market` opus per-call).
5. **`binding-matcher` 라우팅 자격 신호 새 집** — 현재 `if (entry.agentDir)` presence-gate 가 agentDir required 되면 붕괴(전부 통과). 라우팅 자격은 별 신호로.
6. **`AgentProfile` ↔ `AgentEntry`(config) reconcile + resolver** — `config.ts:91` `AgentEntry` + `AgentsConfig.entries: Record<string, AgentEntry>` 가 이미 워커 레지스트리 골격. config(선언) → resolve → AgentProfile(런타임).
7. **`provider` 사문화 필드 정리** — `AgentEntry.provider`/`AgentDefaultsConfig.provider`/`ModelRef.provider` 는 Claude-CLI 단일 후 의미 퇴색. 별도 판단 (지금 건드리지 않음).
8. **delegate 진입점** (Seam 5) — `analyze_market` 하드코딩 클로저(`skills-finance/.../news/index.ts:104`)를 "프로필 받아 spawn"으로 일반화. = orchestrator-worker **기능 phase** (groundwork 아님).

### 주의 / 미결

- 이 결정은 **타입 토대만** (사용자 결정). reader(1~8)는 후속. 타입은 단순해지나 복잡도는 "로더+포맷+집행"으로 **이전**됨 (소멸 아님).
- `AgentProfile` 은 dead 였으므로 필드 제거는 회귀 위험 0 (소비자 0 검증).

---

## 결정 2 — `ModelRef` 슬림: `contextWindow`/`maxOutputTokens` 제거 (실행 완료, 미커밋)

### 배경 (검증 완료)

- `ModelRef` (`types/src/agent.ts`) 는 live(8+ 사용)지만 두 필드는 phase41 CLI 전환 후 **잔재**:
  - `maxOutputTokens`: `runner.ts:266` 서 계산되나 `CliProviderAdapter` 가 안 읽음(claude-cli grep 0) → CLI 경계 폐기. phase41 이 SDK 소비처(`anthropic.ts`) 삭제하며 잔재화.
  - `contextWindow`: `TokenCounter`(observability, 이벤트만) + 죽은 compaction 경로(summarizer 영구 미주입)만 읽음 → load-bearing 0.
- CLI 가 컨텍스트·출력을 자체 관리 → ModelRef 가 들 이유 없음. 토큰 메타 원본은 `ModelEntry`(catalog) 보유 → 정보 손실 0.

### 실행 (cascade, 사용자 "지금 제거")

- `ModelRef` → `{ provider, model }`.
- 읽기 2(runner: `TokenCounter` 기본값 200_000 / `maxTokens` fallback 제거), 생성 5(constants·news-tools·gateway·scheduler·execution-adapter), 죽은 `maybeCompactMessages` **gut**(−110 LOC, 프로덕션 no-op라 동작 동일), 테스트 fixture 9 + 전용 테스트파일 1 삭제.
- 검증: typecheck 0 / lint 0 / test 1641→**1638**(−3=삭제 테스트). 17파일 +4 −146.

### 부산물 — orphan (→ `todo.md` dead-code 백로그)

- `evaluateContextWindow`(window-guard.ts) · `compactContext`(compaction.ts) = `maybeCompactMessages` 제거로 **프로덕션 orphan**(런타임 호출 0, 자체 유닛테스트 + 배럴 export 생존). → `agent/src/agents/context/` 압축 서브시스템 전체가 프로덕션 dead 후보. §3대로 미삭제.

---

## 결정 3 — `AuthProfile` 제거: 죽은 LLM 키-로테이션 클러스터 (실행 완료, 미커밋)

### 배경 (검증 완료)

- `AuthProfile`(types) + `agent/src/auth/{profiles,resolver}.ts`(`ManagedAuthProfile`·`InMemoryAuthProfileStore`·`resolveApiKeyForProvider`) = **Phase 6 부터 dead-on-arrival** (production 호출 0). claude CLI OAuth(구독) 인증이 API-키 인증을 대체(`backends.ts:49` env 키 비움).
- **사용자 질문 검증(중요):** 시세 API 키 로테이션은 **별개 live 클래스 `KeyRotator`**(`skills-finance/src/shared/key-rotator.ts`, finnhub·twelveData·alphaVantage)가 담당 — AuthProfile 과 import 무관. 즉 AuthProfile 제거가 시세 키 로테이션을 **안 건드림** → 제거 안전.

### 실행 (cascade)

- **삭제**: `auth/profiles.ts`(165) · `auth/resolver.ts`(97) · `test/resolver.test.ts`(131).
- **수정**: `types/agent.ts`(AuthProfile 제거) · `auth/health.ts`(`filterHealthy` 만 제거) · `agent/index.ts`(죽은 re-export 제거) · `health.test.ts`(filterHealthy 케이스 제거).
- ⚠️ **보존**: `ProfileHealthMonitor` · `CooldownTracker` (gateway/server live 소비) — typecheck/test 통과 확인. live→dead 의존 없었음.
- 검증: typecheck 0 / lint 0 / test 1638→**1628**(−10 = resolver 9 + filterHealthy 1).

### 부산물 — orphan

- `infra/events.ts:64` `'auth:resolve'` 이벤트 타입 = 유일 emit 처(resolver) 삭제로 **dead(unemitted)**. §3대로 미삭제, `todo.md` 백로그. (`auth:health:change` 는 live `ProfileHealthMonitor` 가 emit — 생존.)

---

## 결정 4 — `AgentRunParams`/`ProviderRequestParams` 슬림: CLI 가 무시하는 SDK-era 필드 제거 (실행 완료, 미커밋)

### 배경 (검증 완료 — 직접 + Explore 재확인)

- phase41 CLI 단일 전환 후 `AgentRunParams`(`types/agent.ts`) + `ProviderRequestParams`(`agent/providers/adapter.ts`) 가 SDK 시절 필드 잔존. **결정 2(ModelRef)와 동일 "CLI 경계 폐기" 패턴.**
- 검증된 데이터 흐름: `buildParams`(gateway/scheduler/execution-adapter) → `AgentRunParams` → `runner.ts:260-269` `ProviderRequestParams` 복사 → `CliProviderAdapter.#run()` 서 **누락** → `runCliAgent`(`RunCliAgentRequest` 에 필드 부재). 유일 `ProviderAdapter` 구현체 = claude-cli (anthropic/openai adapter phase41 삭제).
- 도구는 `backend.mcp`(`--allowedTools`)가 대체 — in-process MCP host(`gateway/mcp/{host,bridge}.ts`)가 `toolRegistry.list()` 를 노출하고 CLI 가 당겨감. 즉 도구 소스가 `AgentRunParams.tools` 가 아님.
- 필드 판정: `temperature`·`maxTokens` = **DEAD**(구성 사이트 set 0 + CLI 누락, 항상 undefined), `tools` = **plumbed-but-ignored**(구성서 채워지고 runner 가 복사하나 CLI 누락). `abortSignal` 만 CLI 도달(spawn SIGTERM/SIGKILL) — 생존.

### 실행 (cascade, 사용자 "셋 다 + cascade 지금")

- **제거**: `AgentRunParams` + `ProviderRequestParams` 의 `temperature`·`maxTokens`·`tools` + 고아 `ToolDefinition` import(adapter.ts). `runner.ts:260-269` 복사 3줄.
- **`tools` cascade**: gateway/agent.ts·scheduler.ts·execution-adapter.ts(execute+TUI 2경로) 의 `exposedTools`(라우터 `allowedToolNames` 필터) + `tools:` 줄 제거. execution-adapter 의 고아 `toolDefinitions` destructure 2 + `buildRequestDispatcher` 반환(타입+값) 동반 정리.
- 검증: typecheck 0 / lint 0 / **test 1628 불변**(footprint 0 — 어느 테스트도 3필드 미참조). 6파일 +4 −32.

### 의미 / 주의

- 라우터의 **model-selection 절반은 live 유지**(`decision.tier` → resolved model → fallback chain). 제거된 건 **tool-gating 절반**(per-run minModel 도구 필터) — CLI 모드선 MCP bridge 가 group/deny 로 정적 노출하므로 이미 vestigial 이었음.

### 부산물 — orphan (→ `todo.md` 백로그)

- `forceToolChoice`(adapter.ts:20) + runner `forceToolName` plumbing(127·137·244·268) = 동류 CLI-drop 잔재. 범위 밖 보류 (별 필드, `tools` 와 독립 제거 가능).

---

## 결정 5 — `RoutingConfig`/`routerHelper` 폐기 → `route_task` 도구 신규 (재설계, 미실행)

### 배경 (검증 완료)

- `RoutingConfig` + `routerHelper` 의 4 역할 × 3 tier 매트릭스 12 조합 중 **실제 사용 = 1** (`analysis` → opus, `skills-finance/src/news/tools.ts:174`). 나머지 11 조합은 정의되어 있으나 호출 사이트 0.
- 라우팅이 **텍스트 분류가 아닌 호출자 인자 매핑**임이 확인됨 (`agent/src/models/routing.ts:64` `resolveModelForRequest` 가 `cfg.roles[req.role].preferred` lookup 만). 메인 에이전트도 분류 안 함 — `analyze_market` 도구가 자기 코드에 `role: 'analysis'` 박아둠 + `agent.run` RPC 는 클라이언트 파라미터 (`gateway/rpc/methods/agent.ts:211` 디폴트 `'analysis'`).
- phase41 "3 겹 무력화" 확인: claude CLI 본체가 `routeToChain` 결과 무시 → 라우팅 효력은 `analyze_market` 호출 시 모델 선택 1 곳뿐. Discord 일반 대화 파이프라인(`pipeline.process`) 는 `routerHelper` 호출 자체 없음 — `defaultModel` 직사용.
- `tier` (`'haiku'|'sonnet'|'opus'`) 추상화는 Claude 단일 provider 전환 후 **모델 id 와 1:1**. `tierToModelId` 한 함수가 변환만 수행 → 추상화의 정당성 0.
- 결정 4 (`AgentRunParams.tools` 제거) 가 라우터의 tool-gating 절반을 vestigial 처리 → model-selection 절반만 남음. 그 절반도 호출처 1 곳.

### 설계 (option 2: main agent first, router as tool)

> 메인 ReAct 가 모든 input 을 받고, trivial · OSS · 전문 분석은 `route_task` 도구 1 회 호출로 위임.

- 메인 에이전트(claude CLI) 의 시스템 프롬프트가 "단순 조회·결정적 계산·전문 분석은 `route_task` 로 위임" 가이드.
- `route_task` 는 intent 별 3 분기:
  - **함수** — 결정적 내부 (e.g. `get_stock_price`). LLM 호출 0.
  - **OSS** — 외부 lib 직접 (e.g. `pykrx`). LLM 호출 0.
  - **sub-agent** — 좁은 system + 좁은 도구 세트 + 좁은 컨텍스트의 별도 LLM 실행. 메인 풀 컨텍스트(~10k) 미상속.
- **토큰 절감 source = sub-agent 의 좁은 컨텍스트**. 메인 입력은 그대로 들어가므로 trivial 쿼리 절감 0%, analysis-heavy 쿼리에서 sub-agent 컨텍스트 분리분 ~25% 절감 (한 줄 추산).

### 결과 타입 (신규)

```ts
// packages/router/src/types.ts (신규, workspace 의존 0)
export type RouteIntent =
  | 'price_lookup'
  | 'chart_data'
  | 'news_summary'
  | 'market_analysis'
  | 'portfolio_calc';

export interface RouteRequest {
  intent: RouteIntent;
  query: string;
  symbol?: string;
}

export interface RouteResult {
  content: string;
  source: 'function' | 'oss' | 'sub-agent';
  modelUsed?: string;
  isError: boolean;
}

export type Dispatcher = (req: RouteRequest) => Promise<RouteResult>;
```

### 제거 대상

| 파일 | 변경 |
| ---- | ---- |
| `packages/agent/src/models/routing.ts` | 전체 삭제 (ModelRole · RouteRequest · RouteDecision · resolveModelForRequest · RouterHelper · tierToModelId · maxTier · computeFloor · modelIdToTier) |
| `packages/server/src/auto-reply/router-helper.ts` | 전체 삭제 (makeRouterHelper · buildToolMetaIndex) |
| `packages/types/src/config.ts` | `RoutingConfig`, `RoleProfile`, `ModelTier` 제거 (cross-ref 검증 필요) |
| `packages/config/src/defaults.ts` | `DEFAULTS.routing` 블록 제거 |
| `packages/config/src/zod-schema.ts` | routing 스키마 제거 |
| `packages/server/src/main.ts:107-138` | routing 로드/로그 + `routerHelper` 생성 제거 |
| `packages/server/src/main.ts:206,296,335` | `routerHelper` 주입 3 곳 제거 |
| `packages/server/src/composition/{runtime,skills}.ts` | `routerHelper` deps 필드 제거 |
| `packages/skills-finance/src/news/tools.ts:172-178` | router 분기 → sub-agent dispatch 로 대체 |

### 신규 구조

> 새 패키지 만들지 않음 — 타입은 기존 `@finclaw/types`, runtime 은 server 내부. router 가 TUI/Web 에서 import 될 일 없으므로 server-only 가 자연스러움.

| 파일 | 책임 |
| ---- | ---- |
| `packages/types/src/router.ts` | RouteIntent · RouteRequest · RouteResult · Dispatcher (types barrel 에 추가) |
| `packages/server/src/router/dispatch.ts` | `dispatchRoute(req)` — intent 별 분기. 함수/OSS 직접 호출 + sub-agent 위임 |
| `packages/server/src/router/sub-agent.ts` | 좁은 컨텍스트 spawn 유틸 (claude CLI 재호출, 좁은 system + 좁은 도구) |
| `packages/skills-general/src/route-task.ts` | `route_task` 도구 정의 (Zod 입력 + dispatch 호출) |

### 마일스톤 (모두 phase42 안)

- **A. 골격** — `packages/router/` 패키지 (types only). typecheck 통과. 소비자 0 검증.
- **B. PoC (intent=market_analysis)** — sub-agent (opus + 좁은 system + `analyze_market` 도구만) 로 디스패치. 기존 `analyze_market` 본문이 sub-agent 내부로 이동. 메인 도구 목록에서 `analyze_market` 제거 → `route_task` 노출.
- **C. routerHelper 제거** — 위 "제거 대상" 표 전체 cascade. typecheck + 기존 unit test 가 인터페이스 의존 0 검증.
- **D. 확장** — `price_lookup` (함수 디스패치) + `chart_data` (pykrx OSS). 분류 = 메인 에이전트 (정규식 분류기 미도입).

### 결정 (사용자 확정)

- **sub-agent LLM 호출 방식 = claude CLI 재호출**. 별 프로세스 spawn. 메모리 "키 없이 부팅" 원칙 유지. spawn 비용/지연은 실측 없이 수용.
- **측정 마일스톤 (E) 제외**. 절감 실측은 별도 phase 또는 사용자 요청 시.

### 미결 / 주의

- **분류기 위치**: option 2 에서 메인 에이전트가 intent 를 결정 (`route_task({ intent: 'X', ... })` 직접 호출). 별도 분류기 LLM 불필요. 다만 메인 system prompt 가이드 정교화 필요 (어느 intent 가 있고, 언제 위임할지).
- **`agent.run` RPC `role` 파라미터**: 외부 호출자 (TUI/Web) 가 `role: 'analysis'|...` 보냄. 이 인터페이스 호환성 유지 vs 같이 제거 — TUI/Web 의 실제 사용 검증 필요 (A 단계 직전 grep).
- **결정 4 잔재 (`forceToolChoice`)**: 본 결정과 독립. orphan 백로그 그대로.

### 부산물 — orphan (예상)

- `ModelTier` 가 `routing.ts` 외에 쓰이면 부분 제거 어려움. cross-ref grep 검증 필요. (현재 추정: `models/routing.ts` 와 `config/zod-schema.ts` 두 곳뿐.)
- `tierToModelId` 사용처 grep 결과에 따라 `models/catalog.ts` 의 모델 id 매핑이 직접 노출되어야 할 수 있음. A 단계 직전 확인.
