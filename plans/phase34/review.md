# Phase 34 Review: LLM 오케스트레이터 라우팅 (키워드 휴리스틱 폐기)

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 코드 품질, 리팩토링 사항, 알려진 제약을 기록한다. phase33(이전 FINAL) 이후 추가된 새 finish line.

base SHA: `1c9460f` (phase31+32+33 머지된 main) ↔ HEAD: `bf95658` (변경 LOC: 약 +600 / -63, 5 커밋)
branch: `feature/llm-router-orchestration`

`execution-adapter.ts` 의 키워드 `inferRole()` 을 소형 라우터 LLM(SDK Haiku 고정) 1회 호출로 대체. 라우터가 `{intent, modelTier, allowedToolNames, reason}` 출력 → 메인 호출이 그대로 따름. 도구 불필요(greeting/memory/other) 시 도구 정의 미전달로 인풋 토큰 절감. 실행은 단일 LLM. plan 인스펙션 보강으로 phase31~33 상호작용 교정(★ SDK Haiku, ★ allowedToolNames, ★ inferRole 폴백).

---

## 1. 구현 사항 (TODO 일치도)

집계: ✅ 26 / ⚠️ 2 / ❌ 0. ⚠️ 2건은 정당 편차 (B6 1곳 swap = NOTE OVERRIDE, D2 mock fixture = 매핑 회귀가드; D3 실측은 의도적 범위외).

| 밀스톤                     | 단계                                                                                                                                       | 상태  | 비고                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------- |
| 사전                       | P-1 router 디렉터리                                                                                                                        | ✅    | `agent/src/router/llm-router.ts` 신규, 역방향 의존 없음                                                        |
| A (라우터 prompt+헬퍼)     | A1 타입 · A2 zod+prompt · A3 INTENT_POLICY · A4 createLlmRouter · A5 barrel · A6 test(7)                                                   | ✅    | Haiku 직호출(`ROUTER_MODEL_ID`), tools 미전달, parse+zod+1회 재시도, 2회 실패 throw                            |
| B (execution-adapter 통합) | B1 deps routerLlm · B2 applyRouting async · B3 routeOrFallback+inferRole · B4 applyTuiRouting · B5 import 정리 · B6 main 배선 · B7 test(2) | ✅/⚠️ | applyRouting+applyTuiRouting 둘 다 async 라우터화. **B6: execution-adapter 1곳만 swap (NOTE OVERRIDE)** ⚠️정당 |
| C (로깅+비용분리)          | C1 pipeline.routed 필드 · C2 tui.routed · C3 라우터 토큰 byModel 분리 · C4 test · C5 events.ts 무변경                                      | ✅    | intent/tier/allowedToolNames/reason/fallback/filteredCount/routerTokens. events.ts diff 빈 출력(C-0)           |
| D (비용·정확도)            | D1 fixture(21) · D2 accuracy+cost test · D3 실LLM 100건                                                                                    | ✅/⚠️ | mock fixture 매핑/over-call 회귀가드 + 비용 ≤$0.0005($0.00024). **D3 실측=live/수동 범위외** ⚠️                |

---

## 2. 자동화 검증 결과

| 명령                       | 결과                  | 비고                                                              |
| -------------------------- | --------------------- | ----------------------------------------------------------------- |
| `pnpm typecheck` (tsgo)    | ✅ PASS               | 0 에러                                                            |
| `pnpm build` (tsc --build) | ✅ PASS               | 게이트 (phase32/33 교훈)                                          |
| `pnpm test`                | ✅ 1678 pass / 0 fail | 193 files                                                         |
| `pnpm test:storage`        | ✅ 151 pass / 0 fail  | phase34 storage 무변경, 회귀 0                                    |
| `pnpm lint`                | ✅ 0 / 0              | 577 files                                                         |
| mock 격리                  | ✅ OK                 | ANTHROPIC_API_KEY unset 통과, 라우터 mock provider, 실 LLM 호출 0 |
| live 격리                  | ✅ OK                 | `*.live.test.ts` 0, `test:live` 미실행                            |
| 회귀                       | ✅ 0                  | routerLlm 미주입/실패 시 기존 동작, scheduler/agent.ts RPC 불변   |

