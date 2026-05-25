# Phase 39 Review: gateway 패키지 추출 (옵션 C2 — Full gateway)

> base `6a408b7` → HEAD `94ba3ac` (branch `phase39-gateway-extraction`). 커밋 4개(A~D) + E 검증.
> 종합: **PASS — 머지 가능** (P0/P1 0건, 전 게이트 green). 단 E4 실 키 부팅 smoke = 사용자 수동 잔여(#1 미검증 리스크).

커밋 체인:

| 밀스톤 | SHA       | subject                                                   |
| ------ | --------- | --------------------------------------------------------- |
| A      | `6950fad` | move cron to infra, dispatcher and message-utils to agent |
| B      | `6faae61` | inject agent metadata instead of loadPrompt in gateway    |
| C      | `64cd29d` | invert gateway-server type coupling via narrow ports      |
| D      | `94ba3ac` | extract gateway to @finclaw/gateway package               |

## 1. 구현 사항 (TODO 일치도)

**39/39 단계 구현 반영 — 미구현·실제 편차 0.**

- **A (결합 #1·#2·#4 해소):** `cron.ts`→`@finclaw/infra`, `buildDispatcher`·`collectToolCalls`·`extractAssistantText`(+`ToolCallRecord`)→`@finclaw/agent/execution/`. 소비자(execution-adapter/scheduler/composition/gateway) re-point, 원본 4파일 삭제.
- **B (결합 #3 해소):** gateway `loadAgents()`(loadPrompt 기반) 제거 → `AgentRpcDeps.agents` 주입. main.ts 가 `finclaw.identity.md` frontmatter 로드 후 주입. agent.list/status/run 메타 동일.
- **C (결합 #5~#11 해소):** narrow port 7종 역전. `@finclaw/types`: `AttachMemoryPort`·`TracerPort`·`BrokerageSyncPort`·`SchedulerPort`(+`AttachMemoryInput`). `@finclaw/agent`: `ChatExecutionPort`·`RunnerFactory`(둘 다 agent-native 타입 참조). `RouterHelper` = agent 직접 import.
- **D (물리 추출):** `git mv` gateway/ → `packages/gateway/src/`, package.json·tsconfig·root references 배선, server 가 `@finclaw/gateway` 의존.
- **E (검증):** 전 게이트 green + import-0 가드. E4 smoke = 사용자 수동(§7).

## 2. 자동화 검증 결과

전 게이트 HEAD `94ba3ac` 에서 실행 (PATH=nvm v22):

| 게이트                     | 결과                                           | 비고                                                                                                       |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` (tsgo)    | ✅ PASS                                        | exit 0                                                                                                     |
| `pnpm build` (tsc --build) | ✅ PASS                                        | **권위 게이트** — 구현 중 tsgo↔tsc 발산을 tsc 가 2회 포착(C variance, D dynamic import). HEAD 에선 발산 0. |
| `pnpm test --run` (unit)   | ✅ **1679** pass / 0 fail / 0 skip (192 files) | 베이스라인 정확 일치 (재배치만)                                                                            |
| `pnpm test:storage`        | ✅ 154 pass / 0 fail (23 files)                |                                                                                                            |
| `pnpm lint` (oxlint)       | ✅ 0 warn / 0 error (584 files)                |                                                                                                            |

> **교훈:** `tsc --build` 가 `tsgo` 보다 엄격(strictFunctionTypes contravariance 등). 밀스톤 검증에 `pnpm build` 필수 — typecheck 단독은 깨진 상태를 통과시켰음.

## 3. 경계면 검증

- **완료조건 #1 — gateway → server sibling import 0** ✅: `packages/gateway/src` 전수 grep — `@finclaw/server` 0, `../../../` 탈출 0, server-core 디렉토리·구체클래스 참조 0 (production + test).
- **완료조건 #3 — createGatewayServer 시그니처 불변** ✅: base 대비 byte-identical. 변경은 `GatewayServerDeps.adapter` 타입 `RunnerExecutionAdapter`→`ChatExecutionPort` 단 3줄(구조 동등).
- **port ↔ 구현 구조 만족** ✅: 4종 explicit `implements`(typecheck/build 강제), `TracerPort` 는 `createTracer` 반환객체 구조만족.
- **RPC 등록 드리프트 0** ✅: createGatewayServer 내 register\* = base 12개 = HEAD 12개.
- **mock-only 격리** ✅: 환경 키 전수 unset 상태에서 1679 green = 격리의 강한 증명. 통합 테스트 2건(agent-runs/memory)은 Q2 기본값대로 `packages/server/test/` 재배치(mock embedding + in-memory storage).

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

**없음.**

### P1 — 권장

**없음.** 순수 추출 충실도 매우 높음 — §3(외과적 변경) 준수, scope creep 0, logic drift 0 (comment-strip diff 로 agent.ts/composition 재배선 검증).

### P2 — 선택 (기록용)

- **P2-1** `AttachMemoryService`(agent-memory-hook.ts:29) ↔ `AttachMemoryPort`(types) 근접 중복. interface 외부 소비자 0(전 소비자가 구체클래스 참조), 반환타입 차이(`AttachMemoryResult` vs `unknown`)로 완전중복 아님. → `extends AttachMemoryPort` 명시 또는 의도 주석. 즉시삭제 비권장.
- **P2-2** port 명명 불균일(`...Port` vs `RunnerFactory`/`RouterHelper`). 분산(types 4 + agent 3)은 정당(agent-native 타입은 agent 소재 = Q3 원칙). rename 은 scope creep → 아래 "port 소재 규칙" 1줄 명문화로 갈음:
  > **port 소재 규칙:** narrow port 는 자신이 참조하는 도메인 타입이 사는 최하위 공유 패키지에 둔다. agent-native 타입(StreamEventListener/Runner/RouterHelper) 참조 → `@finclaw/agent`. types-internal 만 참조 → `@finclaw/types`.

### P3 — 선택 (무해, 기록용)

- 죽은 re-export `collectToolCalls`(execution-adapter.ts:93, 소비자 0 실측 — gateway/scheduler 모두 `@finclaw/agent` 직접 import). 같은 줄 `extractAssistantText` 는 test 가 사용(live)이라 줄 유지. 무해한 호환 shim.
- `ToolCallRecord` 이중 노출 경로(agent 직접 + execution-adapter re-export type).
- `BrokerageSyncResultLike.errors` 필드 — gateway 는 3필드만 소비(미세 over-spec).
- **이동 파일 53건 stale 헤더 주석** (`// packages/server/src/gateway/...` 잔존 — git mv 부작용). 동작·build·lint 무영향이나 경로 오기. 후속 일괄 정리 후보(53파일 churn 이라 본 phase 비포함).
- split-import 스타일, `CronExpression` 미사용 export(이동 시 보존).

## 5. 범위 밖 발견 (참고)

- 남은 백로그(P0-2 CLI 미등록 메서드, agent.list 드리프트, P1-6 tier 발산, dead code) — 본 phase 무관, 별개 작업.

## 6. scope creep 의심

**없음.** plan 대비 "todo 정밀화" 5건은 전부 완료조건 충족(import 0) 또는 빌드 통과에 필수였고, 증거 기반(실제 import)으로 확인:

- `RunnerFactory`→`@finclaw/agent` (todo C6 가 agent-native 가정했으나 server 정의였음; plan 의도 일치).
- `ChatExecutionPort`→`@finclaw/agent` (agent-native `StreamEventListener` 참조; types 두면 contravariance 빌드 실패 — 오케스트레이터 결정).
- gateway package.json 에 `@finclaw/skills-finance`+`@types/ws` 추가(rpc/methods/finance.ts 실사용; 순환 없음).
- D7 추가 re-point: `automation/delivery.ts`·`composition/constants.ts`·`main.ts:396` 동적 `import('./gateway/hot-reload.js')` (정적 grep 이 놓친 것, tsc 가 포착).

## 7. 위험 신호

- ⚠️ **E4 실 키 부팅 smoke = USER-MANUAL PENDING (#1 미검증 리스크).** gateway 는 startup 임계 경로. plan 은 "추출 전 1회 + 후 1회" smoke 를 못박았으나, mock-only 스탠스 + 실 키 부재로 자동 플로우에선 미실행. **머지 후 키 보유자가 1회 필수:**
  ```
  pnpm dev  →  ① "Gateway listening" 로그  ② Discord 봇 온라인  ③ 스케줄러 기동(news-brief cron seed)
  ```
  phase35~38 누적 미검증 항목과 동일 성격 — 본 추출이 startup 경로를 건드렸으므로 우선순위 상향.

## 8. 다음 phase 후보

- E4 smoke 1회 실시 후 결과 기록 (별도 phase 불요 — 사용자 수동 + 메모리 갱신).
- (선택) P3 stale 헤더 53건 일괄 정리 + 죽은 re-export 제거 = 소규모 cleanup phase.
- 기존 백로그(P0-2/agent.list/tier).

## 9. 측정값

- 신규 패키지 `@finclaw/gateway` (deps: types/infra/agent/storage/skills-finance + ws/zod). 워크스페이스 11→12 패키지.
- gateway 57 .ts(비테스트 4,941 + 테스트 4,994 LOC) → server 에서 분리. server 비대 완화.
- 신규 로직 LOC ≈ 100 (port 정의 ~60 + 배선 ~40). 나머지 전량 물리 이동·import re-point(동작 불변).
- 테스트 1679(unit, 재배치만 — 증감 0) / 154(storage). lint 0/0.

## 10. 권고 — 머지 가능 여부

**머지 가능 (PASS).** 근거: P0/P1 0건, 전 게이트 green(빌드 포함), 완료조건 #1·#2·#3 충족, 동작·로그·API 불변, mock-only 격리 입증. P2/P3 는 무해한 기록용 후보(Mode A — 자동 미적용).

**유일 잔여 = 완료조건 #4 (E4 실 키 부팅 smoke).** 자동 불가 → 머지 후 사용자 수동 1회로 충족. 이 항목은 코드 결함이 아니라 검증 갭(phase35~38 누적 #1 리스크)이므로 머지를 막지 않되, smoke 실시 전까지 "부팅 미검증" 상태가 유지됨을 명시.
