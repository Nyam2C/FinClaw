# Phase 24 구현 리뷰

## 개요

Phase 24 는 `plan.md` 6 밀스톤 / `todo.md` 31 Todo 로 구성됐다. 목표는 **요청 역할(role) + 도구 minModel(C) → 모델 자동 선택 라우터** 도입과, 기존 6 개 LLM 호출 site (chat / agent.run / pipeline / executeForTui / analyze_market / sentiment) 의 라우터 연결.

브랜치 `feature/model-role-routing` (base: `main`) 에서 **9 개 코드 커밋 + 4 개 문서 커밋**. 작업 트리 clean.

코드 영향: **32 파일, +1594 / −100 LOC** (테스트 포함). 신규 파일 4: `packages/agent/src/models/routing.ts`, `packages/agent/test/routing.test.ts`, `packages/server/src/auto-reply/router-helper.ts`, `packages/types/test/skill-metadata.test.ts`.

테스트: **1322 → 1358 (+36 신규)**. routing.test 30 + fallback floor 7 + skill-metadata 4 + 기타 −5 (중복 제거).

---

## 커밋 시퀀스 (시간순)

| 커밋      | 범위     | 변경 요약                                                               |
| --------- | -------- | ----------------------------------------------------------------------- |
| `705b25f` | 밀스톤 A | RoutingConfig 타입 / Zod 스키마 / config.example / 기동 로그            |
| `a67de11` | 밀스톤 B | SkillMetadata / ToolMetadata 신설, 4개 SKILL_METADATA 객체 배열 전환    |
| `1aabe2b` | C-1      | `routing.ts` 라우터 모듈 (resolveModelForRequest 등) + 30 단위 테스트   |
| `cce293c` | C-2      | 라우터 wiring — adapter / chat.send / agent.run + main.ts toolMetaIndex |
| `924e2eb` | C-3      | 스킬 내부 LLM (analyzeMarket/sentiment) modelRef 주입                   |
| `b190c28` | 밀스톤 D | FallbackConfig.floor / ModelFloorExhaustedError + 한국어 에러 캐치 4곳  |
| `a403830` | 밀스톤 E | recordResult overload + byModel 집계 + status 모델 분포 출력            |
| `76ce3d8` | 핫픽스   | Deprecated 모델 ID 일괄 교체 (claude-sonnet-4-6 / claude-haiku-4-5-...) |

---

## Todo별 구현 일치도

### 밀스톤 A (Todo 1-4)

| Todo | 항목                        | 상태 | 커밋      | 비고                                                        |
| ---- | --------------------------- | ---- | --------- | ----------------------------------------------------------- |
| 1    | RoutingConfig 타입 (types)  | OK   | `705b25f` | ModelTier / RoleProfile / RoutingConfig                     |
| 2    | Zod 스키마 + 기본값         | OK   | `705b25f` | strictObject + ModelTier enum, defaults.ts DEFAULTS.routing |
| 3    | config.example.json5 라우팅 | OK   | `705b25f` | 한국어 주석 + 4 role + automation/override                  |
| 4    | 기동 시 라우팅 테이블 로그  | OK   | `705b25f` | `routing.loaded` event + ConfigValidationError 차단         |

### 밀스톤 B (Todo 5-10)

| Todo | 항목                          | 상태 | 커밋      | 비고                                                                     |
| ---- | ----------------------------- | ---- | --------- | ------------------------------------------------------------------------ |
| 5    | SkillMetadata/ToolMetadata    | OK   | `a67de11` | + normalizeSkillMetadata, ModelTier 의존성 추가                          |
| 6    | market 메타 전환              | OK   | `a67de11` | 4 도구 모두 minModel=haiku                                               |
| 7    | news 메타 전환                | OK   | `a67de11` | analyze_market=opus, get_portfolio_summary=sonnet, 나머지 haiku          |
| 8    | alerts 메타 전환              | OK   | `a67de11` | 4 도구 모두 haiku                                                        |
| 9    | general 메타 전환             | OK   | `a67de11` | 3 도구 모두 haiku                                                        |
| 10   | normalizeSkillMetadata 테스트 | OK   | `a67de11` | 신/구/혼합/빈 4 케이스. 위치는 plan 의 `__tests__/` 가 아닌 `test/` 채택 |

### 밀스톤 C (Todo 11-20)

