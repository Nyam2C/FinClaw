# Phase 4 구현 리뷰

## Context

`plans/phase04/todo.md`에 정의된 7-Step 구현 계획 대비 실제 코드를 리뷰한다.
대상: `packages/infra/src/concurrency-lane.ts`, `packages/server/src/process/*`, 관련 테스트 전체.

---

## 1. todo.md 대비 구현 완료 상태

| Step | 범위                                 | 상태 | 비고                                                       |
| ---- | ------------------------------------ | ---- | ---------------------------------------------------------- |
| 1    | ConcurrencyLane (infra)              | 완료 | todo.md 코드와 1:1 일치                                    |
| 2    | server 패키지 설정 + errors + barrel | 완료 | package.json, tsconfig.json, errors.ts, index.ts 모두 반영 |
| 3    | spawn, signal-handler, lifecycle     | 완료 | todo.md 코드와 일치                                        |
| 4    | session-key, binding-matcher         | 완료 | todo.md 코드와 일치                                        |
| 5    | message-queue, debounce              | 완료 | collect 모드 윈도우 로직 포함                              |
| 6    | message-router                       | 완료 | todo.md 교정사항 #1 (startedAt) 반영 확인                  |
| 7    | 통합 테스트                          | 완료 | 6개 테스트 케이스                                          |

**파일 수 검증:** 소스 14개 + 테스트 7개 = todo.md 명세와 일치 (debounce 테스트 없음 — todo.md에도 미포함)

---

## 2. 모듈별 리뷰

### 2-1. ConcurrencyLane (`packages/infra/src/concurrency-lane.ts`)

**정상 구현:**

- Generation counter 패턴으로 stale release 무효화
- Promise 기반 대기열 (FIFO dequeue)
- 키별 독립 동시성 카운터
- 타임아웃 / 큐 오버플로우 에러 처리
- ConcurrencyLaneManager 3-Lane 통합 관리

**이슈:**

| #   | 심각도 | 위치                  | 내용                                                                                                                                                                                                                              |
| --- | ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-1 | Medium | `release()` L93-111   | waiter에게 slot을 넘겨줄 때 `active` count를 감소시키지 않는다. 즉 waiter가 resolve되면 실질적으로 active가 1 증가한 상태로 유지된다. 이는 **의도된 동작** (waiter가 slot을 "이어받는" 것)이지만, 주석이 없어 의도 파악이 어렵다. |
| I-2 | Low    | `removeWaiter()` L136 | `waiter as (typeof queue)[number]` 캐스트 — `unknown`에서의 복원. 실제로는 같은 객체 참조이므로 동작하지만, 제네릭 없이 `unknown`을 받는 이유가 불분명.                                                                           |

**테스트 커버리지:** 양호 — 기본 acquire/release, 큐 오버플로우, generation reset, clearWaiters, dispose, 키 독립성, Manager. **미커버:** 타임아웃 만료 시나리오.

---

### 2-2. errors.ts (`packages/server/src/process/errors.ts`)

**정상:** FinClawError 확장 패턴 준수. code는 SCREAMING_SNAKE_CASE, details 구조체 포함.

이슈 없음.

---

### 2-3. spawn.ts (`packages/server/src/process/spawn.ts`)

**정상 구현:**

- `AbortSignal.timeout()` + `AbortSignal.any()` 합성
- SIGTERM → 2초 유예 → SIGKILL 패턴
- stdout/stderr maxBuffer 제한
- timedOut / aborted 분리 보고

**이슈:**

