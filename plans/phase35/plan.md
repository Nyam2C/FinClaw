# Phase 35 — 백로그 후속 P1 정리 (라우터 AbortSignal/중복 · RPC 레지스트리 격리)

> phase34 review §9 의 미해결 P1 항목 중 **키 불요·외과적으로 닫을 수 있는 3건**을 한 phase 로 묶어 정리.
> 🔴 실 키 end-to-end 검증(키 필요)·🟡 server 분할/truncate 동적화(큰 리팩토링·투기적)·국내(KR) 주식 RAG(스코프 외)는 본 phase 비대상.

## 동기

phase34 머지 후 유지보수 모드. 코드 주석·review.md 에 **이미 인지된** 후속 항목들이 쌓여 있다. 큰 구조 변경(server 분할)이나 외부 키 검증(e2e)과 달리, 아래 3건은 스코프가 작고 자기완결적이라 한 사이클로 닫을 수 있다.

## 범위 (코드 실측 기반, 2026-05-25)

### 1. 라우터 호출 AbortSignal 전달 (phase34 잔여 P1-2)

- **현상**: `execute(ctx, signal)`/`executeForTui(…, signal)` 의 signal 이 메인 러너엔 전달되나(`abortSignal: signal`, `:256/:414`) 라우터 경로엔 **미전달**. `applyRouting`→`routeOrFallback`→`routerLlm`→`chatCompletion` 가 signal 을 못 받아, pipeline timeout 후에도 라우터 in-flight HTTP 가 SDK 자체 timeout 까지 매달림.
- **유리한 조건**: `ProviderRequestParams.abortSignal?: AbortSignal` 가 **이미 존재**(`adapter.ts:15`). 순수 배선만 하면 됨.
- **수정**: `RouterInput`(`llm-router.ts:26`)에 `abortSignal?: AbortSignal` 추가 → `createLlmRouter` 의 `chatCompletion({…, abortSignal: input.abortSignal})`(`:136`) → `routeOrFallback(msg, tools, signal)` → `applyRouting`/`applyTuiRouting` 가 signal 받아 전달 → `execute`/`executeForTui` 가 자신의 signal 주입.
- **대상**: `packages/agent/src/router/llm-router.ts`, `packages/server/src/auto-reply/execution-adapter.ts`

### 2. applyRouting / applyTuiRouting 공통 코어 추출 (phase34 잔여 P1-4)

- **현상**: `applyRouting`(`execution-adapter.ts:488-524`)과 `applyTuiRouting`(`:573-613`)이 거의 동일. 차이는 (a) 메시지 출처(`args.message` vs `args.input.userMessage`), (b) 로그 이벤트명(`pipeline.routed` vs `tui.routed`) 뿐. `routeOrFallback`→`tierToModelId`→chain 구성→return shape 전부 중복.
- **수정**: 공통 헬퍼 `private async routeToChain(message, toolDefinitions, logEvent, signal)` 추출, 두 호출자는 메시지·이벤트명만 넘겨 위임.
- **의존**: **항목 1 과 같은 함수(`applyRouting`/`applyTuiRouting`/`routeOrFallback`)를 건드림 → 반드시 항목 1 과 같은 밀스톤에서 처리** (이중 편집 방지).
- **대상**: `packages/server/src/auto-reply/execution-adapter.ts`

### 3. RPC 메서드 레지스트리 인스턴스 격리 (review-3 TODO)

- **현상**: `const methods = new Map()`(`rpc/index.ts:15`)가 **모듈 레벨 전역**. `TODO(review-3)`(`:14`)가 `GatewayServerContext` 소속으로 이동해 서버 인스턴스별 격리를 권장. 현재 테스트는 `clearMethods()` 로 우회 중.
- **수정 방향**: 레지스트리를 `GatewayServerContext` 가 소유, 등록을 서버 구성 시점에 명시적으로. `registerMethod`/`getRegisteredMethods`/`clearMethods`/`dispatchRpc`/`handleSingleRequest` + main.ts 등록부 + 각 method 파일 등록 호출이 영향권. **본 phase 3건 중 blast radius 최대** → 밀스톤 마지막.
- **대상**: `packages/server/src/gateway/rpc/index.ts`, `packages/server/src/gateway/context.ts`, `main.ts`, 등록 호출하는 method 파일들.

## 밀스톤

- **A. 라우터 AbortSignal + 라우팅 헬퍼 통합** (항목 1+2) — `llm-router.ts` + `execution-adapter.ts`. signal 배선 + `routeToChain` 추출 동시. 같은 함수 편집이라 단일 밀스톤.
- **B. RPC 레지스트리 인스턴스 격리** (항목 3) — blast radius 최대, 마지막. typecheck/test 가 안전망. B 가 과하다고 판명되면 A 는 이미 머지된 상태로 분리 가능.

각 밀스톤 = 1 커밋, typecheck + `pnpm test --run` 통과 후 다음 진행.

## 의도적 비대상

- **실 키 end-to-end 검증** — `ANTHROPIC`/`KIS`/`DISCORD` 키 + `claude login` 필요. 별도 트랙(검증 스크립트 준비).
- **server 패키지 분할 / `main()` 706줄** — 큰 아키텍처 리팩토링. 자체 phase 로 신중히. (핸드오프도 "압력 생기면" 분류)
- **truncate 400K 동적 산정**(`runner.ts:190`) — 코드 주석이 "multi-provider 시 필요". 현재 Anthropic 단일 → 투기적 유연성(§2), multi-provider 실제 도입 전엔 보류.
- **국내(KR) 주식 RAG / 6자리 종목코드 추출** — 사용자 결정(2026-05-25): 국내 주식 미대상. `extractSymbols` 의 대문자 티커 전용 동작은 그대로 정상 (KR 누락은 갭이 아니라 의도된 스코프).
- **별도 라우터 timeout 도입** — 항목 1 은 signal 전달만. 라우터 전용 timeout 정책은 phase34 §비대상 유지.
- **항목 3 의 agent.ts 통계 Map**(`activeRuns`/`totalCalls` 등 `:147-150`) — review-3 TODO 는 `methods` 레지스트리 한정. 통계 Map 격리는 별건.

## 완료 조건

- [ ] 라우터 경로에 AbortSignal 전달 — abort 시 라우터 chatCompletion 이 즉시 취소되는 단위 테스트 (mock provider 가 signal.aborted 확인)
- [ ] `applyRouting`/`applyTuiRouting` 가 공통 `routeToChain` 위임, 기존 라우팅 동작 회귀 없음 (기존 테스트 green)
- [ ] RPC 레지스트리가 인스턴스별로 격리 — 테스트가 `clearMethods()` 전역 우회 없이 격리됨
- [ ] `pnpm typecheck` + `pnpm test --run` + `pnpm test:storage` + `pnpm lint` 전부 green

## 추정

중: A (1일, signal 배선 + 리팩). 중~대: B (1-1.5일, 등록 API 변경). 합 2-2.5일.

## 전제 / 리스크

- phase34 가 현 finish line. 본 phase 는 유지보수 성격의 P1 정리.
- **리스크(§1 명시)**: 항목 3(RPC 격리)은 단일 프로세스·1인 스코프에선 실익이 제한적이고 등록부 전반을 건드린다. todo-architect 가 blast radius 가 실익 대비 과하다고 판단하면 **B 만 별도 phase 로 분리**하고 A 만 닫는 선택지를 plan 승인자에게 다시 제시할 것.
- mock-only 테스트 스탠스 유지 — 항목 1 의 abort 테스트도 mock provider 로 (실 네트워크 X).
