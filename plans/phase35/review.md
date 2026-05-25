# Phase 35 Review: 백로그 후속 P1 정리 (라우터 AbortSignal/중복 · RPC 레지스트리 격리)

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 코드 품질 이슈, 리팩토링 사항을 기록한다.

base SHA: `4986e24` ↔ HEAD: `61e540e` (변경 LOC: +418 / -373, 32 파일)

커밋: `76a5d9a`(밀스톤 A), `61e540e`(밀스톤 B — P1-1 수정 amend 포함)

---

## 1. 구현 사항 (TODO 일치도)

### 밀스톤 A — 라우터 AbortSignal 전달 + `routeToChain` 공통 코어 추출

| 단계 | 파일                                                        | 상태    | 비고                                                            |
| ---- | ----------------------------------------------------------- | ------- | --------------------------------------------------------------- |
| A1   | `agent/src/router/llm-router.ts`                            | ✅ 완료 | `RouterInput.abortSignal?` + chatCompletion 배선                |
| A2   | `agent/src/router/__tests__/llm-router.test.ts`             | ✅ 완료 | abort 전파 단위 테스트 (mock provider)                          |
| A3   | `server/src/auto-reply/execution-adapter.ts`                | ✅ 완료 | `routeToChain` 헬퍼 추출, `applyRouting`/`applyTuiRouting` 흡수 |
| A4   | `server/src/auto-reply/execution-adapter.ts`                | ✅ 완료 | `execute`/`executeForTui` 호출부 + signal 주입                  |
| A5   | `server/src/auto-reply/__tests__/execution-adapter.test.ts` | ✅ 완료 | abort 전파 회귀 테스트                                          |
| A6   | (형식 정리)                                                 | ✅ 완료 | -                                                               |
| A7   | (밀스톤 검증)                                               | ✅ 완료 | typecheck + test green                                          |

### 밀스톤 B — RPC 메서드 레지스트리 인스턴스 격리 (Q2 = (2) 클로저 캡처)

| 단계 | 파일                              | 상태    | 비고                                                                 |
| ---- | --------------------------------- | ------- | -------------------------------------------------------------------- |
| B1   | `gateway/rpc/index.ts`            | ✅ 완료 | `MethodRegistry` 클래스 신설, dispatch가 serverCtx 사용              |
| B2   | `gateway/context.ts`              | ✅ 완료 | `GatewayServerContext.methods` 추가                                  |
| B3   | `gateway/rpc/methods/*.ts` (12개) | ✅ 완료 | `registerXxxMethods(deps, registry)` 시그니처                        |
| B4   | `gateway/index.ts`                | ✅ 완료 | 배럴 export 갱신                                                     |
| B5   | `gateway/rpc/methods/system.ts`   | ✅ 완료 | 레지스트리 클로저 캡처 (RpcContext 불변)                             |
| B6   | `gateway/server.ts`               | ✅ 완료 | ctx에 `methods` 생성 + 등록부 주입                                   |
| B7   | 테스트 13개                       | ✅ 완료 | `clearMethods()` 전역 우회 제거 → 인스턴스 레지스트리                |
| B8   | (형식 정리)                       | ✅ 완료 | -                                                                    |
| B9   | (밀스톤 검증)                     | ✅ 완료 | grep `clearMethods\|registerMethod\b\|getRegisteredMethods` → 0 매치 |

**일치도: ✅ 16 / ⚠️ 0 / ❌ 0.** todo.md 전 단계 완전 일치 (B3 register 호출 수까지 표와 일치: finance=9, schedule=9, memory=4 등).

## 2. 자동화 검증 결과

| 명령                | 결과                  | 비고                       |
| ------------------- | --------------------- | -------------------------- |
| `pnpm typecheck`    | ✅ PASS               | tsgo --noEmit, 에러 0      |
| `pnpm build`        | ✅ PASS               | tsc --build                |
| `pnpm test --run`   | ✅ 1681 pass / 0 fail | 193 파일                   |
| `pnpm test:storage` | ✅ 151 pass / 0 fail  | 23 파일                    |
| `pnpm lint`         | ✅ 0 warnings         | oxlint                     |
| mock-only 격리      | ✅ PASS               | API 키 6종 unset 상태 통과 |

