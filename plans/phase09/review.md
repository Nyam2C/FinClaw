# Phase 9: 실행 엔진 — 리뷰

> 리뷰 기준: `git diff main` (브랜치 `feature/execution-engine`)
> 리뷰 일자: 2026-03-01

---

## 1. TODO 체크리스트

| TODO | 내용                                                | 완료 | 비고                                                                               |
| ---- | --------------------------------------------------- | :--: | ---------------------------------------------------------------------------------- |
| 1    | StreamChunk discriminated union (6 variant)         |  ✅  | `interface` → `type` 변환, 6 variant 정확히 일치                                   |
| 2    | ProviderAdapter에 `streamCompletion()` 추가         |  ✅  | `adapter.ts` L22에 메서드 + import 추가                                            |
| 3    | ToolInputBuffer 구현                                |  ✅  | `tool-input-buffer.ts` 신규 생성, 테스트 7건                                       |
| 4    | StreamStateMachine (5 state)                        |  ✅  | `streaming.ts` 신규 생성, 전이 테이블 + 테스트 통과                                |
| 5    | ExecutionToolDispatcher                             |  ✅  | `tool-executor.ts` 신규 생성, `unregister()`/`has()` 추가 (plan에 없으나 유용)     |
| 6    | TokenCounter (80%/95% 임계값)                       |  ✅  | `tokens.ts` 신규 생성, 경계값 테스트 충분                                          |
| 7    | AnthropicAdapter.streamCompletion() + cache_control |  ✅  | 시스템 프롬프트 캐싱 + 마지막 도구 cache_control 부착. 버그 B1/B3 참조             |
| 8    | OpenAIAdapter.streamCompletion()                    |  ✅  | `stream_options: { include_usage: true }` 포함. 버그 B2 참조                       |
| 9    | Runner 오케스트레이션 루프                          |  ✅  | retry + ConcurrencyLaneManager + FSM + ToolInputBuffer 통합. 설계 관찰 D2 참조     |
| 10   | calculateEstimatedCost 캐시 비용 + FinClawEventMap  |  ✅  | 캐시 비용 4개 항목 반영, 이벤트 5종 추가. normalizeAnthropicResponse 호출부도 갱신 |
| 부록 | barrel export + 통합                                |  ✅  | `execution/index.ts` + `agent/src/index.ts` 에 class/type 모두 export              |

**결과: 10/10 TODO + 부록 전부 완료.**

---

## 2. 버그

### B1 — `content_block_stop`에서 무조건 `tool_use_end` 발행 (Low)

**위치:** `packages/agent/src/providers/anthropic.ts` L101–103

```typescript
case 'content_block_stop':
  yield { type: 'tool_use_end' };
  break;
```

**문제:** Anthropic API는 텍스트 블록이 끝날 때도 `content_block_stop`을 보낸다.
현재 코드는 블록 타입을 확인하지 않고 모든 `content_block_stop`에 `tool_use_end`를 발행한다.

**실질 영향:** ToolInputBuffer는 `pending`이 없으면 `tool_use_end`를 무시하므로 (null 반환)
텍스트 전용 응답에서 기능적 오류는 발생하지 않는다.
다만 텍스트+tool_use 혼합 응답에서 텍스트 블록 종료 시 불필요한 `tool_use_end` 청크가 스트림에 섞인다.

**수정안:** `content_block_stop` 이벤트에 `content_block` 인덱스를 추적하여 tool_use 블록일 때만 발행하거나,
최소한 현재 content block 타입을 상태로 기억.

---

### B2 — OpenAI 다중 tool call에서 `tool_use_end` 1회만 발행 (Medium)

**위치:** `packages/agent/src/providers/openai.ts` L88–90

```typescript
if (choice?.finish_reason === 'tool_calls') {
  yield { type: 'tool_use_end' };
}
```

**문제:** OpenAI가 한 응답에서 여러 도구를 호출할 때, `finish_reason === 'tool_calls'`는 응답 종료 시
한 번만 나타난다. 그러나 `tool_use_start`는 각 도구마다 발행된다.

ToolInputBuffer는 단일 pending 슬롯이므로:

1. `tool_use_start` (도구1) → pending = 도구1
2. `tool_use_start` (도구2) → pending = 도구2 (도구1 덮어씀)
3. `tool_use_end` → 도구2만 완성, 도구1 유실

**수정안:** `tool_use_start`가 도착할 때 이전 pending이 있으면 먼저 `tool_use_end`를 yield하거나,
OpenAI 어댑터에서 도구별로 `tool_use_end`를 생성.

---

### B3 — Anthropic `message_start`에서 캐시 토큰 미추출 (Low)

**위치:** `packages/agent/src/providers/anthropic.ts` L111–120

```typescript
case 'message_start':
  if (event.message.usage) {
    yield {
      type: 'usage',
      usage: {
        inputTokens: event.message.usage.input_tokens,
        outputTokens: event.message.usage.output_tokens,
      },
    };
  }
  break;
```

**문제:** Anthropic `message_start` 이벤트의 usage에는 `cache_creation_input_tokens`와
`cache_read_input_tokens` 필드가 포함된다. 현재 코드는 이를 추출하지 않으므로
TokenCounter의 `cacheReadTokens`/`cacheWriteTokens`가 항상 0이 된다.

prompt caching을 적용하고(`cache_control: { type: 'ephemeral' }`) 비용 계산에 캐시 토큰을
반영하도록 수정했음에도(`calculateEstimatedCost`), 실제 스트리밍에서 캐시 토큰이 수집되지 않는다.

**수정안:**

```typescript
usage: {
  inputTokens: event.message.usage.input_tokens,
  outputTokens: event.message.usage.output_tokens,
  cacheReadTokens: event.message.usage.cache_read_input_tokens ?? 0,
  cacheWriteTokens: event.message.usage.cache_creation_input_tokens ?? 0,
},
```

---

## 3. 설계 관찰

### D1 — `ToolResult`와 `ExecutionToolResult` 동일 shape 중복

**위치:**

- `streaming.ts` L14–18: `ToolResult`
- `tool-executor.ts` L10–14: `ExecutionToolResult`

```typescript
// streaming.ts
export interface ToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

// tool-executor.ts
export interface ExecutionToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}
```

두 인터페이스는 필드가 완전히 동일하다. `ToolResult`는 StreamEvent의 `tool_use_end` 이벤트에,
`ExecutionToolResult`는 ToolExecutor 반환에 사용된다. 기능적 문제는 없지만 하나로 통합 가능하다.

**추정 원인:** streaming.ts가 plan.md의 원본 타입 이름(`ToolResult`)을 사용하고,
tool-executor.ts가 `@finclaw/types`의 기존 `ToolResult`와의 충돌을 피하기 위해 이름을 변경한 것으로 보인다.

---

### D2 — FSM이 per-LLM-call 범위 (plan은 per-execution-loop)

**위치:** `runner.ts` L144

```typescript
private async streamLLMCall(...): Promise<LLMCallResult> {
  const sm = new StreamStateMachine();  // ← LLM 호출마다 새로 생성
  ...
}
```

plan.md의 상태 전이 다이어그램은 전체 실행 루프에 걸친 FSM을 상정한다:
`idle → streaming → tool_use → executing → streaming → ... → done`

실제 구현에서는 FSM이 `streamLLMCall()` 내부에서 생성되므로, 각 LLM 호출마다 독립적인
FSM 생명주기를 갖는다. 따라서 `executing → streaming` 전이(턴 간 전이)는 실제로 발생하지 않는다.

**영향:** FSM이 단일 호출 내에서만 유효하므로, 실행 루프 전체의 상태 추적이 외부 리스너에게
전달되지 않는다. 현재는 문제없으나, 향후 execution-level 상태 추적이 필요하면 FSM을 Runner 수준으로
올려야 한다.

---

## 4. 잘된 점

### plan 준수도

- todo.md 10개 항목 + 부록 전부 구현 완료.
- plan.md의 인터페이스 시그니처(RunnerOptions, ExecutionResult, StreamState, StreamEvent 등)가
  구현과 정확히 일치한다.
- "과도한 엔지니어링 경계선" 준수: AttemptManager 미생성, LaneManager 미생성,
  retry() 직접 사용, ConcurrencyLaneManager 주입, ModelRef.contextWindow 사용.

