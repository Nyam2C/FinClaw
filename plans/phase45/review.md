# Phase 45 review — audit-driven dead-code sweep (M-A + M-B + M-C)

> 작성 2026-05-31 · 브랜치 `feature/phase45` · base = main `16939cf`
> 인벤토리 원본 = `_workspace/decl-audit/unused-report.md` (1,756 선언 / 12 에이전트 교차 검증 / 추출기 자체 버그 1건 수정)
> 검증 워크플로우: `wf_529714fe-0c6` (M-A) · `wf_6f1c22a8-52a` (M-B) · `wf_3187b8e6-066` (M-C)

## 1. 한 줄 결론

phase45 = audit 의 114 actionable 항목 중 **91 + 1 인터페이스 트림 제거 / KEEP 1 / ALREADY_REMOVED 19 (cascade) / LIVE_FALSE_POSITIVE 2 (보류) / TEST_FIXTURE 4 (감사 오판 정정)**. 17 파일 삭제 + 30+ 배럴 정리. 전 게이트 통과, 회귀 0.

## 2. 마일스톤 요약

| 마일스톤 | sub-milestones | 항목 | 파일 삭제 | 커밋 | 테스트 (unit / storage) |
| --- | ---: | --- | ---: | ---: | --- |
| docs (kickoff/plan/M-A todo) | — | M-A todo | — | `5cf0e6e` | 1480 / 147 (baseline) |
| **M-A T1 무참조** | 9 | 39 + 인터페이스 트림 1 | 3 | `713a699`~`c962e33` (9) | 1480 / 147 |
| docs (M-B todo) | — | M-B todo | — | `49357c8` | — |
| **M-B T2 죽은 군집** | 5 | 31 (LIVE 2, ALREADY 1) | 10 | `7a39785`~`357a55e` (5) | 1421 / 143 |
| **M-C T3 테스트만** | 5 | 21 (KEEP 1, ALREADY 19) | 4 | `0033d76`~`460b4d0` (5) | 1380 / 143 |
| **합계** | **19** | **91 + 1** | **17** | **21** | **-100 / -4** |

### 마일스톤별 핵심 파일 삭제

- **M-A (3):** `auto-reply/errors.ts`, `plugins/event-bridge.ts`, `process/errors.ts`.
- **M-B (10):** `types/skill.ts` + `skill-metadata.test.ts`, `config/sessions/{store,types,session-key}.ts` + 2 tests, `agent/auth/cooldown.ts` + test, `infra/{paths,system-events,warnings}.ts` + tests.
- **M-C (4):** `infra/env.ts` + test, `infra/json-file.ts`.

## 3. 검증 방법

각 마일스톤은 **결정론적 추출기 + 12 에이전트 교차 검증** 으로 생성된 인벤토리 → **워크플로우 (6~9 패키지 병렬 재검증)** → **메인 컨텍스트 종합 todo 작성** → **사용자 승인 게이트** → **서브밀스톤별 적용 + 5단 게이트** (format/lint/typecheck/`tsc --build`/test) → **커밋**.

각 step 의 재검증 = `rg "\b<SYMBOL>\b" packages/*/src --type ts` → 0 hits. 게이트 위반 시 즉시 보정 (B-5 의 logger-transports.ts → defaultLogDir inline, fallback.test.ts → resetBreakers 복원 등).

## 4. 보류 / KEEP / cascade

### 4-1. LIVE_FALSE_POSITIVE (보류 — phase46 백로그 후보)

| 패키지 | 심볼 | 위치 | 발견 시점 | 사유 / 갱신 |
| --- | --- | --- | --- | --- |
| infra | `readFileSafe` | `fs-safe.ts:42-50` | M-B B-5 verification | `json-file.ts` 의 `readJsonFile` 안에서 호출. **M-C C-2 가 json-file.ts 삭제 후 인-패키지 라이브 소비자 부재 → phase46 재평가** (테스트만 사용 가능성). |
| infra | `ensureDir` | `fs-safe.ts:55-57` | M-B B-5 verification | 라이브 소비처 2: `json-file.ts:writeJsonFile` (M-C 가 삭제), `config/sessions/store.ts` (M-B B-3 가 삭제). **C-2 + B-3 후 라이브 소비자 0 → phase46 재평가**. |