## 3. 경계면 검증

### 3.1 AbortSignal 전파 체인 (밀스톤 A)

- `execute`/`executeForTui(signal)` → `routeToChain(…signal)` → `routeOrFallback(…signal)` → `routerLlm({abortSignal: signal})` → `chatCompletion({abortSignal: input.abortSignal})` — **전 구간 끊김 없음**.
- A2 가 mock provider 의 `calls[0].abortSignal === controller.signal` 직접 단언 (실 Anthropic 호출 없음).

### 3.2 RPC 레지스트리 격리 (밀스톤 B)

- `MethodRegistry` 인스턴스가 `ctx.methods` 로 주입, `dispatchRpc`/`handleSingleRequest` 가 `serverCtx.methods` 읽음 (`index.ts:74`). 호출부 `router.ts`/`ws/connection.ts` 3-arg 정합.
- `system.info` 의 `registry.list()` 클로저 캡처가 실제 등록 메서드(health/info/ping) 반환 — `system.test.ts` 가 단언.
- Q2 추천안(2) 확인: `system.ts` 가 `RpcContext` 미변경, `rpc/types.ts` diff 0줄, `rpcCtx = { ...ctx, requestId }` 로 serverCtx 미주입.

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

없음.

### P1 — 권장 (다음 phase 안에)

1. **`system.ts:8-11` — §3 위반 (incidental reformatting) → ✅ 조치 완료**
   - 문제: todo B5 는 `infoHandler` 클로저 이동만 요구했으나 `healthHandler` 타입 리터럴이 4줄→1줄로 reformatting (로직 무변경 인접 코드, oxfmt/oxlint 둘 다 통과해 도구로 미검출).
   - 조치: 원본 4줄 형태로 수동 원복 후 밀스톤 B 커밋에 amend (`dbd9563`→`61e540e`). `(모듈 레벨 유지: registry 불요)` 주석은 B 맥락 설명이라 유지.

### P2 — 선택 (조치 불요)

1. `server.ts:26` `MethodRegistry` import 알파벳 순 어긋남 — oxfmt/oxlint green (trailing 주석 고정), 무시 가능.
2. `connection.test.ts:13` 만 모듈 레벨 `let methods` — `makeCtx` 클로저 사정상 정당, 수용.
3. `routeToChain` 매개변수화 — 적정. `logEvent` 리터럴 유니온으로 좁게 타입, `applyTuiRouting` 미사용 인자 잔재까지 정리한 순감축. §2 위반 아님.

## 5. 범위 밖 발견 (참고)

- 없음. dead code 0 (`clearMethods`/`registerMethod`/`getRegisteredMethods` 잔재 0, 고아 import 0), scope creep 0.

## 6. scope creep 의심 (사용자 확인)

- 없음. 커밋 A = 밀스톤 A 4파일만, 커밋 B = 밀스톤 B 파일만. plan §비대상(KR RAG / server 분할 / runner truncate / 라우터 timeout / `agent.ts` 통계 Map) 전부 미터치 확인.

## 7. 위험 신호

- 없음.

## 8. 다음 phase 후보 (제안)

- **phase36 — server 패키지 분할** (이미 `plans/phase36/plan.md` 초안 등재, 옵션 A/B/C 결정 대기). phase35 항목 3(RPC 레지스트리 격리) 완료로 gateway 추출 선행조건 충족 — 옵션 C(gateway 추출)가 한 걸음 쉬워짐.

## 9. 측정값

- 변경 파일 수: 32
- 변경 LOC: +418 / -373
- 새 테스트: 3 블록 (A2 router abort, A5 execution-adapter abort ×2)
- 커밋 수: 2 (밀스톤당 1)
- review 생성 일시: 2026-05-25

## 10. 권고 — 머지 가능 여부

**판정: ✅ 머지 가능**

- P0 없음. 유일한 P1(§3 reformatting)은 머지 전 조치 완료.
- 전 자동화 게이트 green, TODO 16/16 일치, 경계면 검증 통과, mock-only 격리 확인.
- 외과적 변경 준수 (dead code/scope creep/요청 안 된 유연성 0).
