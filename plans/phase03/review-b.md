# Phase 3 todo-b 구현 리뷰

> 대상: `feature/config` 브랜치, todo-b.md(세션 3: Step 4-6) 구현 결과
> 파일: 소스 7 + 테스트 4 + 예시 1 = 12파일 (plan 13 → .env.example 미생성)

## 1. 요약

todo-b.md 계획 대비 구현은 **설계 방향을 단순화**하는 쪽으로 일관되게 변경되었다.
핵심 변경: 7단계 함수 체이닝 → `mergeConfig()` 재사용, 단일 sessions.json → 파일별 저장, `readConfigFileSnapshot()` 제거.
기능적으로 계획의 목표(defaults, IO 파이프라인, 세션, barrel)를 모두 충족한다.

## 2. 파일별 리뷰

### 2-1. defaults.ts — 설계 단순화 (양호)

| 항목      | Plan                            | Actual                                     |
| --------- | ------------------------------- | ------------------------------------------ |
| 함수명    | `applyAllDefaults`              | `applyDefaults`                            |
| 구현 방식 | 7개 `applyXxxDefaults()` 체이닝 | `DEFAULTS` 객체 + `mergeConfig()` 1회 호출 |
| 추가 API  | —                               | `getDefaults()`                            |

**기본값 차이:**

| 필드                   | Plan          | Actual        | 비고                           |
| ---------------------- | ------------- | ------------- | ------------------------------ |
| `gateway.port`         | 18789         | 3000          | 의도적 변경                    |
| `gateway.host`         | `'localhost'` | `'127.0.0.1'` | IP 직접 사용으로 DNS 의존 제거 |
| `gateway.tls`          | true          | false         | dev 편의 (로컬에서 TLS 불필요) |
| `session.mainKey`      | `'main'`      | `'default'`   | 명명 변경                      |
| `logging.file`         | true          | false         | dev 편의                       |
| `agents.maxConcurrent` | 3             | 2             | 보수적 기본값                  |

**추가 섹션:** `channels` (cli/web), `models`, `plugins` — plan에 없던 것을 미리 추가.
**제거된 것:** `finance.alertDefaults`, `meta` 기본값 — Zod 스키마에서 optional로 처리.

**평가:** `mergeConfig()` 재사용으로 코드 ~100줄 → ~60줄 감소. 7단계 체이닝의 참조 동일성 보존 설계는 과도했으며, 단일 merge가 더 적절.

### 2-2. io.ts — 파이프라인 경량화 (양호, 이슈 2건)

**파이프라인 (8단계):**

```
1. 파일 읽기 (JSON5)
2. $include 해석
3. 환경변수 치환
4. 경로 정규화 (~/)     ← plan에서는 6단계(defaults 후)였으나, 검증 전으로 이동
5. Zod 검증
6. 유저 설정 선택       ← plan의 "병합" 주석은 부정확 (실제로는 검증 성공/실패 분기)
7. 기본값 적용
8. 런타임 오버라이드
```

**Plan 대비 변경:**

- `readConfigFileSnapshot()` 제거 → ConfigIO 인터페이스 간소화
- `writeConfigFile()` sync → async (writeFileAtomic이 async이므로 적절)
- `invalidateCache()` 메서드 추가 (plan에는 없음, 유용)

**이슈:**

| #   | 위치        | 내용                                                                                                                                                  | 심각도 |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| B-1 | `io.ts:46`  | `require('node:os')` inline 사용. 다른 모듈은 top-level `import * as os` 패턴. 비일관.                                                                | Low    |
| B-2 | `io.ts:130` | `loadConfig(deps?)` — 첫 호출 후 `defaultIO`가 생성되면 이후 호출의 `deps`가 무시됨. 예상과 다른 동작. `clearConfigCache()` 없이 deps를 바꿀 수 없음. | Medium |

> **B-2 보충:** 현재 테스트에서는 `beforeEach`에서 `clearConfigCache()`를 호출하므로 문제 없으나, 프로덕션 코드에서 `loadConfig({ configPath: '/custom' })`를 두 곳에서 다른 deps로 호출하면 두 번째 호출이 조용히 무시됨.

### 2-3. validation.ts — Zod v4 호환 수정 (양호)

- `z.treeifyError()` 반환 타입을 `as unknown as ErrorTree`로 캐스팅
- `ErrorTree` 인터페이스 자체 정의로 Zod 내부 타입(`$ZodErrorTree`) 의존성 제거
- `collectIssues()` 파라미터 타입을 `ErrorTree`로 통일

**평가:** Zod v4의 타입 불안정성에 대한 합리적 대응. 자체 인터페이스로 분리하여 향후 Zod 업데이트 시 수정 범위 최소화.

### 2-4. sessions/ — 저장 구조 변경 (양호)

**설계 변경:**

| 항목           | Plan                         | Actual                           |
| -------------- | ---------------------------- | -------------------------------- |
| 저장 방식      | 단일 `sessions.json` (Map)   | 파일별 `<key>.json`              |
| 동시성 제어    | `sessions.lock` (wx flag)    | 없음 (파일별이라 충돌 범위 축소) |
| API            | `get/set/update/delete/list` | `get/set/delete/list/clear`      |
| `set` 시그니처 | `set(key, entry)`            | `set(entry)` (entry.key 사용)    |
| `list` 반환    | `Map<string, SessionEntry>`  | `SessionEntry[]`                 |
| `get` 반환     | `SessionEntry \| undefined`  | `SessionEntry \| null`           |

**sessions/types.ts:**

