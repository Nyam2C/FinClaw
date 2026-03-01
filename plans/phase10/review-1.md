# Phase 10 — Todo 1 Review

> **검증 시점**: 2026-03-01
> **대상 브랜치**: `feature/gateway-server`
> **명세**: `plans/phase10/todo-1.md`

---

## 1. 검증 결과 요약

| 검증 항목                  | 결과                |
| -------------------------- | ------------------- |
| `tsgo --noEmit`            | **PASS** — 에러 0개 |
| `errors.test.ts` (8 tests) | **PASS**            |
| `index.test.ts` (15 tests) | **PASS**            |
| `router.test.ts` (6 tests) | **PASS**            |
| `system.test.ts` (3 tests) | **PASS**            |
| 전체 테스트 (32 tests)     | **PASS**            |

---

## 2. 파일별 명세 대조

### 2.1 기존 파일 수정 (3개)

| #   | 파일                            | 판정     | 비고                                                                         |
| --- | ------------------------------- | -------- | ---------------------------------------------------------------------------- |
| 1   | `packages/types/src/gateway.ts` | **PASS** | `chat.*` 4개, `system.*` 3개, `config.reload` 1개 추가. 명세와 동일          |
| 2   | `packages/infra/src/events.ts`  | **PASS** | `gateway:*` 8개 이벤트 추가. 시그니처·위치 명세 일치                         |
| 3   | `packages/server/package.json`  | **PASS** | `ws ^8.19.0`, `@types/ws ^8.18.1` 추가. `zod ^4.0.0` 추가 (methods에서 사용) |

### 2.2 신규 소스 파일 (10개)

| #   | 파일                            | 판정     | 비고                                                                               |
| --- | ------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| 1   | `gateway/rpc/types.ts`          | **PASS** | 모든 타입·인터페이스 명세와 동일. import 순서만 포매터 정렬 차이                   |
| 2   | `gateway/rpc/errors.ts`         | **PASS** | `RpcErrors` 확장 3개 코드, `createError` 헬퍼. 명세와 동일                         |
| 3   | `gateway/context.ts`            | **PASS** | `GatewayServerContext` 인터페이스. 명세와 동일                                     |
| 4   | `gateway/registry.ts`           | **PASS** | `ChatRegistry` 스텁. 명세와 동일. Part 3에서 완성 예정                             |
| 5   | `gateway/broadcaster.ts`        | **PASS** | `GatewayBroadcaster` 스텁. 명세와 동일. Part 3에서 완성 예정                       |
| 6   | `gateway/cors.ts`               | **PASS** | CORS 미들웨어. 명세와 동일                                                         |
| 7   | `gateway/router.ts`             | **PASS** | HTTP 라우터 3개 라우트 (`/rpc`, `/health`, `/info`). 명세와 동일                   |
| 8   | `gateway/rpc/index.ts`          | **PASS** | JSON-RPC 디스패처. 메서드 레지스트리, 배치, Zod 검증, 인증 레벨 체크. 명세와 동일  |
| 9   | `gateway/rpc/methods/system.ts` | **PASS** | `system.health`, `system.info`, `system.ping` 3개 메서드. 명세와 동일              |
| 10  | `gateway/rpc/methods/config.ts` | **PASS** | `config.get`, `config.update`, `config.reload` 3개 메서드 (TODO 스텁). 명세와 동일 |

### 2.3 테스트 파일 (4개)

| #   | 파일                                 | 판정     | 비고                                                                                  |
| --- | ------------------------------------ | -------- | ------------------------------------------------------------------------------------- |
| 1   | `gateway/rpc/errors.test.ts`         | **PASS** | 8 tests. 표준 코드 포함, 게이트웨이 확장 범위, 중복 없음, createError 5개 케이스      |
| 2   | `gateway/rpc/index.test.ts`          | **PASS** | 15 tests. 등록, 디스패치, 버전검증, 인증, 스키마, 에러, 배치 3개, hasRequiredAuth 4개 |
| 3   | `gateway/router.test.ts`             | **PASS** | 6 tests. 404, /health, /info, /rpc 디스패치, JSON 파싱 에러, CORS preflight           |
| 4   | `gateway/rpc/methods/system.test.ts` | **PASS** | 3 tests. health/info/ping 각 1개                                                      |

---

## 3. 발견된 문제점

**없음.** 모든 파일이 명세와 로직·타입·테스트 케이스 수준에서 일치한다.

---

## 4. 포매터 정렬 차이 (참고)

모든 파일에서 import 문 순서가 명세의 작성 순서와 다르다. 이는 `oxfmt`(포매터)가 import를 알파벳순으로 재정렬하기 때문이며, 기능 차이는 없다. 파일 상단의 `// packages/server/src/gateway/...` 주석 위치도 포매터에 의해 import 사이로 이동되었다.

---

## 5. 설계 노트

| 항목                        | 현재 상태                                                 | 후속 작업                                                       |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| HTTP 인증                   | `handleRpcRequest`에서 `auth: { level: 'none' }` 하드코딩 | Part 2에서 WS 핸드셰이크 시 4-layer 인증 구현                   |
| `ChatRegistry`              | 스텁 (`startSession`/`stopSession` throw)                 | Part 3에서 TTL, AbortSignal, 중복 방지 완성                     |
| `GatewayBroadcaster`        | 스텁 (`send` no-op)                                       | Part 3에서 150ms delta 배치, slow consumer 보호 완성            |
| `config.*` 메서드           | TODO 스텁 (실제 config 연동 없음)                         | Part 2~3에서 `@finclaw/config` 연동                             |
| `process.memoryUsage.rss()` | Node.js 22+ fast API 사용                                 | 프로젝트 요구사항(Node 22+)에 부합                              |
| RPC `methods` Map           | 모듈 레벨 공유 상태                                       | `clearMethods()`로 테스트 격리. 향후 DI 컨테이너 이동 검토 가능 |