### 인프라 재사용

- `retry()` + `classifyFallbackError()`: Runner에서 한 줄 호출로 통합.
- `ConcurrencyLaneManager`: 핸들 패턴(`acquire → try/finally release`) 올바르게 적용.
- 기존 `@finclaw/types` 타입 재사용: `AgentRunParams`, `ConversationMessage`, `ToolCall`, `TokenUsage`.

### 테스트 커버리지

- 신규 테스트 6 파일, plan 4 + 추가 2:
  - `tool-input-buffer.test.ts` (7건) — 시퀀스 조합, 엣지 케이스
  - `streaming.test.ts` (14건) — 허용 전이 7건, 금지 전이 13건, 이벤트 발행/해제, 리셋
  - `execution-tool-executor.test.ts` (7건) — 등록/해제, 실행, 에러, 크기 제한, 병렬, AbortSignal
  - `tokens.test.ts` (9건) — 누적, 비율, 잔여, 임계값 경계(79%/80%/95%), 리스너 없음
  - `runner.test.ts` (6건) — 단일턴, 멀티턴, maxTurns, abort, 이벤트, 핸들 release
  - `normalize.test.ts` (2건 추가) — 캐시 비용 계산, 캐시 가격 없을 때

### 코드 품질

- discriminated union으로 StreamChunk 타입 안전성 확보.
- buildResult 헬퍼를 모듈 수준 함수로 분리 (클래스 비대화 방지).
- prompt caching 적용 (시스템 프롬프트 + 도구 정의 마지막 항목).

---

## 5. 리팩토링 사항

| 우선순위 | 항목    | 설명                                                                      |
| :------: | ------- | ------------------------------------------------------------------------- |
|    1     | B2 수정 | OpenAI 다중 tool call 유실 — ToolInputBuffer 또는 OpenAI 어댑터 수정 필요 |
|    2     | B3 수정 | Anthropic 캐시 토큰 추출 추가 (2줄 변경)                                  |
|    3     | B1 수정 | `content_block_stop`에서 블록 타입 체크 추가                              |
|    4     | D1 통합 | `ToolResult` / `ExecutionToolResult` → 하나로 통합                        |
|    5     | D2 고려 | FSM을 Runner 수준으로 이동할지 결정 (현재는 동작에 문제 없음)             |

---

## 파일 변경 요약

| 구분     | 파일                                   | 변경량                                            |
| -------- | -------------------------------------- | ------------------------------------------------- |
| 수정     | `provider-normalize.ts`                | +29 −15 (StreamChunk 리팩 + 캐시 비용)            |
| 수정     | `adapter.ts`                           | +3 (streamCompletion 인터페이스)                  |
| 수정     | `anthropic.ts`                         | +100 (streamCompletion + mapAnthropicStreamEvent) |
| 수정     | `openai.ts`                            | +80 (streamCompletion + mapOpenAIStreamChunk)     |
| 수정     | `events.ts`                            | +12 (실행 이벤트 5종)                             |
| 수정     | `agent/src/index.ts`                   | +18 (barrel export)                               |
| 수정     | `normalize.test.ts`                    | +20 (캐시 비용 테스트 2건)                        |
| 신규     | `execution/index.ts`                   | 21줄                                              |
| 신규     | `execution/runner.ts`                  | 245줄                                             |
| 신규     | `execution/streaming.ts`               | 101줄                                             |
| 신규     | `execution/tool-executor.ts`           | 71줄                                              |
| 신규     | `execution/tokens.ts`                  | 67줄                                              |
| 신규     | `execution/tool-input-buffer.ts`       | 57줄                                              |
| 신규     | `test/runner.test.ts`                  | 220줄                                             |
| 신규     | `test/streaming.test.ts`               | 145줄                                             |
| 신규     | `test/execution-tool-executor.test.ts` | 165줄                                             |
| 신규     | `test/tokens.test.ts`                  | 122줄                                             |
| 신규     | `test/tool-input-buffer.test.ts`       | 69줄                                              |
| **합계** | **수정 7 + 신규 11 = 18 파일**         | **+902 −446**                                     |