- `SessionScope`: `'channel' | 'account' | 'chat'` → `'global' | 'channel' | 'user'` (더 범용적)
- `SessionEntry.updatedAt` → `lastAccessedAt` (의미 변경: 수정 시간 → 접근 시간)
- `mergeSessionEntry`: `Date.now() as Timestamp` 하드코딩 → `patch.lastAccessedAt` 사용 (호출자 제어)

**sessions/session-key.ts:**

- 시그니처: `(channel, account, chat?)` → `(scope, identifier)` (더 범용적)
- 정규화: `공백→하이픈 + 특수문자 제거` → `비허용→_ + 연속_ 축소 + 앞뒤_ 제거`

**sessions/store.ts:**

- `now()` 헬퍼 export — `createTimestamp(Date.now())` 래퍼

**평가:** 파일별 저장은 lock 없이도 키 단위 원자성 확보. `update` 제거는 get→modify→set으로 대체 가능하므로 API 표면 축소에 적절. `null` 반환은 `undefined` 대비 JSON 직렬화 시 명시적.

### 2-5. index.ts — barrel export (양호, 이슈 1건)

**Plan 대비 변경:**

- 제거: `deepMerge` (includes.ts에서 내부용으로 유지)
- 추가: `getDefaults`, `getOverrideCount`, `now`

**이슈:**

| #   | 내용                                                                                                                                 | 심각도 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| B-3 | `now()` export — `createTimestamp(Date.now())`의 단순 래퍼. 패키지 공개 API로 노출할 만한 유틸인지 재고. 내부 헬퍼로 충분할 수 있음. | Low    |

### 2-6. test-helpers.ts (양호)

- `withTempHome<T>`: plan은 `process.env.HOME` 변경, actual은 tmpDir만 전달 → **더 안전** (전역 상태 오염 없음)
- `withEnvOverride<T>`: 제네릭 반환 타입 추가로 더 유연
- 동기 `mkdtempSync`/`rmSync` 사용 — 테스트 헬퍼로 적절

### 2-7. config.example.json5 (양호)

- defaults.ts와 값 일치 (port 3000, host 127.0.0.1 등)
- `finance.dataProviders` 포함 (defaults에는 없지만 예시로 적절)
- `.env.example` 미생성 — plan에는 있었으나 누락

### 2-8. 테스트

| 테스트 파일          | Plan 케이스               | Actual 케이스               | 비고                                     |
| -------------------- | ------------------------- | --------------------------- | ---------------------------------------- |
| defaults.test.ts     | 7 (참조 동일성 포함)      | 5                           | 설계 변경으로 참조 동일성 불필요. 적절   |
| io.test.ts           | 6 (mock DI, TTL 타이머)   | 8                           | 실제 fs 사용(tmpDir)으로 변경. 더 현실적 |
| sessions.test.ts     | 6 (단일 파일, deep clone) | 10 (mergeEntry 3 + store 7) | 파일별 스토어 + 캐시 동작 테스트 추가    |
| sessions-key.test.ts | 6                         | 8                           | 스코프 기반 설계에 맞게 확장             |

**테스트 커버리지 양호한 점:**

- io.test.ts: 실제 파일시스템 사용으로 JSON5 파싱, 환경변수 치환 등을 실제로 검증
- sessions.test.ts: 캐시 동작(파일 삭제 후 캐시에서 반환) 테스트 포함
- sessions-key.test.ts: 엣지 케이스(모든 문자 비허용 → default) 포함

## 3. 이슈 요약

| #   | 파일          | 내용                                                    | 심각도 | 조치                                                         |
| --- | ------------- | ------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| B-1 | `io.ts:46`    | inline `require('node:os')` — top-level import와 비일관 | Low    | `import * as os from 'node:os'`로 변경                       |
| B-2 | `io.ts:130`   | `loadConfig(deps?)` 재호출 시 deps 무시                 | Medium | JSDoc에 싱글턴 동작 명시, 또는 deps 변경 시 defaultIO 재생성 |
| B-3 | `index.ts:49` | `now()` 공개 export 필요성                              | Low    | 내부 헬퍼로 전환 검토                                        |

## 4. 미구현 항목

| 항목                           | Plan                    | 상태                 |
| ------------------------------ | ----------------------- | -------------------- |
| `readConfigFileSnapshot()`     | io.ts에서 snapshot 조회 | 의도적 제거 (YAGNI)  |
| `.env.example`                 | 루트에 환경변수 예시    | 미생성               |
| `sessions.lock` (동시성 제어)  | wx flag 기반 lock       | 파일별 저장으로 대체 |
| `finance.alertDefaults` 기본값 | defaults에 포함         | 의도적 제거          |

## 5. 리팩토링 후보

| #   | 대상                      | 내용                                                                                                 | 우선순위 |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| R-1 | `io.ts` loadConfig 싱글턴 | deps가 무시되는 문제. (1) JSDoc 문서화, 또는 (2) deps hash로 불일치 시 재생성                        | P2       |
| R-2 | `io.ts:46` require inline | `import * as os from 'node:os'`로 통일                                                               | P3       |
| R-3 | `store.ts` now() 위치     | barrel export에서 제거하고 sessions 내부 헬퍼로 이동. 또는 `@finclaw/types`에 `Timestamp.now()` 추가 | P3       |
| R-4 | `io.ts:38` 주석 수정      | 6단계 주석 "병합 (includes)" → "유저 설정 선택"                                                      | P3       |
| R-5 | sessions 테스트           | 파일 권한(0o600) 검증 테스트 추가 고려                                                               | P3       |
