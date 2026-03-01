# Phase 10 — Todo 3 Review

> **검증 시점**: 2026-03-01
> **대상 브랜치**: `feature/gateway-server`
> **명세**: `plans/phase10/todo-3.md`

---

## 1. 파일 수 확인

| 구분     | 명세 | 구현 | 판정     |
| -------- | ---- | ---- | -------- |
| 소스     | 9    | 9    | **PASS** |
| 테스트   | 6    | 6    | **PASS** |
| **합계** | 15   | 15   | **PASS** |

---

## 2. 소스 파일별 명세 대조

### 2.1 `gateway/registry.ts` (Part 1 스텁 → 전체 교체)

| 항목                         | 판정     | 비고                                    |
| ---------------------------- | -------- | --------------------------------------- |
| `startSession` 중복 방지     | **PASS** | 동일 connectionId running 체크          |
| `AbortSignal.timeout` TTL    | **PASS** | 세션별 TTL 시그널 생성                  |
| `stopSession` abort + 이벤트 | **PASS** | `session_completed` 이벤트 + durationMs |
| `cleanup()` 60초 주기        | **PASS** | `setInterval(60_000)`                   |
| `dispose()` 리소스 해제      | **PASS** | `clearInterval` + `abortAll`            |
| `on()` 이벤트 리스너         | **PASS** | `EventEmitter` 기반, 해제 함수 반환     |
| 명세 코드와 일치             | **PASS** | 라인 단위 동일                          |

### 2.2 `gateway/broadcaster.ts` (Part 1 스텁 → 전체 교체)

| 항목                      | 판정     | 비고                                                                           |
| ------------------------- | -------- | ------------------------------------------------------------------------------ |
| StreamEvent import 경로   | **DIFF** | 명세: `@finclaw/agent/execution/streaming`, 구현: `@finclaw/agent` (동일 타입) |
| text_delta 150ms 배치     | **PASS** | `bufferDelta` + `setTimeout(150)`                                              |
| tool_use_start/end 즉시   | **PASS** | `sendImmediate` 직접 호출                                                      |
| done/error 시 delta flush | **PASS** | `flushDelta` 후 `sendImmediate`                                                |
| slow consumer 보호        | **PASS** | `bufferedAmount > 1MB` + `readyState !== OPEN` 체크                            |
| `broadcastShutdown`       | **PASS** | `sendImmediate` 재사용으로 기존 스텁 대비 간결화                               |
| `flushAll` shutdown용     | **PASS** | 타이머 해제 + Map 클리어                                                       |
| 무시 이벤트               | **PASS** | state_change, message_complete, usage_update — switch default fall-through     |

### 2.3 `gateway/rpc/methods/chat.ts`

| 항목                             | 판정     | 비고                                      |
| -------------------------------- | -------- | ----------------------------------------- |
| chat.start (token, agentId)      | **PASS** | TODO 주석 + throw로 stub 표시             |
| chat.send (session, idempotency) | **PASS** | schema에 idempotencyKey optional 포함     |
| chat.stop (session)              | **PASS** | 명세와 동일                               |
| chat.history (token, pagination) | **PASS** | `limit: z.number().int().min(1).max(100)` |
| `registerChatMethods` export     | **PASS** | 4개 메서드 일괄 등록                      |

### 2.4 `gateway/rpc/methods/finance.ts`

| 항목                            | 판정     | 비고                           |
| ------------------------------- | -------- | ------------------------------ |
| finance.quote (symbol)          | **PASS** | throw 'Not implemented' 스텁   |
| finance.news (query, symbols)   | **PASS** | 양방 optional                  |
| finance.alert.create (3 fields) | **PASS** | symbol + condition + threshold |
| finance.alert.list (symbol?)    | **PASS** | optional symbol 필터           |
| finance.portfolio.get (empty)   | **PASS** | `z.object({})`                 |
| `registerFinanceMethods` export | **PASS** | 5개 메서드 일괄 등록           |

