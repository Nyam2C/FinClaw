# Refactor Criteria — phase-refactor-expert 체크리스트

phase 의 코드 변경분만 대상. 리팩토링 적용 X, 후보만 보고. 우선순위 — P0 (즉시) / P1 (권장) / P2 (선택).

## 1. 네이밍

| 패턴                             | 예                                              | 우선순위 |
| -------------------------------- | ----------------------------------------------- | -------- |
| 약어 사용 (mgr, ctx, conf, util) | `userMgr` → `userService`                       | P1       |
| 타입을 그대로 쓴 이름            | `data: Data`, `info: Info`                      | P1       |
| 부정 boolean                     | `isNotReady` → `isReady`                        | P2       |
| 단위 누락                        | `timeout: 5000` → `timeoutMs`                   | P1       |
| 한글/영문 일관성 깨짐            | 한 모듈에 `getCurrentUser` 와 `사용자조회` 혼재 | P1       |

## 2. 중복

| 패턴                                                                                               | 우선순위               |
| -------------------------------------------------------------------------------------------------- | ---------------------- |
| 같은 로직 ≥2 곳 — **2 회는 통과**, 3 회 이상부터 추출 권장 (CLAUDE.md §2 — 한 번 쓰는 추상화 금지) | P1 (3 회+) / P2 (2 회) |
| 동일 SQL 쿼리 ≥2 곳                                                                                | P1                     |
| 동일 zod 스키마 정의 ≥2 곳                                                                         | P0 (소스 충돌 위험)    |
| 동일 magic number / string ≥3 곳                                                                   | P1                     |

## 3. 추상화 수준

### 과대 (over-engineering)

- 한 번도 호출되지 않는 옵션 인자 (`{ verbose?, dryRun?, retries? }` 모두 default 만)
- 1 구현체만 있는 interface — premature abstraction
- 사용처 1 곳인 generic 타입 매개변수
- 미래 가정에 기반한 hook / extension point

### 과소 (under-abstraction)

- 50 LOC 이상의 함수가 한 책임을 안 가짐 (parsing + validation + DB write 가 한 함수에)
- 매개변수 5 개 이상 — 옵션 객체로 묶을 후보
- 한 함수가 두 종류의 결과를 반환 (`returns A | null` 이지만 일부 호출자는 null 절대 안 받음)

## 4. 경계 위반

FinClaw 패키지 의존 그래프 (CLAUDE.md / pnpm-workspace.yaml 참조):

```
types ← config / infra / storage / agent / channel-discord / skills-general
       ← skills-finance (uses types + storage)
       ← server (aggregates)
       ← tui / web (depend on server surfaces)
```

| 위반                                                                             | 우선순위 |
| -------------------------------------------------------------------------------- | -------- |
| 역방향 의존 (types 가 storage import)                                            | P0       |
| 순환 의존                                                                        | P0       |
| skills-\* 가 server import                                                       | P0       |
| storage 가 agent 의 도메인 타입 import (반대로 가야 함)                          | P0       |
| web/tui 가 channel-discord 직접 import                                           | P0       |
| package 안에서 `../../other-pkg/src/...` 직접 경로 import (workspace alias 우회) | P0       |

## 5. CLAUDE.md §3 위반 (외과적 변경)

| 패턴                                                                | 우선순위            |
| ------------------------------------------------------------------- | ------------------- |
| phase plan.md 가 요구하지 않은 인접 코드 "개선"                     | P0 (사용자 확인)    |
| 요청 없는 스타일 통일 (포맷·임포트 정렬)                            | P1                  |
| 자기 phase 와 무관한 파일의 죽은 코드 삭제                          | P0 (언급만 해야 함) |
| 자기 phase 와 무관한 함수 시그니처 변경                             | P0                  |
| 새 phase 의 변경된 모든 줄이 `plan.md` 의 요청에 직접 연결되지 않음 | P0 (scope creep)    |

## 6. 죽은 코드 (변경 후 발생)

phase 변경 결과로 **신규 발생** 한 dead code:

| 패턴                                                           | 검증                                      |
| -------------------------------------------------------------- | ----------------------------------------- |
| 변경 후 미사용 import                                          | `grep "from.*'<symbol>'" packages/` 0 hit |
| 새로 추가됐으나 호출 없는 export                               | 동일                                      |
| 삭제된 호출자 때문에 미참조가 된 helper                        | git log 로 추적                           |
| 변경 후 unreachable branch (`if (false)`, 도달 불가능 default) | 정적 검토                                 |

기존 dead code (phase 변경과 무관) — **언급만**, 별도 섹션. 삭제 권장 X.

## 7. 과도한 에러 처리

CLAUDE.md §2 — "일어날 수 없는 시나리오에 대한 에러 처리 X". 다음을 식별:

| 패턴                                                                                            | 우선순위 |
| ----------------------------------------------------------------------------------------------- | -------- |
| 내부 함수 호출에 try/catch (외부 boundary 가 아닌데)                                            | P1       |
| 자기 코드에 의해 invariant 가 보장되는데 추가 검증 (`if (user) { ... }` — null 일 수 없는 경우) | P1       |
| catch (e) { /_ swallow _/ } 또는 빈 fallback                                                    | P0       |
| 에러를 string 으로 변환해서 무의미한 메시지 (`Error: ${e}`)                                     | P1       |
| Zod 검증 후 또 한 번 typeof 검증                                                                | P1       |

## 8. 요청되지 않은 유연성

CLAUDE.md §2 — "요청되지 않은 '유연성' 이나 '설정 가능성' X".

| 패턴                                                      | 우선순위 |
| --------------------------------------------------------- | -------- |
| `options: { ... }` 매개변수에 plan.md 가 요구하지 않은 키 | P1       |
| 환경변수로 toggle 가능한데 plan.md 미언급                 | P1       |
| 미래 가정 (확장 hook, plugin point)                       | P1       |
| feature flag (없는 게 정상)                               | P0       |

## 9. scope creep 의심

phase 의 `plan.md` 가 요구한 범위 vs 실제 git diff 비교. 무관해 보이는 변경:

- 다른 모듈의 함수 시그니처 변경 (호출자 수정 없이)
- plan.md 가 언급 안 한 새 파일/패키지
- 의존성 추가 (package.json) — plan.md 가 요구한 라이브러리인지 확인
- 마이그레이션 (storage SCHEMA_VERSION bump) 가 plan.md 의 데이터 모델 변경에 연결되는지

→ 발견하면 `## scope creep 의심` 섹션. 사용자 확인 요청.

## 10. 보고서 출력 규칙

- 모든 후보에 `packages/x/y.ts:line` 위치 명시
- 후보별로 **문제 / 근거 / 제안** 3 줄 구조
- 제안에 코드 스니펫 가능 (Edit 호출 X)
- "리팩토링 안 하는 게 맞다" 의 결정도 기록 가치 있음 (CLAUDE.md §3 — 외과적 변경)
