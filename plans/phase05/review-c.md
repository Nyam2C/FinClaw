# Phase 5 todo-c 리뷰: 채널 레이어 + 통합

## 파일 대조 요약 (소스 11 + 테스트 4 = 15파일)

| 파일                                     | 스펙 일치 | 비고                                          |
| ---------------------------------------- | --------- | --------------------------------------------- |
| `src/channels/dock.ts`                   | ~60%      | 구조적 재설계 (아래 상세)                     |
| `src/channels/registry.ts`               | ~50%      | CORE_DOCKS 사전 등록 제거, 중복 방지 추가     |
| `src/channels/chat-type.ts`              | ~70%      | undefined/fallback 미지원, 추가 매핑          |
| `src/channels/typing.ts`                 | ~40%      | Handle 패턴으로 전면 재설계                   |
| `src/channels/gating/pipeline.ts`        | ~30%      | GatingResult/Context 없음, boolean+async 전환 |
| `src/channels/gating/mention-gating.ts`  | ~50%      | 팩토리 패턴으로 변경                          |
| `src/channels/gating/command-gating.ts`  | ~50%      | 팩토리 패턴, null prefix 미지원               |
| `src/channels/gating/allowlist.ts`       | ~50%      | 빈 allowlist 의미론 반전 (허용→차단)          |
| `src/channels/index.ts`                  | ~70%      | 구현 차이 반영                                |
| `src/plugins/index.ts`                   | ~90%      | createPluginBuildApi 미포함                   |
| `src/plugins/event-bridge.ts`            | ~40%      | 함수명·패턴 전면 변경                         |
| `test/channels/dock.test.ts`             | ~50%      | 구현 차이 반영                                |
| `test/channels/chat-type.test.ts`        | ~70%      | undefined 케이스 없음, 추가 매핑 테스트       |
| `test/channels/gating.test.ts`           | ~40%      | boolean 기반, 팩토리 패턴 반영                |
| `test/channels/channel-registry.test.ts` | ~50%      | 빈 초기 상태, 중복 에러 테스트                |

## 검증 결과

| 검증 항목                              | 결과                                                |
| -------------------------------------- | --------------------------------------------------- |
| `pnpm typecheck` (tsgo)                | **PASS** — 에러 0                                   |
| `pnpm lint` (oxlint)                   | **PASS** — 경고/에러 0                              |
| `vitest run test/channels/`            | **PASS** — 4파일 55케이스 전체 통과                 |
| `vitest run test/plugins/ + channels/` | **PASS** — 11파일 125케이스 전체 통과               |
| `pnpm build` (tsc --build)             | **FAIL** — 5개 에러 (todo-b 산출물, todo-c 범위 외) |

빌드 에러는 `loader.ts` (3건) + `manifest.ts` (2건)으로 todo-b에서 발생한 기존 문제이며 todo-c 변경과 무관.

---

## 주요 발견 사항

### 1. [설계 변경] dock.ts — capabilities 기본값 제거, CORE_DOCKS 배열화

**스펙:**

- `Partial<ChannelCapabilities>` → DEFAULT_CAPABILITIES와 병합
- `CORE_DOCKS: ReadonlyMap<string, ChannelDock>`
- `Object.freeze` → `Readonly<ChannelDock>` 반환

**구현:**

- capabilities가 **필수** 전체 지정 (기본값 병합 없음)
- `CORE_DOCKS: readonly ChannelDock[]` (frozen 배열)
- Object.freeze는 배열에만 적용, 개별 Dock은 미적용

**영향:** capabilities 부분 오버라이드가 불가능하므로, 새 채널 등록 시 항상 9개 필드를 모두 지정해야 한다. Map→배열 전환으로 registry.ts의 초기화 방식도 변경됨.

**평가:** 구현 쪽이 명시적(explicit) 접근을 택함. 합리적이지만, 다수 채널 Dock을 만들 때 보일러플레이트가 많아진다. 추후 `createChannelDock`에 `Partial<ChannelCapabilities>` + defaults 병합 재도입을 권장.

### 2. [설계 변경] registry.ts — CORE_DOCKS 사전 등록 제거, 중복 방어 추가

**스펙:**

- `new Map(CORE_DOCKS)` — discord, http-webhook이 초기부터 등록
- `resetChannelRegistry()` → CORE_DOCKS로 복원
- 중복 등록 허용 (set으로 덮어쓰기)

**구현:**

- 빈 Map 시작 — CORE_DOCKS import 없음
- `resetChannelRegistry()` → 빈 상태로 초기화
- 중복 등록 시 Error throw

**영향:** 서버 부팅 시 CORE_DOCKS를 별도로 등록하는 코드가 필요하다. 현재 이 부팅 로직은 어디에도 없으므로, 통합 단계에서 반드시 작성해야 한다.

**평가:** 중복 방어는 좋은 변경. 그러나 CORE_DOCKS 자동 등록 제거와 reset의 의미 변경은 스펙 의도와 다르다. 나중 레이어에서 "서버 bootstrap 시 CORE_DOCKS 순회 등록" 코드가 추가되어야 스펙 의도가 달성된다.