---

## 3. 경계면 검증 (PASS, 불일치 0)

- **라우터 ↔ execution-adapter**: `createLlmRouter(sdkAdapter)`(main.ts:279) → `routerLlm`(:590) → `applyRouting`/`applyTuiRouting` `await routeOrFallback` → `routerLlm()` 실호출 ✅
- **라우터 출력 ↔ exposedTools ↔ tools 전달**: `allowedToolNames` ↔ `exposedTools` 필터 ↔ `buildParams.tools=undefined`(빈 배열) ✅
- **라우터 ↔ provider**: `provider.chatCompletion(ProviderRequestParams):Promise<unknown>` ↔ AnthropicAdapter ✅. Haiku id ↔ tierToModelId ↔ catalog ✅
- **폴백**: 라우터 throw → routeOrFallback catch → keywordFallbackDecision → inferRole ✅. routerLlm 미주입 → undefined → 기존 fallbackChain ✅
- **비용**: ROUTER_MODEL_ID ↔ getModel.pricing ↔ calculateEstimatedCost ↔ recordResult byModel(분리 집계) ✅
- **로그**: pipeline.routed/tui.routed 필드 ↔ logger.info (C4 toMatchObject 검증) ✅

---

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

**없음.** 게이트 7/7 green, 라우터 실제 배선(미연결 아님), 회귀 0.

### P1 — 본 PR 처리 2건 + 잔여 2건

1. **✅ 처리됨 (`bf95658`) — INTENT_POLICY toolPatterns 과노출/죽은 패턴 (P1-3)**: `fetch`/`portfolio` 의 `get_` prefix 가 get\_\* 도구 8개 전부 노출, `quote/price/rate/chart/portfolio/holding` 6패턴 매칭 0 → "over-call 70%↓" 완료조건 저해. **명시 도구명으로 정밀화** (fetch=price/forex/chart 4개, portfolio=summary+sync 2개). 테스트도 정책-교집합 검증으로 갱신.
2. **✅ 처리됨 (`bf95658`) — applyRouting `automation` 인자 고아화 (P1-1)**: LLM 재작성 후 본문이 안 읽는데 타입/호출부만 잔존(§3 위반). 제거.
3. **잔여 — 라우터 호출 AbortSignal 미전달 (P1-2)**: `execute(ctx,signal)` 의 signal 이 메인 러너엔 전달되나 `routeOrFallback`→`routerLlm`→`chatCompletion` 엔 미전달. pipeline.ts 외부 timeout 은 걸리나 라우터 in-flight HTTP 가 취소 신호를 못 받음(SDK 자체 timeout 까지 await). → `RouterInput.abortSignal?` 추가 + chatCompletion 전달 권장. (별도 라우터 timeout 도입은 plan §비대상.)
4. **잔여 — applyRouting/applyTuiRouting 중복 (P1-4)**: 두 메서드가 routeOrFallback 호출 + 로그 8필드 + chain 구성 거의 동일. plan B-3 이 "2개 모두 대체" 명시했으므로 분리 자체는 의도. 공통 코어 추출 선택(3회 미만이라 강제 아님).

### P2 — 선택

- `llm-router.ts:33` `ROUTER_MODEL_ID` 하드코딩이 `tierToModelId('haiku')` 와 이중 정의(주석에 동기 명시, drift 위험).
- `llm-router.ts:156` `extractRouterResponse` 의 `as` 캐스팅 (provider SDK 고정이라 안전, zod 한 줄 방어 가능).
- `execution-adapter.ts:558` 주석 부정확 (analysis=모든 도구 설명이 실제 tier-only 분기와 불일치) — 주석만.

---

## 5. 범위 밖 발견 (참고)

