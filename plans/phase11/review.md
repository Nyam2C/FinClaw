# Phase 11 Implementation Review

> `plans/phase11/todo.md` (12단계) 대비 `git diff HEAD` 비교 결과.

---

## 단계별 일치/차이 요약

| Step | 설명                                      | 상태     | 비고                                                                  |
| ---- | ----------------------------------------- | -------- | --------------------------------------------------------------------- |
| 1    | GatewayServerConfig 확장 (`rpc/types.ts`) | **일치** | Config 3필드 + Phase 11 타입 14개 모두 추가됨                         |
| 2    | isDraining 플래그 (`context.ts`)          | **일치** | `isDraining: boolean` 1줄 추가                                        |
| 3    | stop()에 isDraining 설정 (`server.ts`)    | **일치** | ctx 초기화 `isDraining: false` + stop() 첫 줄 `ctx.isDraining = true` |
| 4    | Drain 503 + 신규 라우트 (`router.ts`)     | **일치** | drain 체크 + /healthz, /readyz 라우트 + OpenAI compat 조건부 라우트   |
| 5    | Rate Limiting (`rate-limit.ts`)           | **일치** | todo 코드와 동일한 구현                                               |
| 6    | 액세스 로그 (`access-log.ts`)             | **일치** | todo 코드와 동일한 구현                                               |
| 7    | 헬스 체크 (`health.ts`)                   | **일치** | todo 코드와 동일한 구현                                               |
| 8    | 브로드캐스터 확장 (`broadcaster.ts`)      | **일치** | broadcastToChannel + subscribe + unsubscribe 추가                     |
| 9    | Config Hot-reload (`hot-reload.ts`)       | **일치** | chokidar 의존성 + hot-reload 구현                                     |
| 10   | OpenAI 호환 API (`openai-compat/`)        | **일치** | adapter.ts + router.ts 구현                                           |
| 11   | index.ts + router OpenAI compat           | **일치** | 배럴 export + 조건부 라우트                                           |
| 12   | 전체 검증                                 | **완료** | tsc --build ✓, vitest 18파일 168테스트 pass ✓, oxlint 0 warnings ✓    |

---

## 상세 비교

### Step 1: `rpc/types.ts` — 일치

- `GatewayServerConfig`에 `openaiCompat`, `hotReload`, `rateLimit` 3개 선택적 필드 추가
- Phase 11 타입 14개 (`ConfigChangeEvent`, `BroadcastChannel`, `RateLimitInfo`, `ComponentHealth`, `SystemHealth`, `LivenessResponse`, `AccessLogEntry`, `OpenAIChatRequest`, `OpenAIMessage`, `OpenAIToolCall`, `OpenAITool`, `OpenAIChatResponse`, `OpenAIStreamChunk`, `OpenAIErrorResponse`) 모두 추가
- todo 코드와 구조 완전 일치

### Step 2: `context.ts` — 일치

- `isDraining: boolean` mutable 프로퍼티 추가 (readonly 아님, 의도적)
- 1줄 변경

### Step 3: `server.ts` — 일치

- ctx 초기화: `isDraining: false`
- stop() 첫 줄: `ctx.isDraining = true`
- 2줄 변경

### Step 4: `router.ts` — 일치

**추가된 import:**

- `checkLiveness`, `checkReadiness` from `./health.js`
- `handleChatCompletions` from `./openai-compat/router.js`

**routes 배열 확장:**

- `/healthz` → `handleLivenessRequest`
- `/readyz` → `handleReadinessRequest`

**handleHttpRequest() 수정:**

- CORS 처리 후, 라우트 매칭 전에 drain 503 체크 (`/healthz` 제외)
- drain 체크 후, OpenAI compat 조건부 라우트

**테스트 (`router.test.ts`) 확장:**

- `makeCtx()`에 `isDraining: false` 추가
- `Drain 거부` describe 3개 테스트
- `GET /healthz` describe 1개 테스트
- `GET /readyz` describe 1개 테스트
- todo 코드와 의미 동일 (mock 함수명 차이: `createMockHttpPair` → `mockReqRes`, `getResponseBody` → 직접 `.mock.calls[0][0]`)

### Step 5: `rate-limit.ts` — 일치

- `RequestRateLimiter` 클래스: 슬라이딩 윈도우 + MAX_KEYS eviction + cleanup interval
- `toRateLimitHeaders()` 정적 메서드
- `size` getter, `dispose()` 메서드
- todo 코드와 동일 구현

**차이점 (사소):**

- todo의 constructor 파라미터가 `{ windowMs, maxRequests, maxKeys? }` 인라인인데, 실제 구현도 동일하게 인라인 타입 사용

### Step 6: `access-log.ts` — 일치

- `sanitizePath()`: SENSITIVE_PARAMS Set으로 쿼리 파라미터 마스킹
- `createAccessLogger()`: 팩토리 패턴, writer 주입 가능
- `X-Request-Id` 헤더 설정 + requestId 반환

### Step 7: `health.ts` — 일치

- `checkLiveness()`: 동기, 항상 `{ status: 'ok', uptime }`
- `checkReadiness()`: 비동기, 컴포넌트 집계 → ok/degraded/error
- `registerHealthChecker()` / `resetHealthCheckers()`
- `createProviderHealthChecker()`: TTL 60초 캐시
- `createDbHealthChecker()`: 캐시 없음, healthy/unhealthy

### Step 8: `broadcaster.ts` — 일치

