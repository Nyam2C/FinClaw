# Phase 2 Part 3 리뷰

> 리뷰 기준일: 2026-02-26
> 대상: `packages/infra/` — 소스 8개, 테스트 6개, barrel export 1개
> 실제 LOC: 1,306 (예상 ~1,260)

---

## 1. 스펙 대비 구현 일치도

| Task | 파일                      | 스펙 LOC | 실제 LOC | 일치도       | 비고                         |
| ---- | ------------------------- | -------- | -------- | ------------ | ---------------------------- |
| T1   | `dedupe.ts`               | ~65      | 80       | ✅ 완전 일치 |                              |
| T2   | `circuit-breaker.ts`      | ~90      | 75       | ⚠️ 거의 일치 | `halfOpenMaxAttempts` 미사용 |
| T3   | `fs-safe.ts`              | ~90      | 75       | ✅ 완전 일치 |                              |
| T4   | `json-file.ts`            | ~65      | 51       | ✅ 완전 일치 |                              |
| T5   | `gateway-lock.ts`         | ~165     | 148      | ✅ 완전 일치 |                              |
| T6   | `ports.ts`                | ~80      | 60       | ✅ 완전 일치 |                              |
| T7   | `ports-inspect.ts`        | ~100     | 79       | ✅ 완전 일치 |                              |
| T8   | `unhandled-rejections.ts` | ~100     | 109      | ✅ 완전 일치 |                              |
| T9   | 테스트 6개                | ~460     | 523      | ✅ 완전 일치 |                              |
| T10  | `index.ts` barrel         | ~45      | 106      | ✅ 완전 일치 | Part 1+2+3 전체 포함         |

---

## 2. 코드 이슈

### 2-1. `halfOpenMaxAttempts` 선언만 있고 미사용 (circuit-breaker.ts:20-21)

**심각도: 중**

```typescript
// 선언됨
private readonly halfOpenMaxAttempts: number;
// constructor에서 할당됨
this.halfOpenMaxAttempts = opts.halfOpenMaxAttempts ?? 1;
// execute()에서 사용하지 않음 — half-open 상태에서 요청 수 제한 로직 없음
```

half-open 상태에서 허용할 최대 probe 요청 수를 제한해야 하지만, 현재는 아무 제한 없이 모든 요청이 통과한다. 두 가지 해결 방안:

- (A) `halfOpenMaxAttempts`를 활용하는 카운터 로직 추가
- (B) 사용하지 않을 옵션이면 `halfOpenMaxAttempts` 필드와 옵션을 삭제

### 2-2. `gateway-lock.ts` — `fd.write()` vs `fd.writeFile()` (gateway-lock.ts:67)

**심각도: 낮**

```typescript
await fd.write(payload); // 부분 쓰기 가능성
```

`FileHandle.write(string)`는 전체 문자열을 한 번에 쓰는 것이 보장되지 않는다 (이론적으로). 잠금 파일 페이로드가 작아서 실제 문제 가능성은 극히 낮지만, `fd.writeFile(payload)`가 더 안전하다.

---

## 3. 스펙 선행 조건 대비 실제 의존성

스펙 선행 조건 표에서 Part 3이 사용할 것으로 명시된 의존성 검증:

| 선행 조건    | 사용처 (스펙)                    | 실제 사용                                  | 상태                   |
| ------------ | -------------------------------- | ------------------------------------------ | ---------------------- |
| `errors.ts`  | gateway-lock                     | ✅ `GatewayLockError extends FinClawError` | OK                     |
| `errors.ts`  | unhandled-rejections             | ❌ 미사용                                  | 괴리                   |
| `errors.ts`  | ports                            | ✅ `PortInUseError` import                 | OK                     |
| `backoff.ts` | dedupe TTL 참조 패턴             | ❌ 미사용 (독립 구현)                      | 허용 (참조 패턴이므로) |
| `events.ts`  | unhandled-rejections 이벤트 발행 | ❌ 미사용                                  | 괴리                   |
| `paths.ts`   | gateway-lock lockDir 경로 결정   | ❌ 미사용 (파라미터로 받음)                | 허용 (호출자 책임)     |
| `env.ts`     | ports 환경 변수 기반 포트 결정   | ❌ 미사용 (파라미터로 받음)                | 허용 (호출자 책임)     |