### 3. [설계 변경] gating — GatingResult/GatingContext 제거, boolean+async 패턴

**스펙:**

- `GatingResult = { allowed: true } | { allowed: false; reason: string }` — 거부 사유 포함
- `GatingContext = { botUserId, commandPrefix }` — 컨텍스트 전달
- `GateFunction(msg, dock, ctx)` — 3인자, 동기

**구현:**

- `Gate = (msg) => boolean | Promise<boolean>` — 1인자, 비동기 허용
- 거부 사유 정보 없음
- 컨텍스트는 팩토리 클로저로 주입 (createMentionGate, createCommandGate)

**영향:**

1. **거부 사유 추적 불가** — 어떤 게이트가 왜 차단했는지 로깅할 수 없다
2. **비동기 도입** — composeGates가 항상 `Promise<boolean>` 반환. 동기 게이트만 쓰더라도 await 필요
3. **팩토리 패턴** — 게이트마다 설정을 클로저로 캡처. 스펙의 "상수 export" 대비 유연하지만 인스턴스 관리 필요

**평가:** 팩토리 패턴 자체는 좋은 설계 선택이나, GatingResult(거부 사유) 누락은 운영 가시성을 저해한다. 최소한 `Gate = (msg) => GatingResult | Promise<GatingResult>`로 확장을 권장.

### 4. [의미론 반전] allowlist.ts — 빈 allowlist의 동작

**스펙:**

```typescript
if (allowlist.size === 0) return { allowed: true }; // 빈 목록 = 모두 허용
```

**구현:**

```typescript
const allowed = new Set(allowedSenderIds); // [] → size 0
return allowed.has(msg.senderId); // size 0 → 항상 false = 모두 차단
```

**테스트도 이 동작을 확인:**

```typescript
it('빈 허용 목록은 모든 메시지를 차단한다', () => {
  const emptyGate = createAllowlistGate([]);
  expect(emptyGate(makeMsg({ senderId: 'anyone' }))).toBe(false);
});
```

**영향:** "allowlist 미설정 = 게이트 비활성"이라는 스펙의 의도가 "allowlist 미설정 = 전부 차단"으로 반전. 실 운용 시 allowlist를 설정하지 않으면 모든 메시지가 차단된다.

**평가:** 보안 관점에서는 deny-by-default가 안전하지만, 스펙과 명시적으로 반대이므로 의도적 변경인지 확인 필요. 혼합 전략 권장: allowlist가 null/undefined면 게이트 비활성, 빈 Set이면 전부 차단.

### 5. [설계 변경] typing.ts — 모듈 상태 → Handle 패턴

**스펙:**

- 모듈 수준 `activeTyping` Map으로 전역 관리
- `startTyping`, `stopTyping`, `stopAllTyping`, `activeTypingCount` 4개 함수
- plugin.id를 key로 사용

**구현:**

- `startTyping` 1개 함수, `TypingHandle { stop() }` 반환
- 전역 상태 없음 — 호출자가 Handle 관리
- `stopAllTyping`, `activeTypingCount` 미존재

**영향:**

1. `stopAllTyping()`이 없으므로 서버 종료 시 모든 타이핑을 일괄 정리할 수 없다
2. Handle 패턴은 GC 친화적이나, shutdown 시 leak 방지를 위해 호출자 측 관리 필요
3. 에러 처리: 스펙은 `.catch(() => {})`, 구현은 `void send(...)` — unhandled rejection 위험

**평가:** Handle 패턴 자체는 더 깔끔한 설계이나, shutdown 시나리오와 에러 무시 처리가 빠져 있다.

### 6. [설계 변경] event-bridge.ts — 호출 패턴 전면 변경

**스펙:**

```typescript
bridgeHookToEvent(hookName: string, payload: unknown): void
// switch(hookName)으로 매핑, 훅 fire 후 수동 호출
```

**구현:**

```typescript
bridgeHooksToEventBus(hooks: { afterAgentRun, onConfigChange, ... }): void
// 각 hook runner에 .tap()으로 구독 등록, 자동 전파
```

**추가 매핑:** `afterAgentRun → agent:run:end` (스펙에 없음)

**평가:** tap 기반 자동 구독이 수동 호출보다 누락 위험이 적다. 더 나은 설계. 함수명만 plugins/index.ts barrel과 일관되면 문제 없음.

### 7. [누락] plugins/index.ts — createPluginBuildApi 미포함

스펙에서 `createPluginBuildApi`를 값으로 export하지만, 구현에서는 `loadPlugins`만 export하고 `createPluginBuildApi`는 type export에도 포함되어 있지 않다.

**영향:** 플러그인이 직접 BuildApi를 생성할 수 없다. `loadPlugins` 내부에서만 사용된다면 문제 없지만, 외부 접근이 필요한 경우 추가 필요.

### 8. [수치 차이] DEFAULT_LIMITS 및 CORE_DOCKS 상수값

| 항목                              | 스펙  | 구현  |
| --------------------------------- | ----- | ----- |
| DEFAULT_LIMITS.maxMediaPerMessage | 0     | 1     |
| DEFAULT_LIMITS.rateLimitPerMinute | 60    | 30    |
| HTTP Webhook maxMessageLength     | 65535 | 65536 |
| HTTP Webhook maxChunkLength       | 65535 | 65536 |
| HTTP Webhook rateLimitPerMinute   | 100   | 120   |
| Discord supportsButtons           | false | true  |