- `CHANNEL_MAX_BUFFER` 정적 상수: `market.tick` 256KB, default 1MB
- `broadcastToChannel()`: 채널 구독 + readyState + bufferedAmount 체크
- `subscribe()` / `unsubscribe()`: connectionId + channel + connections Map 파라미터

**코드 차이 (사소):**

- todo의 null assertion `!` 대신 실제 구현은 fallback `?? 1024 * 1024` 추가 (더 안전)

### Step 9: `hot-reload.ts` — 일치

- `HotReloadConfig` 인터페이스 + `HotReloadManager` 인터페이스
- `createHotReloader()` 팩토리: chokidar 감시 + debounce + SHA256 해시 비교
- 검증 실패 시 error 리스너 호출, 성공 시 eventBus emit + broadcastToChannel

### Step 10: `openai-compat/` — 일치

**adapter.ts (92줄):**

- `MODEL_MAP`: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo → claude 매핑
- `mapModelId()`: 매핑 있으면 변환, claude-\* passthrough, 미지원 → undefined
- `adaptRequest()`: system 메시지 분리, 인라인 반환 타입
- `adaptResponse()`: `{ text, usage? }` → OpenAI 포맷 (todo와 동일)
- `adaptStreamChunk()`: text_delta → chunk, done → stop, 기타 → null

**router.ts (90줄):**

- `handleChatCompletions()`: body 파싱, 모델 검증, SSE 스트리밍 + keepalive
- `sendError()`: OpenAI 표준 에러 포맷 (satisfies 키워드 사용)
- TODO(Phase 12+) 2곳: 실행 엔진 연동 (스트리밍/동기)

**adapter.test.ts (130줄):**

- mapModelId, adaptRequest, adaptResponse, adaptStreamChunk 테스트
- todo 코드와 동일

### Step 11: `index.ts` — 일치

- Phase 11 value export: RequestRateLimiter, createAccessLogger, sanitizePath, health 5개, hot-reload 3개, openai-compat 5개
- Phase 11 type export: 11개 타입
- todo 코드와 완전 일치

### Step 12: 전체 검증 — 완료

- `tsc --build`: 성공 (에러 0)
- `vitest run packages/server/src/gateway/`: 18파일 168테스트 pass
- `oxlint packages/server/src/gateway/`: 0 warnings, 0 errors

---

## 기존 테스트 파일 isDraining 추가

GatewayServerContext 인터페이스에 `isDraining` 필드 추가로 인해 기존 테스트의 `makeCtx()` / `makeServerCtx()` 함수에 `isDraining: false` 추가:

- `rpc/index.test.ts`
- `rpc/methods/chat.test.ts`
- `rpc/methods/finance.test.ts`
- `rpc/methods/session.test.ts`
- `rpc/methods/system.test.ts`
- `ws/connection.test.ts`

→ 모두 1줄 추가로 타입 호환성 유지. 정상.

---

## 리팩토링 사항

### 1. `adaptResponse()` 타입 시그니처 차이

**todo:**

```typescript
adaptResponse(
  result: { text: string; usage?: { inputTokens: number; outputTokens: number } },
  model: string,
): OpenAIChatResponse
```

**실제 구현:** 동일 (todo와 일치)

**plan.md 원본:** `result: unknown` → `{ text: '', usage: { 0, 0, 0 } }` 하드코딩

→ todo 기준으로 실제 구현이 올바름. plan.md의 `unknown` 시그니처는 todo 작성 시 수정된 것.

### 2. `broadcastToChannel()` null assertion vs fallback

**todo:** `GatewayBroadcaster.CHANNEL_MAX_BUFFER['default']!` (non-null assertion)
**실제:** `?? GatewayBroadcaster.CHANNEL_MAX_BUFFER['default'] ?? 1024 * 1024` (이중 fallback)

→ 실제 구현이 더 안전함. 유지.

### 3. `_internalRequest` 미사용 변수

**파일:** `openai-compat/router.ts:39`

```typescript
const _internalRequest = adaptRequest(openaiRequest, internalModel);
```

→ `_` 접두사로 lint 경고 회피. Phase 12+에서 실행 엔진 연동 시 사용 예정. 현재는 의도적 placeholder.

### 4. chokidar 버전

**package.json:** `"chokidar": "^5.0.0"` 추가됨
→ ✅ 해결됨. npm에 chokidar 5.0.0 존재 확인. `^5.0.0`이 올바른 버전 범위.

### 5. `@finclaw/infra` import (`hot-reload.ts`)

**hot-reload.ts:4:** `import { getEventBus } from '@finclaw/infra';`
→ ✅ 오판 정정. `@finclaw/infra` 패키지는 `packages/infra/`에 존재함 (getEventBus export 포함). tsc --build 정상 통과.

### 6. `resetHealthCheckers` 미 export from index.ts

**health.ts:** `resetHealthCheckers()` export 존재 (테스트용)
**index.ts:** 배럴에서 re-export하지 않음
→ 테스트 전용이므로 의도적 생략. 문제 없음.

---

## 결론

- **todo 대비 구현 일치도: 12/12 단계** (전체 완료)
- **코드 품질:** todo 스펙과 거의 1:1 일치. 사소한 차이는 모두 개선 방향.
- **블로커:** 없음. 모든 리팩토링 사항 해결 완료 (chokidar 5.0.0 확인, `@finclaw/infra` 존재 확인, 검증 통과).