**판단**: `paths.ts`, `env.ts` 미사용은 호출자가 주입하는 설계로 합리적.
`events.ts` → `unhandled-rejections` 이벤트 발행 누락은 의도적 단순화인지 확인 필요.

---

## 4. 테스트 커버리지 갭

| 갭  | 대상                      | 스펙 검증 항목                               | 상태                           |
| --- | ------------------------- | -------------------------------------------- | ------------------------------ |
| G1  | `fs-safe.test.ts`         | 심링크에 `readFileSafe` → ELOOP              | ❌ 테스트 없음                 |
| G2  | `fs-safe.test.ts`         | `writeFileAtomic` 퍼미션(mode) 검증          | ❌ 테스트 없음                 |
| G3  | `fs-safe.test.ts`         | 잘못된 JSON → 에러 throw                     | ❌ 테스트 없음                 |
| G4  | `circuit-breaker.test.ts` | `halfOpenMaxAttempts` 동작 검증              | ❌ 테스트 없음 (기능 미구현)   |
| G5  | `ports-inspect`           | `inspectPortOccupant` / `formatPortOccupant` | ❌ 테스트 없음 (스펙상 불필요) |
| G6  | `circuit-breaker.test.ts` | 실제 타이머 사용 (150ms 대기)                | ⚠️ flaky 가능성                |

---

## 5. barrel export (index.ts) 검증

스펙과 구현 완전 일치. Part 1 + Part 2 + Part 3 모든 모듈의 public API를 export.
카테고리별 그룹핑: 에러 → 백오프/재시도 → 유틸 → 컨텍스트 → 환경/설정 → 로깅 → 이벤트 → 네트워크 → 파일시스템 → 프로세스.

---

## 6. 리팩토링 항목

### R1. `CircuitBreaker.halfOpenMaxAttempts` 구현 또는 삭제

**파일**: `packages/infra/src/circuit-breaker.ts`
**내용**: half-open 상태에서 probe 요청 수를 제한하는 카운터를 추가하거나, 사용하지 않는 옵션을 삭제한다.
**이유**: dead code. 옵션이 존재하지만 효과가 없어 사용자를 오도할 수 있다.

### R2. `unhandled-rejections.ts`에 이벤트 발행 추가 검토

**파일**: `packages/infra/src/unhandled-rejections.ts`
**내용**: 스펙 선행 조건에서 `events.ts`를 사용하여 이벤트를 발행한다고 명시했으나 미구현. 필요 시 `getEventBus().emit('unhandledRejection', { level, reason })` 패턴 추가.
**이유**: 스펙 괴리. 옵저버빌리티를 위해 이벤트 발행이 유용할 수 있다.

### R3. `gateway-lock.ts` — `fd.write()` → `fd.writeFile()` 변경

**파일**: `packages/infra/src/gateway-lock.ts:67`
**내용**: `await fd.write(payload)` → `await fd.writeFile(payload)`
**이유**: 이론적 부분 쓰기 방지. 변경 비용 극히 낮음.

### R4. 테스트 보강 — symlink, permissions, malformed JSON

**파일**: `packages/infra/test/fs-safe.test.ts`
**내용**:

- `readFileSafe` symlink → ELOOP 테스트 추가
- `writeFileAtomic` mode 파라미터 검증 테스트 추가
- `readJsonFile` malformed JSON → parse error throw 테스트 추가
  **이유**: 스펙 검증 항목 중 미검증 3건.

### R5. `circuit-breaker.test.ts` fake timers 도입

**파일**: `packages/infra/test/circuit-breaker.test.ts`
**내용**: `vi.useFakeTimers()` + `vi.advanceTimersByTime()`으로 실제 대기 제거.
**이유**: `setTimeout(r, 150)` 기반 테스트는 CI에서 flaky할 수 있다.