### 4-2. INTENTIONAL_CONTRACT_KEEP (감사 오판 정정)

| 패키지 | 심볼 | 위치 | 사유 |
| --- | --- | --- | --- |
| agent | `resetBreakers` | `providers/adapter.ts` | module-singleton breakers Map 의 테스트 격리용 fixture. `fallback.test.ts` 가 beforeEach/afterEach 에서 사용. |
| infra | `ConcurrencyLane.dispose` | `concurrency-lane.ts` | `LANE_QUEUE_FULL` 테스트의 waiter cleanup. 제거 시 테스트 hang. |
| infra | `ConcurrencyLaneManager.dispose` | `concurrency-lane.ts` | `MessageRouter.dispose` 가 호출 (server test cleanup chain). |
| server | `MessageRouter.dispose` | `process/message-router.ts` | `'dispose 시 활성 AbortController abort'` 테스트의 검증 대상. cleanup chain 의 진입점. |

워크플로우는 4건 모두 CONFIRMED_DEAD 로 마크했으나 실제 테스트 cleanup 의 합리적 fixture. 감사 도구의 정적 분석이 "test 만 호출 = dead" 로 단순 매핑한 한계.

### 4-3. cascade ALREADY_REMOVED (M-A/M-B 가 흡수, M-C 진입 시 19)

| 패키지 | 흡수된 audit 카테고리 | 흡수 commit |
| --- | --- | --- |
| agent | T3 5 (cooldown methods) | `afb816c` (M-B B-4 cooldown.ts 전체 삭제) |
| config | T3 3 (sessions helpers) | `ef52915` (M-B B-3 sessions/ 전체 삭제) |
| infra | T3 8 (system-events 5 / warnings 2 / getAllPaths 1) | `357a55e` (M-B B-5) |
| storage | T3 1 (`getMemoryChunks`) | `55cce23` (M-B B-2) |
| types | T3 2 (`FinClawError` / `normalizeSkillMetadata`) | `7a39785` (M-B B-1 skill.ts file-delete + FinClawError island) |
| server | T2 1 (`PipelineErrorCode`) | `c962e33` (M-A A-9 auto-reply/errors.ts 전체 삭제) |

= 상위 모듈/파일 삭제가 하위 dead 항목을 자동 회수. 마일스톤 간 시너지가 audit 의 항목 카운트보다 실 작업량을 줄임.

## 5. 발견된 보조 cascade (별 step 으로 동반 처리)

- **B-1:** `WsEvent` union 제거 후 5 `Ws*Event` 변형이 zero-ref → B-1-2 에서 일괄 제거 (실제로는 T2 항목).
- **B-4:** `ToolInputSchema` 제거 (M-A A-5) → `ToolPropertySchema` 가 zero-ref → B-4-1 에서 일괄 제거.
- **B-5-4 (cross-package):** `ConcurrencyLane.dispose` cleanup chain → `server/process/message-router.ts:dispose` 도 test-only consumer chain → 보존 (TEST_FIXTURE) 결정 후 lane.dispose/Manager.dispose 도 복원.
- **B-5-5:** `CircuitBreaker.reset` 제거 → 호출자 `resetBreakers` (agent) test-only → TEST_FIXTURE 로 복원 (단, internal cb.reset() 의존 끊고 `breakers.clear()` 만 호출하도록 단순화).
- **C-2:** `env.ts` 의 4 audit 심볼 제거 → 내부 호출자 `getEnv` 도 함께 cascade dead → 파일 전체 삭제.
- **C-5:** `ChatRegistry.on` 제거 → `emit` private + `emitter` 멤버 + `EventEmitter` import + `RegistryEvent` type 동반 cascade dead → 6 줄 메서드 제거가 실제로는 25 줄 + 1 type 제거로 확장.