| Todo | 항목                          | 상태 | 커밋      | 비고                                                                                              |
| ---- | ----------------------------- | ---- | --------- | ------------------------------------------------------------------------------------------------- |
| 11   | routing.ts 라우터 신설        | OK   | `1aabe2b` | resolveModelForRequest, computeFloor, maxTier, tierToModelId, modelIdToTier                       |
| 12   | routing.test.ts               | OK   | `1aabe2b` | 30 케이스 (B2/B6/floor/automation/reason 커버)                                                    |
| 13   | gateway.ts modelHint/role     | 변경 | `cce293c` | 별도 ChatSendParams 인터페이스가 부재. inline RpcMethodHandler generic 에서 직접 확장             |
| 14   | main.ts 라우터 주입           | OK   | `cce293c` | makeRouterHelper + buildToolMetaIndex (4 SKILL_METADATA aggregate)                                |
| 15   | chat.send 매 메시지 라우팅    | OK   | `cce293c` | modelHint?: ModelTier 추가, executeForTui 로 forward                                              |
| 16   | agent.run role 파라미터       | OK   | `cce293c` | role enum (default 'analysis'), router 호출 → modelRef 교체                                       |
| 17   | execution-adapter 라우팅      | OK   | `cce293c` | inferRole + applyRouting/applyTuiRouting, 키워드 휴리스틱 (분석/리포트/판단/analyze/report)       |
| 18   | market-analysis modelRef 주입 | OK   | `924e2eb` | 4번째 인자로 modelRef                                                                             |
| 19   | sentiment modelRef 주입       | 변경 | `924e2eb` | plan 의 `(client, news, hint, modelRef)` 시그니처 채택 X — back-compat 유지 위해 옵션 인자로 추가 |
| 20   | news/index 라우터 의존성 주입 | OK   | `924e2eb` | NewsSkillConfig.router/defaultModel + tools.ts executor 가 router 호출                            |

### 밀스톤 D (Todo 21-24)

| Todo | 항목                        | 상태 | 커밋      | 비고                                                                              |
| ---- | --------------------------- | ---- | --------- | --------------------------------------------------------------------------------- |
| 21   | fallback.ts floor + 신 에러 | OK   | `b190c28` | FallbackConfig.floor / automation / strictFallback, ModelFloorExhaustedError      |
| 22   | fallback.test floor 케이스  | OK   | `b190c28` | 7 케이스 (opus/sonnet/haiku 차단 + chainAttempted + 빈 chain + automation+strict) |
| 23   | chat / agent 에러 캐치      | OK   | `b190c28` | 한국어 메시지 변환, cause 보존                                                    |
| 24   | 스킬 내부 에러 캐치         | OK   | `b190c28` | analyze_market executor → isError + 한국어 (외부 LLM 자연어 안내용)               |

### 밀스톤 E (Todo 25-29)

| Todo | 항목                                 | 상태 | 커밋      | 비고                                                                                                             |
| ---- | ------------------------------------ | ---- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| 25   | recordResult 영향 범위 측정          | OK   | `a403830` | grep 결과 5 호출 site 식별 → overload 채택                                                                       |
| 26   | ProfileState.byModel + 시그니처      | OK   | `a403830` | recordResult overload (boolean ↔ RecordOptions), getModelBreakdown(profileId, sinceMs)                           |
| 27   | runner 구조화 로그 + 시스템 프롬프트 | 부분 | `a403830` | runner 내부 구조화 로그는 보류 (adapter/agent.ts 의 \*.routed 가 동등 정보). DEFAULT_SYSTEM_PROMPT 가이드만 추가 |
| 28   | status-command 모델 분포             | OK   | `a403830` | tier 정렬 막대그래프 + 비용 + fallback 카운트                                                                    |
| 29   | 스킬 recordResult 호출               | OK   | `a403830` | analyzeMarket 가 AnalysisRecordDeps 받아 성공/실패 모두 기록. profileId='skill-news-analyze'                     |

### 밀스톤 F (Todo 30) — Stretch

| Todo | 항목                    | 상태   | 비고                                                           |
| ---- | ----------------------- | ------ | -------------------------------------------------------------- |
| 30   | app-chat 모델 hint 버튼 | 미진행 | Stretch — 백엔드 인프라 (chat.send.modelHint) 는 C-2 에서 완성 |

### Todo 31 — E2E 검증

| Todo | 항목                  | 상태 | 비고                                                                          |
| ---- | --------------------- | ---- | ----------------------------------------------------------------------------- |
| 31   | E2E 시나리오 8개 검증 | 부분 | 1, 2, 5 시나리오는 Discord 실 채팅으로 확인. 4, 7, 8 은 추가 셋업 필요 — 후술 |

