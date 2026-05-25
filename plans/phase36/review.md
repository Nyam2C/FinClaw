# Phase 36 Review: main() composition root 모듈화 (옵션 A — 순수 구조 리팩토링)

> todo.md 기반 구현 코드 리뷰. **순수 이동 — main() wiring 을 `src/composition/` 빌더로 추출, 동작 불변이 성공 기준.**

base SHA: `0be37d7` ↔ HEAD: `421ac73` (변경 LOC: +863 / −520, 7 파일)

커밋: `edf602d`(A), `8da9fef`(B), `421ac73`(C). **main() 898 → 433줄 (−465, −51.8%).**

---

## 1. 구현 사항 (TODO 일치도)

| 단계 | 산출물                                                               | 상태    | 비고                                               |
| ---- | -------------------------------------------------------------------- | ------- | -------------------------------------------------- |
| P-1  | `src/composition/` 신설 (tsconfig 불변 — `include:["src"]` 자동포함) | ✅ 완료 | 새 패키지 아님, references 무변경                  |
| A1   | `composition/constants.ts` (defaultConfig/DEFAULT_MODEL)             | ✅ 완료 | 38 LOC                                             |
| A2   | `composition/schedule-rpc.ts` (`buildScheduleRpc`)                   | ✅ 완료 | 63 LOC, storage 의존                               |
| A3   | `composition/providers.ts` (`buildProviders`)                        | ⚠️ 편차 | `ConcurrencyLaneManager` import 출처 교정(정당)    |
| A4   | main.ts 치환 (상수/scheduleRpc/providers)                            | ✅ 완료 | 순서 보존                                          |
| B1   | `composition/skills.ts` (`registerSkills`)                           | ✅ 완료 | 281 LOC, general/market/news/alert/kis/mcp/plugins |
| B2   | main.ts skills 블록 치환                                             | ⚠️ 편차 | registerGeneralTools↔catalog reorder 1건(무해)     |
| C1   | `composition/runtime.ts` (buildExecution/Pipeline/Automation)        | ✅ 완료 | 328 LOC                                            |
| C2   | `composition/memory-services.ts` (`wireMemoryServices` 이동)         | ✅ 완료 | 34 LOC                                             |
| C3   | main.ts `wireMemoryServices` 정의 삭제                               | ✅ 완료 | -                                                  |
| C4   | main.ts exec/pipeline/automation 치환                                | ✅ 완료 | main() 은 gateway/router/start 오케스트레이션만    |

**일치도: ✅ 13 / ⚠️ 2 / ❌ 0.** ⚠️ 2건은 모두 정당(A3=todo 스니펫 import 출처 오류 교정, B2=plan 의도 reorder). 동작·로직 무변.

## 2. 자동화 검증 결과

| 명령                | 결과                  | 비고                                |
| ------------------- | --------------------- | ----------------------------------- |
| `pnpm typecheck`    | ✅ PASS               | -                                   |
| `pnpm build`        | ✅ PASS               | tsc --build (project references)    |
| `pnpm test --run`   | ✅ 1681 pass / 0 fail | **baseline 1681 정확 일치, 증감 0** |
| `pnpm test:storage` | ✅ 151 pass / 0 fail  | **baseline 151 정확 일치, 증감 0**  |
| `pnpm lint`         | ✅ 0 warnings         | 583 files                           |
| mock-only 격리      | ✅ PASS               | API 키 8종 unset 상태 통과          |

순수 이동이라 테스트 증감 0 이 정상 — 충족. `main.test.ts` 4 pass, gateway 스위트 245 pass.

## 3. 경계면 검증 (순수 이동 — 이 phase 의 생명)

### 3.1 byte-level 이동 (QA + refactor 교차 검증, PASS)

- 6개 빌더 body 가 base 원본과 **글자 단위 일치** (인자화·반환화 wrapping 외 변경 0).
- 정량 교차검증: `logger.info|warn` 호출 수 **base 25 = HEAD 25**, event 문자열 **base 13종 = HEAD 13종** (개수까지 일치). 로그/이벤트 무변.
- 골격 placeholder(`createTracerLocal`/`_Retrieval`) 잔존 0. main.ts 자기생성 고아 import 0 (추출 40심볼 전수 스캔).

### 3.2 실행/side-effect 순서 (1:1 보존)

- 실행: storage.init → discord setup → registerSkills → buildExecution → buildPipeline → MessageRouter → buildAutomation → gateway → purge → hotReload → setDeliveryHook → lifecycle.init → gateway.start → scheduler.start → emit.
- **8개 `lifecycle.register` 등록 순서 ①→⑧ 보존** (③④ skills.ts, ⑤ runtime.ts buildAutomation 끝, 나머지 main) → cleanup 역순 무영향.

### 3.3 deliveryHook lateinit (C 최대 위험 — PASS)

- `let deliveryHook` 가 `buildAutomation` 으로 이동, `setDeliveryHook` 반환. `onRunComplete` 본문이 base 와 byte 동일, main() 이 gateway 생성 후 원본(864) 시점에 setter 호출. mutable let 클로저 캡처 메커니즘 동일. getter-간접호출 거부안 미사용.