## 6. 통계 / 보조 지표

- 코드 행 감소: 약 -700+ LOC (commit 본문 통계 합산).
- 배럴 export 줄 감소: 30+ (types/agent/infra/skills-finance/skills-general/storage/config/gateway index.ts).
- module-singleton (테스트 격리 필요) 1 군집 식별 → 패턴화 가능: `agent.providers.adapter.breakers` (TEST_FIXTURE 보존).
- LIVE_FALSE_POSITIVE 발견율: 2 / 114 = **1.75%** (감사 인벤토리의 정확도가 매우 높음).
- TEST_FIXTURE 오판율: 4 / 114 = **3.5%** (정적 분석의 한계로, 향후 감사 추출기 개선 후보).

## 7. phase46 backlog

> M-A/M-B/M-C 진행 중 발견된 후속 항목. 모두 phase45 범위 외 (CLAUDE.md §3 외과적 변경).

1. **`infra/src/fs-safe.ts` 재평가** — `readFileSafe` / `ensureDir` 라이브 소비자 (json-file.ts / config sessions) 가 M-B/M-C 에서 사라짐. 두 함수가 진정 dead 인지 / 외부 노출 가치 있는지 재검증. (`writeFileAtomic` / `unlinkSafe` 도 같이 grep.)
2. **`gateway/rpc/types.ts` 의 `ConfigChangeEvent`** — types/config.ts 의 동명 타입 (C-1 에서 제거) 과 별개로 gateway 안에 자체 정의 존재. 라이브 사용 여부 확인.
3. **TypeScript-Go (tsgo)** 의 `--noEmit` 만 의존하면 import-only 에러 누락 가능 (M-A 에서 `tsc --build` 가 잡은 사례 다수). 게이트의 `tsc --build` 단계는 phase45 동안 안정 유지 — 향후 phase 도 유지 권장.
4. **Audit 추출기 개선 안** — 본 phase 에서 발견한 4 TEST_FIXTURE 오판은 `import resetBreakers from ...; ... beforeEach(resetBreakers); ... afterEach(resetBreakers)` 패턴 (테스트 격리 fixture) 을 식별하지 못한 결과. 추출기에 패턴 추가 시 false positive 감소 기대.
5. **`Result<T, E>` 의 후속** — C-1 가 제거했지만 future 도메인 모델에서 다시 필요할 가능성. 도입 시 별 타입 파일 (`packages/types/src/result.ts`) 로 분리하면 island 가 명시적.

## 8. CLAUDE.md 원칙 준수 점검

- **§2 단순함 우선 — 추측성 코드 제거** ✅ 91 항목 제거 = "쓰일 수 있다" 추측의 누적 제거.
- **§3 외과적 변경 — 인접 코드 개선 금지** ✅ cascade 발생 시에도 todo 가 사전 명시한 cascade 만 처리; 인접 stale 주석 (`config/src/paths.ts:1` 의 stale comment 등) 은 review 백로그로 미루고 코드 미수정.
- **§4 목표 기반 실행** ✅ 각 step 의 재검증 명령 + 5단 게이트가 성공 기준 = 회귀 0.
- **테스트 / API 키 없이 부팅** ✅ 모든 게이트 mock-only, 외부 키 의존 0.
- **회귀 0** ✅ M-A baseline 1480 → M-C 종점 1380 의 -100 은 모두 *제거된 dead 코드의 테스트* (의도된 감소).

## 9. 머지 권장

phase45 = M-A + M-B + M-C 전 게이트 통과, 회귀 0, LIVE_FP 2 + TEST_FIXTURE 4 모두 review 에 기록 — **merge 가능.**

phase46 = §7 백로그 (fs-safe 재평가 + audit 추출기 개선 검토 등).