### 2.5 `gateway/rpc/methods/session.ts`

| 항목                            | 판정     | 비고                 |
| ------------------------------- | -------- | -------------------- |
| session.get (sessionId)         | **PASS** | throw stub           |
| session.reset (sessionId)       | **PASS** | throw stub           |
| session.list (empty)            | **PASS** | throw stub           |
| `registerSessionMethods` export | **PASS** | 3개 메서드 일괄 등록 |

### 2.6 `gateway/rpc/methods/agent.ts`

| 항목                   | 판정     | 비고                                           |
| ---------------------- | -------- | ---------------------------------------------- |
| agent.status (agentId) | **PASS** | 스텁 응답 반환 (idle, 0)                       |
| agent.list (empty)     | **PASS** | `{ agents: [] }` 반환                          |
| agent.run (agentId)    | **PASS** | 명세의 "agent.capabilities" → `agent.run` 등록 |
| `registerAgentMethods` | **PASS** | 3개 메서드 일괄 등록                           |

### 2.7 `gateway/server.ts`

| 항목                      | 판정     | 비고                                                      |
| ------------------------- | -------- | --------------------------------------------------------- |
| 6개 메서드 그룹 등록      | **PASS** | system, config, chat, finance, session, agent             |
| HTTP/HTTPS 분기           | **PASS** | `config.tls` 존재 시 `createHttpsServer`                  |
| WebSocket maxPayload      | **PASS** | `config.ws.maxPayloadBytes`                               |
| DI 컨테이너 (ctx)         | **PASS** | `GatewayServerContext` 생성                               |
| 연결 수 제한 (1013)       | **PASS** | `ctx.connections.size >= maxConnections`                  |
| `start()` listen + event  | **PASS** | `gateway:start` 이벤트 발행                               |
| `stop()` 6단계 shutdown   | **PASS** | abort → broadcast → flush → drain → ws close → http close |
| `GatewayServer` interface | **PASS** | httpServer, wss, ctx, start, stop                         |

### 2.8 `gateway/index.ts`

| 항목        | 판정     | 비고                                                             |
| ----------- | -------- | ---------------------------------------------------------------- |
| 배럴 export | **PASS** | server, context, types, errors, registry, broadcaster, auth, rpc |

### 2.9 `main.ts` (기존 스텁 교체)

| 항목                   | 판정     | 비고                                       |
| ---------------------- | -------- | ------------------------------------------ |
| defaultConfig 설정     | **PASS** | port 3000, JWT 환경변수, 30분 TTL          |
| ProcessLifecycle 연동  | **PASS** | `register(() => gateway.stop())`           |
| assertPortAvailable    | **PASS** | 시작 전 포트 확인                          |
| graceful shutdown 연결 | **PASS** | lifecycle.init() → lifecycle이 시그널 처리 |
| system:ready 이벤트    | **PASS** | 서버 시작 후 발행                          |
| 에러 핸들링            | **PASS** | `.catch` → `process.exit(1)`               |

---

## 3. 테스트 파일별 명세 대조

### 3.1 `gateway/registry.test.ts`

| 항목                    | 판정     | 비고                                          |
| ----------------------- | -------- | --------------------------------------------- |
| startSession 4개 테스트 | **PASS** | 생성, count, 중복 거부, 이벤트                |
| stopSession 4개 테스트  | **PASS** | 성공, 미존재, abort, 이벤트                   |
| getSession/listSessions | **PASS** | 3개 테스트                                    |
| abortAll                | **PASS** | 전체 abort + clear                            |
| TTL expiry              | **PASS** | fake timer로 61초 후 cleanup 확인             |
| dispose                 | **PASS** | timer clear + abort 확인                      |
| fake timer 복원         | **PASS** | TTL 테스트 내부에서 `vi.useRealTimers()` 호출 |
| 명세 코드와 일치        | **PASS** | 동일                                          |

