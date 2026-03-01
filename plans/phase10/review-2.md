# Phase 10 — Todo 2 Review

> **검증 시점**: 2026-03-01
> **대상 브랜치**: `feature/gateway-server`
> **명세**: `plans/phase10/todo-2.md`

---

## 1. 검증 결과 요약

| 검증 항목                      | 결과                |
| ------------------------------ | ------------------- |
| `tsgo --noEmit`                | **PASS** — 에러 0개 |
| `index.test.ts` (15 tests)     | **PASS**            |
| `rate-limit.test.ts` (7 tests) | **PASS**            |
| `connection.test.ts` (9 tests) | **PASS**            |
| 전체 테스트 (31 tests)         | **PASS**            |

---

## 2. 파일별 명세 대조

### 2.1 소스 파일 (6개)

| #   | 파일                         | 판정     | 비고                                                                        |
| --- | ---------------------------- | -------- | --------------------------------------------------------------------------- |
| 1   | `gateway/auth/api-key.ts`    | **PASS** | SHA-256 해시 + `timingSafeEqual`. 명세와 동일                               |
| 2   | `gateway/auth/token.ts`      | **PASS** | HS256 JWT 검증. `Permission[]` 캐스트 — 명세의 구현 노트 권고 반영          |
| 3   | `gateway/auth/rate-limit.ts` | **PASS** | IP별 실패 추적, 윈도우 기반 차단/해제. 명세와 동일                          |
| 4   | `gateway/auth/index.ts`      | **PASS** | Bearer > X-API-Key > none 우선순위 디스패치. 명세와 동일                    |
| 5   | `gateway/ws/heartbeat.ts`    | **PASS** | ping/pong 하트비트. 명세의 미사용 변수 `deadline` 올바르게 제거             |
| 6   | `gateway/ws/connection.ts`   | **PASS** | 핸드셰이크 타임아웃, 인증, RPC 디스패치, pong 기록, close 정리. 명세와 동일 |

### 2.2 테스트 파일 (3개)

| #   | 파일                              | 판정     | 비고                                                                            |
| --- | --------------------------------- | -------- | ------------------------------------------------------------------------------- |
| 1   | `gateway/auth/index.test.ts`      | **PASS** | Auth Chain 6개 + validateApiKey 3개 + validateToken 6개 = 15 tests. 명세와 동일 |
| 2   | `gateway/auth/rate-limit.test.ts` | **PASS** | 7 tests. 차단/해제/윈도우 리셋/size/clear. 명세와 동일                          |
| 3   | `gateway/ws/connection.test.ts`   | **PASS** | WebSocket 7개 + sendNotification 2개 = 9 tests. 명세와 동일                     |

---

## 3. 발견된 문제점

### 3.1 `rate-limit.test.ts` — fake timer 미복원 (minor)

`vi.useFakeTimers()` 호출 후 `vi.useRealTimers()`를 호출하지 않음. 후속 테스트에서 `Date.now()`가 고정된 상태로 실행될 수 있음.

- **영향**: 현재 테스트에서는 시간 의존 로직이 후반 테스트(`size`, `clear`)에 없어서 실패하지 않지만, 향후 테스트 추가 시 혼란 가능.
- **수정**: `afterEach(() => { vi.useRealTimers(); })` 추가.

### 3.2 `connection.test.ts` — fake timer 미복원 (minor)

`handshake timeout` 테스트에서 동일한 문제. `vi.useFakeTimers()` 호출 후 복원 없음.

### 3.3 `connection.test.ts` — handshake timeout 테스트 검증 부족 (minor)

테스트 내 주석에서도 인정하듯이, `authenticate()`가 동기적으로 즉시 resolve하므로 실제 4008 close가 발생하지 않음. 타임아웃 메커니즘이 "설정됨"만 확인하고, "동작함"은 검증하지 못함.

---

## 4. 포매터 정렬 차이 (참고)

모든 파일에서 import 문 순서가 명세와 다르다. `oxfmt`가 import를 알파벳순으로 재정렬하기 때문이며, 기능 차이는 없다. 파일 상단의 `// packages/server/src/gateway/...` 주석 위치도 포매터에 의해 import 사이로 이동되었다.

---

## 5. 설계 노트

| 항목                      | 현재 상태                                                  | 비고                                                                             |
| ------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `AuthRateLimiter` 통합    | export만 되고 `authenticate()`에서 미사용                  | HTTP/WS 미들웨어 레벨에서 사용 예정으로 추정                                     |
| `heartbeatTimeoutMs`      | config에 존재하나 실제 로직에서 미참조                     | `isAlive` 플래그 기반 체크가 interval 간격과 1:1 동작. 별도 타임아웃 로직 불필요 |
| pong 핸들러 이중 등록     | `attachPongHandler`(isAlive) + `connection.ts`(lastPongAt) | 역할이 다르므로 의도적. 통합 가능하나 현재도 정상 동작                           |
| `permissions` 런타임 검증 | JWT payload를 `Permission[]`로 캐스트만 수행               | 외부 입력이므로 유효성 검증 추가 고려 가능                                       |

---

## 6. 리팩토링 권고

1. **fake timer 복원 추가**: `rate-limit.test.ts`, `connection.test.ts` 모두 `afterEach(() => vi.useRealTimers())` 필요
2. **`permissions` 런타임 검증**: `token.ts`에서 `payload.permissions` 각 요소가 유효한 `Permission`인지 필터링/검증 후 캐스트 권장. 현재는 악의적 JWT가 임의 문자열을 permissions에 삽입 가능
3. **handshake timeout 테스트 보강**: `authenticate`를 `vi.mock`하여 지연시킨 후 실제 4008 close 발생 검증 가능. 현재 테스트는 타임아웃 "설정" 확인에 그침