- 키워드 RouterHelper 경로(`router-helper.ts`/`makeRouterHelper`/`respectMinModel`/`resolveModelForRequest`)는 **여전히 살아있음** — scheduler.ts:243 + agent.ts RPC:291 가 소비. execution-adapter 만 LLM 라우터로 전환. **죽은 코드 아님** (grep 확인). 향후 scheduler/RPC 도 통일하면 제거 가능 — 범위 밖.
- catalog-data.ts Haiku `jsonMode:true` capability 와 D-0 "JSON mode 부재" 전제 — `chatCompletion` 인터페이스가 json-mode 파라미터 미노출이라 프롬프트 강제 방식 정당. 회귀 아님.

---

## 6. B6 스코프 판정 — 정당 (불일치 아님)

`scheduler.ts:243`(role='analysis' 하드코딩, cron 프롬프트) + `agent.ts:291` RPC(params.role ?? 'analysis', 호출자 명시) 는 **둘 다 `inferRole(message)` 키워드 추론을 안 함** → LLM intent 분류기가 적용될 의미 없는 경로. plan 본문 + 보강 B-3 이 "execution-adapter 키워드 추론 대체"로 한정. scheduler/RPC 는 plan 범위 밖. refactor+qa 양측 "정당" 합치.

---

## 7. 알려진 제약 (사용자 인지)

1. **LLM 라우터는 auto-reply(대화) 경로만.** cron 스케줄 + agent.run RPC 는 키워드/명시 role 유지 (그 경로는 사용자 발화 분류 불필요).
2. **D3 실측(over-call 70%↓, ≤$0.0005)은 자동 게이트 아님** — mock fixture 는 매핑/회귀 가드. 실측은 실 ANTHROPIC_API_KEY 환경에서 profileHealth byModel + agent_runs tool_calls_json 분포로 사용자 운영 검증.
3. **라우터 = SDK Haiku 고정.** CLI 모드여도 라우터만 SDK 직호출 (JSON 파싱 안정성). 라우터 1회 비용 ~$0.00024/메시지.
4. **속도 trade-off**: 메인 호출 직전 라우터 1회 추가 (plan 명시 — 비용 절감 우선).

---

## 8. 위험 신호

**P0/P1 차단 위험 없음** (P1-1/P1-3 본 PR 처리). 게이트 green, 라우터 배선·폴백·환각차단 안전, 회귀 0.
잔여 P1-2(AbortSignal)는 timeout robustness — 라우터 hang 시 pipeline timeout 후에도 지연 가능하나 응답 정확성엔 영향 없음(폴백 경로 존재).

---

## 9. 다음 단계 후보

- P1-2 라우터 AbortSignal 전달 (timeout robustness), P1-4 applyRouting/applyTuiRouting 공통 코어.
- D3 실 LLM 100건 over-call/비용 실측 (운영).
- 향후: scheduler/agent.ts RPC 도 LLM 라우터 통일 시 router-helper.ts 제거.

---

## 10. 측정값

- 변경 파일 수: 신규 5(router + 테스트/fixture) + 수정 3(execution-adapter, main.ts, agent index)
- 변경 LOC: 약 +600 / -63 (llm-router.ts ~190, execution-adapter 통합 ~140, 테스트/fixture ~270)
- 새 테스트: llm-router 7 + routing-accuracy 22 + execution-adapter +3
- 커밋: 5 (`b9307bc` A · `8c293e2` B · `2823dd4` C · `da5ead5` D · `bf95658` P1-1/P1-3 fix)
- review-draft 생성 일시: 2026-05-21

---

## 11. 권고 — 머지 가능 여부

**판정: ✅ 머지 가능**

- P0 0건. P1-1(§3 고아) + P1-3(over-call 저해 정밀도) **본 PR 처리**. 자동화 7/7 PASS(build 포함). 경계면 불일치 0. 라우터 실제 배선(미연결 아님). mock+live 격리 OK. 회귀 0. ❌ 0.
- B6 스코프 정당(양 에이전트 합치), inferRole 폴백 정당, 죽은 코드 없음.
- 잔여 P1-2(AbortSignal)/P1-4(중복)는 차단 아님 — §9 후속.
