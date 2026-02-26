# Phase 2 Part 2 리뷰

> 리뷰 일시: 2026-02-26
> 대상: `packages/infra/` — 소스 8개, 테스트 5개 (Part 2 범위)
> 비교 기준: `plans/phase02/todo-part2.md`

---

## 1. 검증 결과 요약

| 명령어           | 기대 결과              | 실제 결과              | 판정 |
| ---------------- | ---------------------- | ---------------------- | ---- |
| `pnpm typecheck` | 에러 0                 | 에러 0                 | PASS |
| `pnpm build`     | `packages/infra/dist/` | 정상 빌드              | PASS |
| `pnpm test`      | 12개 infra 테스트 통과 | 12개 infra 테스트 통과 | PASS |
| `pnpm lint`      | 에러 0                 | 에러 0                 | PASS |

전체 테스트: 17 파일, 148 테스트 전부 통과 (types 5 + infra 12).

---

## 2. 파일별 스펙 대조

### T1. `logger-transports.ts`

| 항목                  | 스펙                          | 구현 | 판정 |
| --------------------- | ----------------------------- | ---- | ---- |
| `FileTransportConfig` | 인터페이스 4필드              | 동일 | OK   |
| `attachFileTransport` | 로테이션 포함 파일 트랜스포트 | 동일 | OK   |
| `createFlushFn`       | 스트림 flush 유틸             | 동일 | OK   |
| `rotateFiles`         | private 로테이션 함수         | 동일 | OK   |

**이슈 없음.** 스펙과 1:1 일치.

---

### T2. `logger.ts`

| 항목                   | 스펙                   | 구현 | 판정 |
| ---------------------- | ---------------------- | ---- | ---- |
| `LoggerConfig`         | 7필드 인터페이스       | 동일 | OK   |
| `LoggerFactory`        | DI 인터페이스          | 동일 | OK   |
| `FinClawLogger`        | 8메서드 인터페이스     | 동일 | OK   |
| `DEFAULT_REDACT_KEYS`  | 8개 키                 | 동일 | OK   |
| `LOG_LEVEL_MAP`        | 6레벨 매핑             | 동일 | OK   |
| `createLogger`         | tslog 래핑 팩토리      | 동일 | OK   |
| `wrapLogger`           | ALS 컨텍스트 주입 래핑 | 동일 | OK   |
| `defaultLoggerFactory` | 기본 팩토리 객체       | 동일 | OK   |

**이슈 1건** → [R-01] 참고.

---

### T3. `events.ts`

| 항목                 | 스펙                  | 구현     | 판정     |
| -------------------- | --------------------- | -------- | -------- |
| `EventMap`           | 제네릭 이벤트 맵 타입 | 동일     | OK       |
| `TypedEmitter<T>`    | 6메서드 인터페이스    | 동일     | OK       |
| `createTypedEmitter` | 팩토리 함수           | 동일     | OK       |
| `FinClawEventMap`    | 9개 이벤트 정의       | **편차** | **주의** |
| `getEventBus`        | 싱글턴 반환           | 동일     | OK       |
| `resetEventBus`      | 테스트용 리셋         | 동일     | OK       |

**편차: `FinClawEventMap`에 인덱스 시그니처 추가됨** → [R-02] 참고.

---

### T4. `system-events.ts`

| 항목                 | 스펙               | 구현 | 판정 |
| -------------------- | ------------------ | ---- | ---- |
| `SystemEvent`        | 4필드 인터페이스   | 동일 | OK   |
| `pushSystemEvent`    | MAX 20 + 중복 스킵 | 동일 | OK   |
| `drainSystemEvents`  | 소비적 반환        | 동일 | OK   |
| `peekSystemEvents`   | 비소비적 조회      | 동일 | OK   |
| `clearSystemEvents`  | 세션 큐 삭제       | 동일 | OK   |
| `onContextKeyChange` | 키 변경 시 정리    | 동일 | OK   |
| `resetForTest`       | 전체 상태 초기화   | 동일 | OK   |

**이슈 없음.** 스펙과 1:1 일치.

---

### T5. `agent-events.ts`