| #   | 심각도 | 위치     | 내용                                                                                                                                                                                                                                                                                                                            |
| --- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1 | Medium | L87      | `combinedSignal` abort 리스너가 child `'close'` 이후에도 남을 수 있다. `{ once: true }`이므로 메모리 누수는 아니지만, 이미 종료된 프로세스에 `gracefulKill`을 시도할 수 있다. `child.killed` 체크가 `gracefulKill` 내에 없으므로 (SIGTERM 전), 이미 종료된 프로세스에 SIGTERM을 보내게 된다. 실해(害)는 없지만 불필요한 시그널. |
| S-2 | Low    | L71-80   | maxBuffer 초과 시 조용히 truncate — 로깅이나 `truncated` 플래그가 없다. 디버깅 시 출력이 잘려있는지 알 수 없다.                                                                                                                                                                                                                 |
| S-3 | Low    | L103-105 | `error` 이벤트에서 reject하지만, child 프로세스가 아직 실행 중일 수 있다. `gracefulKill`을 호출하지 않는다.                                                                                                                                                                                                                     |

**테스트 커버리지:** 양호 — 정상 실행, 존재하지 않는 명령, 타임아웃, 외부 AbortSignal, stdin, exitCode, durationMs.

---

### 2-4. signal-handler.ts (`packages/server/src/process/signal-handler.ts`)

**정상:** 이중 시그널 방어, 30초 타임아웃, 순차 정리, 에러 내성.

이슈 없음.

---

### 2-5. lifecycle.ts (`packages/server/src/process/lifecycle.ts`)

**정상:** LIFO 정리 순서, 단일 초기화 가드, 수동 shutdown 지원.

**이슈:**

| #   | 심각도 | 위치         | 내용                                                                                                                                                                                                                   |
| --- | ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L-1 | Medium | `init()` L39 | `setupGracefulShutdown`에 현재 시점의 `cleanupFns` 스냅샷을 전달한다. `init()` 이후에 `register()`로 추가된 정리 함수는 시그널 핸들러에 반영되지 않는다. `shutdown()`은 항상 최신 배열을 사용하므로 불일치가 발생한다. |

---

### 2-6. session-key.ts (`packages/server/src/process/session-key.ts`)

**정상:** agent-scoped 키 형식, normalize 함수, classify/parse 유틸.

**이슈:**

| #   | 심각도 | 위치                                                 | 내용                                                                                                                                                       |
| --- | ------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K-1 | Low    | `normalizeChatId` L94-96                             | `/@[a-z.]+$/` — 소문자만 매칭. `@Domain.Com` 같은 대문자 도메인은 제거되지 않는다. `normalizeChannelId`는 toLowerCase를 하지만 chatId에는 적용하지 않는다. |
| K-2 | Low    | `deriveRoutingSessionKey` L59-64 (message-router.ts) | `accountId` 파라미터에 `msg.senderId`를 전달하지만, 키 생성에는 `accountId`가 사용되지 않는다 (키에 포함되지 않음). 무의미한 전달.                         |

**테스트 커버리지:** 우수 — 10개 테스트, 정규화, 결정성, classify, parse 모두 커버.

---

### 2-7. binding-matcher.ts (`packages/server/src/process/binding-matcher.ts`)

**정상:** 4계층 매칭 (peer > channel > account > default), priority 정렬, chatType 필터.

**이슈:**

| #   | 심각도   | 위치                         | 내용                                                                                                                                                                                                                                                     |
| --- | -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | **High** | L67-69                       | **account 계층 매칭이 accountId 값을 비교하지 않는다.** `rule.accountId`가 존재하기만 하면 무조건 매칭된다. `rule.accountId === msg.senderId` (또는 별도 accountId 필드) 비교가 필요하다. 현재는 accountId가 있는 첫 번째 규칙이 모든 메시지를 가로챈다. |
| B-2 | Low      | `extractBindingRules` L83-97 | `agentDir`가 있는 에이전트만 추출하며, `priority: 10` 고정, `channelId`/`senderId`/`accountId` 미추출. 설정에서 바인딩 규칙을 완전히 추출하지 못한다. 현재 Phase에서는 기본 동작으로 충분하나, Phase 8에서 확장 필요.                                    |

**테스트 커버리지:** 양호하나, B-1 버그를 검출하지 못하는 테스트가 있다 (account 테스트가 값 불일치 케이스를 검증하지 않음).

---

### 2-8. message-queue.ts (`packages/server/src/process/message-queue.ts`)

