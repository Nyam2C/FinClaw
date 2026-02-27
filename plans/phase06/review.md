# Phase 06 구현 리뷰

## 1. 개요

| 항목      | 값                                     |
| --------- | -------------------------------------- |
| 브랜치    | `feature/agent-model-auth`             |
| 커밋      | `e245c65` (Part 1), `df5acfd` (Part 2) |
| 변경 파일 | 32 files                               |
| 변경 규모 | +6,044 / −114 lines                    |
| 테스트    | 8 파일, 86 테스트 전부 통과            |
| Typecheck | 통과                                   |

---

## 2. Part 1 체크리스트 (L1 모델 계층 + 프로바이더 어댑터)

| #   | 항목                                                       | 완료 | 비고                                              |
| --- | ---------------------------------------------------------- | :--: | ------------------------------------------------- |
| T1  | 프로젝트 셋업 — package.json + tsconfig.json               |  O   | `@finclaw/config` phantom 의존성 (아래 이슈 참조) |
| T2  | `errors.ts` — FailoverError + classifyFallbackError        |  O   |                                                   |
| T3  | `catalog.ts` — 타입 + InMemoryModelCatalog                 |  O   |                                                   |
| T4  | `catalog-data.ts` — BUILT_IN_MODELS                        |  O   | `o3` alias 중복 (아래 이슈 참조)                  |
| T5  | `alias-index.ts` — buildModelAliasIndex()                  |  O   |                                                   |
| T6  | `selection.ts` — resolveModel()                            |  O   |                                                   |
| T7  | `provider-normalize.ts` — 응답 정규화                      |  O   | 캐시 토큰 비용 미산정 (아래 이슈 참조)            |
| T8  | `adapter.ts` — ProviderAdapter + CircuitBreaker 레지스트리 |  O   |                                                   |
| T9  | `anthropic.ts` — Anthropic SDK 어댑터                      |  O   | `tools` 미전달 (아래 이슈 참조)                   |
| T10 | `openai.ts` — OpenAI SDK 어댑터                            |  O   | `tools` 미전달 (아래 이슈 참조)                   |
| T11 | FinClawEventMap 확장 — model 이벤트 3종                    |  O   |                                                   |
| T12 | `index.ts` — Part 1 배럴 export                            |  O   |                                                   |
| T13 | `test/errors.test.ts`                                      |  O   |                                                   |
| T14 | `test/catalog.test.ts`                                     |  O   |                                                   |
| T15 | `test/selection.test.ts`                                   |  O   |                                                   |
| T16 | `test/normalize.test.ts`                                   |  O   |                                                   |
| T17 | Part 1 최종 검증                                           |  O   |                                                   |

---

## 3. Part 2 체크리스트 (L2 인증 계층 + 폴백 통합)

| #   | 항목                                         | 완료 | 비고                                            |
| --- | -------------------------------------------- | :--: | ----------------------------------------------- |
| T1  | FinClawEventMap 확장 — auth 이벤트 3종       |  O   |                                                 |
| T2  | Config 스키마 확장 — defaultModel, fallbacks |  O   |                                                 |
| T3  | `cooldown.ts` — CooldownTracker              |  O   |                                                 |
| T4  | `health.ts` — ProfileHealthMonitor           |  O   |                                                 |
| T5  | `profiles.ts` — InMemoryAuthProfileStore     |  O   | `selectNext()` stale 반환 (아래 이슈 참조)      |
| T6  | `resolver.ts` — resolveApiKeyForProvider()   |  O   | API 키 INFO 로깅 (아래 이슈 참조)               |
| T7  | `fallback.ts` — runWithModelFallback()       |  O   | 타입 중복 + 이벤트 인자 불일치 (아래 이슈 참조) |
| T8  | `index.ts` — 완전한 배럴 export              |  O   |                                                 |
| T9  | `test/cooldown.test.ts`                      |  O   |                                                 |
| T10 | `test/health.test.ts`                        |  O   |                                                 |
| T11 | `test/resolver.test.ts`                      |  O   |                                                 |
| T12 | `test/fallback.test.ts`                      |  O   |                                                 |
| T13 | Part 2 최종 검증                             |  O   |                                                 |

---

## 4. 발견된 이슈

### CRITICAL

#### C1. `UnresolvedModelRef` 인터페이스 중복 정의