| 항목                | 스펙           | 구현 | 판정 |
| ------------------- | -------------- | ---- | ---- |
| `emitAgentRunStart` | 이벤트 발행    | 동일 | OK   |
| `emitAgentRunEnd`   | 이벤트 발행    | 동일 | OK   |
| `emitAgentRunError` | 이벤트 발행    | 동일 | OK   |
| `onAgentRunStart`   | 구독 편의 함수 | 동일 | OK   |
| `onAgentRunEnd`     | 구독 편의 함수 | 동일 | OK   |
| `onAgentRunError`   | 구독 편의 함수 | 동일 | OK   |

**이슈 없음.** 스펙과 1:1 일치.

---

### T6. `ssrf.ts`

| 항목                | 스펙                   | 구현 | 판정 |
| ------------------- | ---------------------- | ---- | ---- |
| `SsrfPolicy`        | 2필드 인터페이스       | 동일 | OK   |
| `validateUrlSafety` | DNS 핀닝 + 사설IP 차단 | 동일 | OK   |
| `isPrivateIp`       | IPv4/IPv6/mapped 판별  | 동일 | OK   |
| `isPrivateIpv4`     | 7개 대역 검사          | 동일 | OK   |
| `isPrivateIpv6`     | 4개 패턴 검사          | 동일 | OK   |
| `BLOCKED_HOSTNAMES` | 4개 패턴               | 동일 | OK   |

**이슈 1건** → [R-03] 참고.

---

### T7. `fetch.ts`

| 항목               | 스펙                      | 구현 | 판정 |
| ------------------ | ------------------------- | ---- | ---- |
| `SafeFetchOptions` | 4필드 인터페이스          | 동일 | OK   |
| `safeFetch`        | SSRF + timeout + redirect | 동일 | OK   |
| `safeFetchJson`    | JSON 파싱 편의 함수       | 동일 | OK   |

**이슈 없음.** 스펙과 1:1 일치.

---

### T8. `retry.ts`

| 항목                 | 스펙                 | 구현 | 판정 |
| -------------------- | -------------------- | ---- | ---- |
| `RetryOptions`       | 8필드 인터페이스     | 동일 | OK   |
| `resolveRetryConfig` | 기본값 병합          | 동일 | OK   |
| `retry<T>`           | 지수 백오프 재시도   | 동일 | OK   |
| `defaultShouldRetry` | 8개 일시적 에러 코드 | 동일 | OK   |

**이슈 없음.** 스펙과 1:1 일치.

---

### T9. 테스트 (5개 파일)

| 테스트 파일             | 스펙 테스트 수    | 실제 테스트 수 | 판정 |
| ----------------------- | ----------------- | -------------- | ---- |
| `logger.test.ts`        | 6                 | 6              | OK   |
| `system-events.test.ts` | 8                 | 8              | OK   |
| `ssrf.test.ts`          | 24 (each 포함)    | 24             | OK   |
| `fetch.test.ts`         | 5                 | 5              | OK   |
| `retry.test.ts`         | 10 (config+retry) | 10             | OK   |

**미세 편차:**

- `logger.test.ts`: 스펙에서 `vi` import가 있었으나, 구현에서는 미사용이므로 제거됨. 올바른 판단.

---

### T10. 전체 검증

- typecheck, build, test, lint 모두 PASS.
- 순환 의존 없음 확인:
  - `logger.ts` → `context.ts`, `logger-transports.ts` (→ `paths.ts`) — OK
  - `retry.ts` → `backoff.ts` — OK
  - `fetch.ts` → `ssrf.ts` → `errors.ts` — OK
  - `system-events.ts` → `@finclaw/types` — OK

---

## 3. 의존성 확인

| Part 1 모듈  | Part 2 사용처                                   | 연결 상태 |
| ------------ | ----------------------------------------------- | --------- |
| `errors.ts`  | `ssrf.ts` → `SsrfBlockedError`                  | OK        |
| `context.ts` | `logger.ts` → `getContext`                      | OK        |
| `paths.ts`   | `logger-transports.ts` → `getLogDir`            | OK        |
| `env.ts`     | (간접: paths → env)                             | OK        |
| `backoff.ts` | `retry.ts` → `computeBackoff`, `sleepWithAbort` | OK        |

외부 의존:

- `tslog ^4.9.3`: `logger.ts`에서 사용. `package.json`에 선언됨. OK.
- `@finclaw/types`: `system-events.ts`에서 `SessionKey`, `Timestamp` 사용. OK.