**정상:** 4종 모드 (queue, followup, interrupt, collect), 드롭 정책, 우선순위 삽입, idle purge, 처리 상태 추적.

**이슈:**

| #   | 심각도 | 위치                           | 내용                                                                                                                                                                                   |
| --- | ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-1 | Medium | `enqueue` collect 모드 L96-108 | collect 윈도우 타이머가 만료되어도 콜백이 비어있다 (L101-104). `isCollectReady()`로 외부 폴링해야 하지만, MessageRouter에 폴링 로직이 없다. collect 모드가 실질적으로 동작하지 않는다. |
| Q-2 | Low    | L88                            | 우선순위 삽입이 `findIndex` O(n) — 큐 크기 50이면 무시할 수 있으나, 주석으로 한계를 명시하면 좋겠다.                                                                                   |
| Q-3 | Info   | L16-17                         | `steer`, `steer-backlog` 타입만 정의, 구현 없음 — Phase 8 예약으로 문서화됨.                                                                                                           |

**테스트 커버리지:** 우수 — 24개 테스트, 모든 모드 및 edge case 커버.

---

### 2-9. debounce.ts (`packages/server/src/process/debounce.ts`)

**정상:** Dual-timer 전략 (window + maxWait), 키별 독립, destroy 정리.

**이슈:**

| #   | 심각도 | 위치       | 내용                                                                                                                                                                                 |
| --- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1 | Medium | `fire` L44 | `void handler(key, value)` — handler rejection이 무시된다. unhandled rejection은 Node.js에서 프로세스 종료를 유발할 수 있다 (Node 15+). `.catch(logger.error)` 같은 처리가 필요하다. |
| D-2 | Info   | —          | 테스트 파일 없음. todo.md에도 debounce 테스트는 미포함.                                                                                                                              |

---

### 2-10. message-router.ts (`packages/server/src/process/message-router.ts`)

**정상:** 10단계 파이프라인 오케스트레이션, Dedupe/EventBus/ALS/ConcurrencyLane 통합, AbortController 관리, finally cleanup chain.

**이슈:**

| #   | 심각도 | 위치 | 내용                                                                                                                                                                                                       |
| --- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | Medium | L122 | `laneId: LaneId = 'main'` 하드코딩 — 모든 메시지가 main 레인으로만 간다. cron/subagent 레인이 사용되지 않는다. 현재 Phase에서는 의도적이나 TODO 주석이 없다.                                               |
| R-2 | Medium | L50  | `new MessageQueue({ mode: 'queue', maxSize: 50 })` — 큐 모드가 생성자에서 고정. 세션별/에이전트별 다른 모드를 사용할 수 없다. 현재 Phase에서는 의도적이나, Phase 8에서 구조 변경 필요.                     |
| R-3 | Low    | L176 | `provider: msg.channelId as string` — provider 필드에 channelId를 그대로 사용. 실제 provider는 'discord', 'slack' 등의 플랫폼 식별자여야 하나, channelId는 'discord' 같은 값이 들어오므로 현재는 동작한다. |
| R-4 | Low    | L180 | `accountId: msg.senderId` — accountId에 senderId를 매핑. 실제 accountId는 별도 필드일 수 있으나, 현재 InboundMessage에 accountId 필드가 없으므로 senderId로 대체.                                          |
| R-5 | Low    | L148 | `void this.processNext(sessionKey, match)` — 큐 체인에서 이전 match를 재사용한다. 큐에 다른 세션의 메시지가 있을 수 없으므로 현재는 맞지만, 같은 세션이라도 다른 바인딩 매칭이 필요할 수 있다.             |

**테스트 커버리지:** 기본 — 4개 테스트 (라우팅, dedupe, EventBus, dispose abort). **미커버:** 큐 체인 (다중 메시지), 레인 acquire 실패, interrupt 모드 동작.

---

## 3. 패턴 준수 평가

