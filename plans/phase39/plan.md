# Phase 39 — gateway 패키지 추출 (옵션 C2: Full gateway)

> base = main HEAD `6a408b7` (phase38 #73 머지 직후). kickoff = `plans/phase39/kickoff.md`.
> 감독 필요 — 자동 풀사이클 금지. 본 plan 승인 후에만 todo → 구현 진입.

## 결정 (2026-05-26)

`packages/server/src/gateway/` 전체(57 .ts · 비테스트 4,941 LOC + 테스트 4,994 LOC)를 신규 워크스페이스 패키지 **`@finclaw/gateway`** 로 분리한다. **rpc/methods/\* 포함 통째 이동** (옵션 C2 — AskUserQuestion 2026-05-26 사용자 선택: "Full gateway, server 축소 최대").

순환참조(server ↔ gateway)는 **결합 10건을 모두 하위 패키지로 역전**하여 해소한다 — gateway 가 server sibling 을 한 건도 import 하지 않게 만든 뒤 물리 이동. createGatewayServer 시그니처는 **유지**(C2 의 장점).

## ⚠️ 판단 기록 (CLAUDE.md §1 — 반론·보정 명시)

1. **kickoff value 결합 3 → 4 보정.** kickoff §핵심 블로커는 value(런타임) 결합을 3건으로 적었으나, 정밀 재스캔 결과 `agent.ts:18-22` 가 `execution-adapter` 에서 **`collectToolCalls`·`extractAssistantText` (런타임 함수)** 를 추가로 import 한다. 실제 value 결합은 **4 모듈**. (kickoff 는 execution-adapter 를 type-only 로 오분류.)
2. **유지보수 모드 + 부팅 e2e 미검증 상태의 대형 구조 변경.** gateway 는 startup 임계 경로. 메모리는 기능/추출보다 부팅 smoke 를 먼저 권장. → kickoff 가 사용자 명시 선택으로 **진행 결정**하되, 추출 **전 1회 + 후 1회** 실 키 `pnpm dev` smoke 를 밀스톤 E 에 못박는다.
3. **C1(thin) 대신 C2(full).** C1(transport 만 추출, methods 는 server 잔존)은 결합 해소 0건이나 createGatewayServer 계약을 역전해야 함. C2 는 결합 10건 해소가 필요하나 server 축소 최대 + createGatewayServer 계약 유지. 사용자가 server 축소 최대화를 선택.

## 현황 (코드 실측, 2026-05-26)

**진입점:** gateway 본체 생성은 `main.ts:292 createGatewayServer(...)` 단 한 곳. `createGatewayServer`(server.ts:76)는 13개 `registerXxxMethods` 를 **내부에서 import·호출**(server.ts:27-39, 136-182).

**gateway → server sibling 교차 import (정밀 분류, 해소 대상 10건):**

| #   | gateway 파일                         | → server 코어 모듈                 | 심볼                                       | 종류      | 소비자(server 코어 공유)                                |
| --- | ------------------------------------ | ---------------------------------- | ------------------------------------------ | --------- | ------------------------------------------------------- |
| 1   | rpc/methods/agent.ts:24              | auto-reply/tool-dispatcher-adapter | `buildDispatcher`                          | **value** | execution-adapter, scheduler                            |
| 2   | rpc/methods/agent.ts:18              | auto-reply/execution-adapter       | `collectToolCalls`, `extractAssistantText` | **value** | execution-adapter(self), scheduler                      |
| 3   | rpc/methods/agent.ts:26              | prompts/loader                     | `loadPrompt`, `requireFrontmatterKeys`     | **value** | main.ts                                                 |
| 4   | rpc/methods/schedule.ts:15           | automation/cron                    | `parseCron`, `nextRunAt`, `CronParseError` | **value** | scheduler, composition/schedule-rpc, composition/skills |
| 5   | rpc/methods/agent.ts:17              | auto-reply/agent-memory-hook       | `AttachMemoryService`                      | type      | —                                                       |
| 6   | rpc/methods/agent.ts:21              | auto-reply/execution-adapter       | `RunnerFactory`                            | type      | —                                                       |
| 7   | rpc/methods/agent.ts:23              | auto-reply/router-helper           | `RouterHelper`                             | type      | —                                                       |
| 8   | rpc/methods/agent.ts:25              | observability/tracer               | `FinclawTracer`                            | type      | —                                                       |
| 9   | rpc/methods/brokerage.ts:4           | services/brokerage-sync-service    | `BrokerageSyncService`                     | type      | —                                                       |
| 10  | rpc/methods/chat.ts:7 + server.ts:13 | auto-reply/execution-adapter       | `RunnerExecutionAdapter`                   | type      | —                                                       |

**핵심:** value 헬퍼 4개 모두 server 코어 + gateway 양쪽이 공유 → "server 잔존"(gateway→server)도 "gateway 이동"(server→gateway)도 순환. **하위 공유 패키지로 내리는 것만이 해법.**

**이동 홈 feasibility (실측 확인):**

- `cron.ts` — import 0, 순수 함수. → `@finclaw/infra` (backoff/retry/circuit-breaker 인접 유틸).
- `buildDispatcher` — `@finclaw/agent`(ExecutionToolDispatcher/toApiToolDefinition) + `@finclaw/types` 만 의존. → `@finclaw/agent` (이동 시 내부 import 화).
- `collectToolCalls`/`extractAssistantText` — `ConversationMessage`/`ContentBlock`(@finclaw/types)만 다루는 순수 함수 (`ToolCallRecord` 로컬 인터페이스 동반). 829-LOC execution-adapter 의 무거운 부분(pipeline-context/memory-retrieval)과 무관. → `@finclaw/agent` (`execution/` 디렉토리, `execution/token-fn` 선례).
- `loadPrompt`-`loadAgents` — gateway 는 `finclaw.identity.md` frontmatter(id/name/description)만 읽음. → **agent 메타데이터 주입으로 대체** (loader 이동 불필요, 파일시스템 결합 제거).
- type 6종 port 사용면(narrow): `RunnerExecutionAdapter`→`executeForTui` 만, `BrokerageSyncService`→`run()` 만, `RouterHelper`→함수 호출, `FinclawTracer`→`withSpan`, `AttachMemoryService`→`attach`, `RunnerFactory`→`(ExecutionToolDispatcher)=>Runner`.

**배선 비용 (실측 — 예상보다 낮음):**

- vitest `include: ['packages/*/src/**/*.test.ts']` + pnpm `packages/*` 글롭 = 신규 패키지 **자동 발견**. 테스트 1679개는 **재배치만**, vitest/pnpm 설정 변경 0.
- build(`tsc --build`)/typecheck(`tsgo`) = root `tsconfig.json` references 에 `{path: packages/gateway}` 한 줄 + gateway tsconfig references.

## 밀스톤 (각 = 1 커밋, 동작·로그·API 불변, 각 밀스톤 후 typecheck+build+test+lint green)

순서 핵심: A→B→C 로 gateway 의 server sibling import 를 **0 으로 만든 뒤** D 에서 물리 이동. A·B·C 는 gateway 가 아직 server 안에 있는 상태에서 import 만 하위 패키지로 re-point (각 단계 green 유지).

- **A — 순수 value 헬퍼 3종을 하위 패키지로 이동 + 전 소비자 re-point** (결합 #1·#2·#4 해소)
  - A1: `cron.ts` → `@finclaw/infra`. 소비자 re-point: scheduler, composition/schedule-rpc, composition/skills, gateway/schedule. (테스트 동반 이동.)
  - A2: `buildDispatcher`(+BuiltDispatcher/DispatcherContextBase) → `@finclaw/agent/execution/`. 소비자 re-point: execution-adapter, scheduler, gateway/agent. 빈 `tool-dispatcher-adapter.ts` 삭제.
  - A3: `collectToolCalls`·`extractAssistantText`(+ToolCallRecord) → `@finclaw/agent/execution/`. 소비자 re-point: execution-adapter(self, agent 에서 re-import), scheduler, gateway/agent. execution-adapter 의 잔여 export(RunnerExecutionAdapter/Mock/maybeCompact 등) 유지.
- **B — loadPrompt-loadAgents → 메타데이터 주입 대체** (결합 #3 해소)
  - gateway/agent.ts 의 `loadAgents()`(loadPrompt 사용) 제거, `AgentRpcDeps.agents: readonly AgentInfo[]` 추가. main.ts/composition 가 `loadPrompt('finclaw.identity.md')` 로 로드 후 주입. agent.list/status/run 메타 동일(의미 동등).
- **C — type 결합 6종을 port 인터페이스로 역전 (DIP)** (결합 #5~#10 해소)
  - `@finclaw/types` 에 narrow port 정의: `AttachMemoryPort`, `TracerPort`, `BrokerageSyncPort`, `ChatExecutionPort`, `RouterHelper`(함수형). `RunnerFactory` 는 agent-native → `@finclaw/agent`.
  - gateway type import 를 port 로 교체. server 클래스는 구조적 만족(typecheck 강제, 필요 시 `implements`).
  - **가드: 이 시점 gateway/ 의 server sibling import 0** (grep 검증).
- **D — gateway/ → packages/gateway/ 물리 추출 + 배선**
  - `git mv` 로 gateway/ 전체(테스트 포함) → `packages/gateway/src/`. 내부 상대 import 깊이 정리.
  - `packages/gateway/package.json`(deps: types/infra/agent/storage + ws + zod), `tsconfig.json`(references: types/infra/agent/storage), root `tsconfig.json` references 추가.
  - server: `@finclaw/gateway` workspace dep 추가, `../gateway/index.js` import → `@finclaw/gateway` (main.ts:292 외).
- **E — 검증 + smoke 게이트**
  - 전체 스위트 green(unit 1679 / storage), lint clean, gateway→server sibling import 0 재확인.
  - ⚠️ **실 키 부팅 smoke (사용자 액션, 자동 커버 불가):** 추출 전 1회 + 후 1회 `pnpm dev` — Gateway listening 로그 + Discord 온라인 + 스케줄러 기동.

## 의도적 비대상

- 동작·로그·공개 API 변경 (순수 추출 — 성공 기준은 불변).
- `openai-compat/*`(inbound OpenAI 호환 API)는 gateway 와 함께 이동·유지 (phase38 에서 유지 확정).
- 남은 백로그(P0-2 CLI 미등록 메서드, agent.list 드리프트, P1-6 tier 발산, dead code) — 별개 작업.
- mock-only 스탠스 유지 (실 키/네트워크 호출 테스트 금지).

## 완료 조건

1. gateway/ 가 `@finclaw/gateway` 로 분리, gateway → server sibling import 0 (grep 가드).
2. `pnpm typecheck` + `pnpm build` + `pnpm test --run`(1679) + `pnpm test:storage` + `pnpm lint` 모두 green.
3. 동작·로그·API 불변 (createGatewayServer 시그니처 유지).
4. review.md 에 실 키 부팅 smoke 게이트 결과(또는 미실시 리스크) 명시.

## 추정

밀스톤 5개. value 4 + type 6 결합 해소 + 물리 이동. phase36(main 모듈화, server 내부 순수 추출)보다 blast radius 큼 — 하위 패키지 3곳(agent/infra/types) 신규 표면 + server 코어(execution-adapter/scheduler/composition) re-point. 단 배선(vitest/pnpm/tsconfig)은 글롭 자동 발견으로 경량.

## 전제 / 리스크

- **#1 미검증 리스크 = 실 키 부팅 e2e** (phase35~38 누적). gateway 는 startup 임계 경로 → 밀스톤 E smoke 게이트로 완화하나 자동 테스트론 커버 불가. review 에 명시.
- collect/extract/buildDispatcher 이동이 execution-adapter 내부 사용과 얽힘 → re-import 순환 없음(server→agent 단방향) 확인됨.
- port 역전 시 server 클래스의 구조적 port 만족을 typecheck 가 강제.
- `cron → @finclaw/infra` 의 도메인 적합성: infra 가 cron 파서의 홈으로 맞는지 (backoff/retry 인접 유틸로 수용 제안 — **승인 시 확정**).