---

## 계획 외 추가 변경

| 항목                                                                    | 이유                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `RouterHelper` 타입을 `@finclaw/agent` 로 승격                          | C-3 작업 중 발견. skills-finance 가 server/router-helper 를 import 시 의존성 역전 발생         |
| `buildToolMetaIndex(skills)` 헬퍼                                       | main.ts 가 4 SKILL_METADATA 를 단일 Map 으로 모으는 코드 중복 회피                             |
| `AnalysisRecordDeps` 인터페이스 (skills-finance)                        | analyzeMarket 가 profileHealth + modelCatalog 를 받기 위한 옵션 컨테이너                       |
| executeForTui 가 runWithModelFallback 사용 (이전엔 단일 모델 직접 호출) | 밀스톤 D 의 floor 보호를 chat.send 에도 적용하기 위해 필요                                     |
| AgentRpcDeps 에 `modelCatalog/aliasIndex/fallbackChain` 추가            | agent.run 도 fallback chain + floor 보호 받도록 (D 일관성)                                     |
| chat methods 에 `logger?: FinClawLogger` 옵션                           | floor_exhausted 구조화 로그용. agent.\* 의 logger 와 공유                                      |
| Deprecated 모델 ID 일괄 교체 (커밋 `76ce3d8`)                           | 테스트 직전 sub-agent 스캔으로 발견. catalog 미존재 ID 가 fallback 경로에서 503 위험 사전 정리 |

---

## 계획 vs 실제 API 차이 (todo.md 가정 보정)

| 영역                           | 계획 가정                                          | 실제 코드                                                             | 대응                                                               |
| ------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `gateway.ts` 의 ChatSendParams | 별도 export 인터페이스가 존재한다고 가정           | 없음. params 는 `RpcMethodHandler` generic 에 inline 정의             | inline generic 에서 modelHint?: ModelTier 직접 추가. Todo 13 흡수  |
| FinClawLogger 시그니처         | `logger.info({...}, 'msg')` 객체 우선 형식         | `logger.info(msg: string, ...args: unknown[])` — 메시지 문자열이 우선 | 모든 구조화 로그를 `logger.info('event-name', {...})` 순서로 보정  |
| ModelCatalog API               | `getById(modelId)` 메서드 가정                     | 실제는 `getModel(modelId)`                                            | market-analysis.ts 의 cost 조회 코드 보정                          |
| recordResult 호출 site         | "변경 가능 / 영향 작음" 가정                       | 5 곳 (profiles.ts, execution-adapter ×2, agent.ts ×2)                 | overload 방식 채택 — boolean 호출자 그대로 두고 RecordOptions 추가 |
| analyzeSentiment 시그니처      | plan 예시: `(client, news, hint, modelRef)` 4 인자 | `(news, client?)` — client 는 옵션, 호출자는 테스트뿐                 | 옵션 인자로 추가. plan 시그니처 비채택                             |
| oxlint 의 curly enforcement    | inline `if (x) return;` 패턴 허용 가정             | 강제로 `{return;}` 요구                                               | 라우팅 모듈의 모든 single-line if 에 brace 추가                    |

---

## 상세 리뷰

### 밀스톤 A — Config 인프라

`RoutingConfig` 가 `FinClawConfig.routing?` 에 추가됨. Zod strictObject + ModelTier enum 으로 잘못된 role/tier 입력 차단. defaults.ts 에 `DEFAULTS.routing` 4 role + automation + override 추가. `applyDefaults` 가 부분 입력도 deep merge 로 보강.

main.ts 변경은 단 30 줄: `loadConfig({ logger })` + `validateConfigStrict(finclawConfig)` + 한 줄 진단 로그.

### 밀스톤 B — 스킬 메타 전환

기존 `*_SKILL_METADATA` 4 개 객체의 `tools` 필드를 `string[]` → `ToolMetadata[]` 로 전환. `as const` 제거하고 `: SkillMetadata` 타입 명시로 readonly literal 보존.

`normalizeSkillMetadata` 는 신/구 형식 모두 받지만 현재 코드베이스는 모두 신 형식. 외부 플러그인 호환을 위한 안전망.

### 밀스톤 C — 라우터 + 호출 site 배선

3 단계 commit (C-1/C-2/C-3) 로 분할:

- **C-1**: 순수 함수 모듈 신설 + 30 테스트
- **C-2**: server 측 wiring (adapter, RPC handlers, main.ts)
- **C-3**: skill 내부 LLM (analyze_market) 의 modelRef 주입