### 3.4 의도된 reorder 1건 (B2 — 무해 검증)

- `registerGeneralTools` 가 catalog 블록 **앞**(원본 355<357)에서 `registerSkills` 첫 줄(catalog **뒤**)로 이동. **무해 근거**: `registerGeneralTools(toolRegistry,{scheduleRpc})` 는 toolRegistry/scheduleRpc 만 의존(catalog 무관), catalog 생성은 general 산출물 미사용 → 입출력 교차 0, 관측 동작 무변. **이 phase 유일한 상대순서 변화.** QA+refactor 독립 합의.

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

없음. 로직·로그·event·실행순서 변경 0 — 순수 이동 성공 기준 충족.

### P1 — 권장 (다음 phase 안에)

1. **잔여 리스크: 실 부팅 e2e 부재** (코드 결함 아님 — 검증 한계)
   - main() 런타임 wiring 경로는 자동 테스트가 직접 커버 안 함 (`main.test.ts` 는 `requireEnv`/`MissingEnvError`/`createGatewayServer` 만). green 이 "누락 의존·순서 깨짐" 은 배제하나 **"동작 불변" 마지막 1%(실 키 부팅 side-effect 타이밍)는 수동 검증 필요**.
   - **조치 권장 (머지 후, 키 보유자)**: `pnpm dev` 부팅 smoke 1회 — `Gateway listening on …` 로그 + Discord 온라인 + 스케줄러 기동 확인. 핸드오프의 "실 키 end-to-end 미검증" 과 합류하는 지점.

### P2 — 선택 (조치 불요)

1. composition 파일 헤더 주석의 라인 인용(`skills.ts:2`, `runtime.ts:2`)이 base SHA 기준 — "(base `0be37d7` 기준)" 한 마디 덧붙이면 후속 리뷰 혼선 제거. 코드 변경 아님.
2. 빌더 deps 인터페이스 11~13 필드(`RegisterSkillsDeps` 12, `BuildPipelineDeps`/`BuildAutomationDeps` 13) — composition root 의 **본질적 fan-in**, 인위적 과대추상화 아님(각 필드 전부 소비, 미사용 var 0). mega-context 주입은 결합도 악화. **현행 유지** (§3 — 고장나지 않음). 향후 단일 빌더가 15+ 로 커지면 그것만 재분할 신호.
3. composition 타입 export(`*Deps`/`*Bundle`/`DeliveryHook`) 외부 미소비 — "빌더+타입 공개" 관용 패턴. `DeliveryHook` 는 base 인라인 익명 타입을 추출 경계 표현 위해 named 승격(추출 부산물, §3 위반 아님). 현행 유지 권장.

## 5. 범위 밖 발견 (참고)

- `main.ts:1-3` import 블록의 파일경로 주석 위치 이상(`// packages/server/src/main.ts` 가 import 2개 뒤) — **base `0be37d7` 에 이미 존재**, phase36 산물 아님. §3 따라 미터치. 차후 정리 시 참고만.

## 6. scope creep 의심

- 없음. `createGatewayServer`·`MessageRouter`·`gateway.start()`·`scheduler.start()`·`setDeliveryHook(...)` 대입 **전부 main() 잔존**(plan 명시 준수). composition 에 gateway/router 출현 0. 패키지 추출(B/C) 흔적 0 — tsconfig/package.json/build 무변경.

## 7. 위험 신호

- §3.x 의 잔여 e2e-boot 리스크(P1-1) 외 없음. P0 차단 0.

## 8. 다음 phase 후보 (제안)

- **phase37 — gateway 패키지 추출 (옵션 C)**: 이번 phase 가 옵션 C 의 선행 작업(main 모듈화)을 끝냈으므로, `gateway/` → `@finclaw/gateway` 추출이 자연스러운 후속. **단 감독 필요**(의존 그래프·순환참조·tsconfig references 재구성). 구체적 드라이버 생길 때.

## 9. 측정값

- 변경 파일 수: 7 (composition 6 신설 + main.ts)
- 변경 LOC: +863 / −520. main.ts 898 → 433 (−465, −51.8%). composition 6파일 808 LOC.
- 새 테스트: 0 (순수 이동 — 기존 1681+151 이 회귀 안전망)
- 커밋 수: 3 (밀스톤당 1)
- review 생성 일시: 2026-05-25

## 10. 권고 — 머지 가능 여부

**판정: ✅ 머지 가능 (단, 머지 후 수동 부팅 smoke 권장)**

- P0 없음. 순수 이동의 코드 레벨 증거 강함(byte 일치 + logger 25=25 + event 13=13 + test 증감 0 + scope creep 0).
- 전 자동화 게이트 green, 실행/lifecycle 순서 1:1 보존, deliveryHook·reorder 무해 교차합의.
- **유일 잔여 = 실 부팅 e2e 부재(P1-1)**: 자동 검증의 구조적 한계이지 이 diff 의 결함이 아님. 키 보유자의 `pnpm dev` smoke 1회로 마지막 1% 확정 권장.
