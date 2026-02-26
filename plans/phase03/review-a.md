# Phase 3 todo-a 리뷰

> 대상: 세션 1 (패키지 인프라 + Zod 스키마) + 세션 2 (기능 해석기)
> 소스 11 + 테스트 8 = 19 파일

---

## 1. 전체 요약

| 항목            | 결과                                                                                |
| --------------- | ----------------------------------------------------------------------------------- |
| 소스 파일 (11)  | 전체 생성 완료, todo-a.md 명세와 일치                                               |
| 테스트 파일 (8) | 전체 생성 완료, 50개 테스트 케이스                                                  |
| package.json    | deps 3개 추가 (@finclaw/infra, json5, zod) ✅                                       |
| tsconfig.json   | references에 ../infra 추가 ✅                                                       |
| 의존성 호환성   | FinClawError, FinClawLogger, FinClawConfig, ConfigValidationIssue 모두 존재 확인 ✅ |

---

## 2. 파일별 점검

### 세션 1: 패키지 인프라 + Zod 스키마

| 파일                    | LOC | 명세 일치 | 비고                                                                         |
| ----------------------- | --- | --------- | ---------------------------------------------------------------------------- |
| src/errors.ts           | 41  | ✅        | ConfigError, MissingEnvVarError, CircularIncludeError, ConfigValidationError |
| src/types.ts            | 30  | ✅        | ConfigDeps, ConfigCache 인터페이스                                           |
| src/zod-schema.ts       | 158 | ✅        | .default() 제거 + .partial() 적용 설계 반영                                  |
| src/validation.ts       | 81  | ⚠️        | collectIssues 배열 에러 누락 (아래 B-1)                                      |
| test/zod-schema.test.ts | 78  | ✅        | 7개 케이스                                                                   |
| test/validation.test.ts | 46  | ✅        | 5개 케이스                                                                   |

### 세션 2: 기능 해석기

| 파일                           | LOC | 명세 일치 | 비고                        |
| ------------------------------ | --- | --------- | --------------------------- |
| src/includes.ts                | 77  | ✅        | 프로토타입 오염 방지 포함   |
| src/env-substitution.ts        | 61  | ✅        | \x00 마커 escape 기법       |
| src/paths.ts                   | 25  | ✅        |                             |
| src/merge-config.ts            | 44  | ✅        |                             |
| src/normalize-paths.ts         | 43  | ✅        |                             |
| src/runtime-overrides.ts       | 58  | ✅        | 모듈 레벨 싱글턴 (아래 D-1) |
| src/cache-utils.ts             | 45  | ✅        |                             |
| test/includes.test.ts          | 73  | ✅        | 8개 케이스                  |
| test/env-substitution.test.ts  | 69  | ✅        | 10개 케이스                 |
| test/paths.test.ts             | 31  | ⚠️        | 비결정적 테스트 (아래 B-2)  |
| test/merge-config.test.ts      | 45  | ✅        | 6개 케이스                  |
| test/normalize-paths.test.ts   | 41  | ✅        | 6개 케이스                  |
| test/runtime-overrides.test.ts | 51  | ✅        | 5개 케이스                  |

---

## 3. 버그 / 수정 필요

### B-1. validation.ts:56-79 — `collectIssues`가 배열 에러를 수집하지 않음

**심각도: 중**

`collectIssues`가 `tree.properties`만 순회하고 `tree.items`(배열 요소 에러)를 처리하지 않는다.
배열 내부의 검증 실패 시 이슈가 누락된다.

```
예시: { finance: { dataProviders: [{ name: 123 }] } }
→ dataProviders[0].name 에러가 수집되지 않음
```

**수정안:**

```typescript
// validation.ts collectIssues() 에 추가
if (tree.items) {
  for (const [index, subtree] of Object.entries(tree.items)) {
    const childPath = path ? `${path}[${index}]` : `[${index}]`;
    issues.push(...collectIssues(subtree as z.ZodErrorTree<unknown>, childPath));
  }
}
```

### B-2. paths.test.ts:14-23 — 비결정적 테스트

**심각도: 낮**

- 테스트 2(`환경변수 없으면 ~/.finclaw/config/finclaw.json5를 탐색한다`)가 실제 파일시스템 상태에 의존
- `resolveConfigPath`는 동기 함수인데 테스트가 `async`로 선언되고 `fs.access`를 사용
- `~/.finclaw/config/finclaw.json5`가 없는 환경에서 테스트 2와 3이 동일한 결과

**수정안:** `resolveConfigPath`에 `fs` DI를 추가하거나, 테스트 2를 `vi.mock('node:fs')`로 격리

---

## 4. 설계 고려사항

### D-1. runtime-overrides.ts — 모듈 레벨 싱글턴

모듈 스코프 `Map`으로 전역 상태를 관리한다. 다른 모듈(includes, env-substitution 등)은 순수 함수인데 overrides만 전역이다.

- 테스트: `beforeEach(resetOverrides)`로 격리 중 → 현재는 문제 없음
- todo-b의 `io.ts`에서 `createConfigIO()` DI 팩토리와 통합 시, overrides를 팩토리 내부 상태로 캡슐화하는 것을 검토

### D-2. Zod 스키마 ↔ TypeScript 타입 비대칭

| Zod 스키마           | Zod 필수 필드                    | TS 타입              | TS 필드       |
| -------------------- | -------------------------------- | -------------------- | ------------- |
| DiscordChannelSchema | botToken, applicationId 필수     | DiscordChannelConfig | 모두 optional |
| AlertDefaultsSchema  | cooldownMs, maxActiveAlerts 필수 | AlertDefaultsConfig  | 모두 optional |

의도적 설계(discord 사용 시 토큰 필수)이나, `as FinClawConfig` 캐스트(validation.ts:26)로 타입 안전성이 약화된다.
todo-b에서 `defaults.ts` 구현 시 이 비대칭을 고려해야 한다.

---

## 5. 리팩토링 후보

### R-1. `isPlainObject` 4회 중복

동일한 구현이 4개 파일에 존재:

| 파일                    | 라인   |
| ----------------------- | ------ |
| src/includes.ts         | 64-70  |
| src/env-substitution.ts | (동일) |
| src/merge-config.ts     | 37-43  |
| src/normalize-paths.ts  | (동일) |

**제안:** 공유 유틸리티 파일(`src/object-utils.ts` 등)로 추출

### R-2. `deepMerge` ≈ `mergeConfig` 중복

| 함수          | 파일               | 시그니처                                                                                        |
| ------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `deepMerge`   | includes.ts:47     | `(target: unknown, source: unknown) => unknown`                                                 |
| `mergeConfig` | merge-config.ts:11 | `(target: Record<string, unknown>, source: Record<string, unknown>) => Record<string, unknown>` |

로직 동일, 타입 시그니처만 다르다.

**제안:** `deepMerge` 하나로 통합하고 `mergeConfig`는 타입 래퍼로 변환. 또는 includes.ts가 merge-config.ts를 import.