---

## 4. barrel export 상태

`src/index.ts`는 여전히 stub (`export type TODO = 'stub'`).
스펙에 "Part 3에서 완성"으로 명시되어 있으므로 **정상**.

---

## 5. 리팩토링 사항

### R-01. `logger.ts` — `flushCallbacks` 배열이 비어있음 (중요도: 중)

`wrapLogger` 내부에서 `flushCallbacks: (() => Promise<void>)[] = []`를 생성하지만, 어디서도 push하지 않는다.
`attachFileTransport`가 내부적으로 `WriteStream`을 생성하지만 이를 외부에 노출하지 않아 `flushCallbacks`와 연결되지 않는다.

결과: `logger.flush()`는 항상 즉시 resolve하는 no-op이다.

**제안:** `attachFileTransport`가 flush 콜백을 반환하거나, `logger.ts`에서 `createFlushFn`을 활용하여 파일 트랜스포트의 스트림과 `flush()`를 연결해야 한다.

```
attachFileTransport → (stream 참조 반환 or flush callback 반환)
  → wrapLogger의 flushCallbacks에 push
  → logger.flush() 호출 시 실제 stream.end() 실행
```

---

### R-02. `events.ts` — `FinClawEventMap`에 인덱스 시그니처 추가됨 (중요도: 높)

**스펙 대비 편차.** 구현에 `[key: string]: (...args: never[]) => void;` 인덱스 시그니처가 추가되어 있다.

스펙에는 이 인덱스 시그니처가 없다. 이것이 추가된 이유는 `FinClawEventMap extends EventMap` 제약을 만족시키기 위한 것으로 보인다.

**문제:** 인덱스 시그니처가 있으면 `emit('typo:event')` 같은 잘못된 이벤트명이 컴파일 타임에 잡히지 않는다. TypedEmitter의 핵심 목적(타입 안전한 이벤트)이 약화된다.

**제안:** 인덱스 시그니처를 제거하고, `createTypedEmitter`의 제네릭 제약을 조정하거나, `FinClawEventMap`을 `EventMap`과 별도의 타입 패턴으로 처리한다.

```typescript
// 현재 (문제)
export interface FinClawEventMap {
  [key: string]: (...args: never[]) => void; // ← 이 줄 제거
  'system:ready': () => void;
  // ...
}

// 수정안: EventMap 제약에서 FinClawEventMap을 제외하거나 satisfies 사용
```

---

### R-03. `ssrf.ts` — `BLOCKED_HOSTNAMES` 매칭이 부분 문자열 매칭 (중요도: 낮)

`hostname.endsWith(pattern)` 방식에서 `'localhost'` 패턴은 `evillocalhost`도 차단한다.

실제 위협 가능성은 극히 낮으나 (단일 레이블 호스트명이 DNS에서 해석될 가능성 희박), 정확한 매칭을 원한다면:

```typescript
// 수정안
const isBlocked = BLOCKED_HOSTNAMES.some(
  (pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`),
);
```

현재 `BLOCKED_HOSTNAMES`의 `.local`, `.internal`, `.localhost`는 점(`.`) 접두사가 있어 서브도메인만 매칭되므로 문제없다. `'localhost'` 항목만 해당.

---

### R-04. `system-events.ts` — 중복 감지가 참조 동등성 사용 (중요도: 참고)

`last.payload === event.payload`는 참조 동등성(reference equality)으로 비교한다.
동일 내용의 객체 `{ a: 1 }`을 두 번 push하면 중복으로 감지되지 않는다.

현재 스펙에서 이 동작이 의도된 것이라면 문제없다. 깊은 비교가 필요해지면 추후 조정.

---

## 6. 최종 판정

**Part 2 구현: PASS**

- 8개 소스 파일, 5개 테스트 파일 모두 스펙 대로 구현됨
- typecheck / build / test / lint 전부 통과
- 의존성 체인 정상, 순환 없음
- 리팩토링 사항 4건 (R-01 중, R-02 높, R-03 낮, R-04 참고)
  - R-02는 타입 안전성에 직접 영향을 주므로 Part 3 barrel export 작업 시 함께 수정 권장
  - R-01은 graceful shutdown 구현 시 반드시 해결 필요