| 패턴                      | 준수 여부 | 비고                                                |
| ------------------------- | --------- | --------------------------------------------------- |
| FinClawError 확장         | O         | code, details, name 모두 설정                       |
| EventBus singleton        | O         | `getEventBus().emit()` 사용                         |
| ALS (runWithContext)      | O         | requestId + startedAt 전달                          |
| Dedupe 활용               | O         | 5s TTL, check → execute 패턴                        |
| Branded type (SessionKey) | O         | `createSessionKey()` 팩토리, `as string` 캐스트     |
| 파일명 kebab-case         | O         | 전체 준수                                           |
| Barrel export 그룹화      | O         | 카테고리별 한글 주석                                |
| 테스트 패턴 (vitest)      | O         | describe/it, vi.fn(), 한글 테스트명                 |
| DI (생성자 주입)          | O         | MessageRouterDeps 인터페이스                        |
| dispose 패턴              | O         | AbortController abort + lane dispose + dedupe clear |

---

## 4. 종합 평가

**잘된 점:**

- todo.md 대비 구현 충실도 높음 (코드 거의 1:1 일치)
- 기존 infra 패턴 (FinClawError, EventBus, Dedupe, ALS) 잘 활용
- Generation counter 패턴으로 stale release 방어
- AbortSignal 합성 (timeout + external)이 모던하고 정확
- 에러 내성 (try-catch-finally, 에러 로깅 후 계속 진행)
- LIFO cleanup 순서

**개선 필요:**

- **B-1 (High):** account 계층 매칭 버그 — 값 비교 누락
- **Q-1 (Medium):** collect 모드 실질 미동작 (폴링/콜백 부재)
- **D-1 (Medium):** debounce handler rejection 미처리
- **L-1 (Medium):** lifecycle init 후 register된 함수가 시그널 핸들러에 반영 안 됨

---

## 5. 리팩토링 후보

| #    | 범위                           | 파일                                                  | 내용                                                                                                           | 시점                              |
| ---- | ------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| RF-1 | binding-matcher.ts L67-69      | `packages/server/src/process/binding-matcher.ts`      | account 계층: `rule.accountId === msg.accountId` (또는 senderId) 값 비교 추가. 테스트에 값 불일치 케이스 추가. | 즉시 (버그)                       |
| RF-2 | message-queue.ts collect 모드  | `packages/server/src/process/message-queue.ts`        | collect 타이머 만료 시 콜백 호출 메커니즘 추가, 또는 MessageRouter에서 폴링 로직 구현.                         | Phase 8 또는 collect 모드 사용 시 |
| RF-3 | debounce.ts L44                | `packages/server/src/process/debounce.ts`             | `void handler()` → `handler().catch(onError)` 패턴으로 변경. `onError` 콜백을 `createDebouncer` 옵션으로 추가. | 즉시                              |
| RF-4 | lifecycle.ts L39               | `packages/server/src/process/lifecycle.ts`            | `setupGracefulShutdown`에 배열 참조 대신 getter 함수를 전달하여, 시그널 발생 시점에 최신 배열을 읽도록 변경.   | 즉시                              |
| RF-5 | message-router.ts L122         | `packages/server/src/process/message-router.ts`       | laneId를 BindingMatch 또는 config에서 도출하도록 변경. TODO 주석이라도 추가.                                   | Phase 8                           |
| RF-6 | session-key.ts normalizeChatId | `packages/server/src/process/session-key.ts`          | `/@[a-z.]+$/` → `/@[a-zA-Z.]+$/i` 또는 `toLowerCase()` 추가.                                                   | 낮은 우선순위                     |
| RF-7 | message-router.ts 테스트 보강  | `packages/server/test/process/message-router.test.ts` | 큐 체인, 레인 acquire 실패, interrupt 모드 테스트 추가.                                                        | 다음 Phase 전                     |
| RF-8 | debounce 테스트 추가           | `packages/server/test/process/`                       | debounce.test.ts 신규 작성 (window reset, maxWait, flush, destroy).                                            | 다음 Phase 전                     |