- **위치**: `selection.ts:7-9`, `fallback.ts:8-10`
- **내용**: 동일한 `UnresolvedModelRef` 인터페이스가 두 파일에 각각 정의됨
- **영향**: 한쪽 수정 시 다른 쪽이 동기화되지 않아 런타임 불일치 가능. `index.ts`는 `selection.ts`에서만 re-export하므로, `fallback.ts`의 타입은 외부에서 접근 불가
- **수정**: `selection.ts`에만 정의하고, `fallback.ts`에서 import

---

### MEDIUM

#### M1. `FallbackTrigger` / `FallbackReason` 동일 타입 중복

- **위치**: `errors.ts:5-10` (`FallbackReason`), `fallback.ts:13-18` (`FallbackTrigger`)
- **내용**: 두 타입은 이름만 다르고 값이 동일 (`'rate-limit' | 'server-error' | 'timeout' | 'context-overflow' | 'model-unavailable'`)
- **영향**: 하나를 수정하면 다른 쪽과 불일치 발생 가능
- **수정**: `errors.ts`의 `FallbackReason`을 canonical로 사용하고, `fallback.ts`에서 `FallbackTrigger`를 type alias로 재정의 (`type FallbackTrigger = FallbackReason`)

#### M2. `o3` 모델 alias 중복으로 매 빌드 시 경고 로그

- **위치**: `catalog-data.ts:116`
- **내용**: `o3` 모델의 `id`가 `'o3'`이고 `aliases`가 `['o3']`. `buildModelAliasIndex()`는 `[model.id, ...model.aliases]`를 순회하므로 `'o3'`가 두 번 등록됨
- **영향**: `buildModelAliasIndex()` 호출 시마다 `Duplicate alias "o3"` 경고 로그 출력
- **수정**: `aliases: []` 또는 `aliases: ['openai-o3']` 등 중복 없는 값으로 변경

#### M3. `selectNext()` 갱신 전 stale 객체 반환

- **위치**: `profiles.ts:138-141`
- **내용**: `selectNext()`가 `sorted[0]` (stale 객체)을 반환한 후 Map에 `lastUsedAt: new Date()`로 갱신된 새 객체를 저장. 호출자가 받는 객체의 `lastUsedAt`은 갱신 전 값
- **영향**: 호출자가 반환된 프로필의 `lastUsedAt`을 참조하면 실제보다 이전 시각을 봄
- **수정**: Map 갱신 후 갱신된 객체를 반환하거나, `lastUsedAt`이 중요하지 않다면 현행 유지 후 주석 추가

#### M4. `model:fallback` 이벤트 인자 의미 불일치

- **위치**: `fallback.ts:117`, `events.ts:60`
- **내용**: 이벤트 시그니처는 `(from: string, to: string, reason: string)`이나, 실제 emit은 `(resolved.modelId, modelRef.raw, trigger)` — `from`과 `to` 모두 동일 모델을 가리킴 (하나는 resolved ID, 하나는 원본 raw 문자열). 또한 재시도(같은 모델 retry) 시에도 이벤트가 발생하여, "다른 모델로 전환됨"이라는 시맨틱과 맞지 않음
- **영향**: 이벤트 리스너가 `to`를 다음 모델로 해석하면 잘못된 정보를 받음
- **수정**: 이벤트를 모델 전환 시점(다음 `modelRef` for 루프 진입 시)에만 emit하고, `from`을 현재 모델, `to`를 다음 모델로 변경

#### M5. Provider normalizer `as` 캐스트 런타임 검증 부재

- **위치**: `provider-normalize.ts:63`, `provider-normalize.ts:115`
- **내용**: `normalizeAnthropicResponse()`와 `normalizeOpenAIResponse()` 모두 `raw as { ... }`로 타입 캐스트만 하고 런타임 검증이 없음. SDK 응답 스키마가 변경되면 silent failure 발생
- **영향**: SDK 버전 업그레이드 시 필드 누락으로 `0` 또는 `''` 반환. 비용 계산이 0으로 나와도 에러 없이 통과
- **수정**: 최소한 필수 필드(`usage`, `content`/`choices`) 존재 여부를 런타임에 검증하는 가드 추가. 또는 zod 스키마로 파싱

#### M6. 모델 카탈로그 하드코딩 — 운영 변경에 코드 수정 필요

