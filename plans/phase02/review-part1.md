# Phase 2 Part 1 리뷰

> 리뷰 기준일: 2026-02-26
> 브랜치: `feature/types` (uncommitted — `packages/infra/` untracked)
> 대상: `todo-part1.md` T1~T15

---

## 검증 결과 요약

| 명령어           | 결과                                              |
| ---------------- | ------------------------------------------------- |
| `pnpm typecheck` | 에러 0                                            |
| `pnpm build`     | `packages/infra/dist/` 생성 성공                  |
| `pnpm test`      | 12파일 95테스트 전체 통과 (infra 7파일, 61테스트) |
| `pnpm lint`      | 에러 0, 경고 0 (50파일)                           |

---

## 태스크별 리뷰

### T1. 프로젝트 셋업 — OK

- `package.json`: 스펙과 일치
- `tsconfig.json`: 스펙과 일치
- 루트 `tsconfig.json`: `packages/types`와 `packages/config` 사이에 `packages/infra` 정확히 삽입
- `src/index.ts`: 스펙은 `export {};`이지만 구현은 `export type TODO = 'stub';`
  - 프로젝트 컨벤션(`no-empty-file` + `require-module-specifiers` 린트 규칙 대응)에 맞는 올바른 판단

### T2. errors.ts — OK

- 스펙과 로직 일치. 클래스 계층(FinClawError → SsrfBlockedError, PortInUseError), 타입가드, wrapError, extractErrorInfo 모두 정확

### T3. backoff.ts — OK

- 스펙과 로직 일치. 코드 포매팅만 상이 (if 블록 중괄호 스타일 — 린터 자동 포맷 결과로 판단)

### T4. format-duration.ts — OK

- 스펙과 로직 일치

### T5. warnings.ts — OK

- 스펙과 로직 일치

### T6. context.ts — OK

- 스펙과 로직 일치

### T7. test/helpers.ts — OK

- 스펙과 일치. `withTempDir`, `createTestLogger` 제공
- 현재 Part 1 테스트에서는 미사용 (Part 2/3용 — 의도된 상태)

### T8. runtime-guard.ts — OK

- 스펙과 로직 일치

### T9. dotenv.ts — OK

- 스펙과 로직 일치

### T10. env.ts — OK

- 스펙과 로직 일치

### T11. paths.ts — 경미한 차이

- **로직**: 스펙과 동일
- **import 순서**: 스펙은 `path → os → getEnv` 순이지만, 구현은 `os → (파일 주석) → path → getEnv` 순
  - 동작에 영향 없음. 다른 파일들은 주석이 파일 첫 줄에 위치하는 반면 여기만 import 사이에 끼어 있음

### T12. is-main.ts — OK

- 스펙과 로직 일치

### T13. 기반 모듈 테스트 — OK

- `errors.test.ts` (15 tests): 스펙과 일치
- `backoff.test.ts` (8 tests): 스펙과 일치
- `context.test.ts` (4 tests): 스펙과 일치
- `format-duration.test.ts` (7 tests): 스펙과 일치

### T14. 환경/설정 테스트 — OK

- `runtime-guard.test.ts` (2 tests): 스펙에서 사용하지 않는 `beforeEach, afterEach` import를 제거. 개선
- `env.test.ts` (19 tests): 스펙과 일치
- `paths.test.ts` (6 tests): 스펙과 일치

### T15. 전체 검증 — PASS

- 4개 명령어 모두 통과 (위 표 참조)

---

## 전체 판정: PASS

스펙 대비 로직 일치율 100%. 커밋 가능 상태.

---

## 리팩토링 사항

### R1. `paths.ts` import 주석 위치 (cosmetic)

```
현재:
  import * as os from 'node:os';
  // packages/infra/src/paths.ts       ← import 사이에 끼어 있음
  import * as path from 'node:path';

권장:
  // packages/infra/src/paths.ts       ← 파일 첫 줄 (다른 파일과 일관성)
  import * as os from 'node:os';
  import * as path from 'node:path';
```

심각도: 낮음. 동작 무관. 다른 소스파일(`errors.ts`, `backoff.ts`, `env.ts` 등)은 모두 첫 줄에 파일 주석.

### R2. 테스트 커버리지 갭 — 3개 모듈 미테스트

todo 스펙에서 "별도 테스트 불필요" 또는 "간접 검증 가능"으로 명시한 모듈들이지만,
실제로 어떤 테스트에서도 검증되지 않는 상태:

| 모듈                   | 스펙 판단         | 실제 테스트   |
| ---------------------- | ----------------- | ------------- |
| `warnings.ts`          | T13에서 판단      | **없음**      |
| `dotenv.ts`            | env.test에서 간접 | **간접 없음** |
| `is-main.ts`           | T14에서 간접 가능 | **간접 없음** |
| `logAcceptedEnvOption` | (env.ts 내 함수)  | **없음**      |

Part 2/3에서 사용하면서 자연스럽게 간접 검증될 수 있으나,
단위 테스트 커버리지 관점에서 의도적 기록이 필요.

심각도: 낮음. 3개 모듈 모두 5줄 내외의 단순 래퍼.

### R3. `@finclaw/types` 의존성 미사용

`package.json`에 `"@finclaw/types": "workspace:*"` 선언되어 있으나
Part 1의 소스파일 중 `@finclaw/types`를 import하는 곳이 없음.

Part 2/3에서 사용 예정이므로 선제적 선언으로 판단. 삭제 불필요.

심각도: 정보. 조치 불필요.