C-2 에서 `RouterHelper` 의 위치가 핵심 결정. server 에 두면 skills-finance import 시 의존성 역전 → C-3 시작 시 agent 패키지로 이동. `makeRouterHelper`/`buildToolMetaIndex` 구현체는 server 에 잔류.

### 밀스톤 D — Fallback floor

`FallbackConfig.floor` 가 핵심. fallback chain 사전 필터링 + chain 빈 / 모두 실패 시 `ModelFloorExhaustedError` throw. 기존 caller (floor 미설정) 는 AggregateError 동작 그대로 유지 — 100% 후방 호환.

`automation + strictFallback` 는 동일 tier 만 허용 (이상도 이하도 차단). 자동화 컨텍스트의 비용/예측 일관성 보호용. 단위 테스트 1 케이스로 검증.

밀스톤 D 작업 중 executeForTui 도 runWithModelFallback 으로 통일했음 (이전엔 단일 모델 직접 호출). 결과: chat.send 도 floor 보호를 받게 됨.

### 밀스톤 E — 감사 로그 + status

`recordResult(profileId, RecordOptions)` overload 가 핵심. 기존 boolean 호출자 4 곳은 그대로 두고, 신규 호출 site 가 modelId/tokens/costUsd/isFallback 을 채워 byModel 집계 활성화. `getModelBreakdown(profileId, sinceMs)` 는 windowSizeMs 와 별개로 sinceMs 윈도우 내 calls 수만 시간 가중.

`!finclaw status` 출력에 모델별 막대그래프 + 비용 + fallback 카운트 추가. 스킬 내부 LLM (analyze_market) 호출도 별도 profileId='skill-news-analyze' 로 기록 — 분포에 포함.

Todo 27 의 runner 내부 구조화 로그는 보류. role/automation/userHint 등 라우팅 컨텍스트를 Runner 까지 plumbing 하는 비용 대비, adapter/agent.ts 의 `*.routed` 로그가 이미 동등 정보를 제공한다고 판단.

---

## 범위 외 (의식적으로 남긴 것)

| 항목                                                          | 사유                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 밀스톤 F (web UI Opus 버튼)                                   | Stretch. 백엔드는 C-2 에서 완성. 응답 메시지의 modelTier 노출 인프라가 추가로 필요해 비용 ↑ |
| Runner 내부 구조화 로그                                       | adapter/agent.ts 의 \*.routed 가 동등. plumbing 비용 대비 가치 낮음                         |
| 자동화 / 크론 path 의 strictFallback 실 환경 검증             | 단위 테스트로 확정. 실 자동화 트리거 / mock 503 셋업은 별도 스프린트                        |
| sentiment 스킬을 라우터에 등록                                | 현재 sentiment 는 도구로 등록되지 않음 (analyzeSentiment 만 정의). 라우터 호출 site 가 없음 |
| ProfileHealthMonitor 의 alert 채널                            | byModel 통계가 임계 초과 시 알림 발송 — 기능 자체가 새로운 시스템                           |
| OpenAI compat adapter 의 GPT-4o → claude-sonnet-4-6 매핑 정책 | 단순 ID 교체만. 실제 GPT-4o 사용자에게 동일 가격대 모델 매핑이 옳은지 별도 검토             |

---

## 개선 여지 (다음 Phase 에서 고려)

### 🔴 핵심 — 도구 minModel 으로 인한 모든 chat → Opus 승격

**증상:** Discord 실 채팅 4 메시지 모두 `claude-opus-4-7` 로 라우팅됨 (1 개만 'analysis', 3 개는 'chat').

```
msg-1 "안녕"     → role=chat, A=sonnet, C=opus → opus (tool_min)
msg-2 "AAPL 얼마야?" → role=chat, A=sonnet, C=opus → opus (tool_min)
msg-3 "분석해줘"  → role=analysis, A=opus, C=opus → opus (role)
msg-4 (chat)    → role=chat, A=sonnet, C=opus → opus (tool_min)
```

**원인:** execution-adapter 의 `applyRouting()` 이 `toolRegistry.list()` 의 **전체 도구** 를 라우터에 전달. `analyze_market` (minModel=opus) 한 도구만으로 floor=opus 가 되어 모든 chat 메시지가 Opus 강제.

**기술적으로는 의도된 동작** (B6: respectMinModel=true). 그러나 실용적으로는:

- 90 % 의 채팅이 분석 도구 미사용임에도 Opus 비용 발생 (~ Sonnet 의 5×, Haiku 의 19×)
- 라우팅의 본래 가치 (역할별 비용 최적화) 가 무력화됨

**해결 후보:**

1. **Lazy 도구 노출** — 라우터 1 차 결정 (haiku) 시점엔 도구 0개 → role 만 적용. LLM 응답에 tool_use 가 보이면 2 차 라우터 호출. 비용: Haiku 추가 1 회 호출 (~$0.001) ↔ Opus 절약 (~$0.05)
2. **Config 토글** — `routing.override.respectMinModel: false` 로 즉시 비활성화 가능. 안전성 ↓ 비용 ↓
3. **2 단계 라우팅** — Haiku 가 메시지 의도 분류 → 분류 결과로 tools whitelist + 라우터 호출. 정확도 ↑ 추가 호출 1 회

**권장:** Phase 25 또는 별도 PR 에서 후보 1 택. 단기 회피책으로 후보 2 (config 토글) 도 가능.

### 🟡 미반영된 코드 정리 (테스트 직전 sub-agent 스캔으로 발견)

| 항목                        | 위치                                                                                                  | 통합안                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `TIER_RANK` 3 곳 중복       | `agent/models/routing.ts:4`, `agent/models/fallback.ts:30`, `server/auto-reply/commands/status.ts:59` | `routing.ts` 에서 export → 두 곳 import              |
| `ModelRole` 타입 중복       | `routing.ts:7` (TS 유니온) vs `agent.ts:145` (Zod 리터럴)                                             | 단일 진실 출처 통합 (Zod inferred 또는 z.nativeEnum) |
| Fallback 매개변수 중복      | `execution-adapter.ts:190, 308` 의 `maxRetriesPerModel: 1`, `retryBaseDelayMs: 500`                   | constants 모듈 또는 FallbackConfig 기본값            |
| `'dev-secret'` JWT fallback | `main.ts:62`                                                                                          | production 모드에서 환경변수 강제화                  |

### 🟢 Phase 25 인계 (이미 plan 부록에 명시)

- DEFAULT_SYSTEM_PROMPT 외부화 (`prompts/finclaw.system.ko.md`)
- `buildAnalysisSystemPrompt` 6 변형 외부화
- sentiment 시스템 프롬프트 (`{{ruleHint}}` 변수)
- agent.ts AGENTS 메타와 시스템 프롬프트 페르소나 통합

---

## 검증 결과

### 정적 검증 (모두 통과)

```bash
pnpm build                          # tsc --build, 0 errors
pnpm lint                           # 0 warning, 0 error (오xlint 122 rules)
pnpm format                         # oxfmt clean, 594 files
pnpm test                           # 1358 passed (149 test files)
```

### 단위 테스트 신규 분포

| 파일                                         | 신규 케이스                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/agent/test/routing.test.ts`        | 30 (maxTier, computeFloor, resolveModelForRequest, hint, floor, automation, tier ↔ ID, reason) |
| `packages/agent/test/fallback.test.ts`       | +7 (floor=opus/sonnet/haiku 차단, chainAttempted, automation+strict, 빈 chain)                 |
| `packages/types/test/skill-metadata.test.ts` | 4 (신/구/혼합/빈)                                                                              |
| `packages/config/test/zod-schema.test.ts`    | +3 (routing 허용 / 알 수 없는 role / 잘못된 tier)                                              |
| `packages/config/test/defaults.test.ts`      | +2 (routing 기본값 / 부분 오버라이드)                                                          |

### 실 환경 검증 (Discord 봇 / Docker 컨테이너)

| 시나리오                      | 결과 | 로그 증거                                                                                              |
| ----------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| 부팅 시 routing 테이블 출력   | ✅   | `event: 'routing.loaded', table: { fetch:'haiku', chat:'sonnet', analysis:'opus', summarize:'haiku' }` |
| 일반 채팅 (chat role 추론)    | ⚠️   | role 추론은 의도대로. 단 tool_min 으로 Opus 승격 (위 개선 여지 참조)                                   |
| 분석 키워드 → analysis role   | ✅   | "분석해줘" → `role: 'analysis', reason: 'A=opus, C=opus → opus (role)'`                                |
| reason 문자열 디버깅 가능성   | ✅   | `A=sonnet, C=opus, hint=none → opus (tool_min)` 형태로 모든 결정 추적 가능                             |
| Discord 봇 로그인 + 도구 등록 | ✅   | FinClaw#5522, market/news/alert tools 모두 registered                                                  |
| Gateway 3000 포트             | ✅   | healthy 상태로 Up                                                                                      |

### 미검증 (실 트리거 부재)

| 시나리오                           | 사유                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| chat.send WebSocket (`tui.routed`) | Discord 만 사용. Web UI 또는 RPC 직접 호출 필요                |
| agent.run RPC (`agent.run.routed`) | RPC 직접 호출 필요. agentRunLane(1) 큐잉 동시 검증             |
| Floor 차단 → 한국어 에러           | Opus 503 mock 또는 잘못된 API 키 강제 필요. 단위 테스트로 확정 |
| `!finclaw status` 모델 분포        | 실 명령 호출 + 1 시간 누적 데이터 필요                         |
| automation+strictFallback          | 크론/agent.run automation 트리거 필요                          |

---

## 사용자 직접 검증 체크리스트

### 0. 준비

```bash
# .env 가 채워져 있어야 함 (ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN 등)
cat .env | grep -v "^#\|^$"