- **위치**: `catalog-data.ts:5-120`
- **내용**: `BUILT_IN_MODELS` 상수 배열에 6개 모델이 하드코딩. 모델 단종(예: `o3` 서비스 종료)이나 신규 모델 추가 시 코드 변경 + 재빌드 + 재배포가 필요
- **영향**: 운영 변경이 코드 변경을 강제함. config의 `ModelsConfig.definitions` 필드가 존재하나, config → catalog 연결 로직이 미구현이라 실제로는 사용 불가
- **수정**: config에서 `models.definitions`를 읽어 `registerModel()`로 등록하는 초기화 로직 추가. 하드코딩 데이터는 폴백 기본값으로만 유지

#### M7. `resolver.ts` API 키 INFO 레벨 로깅

- **위치**: `resolver.ts:57,66,74,85`
- **내용**: `log.info()`로 마스킹된 API 키를 로깅. `maskApiKey()`가 앞 3자 + 뒤 4자를 노출하므로, 프로덕션 INFO 로그에 키 일부가 남음
- **영향**: 로그 수집 시스템에 키 힌트가 노출될 수 있음
- **수정**: `log.debug()`로 하향하거나, INFO 레벨에서는 키 정보를 제거하고 source만 로깅

---

### LOW

#### L1. `calculateEstimatedCost` 캐시 토큰 비용 미산정

- **위치**: `provider-normalize.ts:35-44`
- **내용**: `cacheReadTokens`, `cacheWriteTokens`가 `NormalizedUsage`에 포함되지만 `calculateEstimatedCost()`는 `inputTokens`, `outputTokens`만 계산. `ModelPricing`에 `cacheReadPerMillion`, `cacheWritePerMillion` 옵셔널 필드가 있으나 미사용
- **영향**: Anthropic prompt caching 사용 시 실제 비용보다 낮게 산정
- **수정**: 캐시 토큰 비용을 함수 시그니처에 추가하고 pricing의 cache 필드 반영

#### L2. `@finclaw/config` phantom 의존성

- **위치**: `packages/agent/package.json:18`, `packages/agent/tsconfig.json:4`
- **내용**: `@finclaw/config`가 dependencies와 tsconfig references에 있으나, `packages/agent/src/` 내 어떤 파일에서도 `@finclaw/config`를 import하지 않음
- **영향**: 불필요한 빌드 의존성. 설치/빌드 시간 미세 증가
- **수정**: package.json dependencies와 tsconfig.json references에서 `@finclaw/config` 제거

#### L3. Provider 어댑터 `tools` 미전달

- **위치**: `anthropic.ts:24-36`, `openai.ts:16-25`
- **내용**: `ProviderRequestParams`에 `tools?: ToolDefinition[]`이 있으나, 두 어댑터 모두 SDK 호출 시 `tools`를 전달하지 않음
- **영향**: Phase 9+ 도구 사용 기능 구현 시 반드시 수정 필요
- **수정**: 현재는 Phase 6 범위 밖이므로 TODO 주석 추가

#### L4. 서킷브레이커 open 상태 에러 미분류

- **위치**: `fallback.ts:80-84`
- **내용**: CircuitBreaker가 open 상태이면 해당 provider를 `continue`로 건너뛰지만, `circuit.execute()` 내부에서 open 시 throw하는 에러는 `classifyFallbackError`로 분류되지 않음 (CircuitBreakerOpenError가 FallbackReason에 매핑되지 않음)
- **영향**: 서킷이 열린 직후 `execute()` 호출 시 미분류 에러로 전체 체인이 중단될 수 있음. 현재는 `getState()` 선 검사로 우회되고 있어 실질적 영향은 낮음
- **수정**: `classifyFallbackError()`에 CircuitBreakerOpenError → `'model-unavailable'` 매핑 추가, 또는 현행 유지

#### L5. `normalizeAnthropicResponse` stop_reason 매핑 불완전

- **위치**: `provider-normalize.ts:89`
- **내용**: `r.stop_reason as StopReason`으로 직접 캐스트. Anthropic API가 새로운 stop_reason 값을 추가하면 `StopReason` 유니온에 없는 값이 됨
- **영향**: 타입 안전성 위반 (런타임에는 문제 없으나 타입 보장 깨짐)
- **수정**: OpenAI처럼 `mapAnthropicStopReason()` 헬퍼로 변환하고 unknown 값에 대해 `'end_turn'` 폴백

#### L6. `InMemoryModelCatalog.registerModel` 중복 등록 시 throw