**평가:** 대부분 합리적 조정이나, HTTP Webhook의 65535(0xFFFF)→65536은 off-by-one 의도인지 확인 필요. Discord supportsButtons: true는 Discord API가 실제로 버튼(Components)을 지원하므로 구현이 더 정확.

---

## 테스트 커버리지 비교

| 테스트 파일              | 스펙 케이스 수 | 구현 케이스 수 | 비고                                               |
| ------------------------ | -------------- | -------------- | -------------------------------------------------- |
| dock.test.ts             | 8              | 7              | Object.freeze 독립 테스트 대신 frozen array 테스트 |
| chat-type.test.ts        | 12             | 22             | whisper/room/chat/forum, trim 추가                 |
| gating.test.ts           | 12             | 16             | async 게이트, 통합 테스트 확장                     |
| channel-registry.test.ts | 7              | 10             | 중복 등록 에러, ChannelId 브랜드 테스트 추가       |
| **합계**                 | **39**         | **55**         | 구현이 더 많은 케이스 커버                         |

---

## 전체 평가 요약

구현은 스펙의 **핵심 책임과 기능**을 모두 달성하되, 여러 설계 결정에서 독자적 판단을 적용:

1. **좋은 변경:** 팩토리 패턴(gating), Handle 패턴(typing), tap 자동구독(event-bridge), 중복 등록 방어(registry), 추가 chat-type 매핑
2. **주의 필요:** 빈 allowlist 의미론 반전, GatingResult(거부 사유) 누락, stopAllTyping 부재, void send의 unhandled rejection
3. **통합 시 필요:** CORE_DOCKS 부팅 등록 코드, shutdown 시 typing 정리 로직

typecheck·lint·테스트 모두 통과하므로 현재 상태에서 내부 정합성은 확보됨.

---

## 리팩토링 후보

### R-1. allowlist 빈 목록 의미론 통일

- **위치:** `src/channels/gating/allowlist.ts`
- **내용:** 빈 allowlist(`size === 0`) 시 모두 허용으로 변경하거나, null/undefined = 비활성 vs 빈 Set = 전체 차단으로 2단 구분
- **이유:** 스펙 의도 반전이 운영 사고 유발 가능

### R-2. GatingResult 도입 — 거부 사유 추적

- **위치:** `src/channels/gating/pipeline.ts`, 모든 게이트 파일
- **내용:** `Gate = (msg) => boolean` → `(msg) => GatingResult` 확장, `GatingResult = { allowed: true } | { allowed: false; reason: string }`
- **이유:** 운영 로깅·디버깅에 필수. 어떤 게이트가 왜 차단했는지 추적 불가

### R-3. typing.ts — stopAllTyping 및 에러 처리 추가

- **위치:** `src/channels/typing.ts`
- **내용:** 전역 Handle 트래커 또는 shutdown hook에서 모든 Handle.stop() 호출 보장. `void send(...)` → `.catch(() => {})` 또는 에러 로깅
- **이유:** 서버 종료 시 타이머 leak, unhandled rejection 위험

### R-4. dock.ts — Partial<ChannelCapabilities> 기본값 병합 재도입

- **위치:** `src/channels/dock.ts`
- **내용:** `capabilities` 파라미터를 `Partial<ChannelCapabilities>`로 변경, DEFAULT_CAPABILITIES와 병합
- **이유:** 새 채널 등록 시 보일러플레이트 감소

### R-5. registry.ts — CORE_DOCKS 자동 등록 또는 부팅 함수 제공

- **위치:** `src/channels/registry.ts` 또는 서버 bootstrap
- **내용:** `initCoreChannels()` 함수 추가하여 CORE_DOCKS를 순회 등록, 또는 registry 생성 시 자동 등록
- **이유:** 현재 상태에서는 discord/http-webhook이 자동 등록되지 않음

### R-6. todo-b 빌드 에러 수정

- **위치:** `src/plugins/loader.ts`, `src/plugins/manifest.ts`
- **내용:**
  - loader.ts:140 — `as Record<string, string>` → `as unknown as Record<string, string>` 또는 타입 가드
  - loader.ts:199 — void 표현식 truthiness 체크 수정
  - manifest.ts:37,49 — `ZodErrorTree` → `ZodError` (zod v4 API 변경 대응)
- **이유:** `pnpm build` 실패 — todo-c 범위 외이지만 전체 파이프라인 차단

### R-7. event-bridge.ts — afterAgentRun 매핑 검증

- **위치:** `src/plugins/event-bridge.ts`
- **내용:** 스펙에 없는 `afterAgentRun → agent:run:end` 매핑이 의도적인지 확인. `agent:run:end`는 3번째 인자 `durationMs`를 받는데, 현재 하드코딩 `0` 전달
- **이유:** durationMs=0은 무의미한 데이터. payload에 duration이 없으면 매핑 자체를 제거하거나 payload 확장 필요