# Docker 사용 시:
pnpm dev:all
docker logs finclaw-server -f

# 직접 기동:
pnpm dev
```

### 1. 부팅 + routing.loaded

```bash
docker logs finclaw-server 2>&1 | grep -A 5 "routing.loaded"
# 출력 4 role 매핑 + automation/override 확인
```

### 2. Discord 일반 채팅

```
사용자: "안녕"
docker logs finclaw-server 2>&1 | grep -A 7 "pipeline.routed"
# role: 'chat', overriddenBy: 'tool_min' 또는 'role'
```

### 3. Discord 분석 키워드

```
사용자: "이 뉴스가 내 포트에 미치는 영향 분석해줘"
# role: 'analysis', chosenModel: 'claude-opus-4-7'
```

### 4. !finclaw status

```
사용자: "!finclaw status"
# 응답에 "최근 1시간 모델 분포" 섹션 + 막대그래프 확인
```

### 5. JSON-RPC chat.send modelHint (옵션)

```bash
curl -X POST http://localhost:3000/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"chat.send","params":{
    "sessionId":"<active-session-id>",
    "message":"안녕",
    "modelHint":"opus"
  },"id":1}'
# 로그: tui.routed { userHint: 'opus', overriddenBy: 'hint' }
```

### 6. JSON-RPC agent.run role (옵션)

```bash
curl ... -d '{"method":"agent.run","params":{
  "agentId":"finclaw-partner",
  "prompt":"AAPL 분석",
  "role":"analysis"
},"id":1}'
# 로그: agent.run.routed { role: 'analysis', chosenModel: 'claude-opus-4-7' }
```

---

## Done

- [x] 31 Todo 중 30 완료 (Stretch F 제외, 31 부분)
- [x] 9 코드 커밋 + 4 문서 커밋
- [x] 단위 테스트 +36 (1322 → 1358)
- [x] 실 환경 부팅 + Discord 라우팅 4 메시지 검증
- [x] Deprecated 모델 ID 핫픽스 (커밋 `76ce3d8`)
- [x] todo.md 부록에 후속 정리 항목 명시
- [ ] 도구 minModel 으로 인한 chat → Opus 승격 — Phase 25 또는 별도 PR
- [ ] TIER_RANK / ModelRole / fallback 매개변수 중복 통합 — 별도 PR
- [ ] dev-secret JWT fallback production 강제화 — 배포 전
- [ ] Floor 차단 한국어 에러 실 환경 검증 — 별도 mock 셋업

## 핵심 학습

1. **단일 진실 출처 (SSOT) 의 가치** — RouterHelper 타입을 잘못된 패키지 (server) 에 두면 의존성 역전. C-3 작업 중 발견하고 agent 패키지로 이동했지만 처음부터 agent 에 두는 게 깔끔.
2. **Overload 의 후방 호환 가치** — recordResult 의 5 호출 site 를 일괄 변경하는 대신 boolean overload 유지. 작업 분량 감소 + 깨질 위험 차단.
3. **테스트 직전 코드 스캔의 가치** — sub-agent 4 개 병렬로 deprecated 모델 ID 발견. 실 환경에서 503 으로 발견했으면 디버깅 비용 ↑.
4. **로그가 의도와 일치 ≠ 의도가 옳음** — 라우터는 plan 대로 동작 (tool_min 승리) 하지만 사용자 입장에선 비싼 부작용. 단위 테스트로는 발견 불가능, 실 환경 로그 분석에서만 보임.