- **위치**: `catalog.ts:83-86`
- **내용**: 동일 ID 모델 등록 시 에러 throw. 모델 정의 업데이트/오버라이드 불가
- **영향**: config에서 모델 정의를 오버라이드하려는 경우 사전 삭제가 필요
- **수정**: `upsert` 옵션 추가 또는 별도 `updateModel()` 메서드 제공 (향후 필요 시)

#### L7. `profiles.ts` update 메서드의 `as ManagedAuthProfile`

- **위치**: `profiles.ts:96`
- **내용**: `{ ...existing, ...patch } as ManagedAuthProfile` — spread + partial patch 결과를 type assertion으로 처리
- **영향**: patch에 잘못된 필드 조합이 들어와도 타입 검사가 통과
- **수정**: assertion 대신 명시적 필드 매핑

#### L8. `HealthRecord` records 배열 mutable

- **위치**: `health.ts:31-33`
- **내용**: `ProfileState.records`가 `HealthRecord[]` (mutable). `readonly` 마킹 없음
- **영향**: 의도치 않은 외부 변경 가능성 (현재는 내부 전용이므로 실질적 영향 없음)

#### L9. 테스트에서 `vi.useFakeTimers` 누적 부작용

- **위치**: `cooldown.test.ts`, `health.test.ts`
- **내용**: 타이머 테스트가 `Date.now()` 모킹에 의존. `afterEach`에서 `vi.useRealTimers()` 호출하지만, 테스트 실패 시 정리되지 않을 수 있음
- **영향**: 테스트 순서 의존성 (현재는 vitest가 파일별 격리하므로 실질적 영향 없음)

#### L10. `ConversationMessage` role 타입 좁히기

- **위치**: `anthropic.ts:29`, `openai.ts:19`
- **내용**: `m.role as 'user' | 'assistant'` (Anthropic), `m.role as 'system' | 'user' | 'assistant'` (OpenAI) — `ConversationMessage.role` 타입이 더 넓을 수 있음
- **영향**: `tool` role 등 새 role 추가 시 silent ignore

---

## 5. 테스트 커버리지 갭

| #   | 미테스트 영역                                         | 우선순위 |
| --- | ----------------------------------------------------- | -------- |
| G1  | `AnthropicAdapter` 단위 테스트 (SDK mock)             | 높음     |
| G2  | `OpenAIAdapter` 단위 테스트 (SDK mock)                | 높음     |
| G3  | `createProviderAdapter` 팩토리 테스트                 | 중간     |
| G4  | 모든 서킷 open 시 fallback 전체 소진 시나리오         | 중간     |
| G5  | `calculateEstimatedCost` 캐시 토큰 포함 시나리오      | 낮음     |
| G6  | `profiles.ts` `recordUsage` → health 연동 통합 테스트 | 중간     |
| G7  | `InMemoryModelCatalog.findModels` 복합 필터 테스트    | 낮음     |

---

## 6. 리팩토링 항목

리뷰에서 도출된 개선 항목. Phase 06 fix 커밋 또는 후속 Phase에서 처리.

| #   | 항목                                                   | 관련 이슈 | 우선순위 |
| --- | ------------------------------------------------------ | --------- | -------- |
| R1  | `UnresolvedModelRef` 중복 제거 — `selection.ts`에 통합 | C1        | 높음     |
| R2  | `FallbackTrigger` → `FallbackReason` type alias로 변경 | M1        | 높음     |
| R3  | `selectNext()` 반환값을 갱신된 객체로 수정             | M3        | 중간     |
| R4  | `model:fallback` 이벤트 시점/인자 재설계               | M4        | 중간     |
| R5  | API 키 로그 레벨 `log.info` → `log.debug` 하향         | M7        | 중간     |
| R6  | config → catalog 연결 로직 추가 (모델 하드코딩 탈피)   | M6        | 중간     |
| R7  | `o3` alias 배열에서 중복 제거                          | M2        | 낮음     |
| R8  | `@finclaw/config` phantom 의존성 제거                  | L2        | 낮음     |
| R9  | `calculateEstimatedCost`에 캐시 토큰 반영              | L1        | 낮음     |
| R10 | Provider adapter `tools` 전달 TODO 주석 추가           | L3        | 낮음     |
| R11 | Provider adapter 단위 테스트 추가                      | G1, G2    | 중간     |
| R12 | Provider normalizer 런타임 검증 추가                   | M5        | 낮음     |