### 3.2 `gateway/broadcaster.test.ts`

| 항목                       | 판정     | 비고                                     |
| -------------------------- | -------- | ---------------------------------------- |
| text_delta 배치 (2 tests)  | **PASS** | 150ms 배치 + done 시 flush               |
| immediate events (3 tests) | **PASS** | tool_start, tool_end, error+flush        |
| ignored events (2 tests)   | **PASS** | state_change, usage_update               |
| slow consumer (2 tests)    | **PASS** | bufferedAmount, readyState               |
| broadcastShutdown (1 test) | **PASS** | 다수 연결에 system.shutdown              |
| afterEach vi.useRealTimers | **추가** | 명세에 없으나 review-2 권고 반영. 올바름 |

### 3.3 `gateway/rpc/methods/chat.test.ts`

| 항목                     | 판정     | 비고                                     |
| ------------------------ | -------- | ---------------------------------------- |
| schema validation (4)    | **PASS** | start, send×2, history limit 범위        |
| auth requirements (2)    | **PASS** | start→token, send→session                |
| resetEventBus beforeEach | **추가** | 명세에 없으나 테스트 격리에 필요. 올바름 |

### 3.4 `gateway/rpc/methods/finance.test.ts`

| 항목                  | 판정     | 비고                          |
| --------------------- | -------- | ----------------------------- |
| schema validation (2) | **PASS** | quote, alert.create 필수 필드 |
| auth requirements (1) | **PASS** | quote → token 레벨            |
| stub behavior (3)     | **PASS** | quote, news, portfolio.get    |

### 3.5 `gateway/rpc/methods/session.test.ts`

| 항목                  | 판정     | 비고                             |
| --------------------- | -------- | -------------------------------- |
| schema validation (2) | **PASS** | get, reset → sessionId 필수      |
| session.list (1)      | **PASS** | empty params 수용, stub INTERNAL |
| auth requirements (1) | **PASS** | get → token 레벨                 |

### 3.6 `gateway/server.test.ts`

| 항목                  | 판정     | 비고                                        |
| --------------------- | -------- | ------------------------------------------- |
| 서버 생성 검증        | **PASS** | httpServer, wss, ctx 존재 확인              |
| start + port 할당     | **PASS** | port 0 → OS 자동 할당                       |
| stop graceful         | **PASS** | listening === false 확인                    |
| GET /health           | **PASS** | status: ok 응답 확인                        |
| POST /rpc system.ping | **PASS** | pong: true 확인                             |
| timeout 15_000        | **PASS** | drain 5초 대기 고려                         |
| beforeEach 추가       | **추가** | `clearMethods()` + `resetEventBus()` 초기화 |

---

## 4. 포매터 정렬 차이 (참고)

review-2와 동일하게, `oxfmt`에 의한 import 순서 재정렬과 파일 상단 주석 위치 이동이 전 파일에 걸쳐 발생. 기능 차이 없음.

---

## 5. 발견된 문제점

### 5.1 `broadcaster.ts` — StreamEvent import 경로 차이 (cosmetic)

- **명세**: `import type { StreamEvent } from '@finclaw/agent/execution/streaming'`
- **구현**: `import type { StreamEvent } from '@finclaw/agent'`
- **영향**: `@finclaw/agent` 패키지 루트에서 re-export하면 동일. 현재 패키지 구조에서 정상 동작하면 문제 없음.

### 5.2 `server.ts` — `stop()` 5초 무조건 대기 (minor)

`stop()` 내부 4번째 단계에서 `await new Promise((resolve) => setTimeout(resolve, 5_000))`로 항상 5초를 대기한다. 연결이 0개여도 5초 소비. 테스트에서 `server.test.ts`의 "stops gracefully" 케이스가 매번 5초 소요.

- **영향**: 테스트 속도 저하. CI에서 server 테스트 suite가 불필요하게 느림.
- **권고**: `ctx.connections.size === 0`이면 drain 생략, 또는 drain 시간을 설정 가능하게.

### 5.3 `registry.ts` — `AbortSignal.timeout` 리스너 미해제 (minor)

`startSession`에서 생성하는 `AbortSignal.timeout(this.sessionTtlMs)`의 이벤트 리스너가, `stopSession`으로 세션이 조기 종료되더라도 TTL 만료 시점까지 GC되지 않는다. TTL이 30분이면 종료된 세션마다 30분간 유휴 타이머가 남아있다.

- **영향**: 단기적으로 무해. 대량 세션 시작/종료 시 타이머 누적 가능.
- **권고**: `AbortSignal.any([session.abortController.signal, ttlSignal])` 패턴이나, 세션의 `abortController`를 abort할 때 `removeEventListener`하는 방식으로 정리.

### 5.4 `server.ts` — 글로벌 메서드 레지스트리 + `createGatewayServer` 충돌 (structural)

`registerMethod()`는 모듈 레벨 `Map`에 저장한다. `createGatewayServer`가 두 번 호출되면 `RPC method already registered` 에러 발생. 테스트에서는 `clearMethods()`로 우회하지만, 프로덕션에서 hot reload나 서버 재생성 시 문제가 될 수 있다.

- **영향**: 현 단계에서는 서버를 한 번만 생성하므로 무해.
- **권고**: `registerMethod`에 중복 시 skip 또는 overwrite 옵션 추가, 또는 메서드 레지스트리를 `GatewayServerContext`에 포함.

---

## 6. 설계 노트

| 항목                           | 현재 상태                                      | 비고                                                          |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| chat/session/agent 메서드      | 모두 throw stub (server context wiring 필요)   | Phase 10 후속 작업으로 DI wiring 예정                         |
| finance 메서드                 | 모두 throw 'Not implemented' 스텁              | @finclaw/skills-finance 패키지 연동 시 구현 예정              |
| `flushAll()` 데이터 유실       | shutdown 시 미전송 delta 버퍼를 버림           | 의도적 — shutdown 시 in-progress 작업 폐기가 합리적           |
| `defaultConfig` 하드코딩       | 환경변수는 JWT secret만 지원                   | 향후 포트, 호스트 등 env 지원 필요                            |
| `dispatchRpc` serverCtx 미활용 | `_serverCtx` 매개변수가 있으나 핸들러에 미전달 | execute 시그니처가 `(params, ctx)` — serverCtx 주입 통로 필요 |

---

## 7. 리팩토링 권고

1. **`stop()` drain 대기 조건화**: 활성 연결이 없으면 5초 대기를 생략하거나, drain 시간을 config에서 받도록 변경. 테스트 속도에 직접적 영향.
2. **`AbortSignal.timeout` 리스너 정리**: 세션 종료 시 TTL 타이머를 해제하여 리소스 누적 방지. `AbortSignal.any` 패턴 또는 세션 abort 시 `clearTimeout` 대체 구현 고려.
3. **글로벌 메서드 레지스트리 → DI 소속**: 메서드 Map을 `GatewayServerContext`에 포함시켜 서버 인스턴스별 격리. `clearMethods()` 해킹 제거 가능.
4. **`dispatchRpc`에 serverCtx 전달**: 현재 `_serverCtx`가 `handleSingleRequest`에 전달되지만 `execute(params, rpcCtx)`까지 도달하지 못함. `RpcContext`에 serverCtx 참조를 추가하거나, execute 시그니처를 확장하여 DI wiring 완성 시 핸들러가 registry/broadcaster에 접근 가능하도록.
5. **`defaultConfig` 환경변수 확장**: `PORT`, `HOST` 등 기본 설정을 env에서 읽도록. 현재 port 3000 하드코딩은 개발 편의용으로 충분하나, 배포 시 변경 필요.
