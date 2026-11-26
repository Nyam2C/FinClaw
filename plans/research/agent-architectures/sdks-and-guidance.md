# Lane 3 — 에이전트 SDK/프레임워크 아키텍처와 공식 가이던스

> 조사 레인 보고서 원문 (2026-11-26). 요약은 [`../agent-architectures.md`](../agent-architectures.md). 경로 · 줄 번호는 본문 표의 분석 커밋 기준이며, 레포 코드는 실행하지 않고 읽기만 했다.

- 작성일: 2026-11-26
- 목적: FinClaw 가 `claude` CLI 래핑을 버리고 자체 소형 에이전트 루프로 갈 때, 현행 프레임워크들이 수렴한 **어휘와 구조**를 맞추기 위한 근거 자료. 프레임워크 채택은 전제에서 제외.
- 방법: 각 레포를 `git clone --depth 1` 로 받아 run loop 구현 코드를 직접 읽음. 코드는 실행/설치/빌드하지 않음. 공식 가이던스는 페이지를 직접 fetch.

## 0. 검증된 레포 메타 (`gh api repos/<owner>/<repo>`, 2026-11-26 조회)

| 레포                                               |  stars | pushed_at (UTC)  | default | 분석한 커밋 (shallow HEAD) | 버전                                         |
| -------------------------------------------------- | -----: | ---------------- | ------- | -------------------------- | -------------------------------------------- |
| `openai/openai-agents-js`                          |  4,031 | 2026-11-26T04:22 | main    | `ccceb64` (2026-11-23)     | —                                            |
| `openai/openai-agents-python` (비교용, 클론 안 함) | 30,880 | 2026-11-25T23:01 | main    | —                          | —                                            |
| `vercel/ai`                                        | 28,217 | 2026-11-26T04:33 | main    | `0411a13` (2026-11-25)     | `ai@7.0.183`                                 |
| `mastra-ai/mastra`                                 | 29,824 | 2026-11-26T04:47 | main    | `075a9591` (2026-11-25)    | `@mastra/core@1.87.0-alpha.2`                |
| `anthropics/claude-agent-sdk-typescript`           |  1,905 | 2026-11-25T01:31 | main    | `e774912` (2026-11-25)     | npm `@anthropic-ai/claude-agent-sdk@0.3.332` |
| `anthropics/claude-agent-sdk-python` (보조)        |  8,644 | 2026-11-25T02:22 | main    | `6c1b03f` (2026-11-25)     | —                                            |
| `langchain-ai/langgraphjs`                         |  3,427 | 2026-11-26T03:46 | main    | `61aad39` (2026-11-24)     | `@langchain/langgraph-core@1.7.5`            |

다섯 레포 모두 살아 있고(archived=false) 이름 변경/후계 레포 없음. 단 하나의 예외적 사실:

> **`anthropics/claude-agent-sdk-typescript` 레포에는 SDK 소스가 없다.** README/CHANGELOG/`examples/session-stores/` 뿐이다. 실제 SDK 는 npm 타볼(번들된 `.mjs` + `sdk.d.ts` 11,047줄)로만 배포되고, 루프 자체는 SDK 가 띄우는 Claude Code 바이너리 안에 있다(공식 문서: "A library that runs the Claude Code binary" — https://code.claude.com/docs/en/agent-sdk/overview). Python SDK 도 `src/claude_agent_sdk/_internal/transport/subprocess_cli.py` 로 CLI 를 서브프로세스로 구동한다. 따라서 4번(Claude Agent SDK)은 **run loop 구현 코드를 읽지 못했고**, npm 타볼의 타입 선언(`claude-agent-sdk-npm/package/sdk.d.ts`)과 공식 문서로 분석했다.

---

## 1. openai/openai-agents-js

핵심 소스: `packages/agents-core/src/` (`run.ts` 3,882줄, `runState.ts` 7,970줄, `runner/*`).

### 1.1 핵심 추상화

| 추상화                 | 정의 위치                          | 역할                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Agent`                | `agent.ts:546-570`                 | 선언적 설정 객체: `name, instructions, prompt, handoffDescription, handoffs, model, modelSettings, tools, mcpServers, inputGuardrails, outputGuardrails, outputType, toolUseBehavior, resetToolChoice` |
| `Runner` / `run()`     | `run.ts`                           | 루프 실행자. `RunConfig`(`run.ts:316-459`) = 실행 전역 설정, `SharedRunOptions`(`run.ts:464-488`) = 호출별 옵션                                                                                        |
| `RunState`             | `runState.ts`                      | 직렬화 가능한 실행 상태(`CURRENT_SCHEMA_VERSION = '1.25'`, `runState.ts:212`; `fromString` `:3840`). 중단/재개의 단위                                                                                  |
| `RunContext<TContext>` | `runContext.ts`                    | 모델에 보내지 않는 로컬 의존성/상태(DI). 승인 결정도 여기 저장(`runState.ts:3448-3455`)                                                                                                                |
| `Session`              | `memory/session.ts:28-96`          | 대화 히스토리 저장소 인터페이스                                                                                                                                                                        |
| `Tool` / `tool()`      | `tool.ts`                          | 함수 도구 + hosted/computer/shell/apply_patch 도구                                                                                                                                                     |
| `Handoff`              | `handoff.ts:181`                   | 다른 에이전트로의 **제어 이전**(도구처럼 노출: `transfer_to_<name>`, `handoff.ts:80`)                                                                                                                  |
| Guardrail              | `guardrail.ts`, `toolGuardrail.ts` | input / output / tool-input / tool-output 4종                                                                                                                                                          |
| Tracing                | `tracing/`                         | Trace/Span + `TracingProcessor`                                                                                                                                                                        |

관계: `Runner.run(agent, input, {session, context, ...})` → 루프가 `RunState` 를 전진 → 결과 `RunResult`(또는 `StreamedRunResult`). Agent 는 상태가 없고, 상태는 전부 `RunState`/`Session` 에 있다.

### 1.2 Run loop

- 형태: `while (true)` (`run.ts:1669` 비스트리밍, `run.ts:2715` 스트리밍) 위의 **명시적 상태 기계**. 한 턴의 결과는 `NextStep` 판별 유니온(`runner/steps.ts:7-25`):
  `next_step_run_again` | `next_step_final_output` | `next_step_handoff` | `next_step_interruption`. 분기 switch 는 `run.ts:2206-2238`.
- 종료 조건
  - `maxTurns`: 기본 10(`runner/constants.ts:2`), 초과 시 `MaxTurnsExceededError`(`runner/turnPreparation.ts:160-169`). `maxTurns: null` 로 해제 가능(`run.ts:469`).
  - `toolUseBehavior`: `'run_llm_again'`(기본, `agent.ts:617`) | `'stop_on_first_tool'` | `{ stopAtToolNames }` | 함수(`agent.ts:229, 292-301`).
  - 도구 호출이 없는 응답(또는 `outputType` 을 만족하는 구조화 출력) = final output.
  - `errorHandlers`: `'maxTurns' | 'modelRefusal' | 'invalidFinalOutput'` 종류별로 예외 대신 `finalOutput` 을 합성할 수 있음(`runner/errorHandlers.ts:31-77`).
  - **토큰/비용 예산 기반 중단 옵션: not found** (`run.ts`, `runner/runConfig.ts` 에서 budget 계열 식별자 grep 결과 없음. `usage.ts` 로 집계만 함).
- 스텝별 훅
  - 라이프사이클 이벤트(EventEmitter): `agent_start, agent_end, agent_handoff, agent_tool_start, agent_tool_end` (`lifecycle.ts:52-89`).
  - `callModelInputFilter`: 모델 호출 직전에 instructions/input 을 편집(`runner/conversation.ts:32-49`, `run.ts:436-440`).
  - `sessionInputCallback`: 세션 히스토리와 새 입력의 병합 방식 커스터마이즈(`memory/session.ts:8-11`).
- 병렬 도구 호출: 한 턴의 함수 도구는 기본적으로 전부 동시 시작. `toolExecution.maxFunctionToolConcurrency` 로 제한(`runner/runConfig.ts:5-17`).
- 에러/재시도
  - 모델 호출: `modelSettings.retry.maxRetries`(기본 **0**) + backoff/jitter, `retryPolicies`(`runner/modelRetry.ts:775-780, 1019, 1172-1174`).
  - 도구: `errorFunction`(`tool.ts:519`)·`toolErrorFormatter`(`run.ts:300-302, 442-446`)로 에러를 **모델이 읽는 결과**로 변환. `timeoutMs`/`timeoutBehavior`(`tool.ts:530-541`). 없는 도구 호출은 `toolNotFoundBehavior: 'raise_error' | 'return_error_to_model'`(`run.ts:311`).
- 취소: `signal?: AbortSignal`(`run.ts:470`), 루프 곳곳에서 `signal?.throwIfAborted()`(예: `run.ts:1796, 2192, 2215`).

### 1.3 세션/상태 영속 인터페이스

`Session` 이 구현해야 하는 것(`memory/session.ts:28-96`):

```ts
getSessionId(): Promise<string>
getItems(limit?: number): Promise<AgentInputItem[]>
addItems(items: AgentInputItem[]): Promise<void>
popItem(): Promise<AgentInputItem | undefined>
clearSession(): Promise<void>
// 선택: replaceHistoryWithCompaction?(items), prepareHistoryItemForModelInput?(item)
```

선택 capability: `applyHistoryTransaction({operationId, transaction})` — `append_items` | `replace_suffix`, operationId 로 멱등(`memory/session.ts:133-171`). 구현체: `MemorySession`(`memory/memorySession.ts:25`), `OpenAIConversationsSession`, `OpenAIResponsesCompactionSession`(`packages/agents-openai/src/memory/`).

- **Python 과의 차이**: Python 레포에는 `sqlite_session.py` 와 `extensions/memory/{advanced_sqlite,async_sqlite,redis,sqlalchemy,mongodb,dapr,encrypt}_session.py` 가 있다(`gh api repos/openai/openai-agents-python/contents/src/agents/memory` 로 확인). **JS 레포에서 SQLite 세션 구현은 찾지 못함.**
- 세션과 별개로 `RunState` 직렬화(`toString()`/`fromString()`)가 "중단된 실행" 영속 수단이다.

### 1.4 도구 정의·검증, HITL

- `tool({ name, description, parameters(zod), strict, execute, needsApproval, isEnabled, timeoutMs, errorFunction, inputGuardrails, outputGuardrails, deferLoading })` (`tool.ts:479-559`).
- HITL: `needsApproval: boolean | fn`(`tool.ts:525`) → 턴 결과가 `next_step_interruption` → `RunResult.interruptions`(`result.ts:259`) → 호스트가 `state.approve(item, {alwaysApprove})` / `state.reject(item, {alwaysReject, message})`(`runState.ts:3448-3480`) 후 **같은 state 로 다시 run**. 승인 대기 중 상태는 문자열로 직렬화해 프로세스 밖에 보관 가능.
- 스트림 이벤트에도 `tool_approval_requested` 가 있다(`events.ts:46`).

### 1.5 컨텍스트 관리

- instructions: 문자열 또는 `(runContext, agent) => string` 동적 함수(`agent.ts:1113-1123`).
- per-run 주입: `context`(모델 비노출), `callModelInputFilter`(모델 노출분 편집).
- 히스토리 축약: `OpenAIResponsesCompactionSession` — OpenAI `responses.compact` 를 호출, 기본 트리거는 "user/compaction 이 아닌 항목 ≥ 10개"(`packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts:32, 661-676`). 범용 trimming 유틸은 `getItems(limit)` 정도.
- 프롬프트 캐싱: `ModelSettings.promptCacheRetention?: 'in-memory' | '24h' | null`(`model.ts:379`) — 제공자 기능에 대한 패스스루.

### 1.6 메모리

Session = 대화 히스토리뿐. 장기/시맨틱 메모리 추상화는 `agents-core` 에 없음. `sandbox/memory/{generation,prompts,rollouts,storage}.ts` 디렉터리가 존재하지만(샌드박스 에이전트용) **내용은 분석하지 않음**.

### 1.7 멀티 에이전트

- **Handoff**(탈중앙): 단방향 제어 이전. `inputFilter` 로 넘겨줄 히스토리 편집(`handoff.ts:57, 170`), `onHandoff`, `isEnabled`. 루프에서는 `next_step_handoff` → `state.setCurrentAgent()`(`run.ts:2217-2230`).
- **Agents as tools**(매니저): `agent.asTool({ toolName, toolDescription, needsApproval, customOutputExtractor, onStream, ... })`(`agent.ts:136-193, 765`). 중첩 실행이라 호출자가 제어를 유지.

### 1.8 스트리밍 이벤트 프로토콜 (`events.ts:18-81`)

3종: `raw_model_stream_event`(모델 원본 이벤트 패스스루), `run_item_stream_event`(name: `message_output_created | handoff_requested | handoff_occurred | tool_search_called | tool_search_output_created | tool_called | tool_output | reasoning_item_created | compaction_item_created | tool_approval_requested`), `agent_updated_stream_event`.

### 1.9 가드레일·evals·트레이싱

- 가드레일: input(`runInParallel` 기본 true = 낙관적 병렬 실행, `guardrail.ts:75-78, 138`), output, tool-input/tool-output(동작 `allow | rejectContent | throwException`, `toolGuardrail.ts:13-16`). 위반은 `tripwireTriggered`(`guardrail.ts:28`) → 예외.
- 트레이싱: 자체 Trace/Span 모델. span 종류: response, agent, task, turn, function, handoff, generation, custom, guardrail, transcription, speech, mcp_list_tools(`tracing/createSpans.ts:109-462`). `TracingProcessor` 인터페이스(`tracing/processor.ts`) + OpenAI 익스포터(`packages/agents-openai/src/openaiTracingExporter.ts`). **OpenTelemetry 의존성: not found** (`packages/` 전체 grep 결과 없음).
- evals: **not found** (`docs/src/content/docs/guides/` 에 `testing.mdx` 는 있으나 evals 모듈/가이드 없음).

---

## 2. vercel/ai (AI SDK 7)

핵심 소스: `packages/ai/src/agent/`, `packages/ai/src/generate-text/`, 설계 문서 `architecture/*.md`.

### 2.1 핵심 추상화

- `Agent` 인터페이스(`packages/ai/src/agent/agent.ts`, `version: 'agent-v1'`) — `generate()` / `stream()` 두 메서드.
- `ToolLoopAgent`(`agent/tool-loop-agent.ts:53-59`) — 그 구현체. **실체는 `generateText`/`streamText` 를 감싼 얇은 설정 객체**(`tool-loop-agent.ts:9, 16`). 즉 "에이전트 = 루프 설정 묶음"이고 루프는 `generateText` 안에 있다.
- `tool()`(`packages/provider-utils/src/types/tool.ts`), `StopCondition`, `PrepareStepFunction`, `StepResult`.
- 4계층 메시지(`architecture/message-layers.md`): UI messages → Model messages → Language model messages(v4 spec) → provider-specific messages.
- 그 외 계층: `@ai-sdk/workflow` 의 `WorkflowAgent`(내구 실행, `packages/workflow/README.md`), `@ai-sdk/harness` 의 `HarnessAgent`(Claude Code 등 외부 코딩 에이전트 런타임을 샌드박스에 붙이는 어댑터 규격, `architecture/harness-abstraction.md` — experimental).

### 2.2 Run loop

- 형태: `do { ... } while (await shouldStartNextStep())` (`generate-text/generate-text.ts:989-1041`). 설계 문서의 의사코드(`architecture/stream-text-loop-control.md`): prepare step → 메시지 변환 → doStream → 도구 실행 변환 → 응답 메시지 누적 → 종료 판정.
- 루프가 멈추는 조건(`generate-text/stop-condition.ts:8-12`, `tool-loop-agent.ts:47-51`):
  1. finish reason 이 `tool-calls` 가 아님
  2. `execute` 가 없는 도구가 호출됨(클라이언트 측 도구)
  3. 승인이 필요한 도구 호출
  4. `stopWhen` 조건 중 하나가 true (배열이면 OR — `isStopConditionMet`, `stop-condition.ts:64-77`)
- 내장 stop condition: `isStepCount(n)`, `isLoopFinished()`, `hasToolCall(...names)`(`stop-condition.ts:27-54`). 기본값: `generateText` 는 `isStepCount(1)`(`generate-text.ts:302`), `ToolLoopAgent` 는 `isStepCount(20)` + 한도 도달 시 경고(`tool-loop-agent.ts:150-152`, `agent/default-stop-condition.ts`).
- 예산: 전용 옵션 없음. `StopCondition` 이 `steps`(각 step 의 usage 포함)를 받으므로 **사용자 정의 조건으로 구현**하는 구조. `timeout` 은 total/per-step/first-content/inter-content/tool 단위로 설정 가능(`agent/agent.ts:72-78`). 결과에 `stoppedBy`(`'model' | 'stop-condition' | ...`, `generate-text.ts:987`)가 남는다.
- 스텝별 훅
  - `prepareCall`(호출당 1회, `tool-loop-agent.ts:156-168`)
  - `prepareStep`(스텝마다): `model, toolChoice, activeTools, toolOrder, instructions, messages, toolsContext, runtimeContext, providerOptions` 를 그 스텝에 한해(일부는 이후 스텝까지) 덮어씀(`generate-text/prepare-step.ts:36-196`)
  - 콜백: `onStart, onStepStart, onToolExecutionStart, onToolExecutionEnd, onStepEnd, onEnd(onFinish), onError, onAbort`(`agent/agent.ts:83-140`)
- 병렬 도구: `toolCallConcurrency`, 기본 무제한(`generate-text.ts:196`).
- 재시도: `maxRetries` 기본 2, 지수 백오프 + retry 헤더 존중(`generate-text.ts:224`, `util/retry-with-exponential-backoff.ts:61-92`). 잘못된 도구 입력은 `repairToolCall` 훅(`generate-text.ts:470-475`). 도구 실패는 `tool-error` 파트로 모델에 되돌아감.
- 취소: `abortSignal`. 실행 중 사용자 메시지 삽입은 `experimental_steering`(스텝 경계에서 주입, `tool-loop-agent.ts:34-40`).

### 2.3 세션/상태 영속

**세션 스토어 인터페이스: not found (ai core).** `Agent.generate/stream` 은 `prompt | messages` 를 받는 무상태 호출이고(`agent/agent.ts:36-65`) 히스토리 소유권은 호출자에게 있다. UI 스트림 종료 콜백(`ui-message-stream/ui-message-stream-on-finish-callback.ts`)에서 호출자가 저장하는 패턴. 내구성은 별도 패키지 `@ai-sdk/workflow`.

### 2.4 도구·HITL

- 도구 필드(`provider-utils/src/types/tool.ts:67-217`): `description, inputSchema(FlexibleSchema), contextSchema, needsApproval, onInputStart/onInputDelta/onInputAvailable, toModelOutput, strict, inputExamples, deferLoading, providerOptions, metadata`. 타입: function / dynamic / provider.
- `toModelOutput`: 도구의 "전체 결과"(UI/저장용)와 "모델이 보는 결과"를 분리하는 훅 — 컨텍스트 절약의 핵심 장치(`tool.ts:157`, `content/docs/03-agents/06-subagents.mdx:183-229`).
- HITL: 도구별 `needsApproval`(`tool.ts:115`) 또는 실행 전역 `toolApproval` 정책. 상태값 `'not-applicable' | 'approved' | 'denied' | 'user-approval'` (+reason)(`generate-text/tool-approval-configuration.ts:13-36`). 승인이 필요하면 루프가 멈추고, 클라이언트가 승인 응답을 메시지에 실어 다시 호출. 스트림 청크 `tool-approval-request` / `tool-approval-response` / `tool-output-denied`.

### 2.5 컨텍스트 관리

- instructions(구 `system`) 정적 값 + `prepareCall`/`prepareStep` 로 동적 교체. `runtimeContext`(사용자 정의), `toolsContext`(도구별 컨텍스트).
- 히스토리 축약: `pruneMessages({ reasoning, toolCalls, emptyMessages })` — 마지막 N개 메시지 이전의 reasoning/tool call 을 제거하는 유틸(`generate-text/prune-messages.ts:17-36`). **요약형 compaction: not found** (ai core; `agent/`, `generate-text/` grep 결과 없음. harness 규격의 `HarnessV1Session` 이 compaction 을 다룬다고 문서에 명시 — `architecture/harness-abstraction.md`).
- 프롬프트 캐싱: 제공자 옵션 패스스루(`packages/anthropic/src/anthropic-api.ts:113` `cache_control`).

### 2.6 메모리

코어 추상화 없음. 공식 문서가 3가지 접근을 제시(`content/docs/03-agents/06-memory.mdx`): provider-defined tool(Anthropic Memory Tool), 외부 memory provider(Letta, Mem0 등), custom tool.

### 2.7 멀티 에이전트

handoff 프리미티브 없음. **subagent = 도구의 `execute` 안에서 다른 에이전트를 호출**하는 패턴(`content/docs/03-agents/06-subagents.mdx`): 독립 컨텍스트에서 실행, `toModelOutput` 으로 요약만 부모에게 전달. 문서가 명시한 제약: 서브에이전트 안에서는 tool approval 불가, 컨텍스트 격리(`06-subagents.mdx:333-341`).

### 2.8 스트리밍 프로토콜

- 서버 내부 `TextStreamPart`(`generate-text/stream-text-result.ts:486-658`): `start, start-step, text-start/delta/end, reasoning-start/delta/end, tool-input-start/delta/end, tool-call, tool-result, tool-error, tool-output-denied, source, file, steering-message, finish-step, finish, abort, error, raw`.
- 클라이언트용 UI message chunk(SSE, zod 스키마, `ui-message-stream/ui-message-chunks.ts:30-246`): `start, start-step, text-*, reasoning-*, tool-input-start/delta/available/error, tool-approval-request/response, tool-output-available/error/denied, source-url, source-document, file, data-*, steering-message, finish-step, finish, abort, error, message-metadata`.
- 특징: **run → step → part(start/delta/end)** 3단 중첩이 프로토콜에 그대로 드러난다.

### 2.9 가드레일·evals·관측

- 가드레일: 1급 개념 없음. `wrapLanguageModel` 미들웨어(`packages/ai/src/middleware/`)와 `toolApproval` 로 대체.
- evals: **not found** (패키지 목록에 없음).
- 관측: `telemetry` 옵션 + dispatcher(`packages/ai/src/telemetry/`), OpenTelemetry 는 `packages/otel`(`@opentelemetry/api` 의존).

---

## 3. mastra-ai/mastra

핵심 소스: `packages/core/src/{agent,loop,processors,memory,storage,evals,stream}`, `packages/memory`, `packages/evals`, `observability/*`.

### 3.1 핵심 추상화

`Mastra`(레지스트리) · `Agent`(`agent/types.ts:632-1017`) · `Memory` · storage domain · `Processor` · `Workflow`/`createStep` · tool(`createTool`) · scorer · `RequestContext`.

Agent 설정 키(`agent/types.ts`): `id, name, description, instructions(:650), model(:733, ModelWithRetries[] 폴백 가능), maxRetries(:738), tools(:742), workflows(:752), defaultOptions(:777), agents(:815), scorers(:819), memory(:824), skills(:874), inputProcessors(:938), outputProcessors(:944), maxProcessorRetries(:952), errorProcessors(:964), requestContextSchema(:987), backgroundTasks(:992), goal(:1017)`. 거의 전부 `DynamicArgument`(요청 컨텍스트의 함수).

### 3.2 Run loop — "루프 자체가 워크플로"

- 형태(`loop/loop-builder.ts`): 1회 반복 워크플로 = `llmExecutionStep → .map → .foreach(toolCallStep, {concurrency}) → llmMappingStep → backgroundTaskCheckStep → signalDrainStep → isTaskCompleteStep → goalStep`(`:331-420`). 바깥은 `.dowhile(iterationWorkflow, predicate)`(`:759`).
- 계속/중단 판정은 `decideContinuation`(`loop/shared/continuation-core.ts`, 호출부 `loop-builder.ts:593-613`).
- 종료 조건: `maxSteps`(문서상 기본 5 — `docs/src/content/en/reference/agents/generate.mdx:1489`), `stopWhen`(AI SDK 와 동일 개념, `loop/types.ts:298`), abort(`loop-builder.ts:580-590`), `onIterationComplete` 훅의 `{continue, feedback}` 반환(`agent/agent.types.ts:349-361`), `isTaskComplete`(scorer 기반 완료 판정), `goal`, 프로세서 tripwire.
- 스텝별 훅 = **Processor**(`processors/index.ts:648-905`): `processInput`(:723), `processInputStep`(:751, 스텝마다 — AI SDK `prepareStep` 대응), `processLLMRequest`(:794), `processLLMResponse`(:818), `processOutputStream`(:730), `processOutputStep`(:835), `processOutputResult`(:739), `processAPIError`(:875). 프로세서는 `abort(reason)` 으로 tripwire 를 걸거나(`:68`) `abort({retry: true})` 로 자기 교정 재시도(`:829-843`, 상한 `maxProcessorRetries`).
- 병렬 도구: `toolCallConcurrency`(`loop/types.ts`), foreach 의 concurrency 로 구현(`loop-builder.ts:388-411`). 승인 정책이 걸리면 순차로 떨어짐(`:400-404` 주석).
- 재시도/폴백: `maxRetries`, 모델 폴백 배열, `errorProcessors`.
- 취소: `abortSignal`/`runAbortSignal`, 스트림 청크 `abort`.

### 3.3 세션/상태 영속

thread(대화) + resource(사용자) 2단 키. Memory storage domain 이 구현해야 하는 추상 메서드(`storage/domains/memory/base.ts`): `getThreadById(:83), saveThread(:146), updateThread(:157), deleteThread(:243), listMessages(:245), listMessagesById(:261), saveMessages(:263), updateMessages(:268), listThreads(:292)` + 선택 `deleteMessages, cloneThread, getResourceById/saveResource/updateResource(:477-493)` + observational memory 계열(:540~). suspend/resume 은 워크플로 스냅샷(`storage/workflow-snapshot.ts`)으로 저장.

### 3.4 도구·HITL

- `createTool({ id, description, inputSchema, outputSchema, suspendSchema, resumeSchema, requireApproval, execute })`(`tools/types.ts:786-793`). `toModelOutput`(`:551`), `strict`(`:536`).
- HITL 두 갈래: (a) 승인 — 도구별 `requireApproval` 또는 실행 전역 `requireToolApproval`(`loop/types.ts`), 청크 `tool-call-approval`; (b) 도구가 실행 중 스스로 `suspend(payload)` 호출(`tools/types.ts:251`), 청크 `tool-call-suspended`. 재개는 `agent.resumeStream()` / `resumeGenerate()`(`agent/agent.ts:11933, 12242`). 가이드: `docs/src/content/en/docs/agents/human-in-the-loop.mdx`.

### 3.5 컨텍스트 관리

- instructions 는 `DynamicArgument` — `RequestContext`(스키마 검증 가능, `agent/types.ts:987`)의 함수.
- 히스토리 한도: `lastMessages`(기본 10, **deprecated** — "Counting messages is a poor proxy for context size") → `messageHistory: { maxTokens }` 토큰 예산으로 오래된 것부터 제거, 저장소에는 남김(`memory/types.ts:1033-1060`).
- 압축: observational memory(아래).
- 프롬프트 캐싱: `memory/processor-caching.test.ts` 가 있으나 **구현은 분석하지 않음**.

### 3.6 메모리 (4종, `memory/types.ts:1047-1132`)

| 종류                  | 내용                                                                                                                           | 기본      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- | ------- |
| message history       | 최근 대화. 토큰 예산 트리밍                                                                                                    | on        |
| `semanticRecall`      | 벡터 임베딩으로 과거 메시지 RAG. `topK, messageRange, scope: 'resource'                                                        | 'thread'` | **off** |
| `workingMemory`       | 사용자 프로필/선호의 구조화 레코드(Markdown 템플릿 또는 zod 스키마). 에이전트가 도구로 갱신. scope thread/resource             | 설정 시   |
| `observationalMemory` | Observer 에이전트가 관찰을 추출하고 Reflector 가 커지면 압축. 예시 임계값 `messageTokens: 20_000`, `observationTokens: 90_000` | off       |

구현은 전부 프로세서(`processors/memory/{message-history,semantic-recall,working-memory}.ts`, `packages/memory/src/processors/observational-memory/`) — **메모리 = 입력/출력 프로세서**라는 구조.

### 3.7 멀티 에이전트

- `agents`: 서브에이전트를 도구로 노출(위임). 훅 `onDelegationStart / onDelegationComplete / messageFilter`(`agent/agent.types.ts:376-424`), 위임 시 `modifiedMaxSteps` 등 조정 가능.
- `workflows`: 워크플로를 도구로 노출. `loop/network/`: 라우팅 에이전트(청크 `routing-agent-*`, `agent-execution-*`).
- handoff(제어 이전) 프리미티브: **not found**.

### 3.8 스트리밍 프로토콜

`ChunkType`(`stream/types.ts:1000-1046`): `start, step-start, text-start/delta/end, reasoning-*, tool-call-input-streaming-start/end, tool-call-delta, tool-call, tool-call-approval, tool-call-suspended, tool-call-resumed, tool-result, tool-error, tool-output-denied, source, file, step-finish, finish, error, abort, tripwire, is-task-complete, goal` + 백그라운드 태스크/워크플로/네트워크 청크군. AI SDK 와 같은 어휘에 approval/suspend/tripwire 가 추가된 형태.

### 3.9 가드레일·evals·관측

- 가드레일 = 프로세서. 내장: `moderation`, `language-detector`, `classifier`, `file-upload` 등(`processors/processors/`). 위반 시 tripwire.
- evals = scorer. 파이프라인 `preprocess → analyze → generateScore → generateReason`(`evals/base.ts:324-331`). `packages/evals/src/scorers/{code,llm,prebuilt}`. 에이전트에 `scorers` 로 붙여 라이브 스코어링, `isTaskComplete` 로 루프 종료 판정에도 재사용.
- 관측: `observability/{otel-exporter, otel-bridge, langfuse, langsmith, braintrust, datadog, sentry, arize, posthog, ...}`. OTel 지원.

---

## 4. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@0.3.332`)

> 근거: `claude-agent-sdk-npm/package/sdk.d.ts`(이하 `sdk.d.ts`), https://code.claude.com/docs/en/agent-sdk/overview , https://code.claude.com/docs/en/agent-sdk/agent-loop (둘 다 `platform.claude.com/docs/en/agent-sdk/*` 에서 307 리다이렉트). **루프 구현 코드는 비공개 번들이라 읽지 못함.**

### 4.1 핵심 추상화

- `query({ prompt, options }) → Query extends AsyncGenerator<SDKMessage>`(`sdk.d.ts:3221, 3664`). `Query` 는 `interrupt(), setPermissionMode(), setModel()` 등 제어 메서드를 가진다(`:3235-3277`).
- `Options`(`sdk.d.ts:1663~`): `systemPrompt, model, fallbackModel, effort, thinking, tools, allowedTools, disallowedTools, canUseTool, permissionMode, hooks, agents, mcpServers, maxTurns, maxBudgetUsd, taskBudget, resume, continue, forkSession, sessionId, sessionStore, persistSession, settingSources, skills, plugins, sandbox, outputFormat, includePartialMessages, abortController, enableFileCheckpointing ...`
- `AgentDefinition`(서브에이전트, `sdk.d.ts:40~`): `description, prompt, tools, disallowedTools, model, mcpServers, skills, maxTurns, autoCompactWindow, background, memory, effort, permissionMode`.
- 커스텀 도구: `tool(name, description, zodShape, handler)` + `createSdkMcpServer()`(`sdk.d.ts:10812, 671`) — **in-process MCP 서버**로 등록.

### 4.2 Run loop (공식 문서 기준)

1. prompt 수신 → `SystemMessage(init)` 2. 모델 평가 → `AssistantMessage` 3. 도구 실행 → `UserMessage(tool result)` 4. 반복 5. 도구 호출 없는 응답 → `ResultMessage`.

- **turn** = 루프 1회전. `maxTurns` 는 "도구 호출이 있는 턴 수 + 마지막 텍스트 턴 1".
- 종료 = `ResultMessage.subtype`(`sdk.d.ts:6389`): `success | error_max_turns | error_max_budget_usd | error_during_execution | error_max_structured_output_retries`. 모든 변형이 `total_cost_usd, usage, num_turns, session_id, stop_reason` 을 가진다 — **종료 사유가 타입으로 구분되고, 실패해도 비용·재개 정보가 남는다.**
- 한도: `maxTurns`(기본 무제한), `maxBudgetUsd`(USD 추정치, 응답 도착 후 비교하므로 1응답분 초과 가능), `taskBudget`(`sdk.d.ts:2085`). 문서: "Setting a budget is a good default for production agents."
- 병렬 도구: read-only 도구는 동시, 상태 변경 도구는 순차. 커스텀 도구는 기본 순차이고 `readOnlyHint` 어노테이션을 주면 병렬.
- 에러/재시도: `SDKAPIRetryMessage`, `fallbackModel`, 모델 거부 시 `SDKModelRefusalFallbackMessage`(`sdk.d.ts:6026`).
- 취소: `abortController`, `query.interrupt()`.

### 4.3 세션 스토어 인터페이스 (`sdk.d.ts:7440-7520`, 예제 `examples/session-stores/{postgres,redis,s3}`)

```ts
append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>   // 필수
load(key: SessionKey): Promise<SessionStoreEntry[] | null>             // 필수
listSessions?(projectKey): Promise<{sessionId, mtime}[]>
listSessionSummaries?(projectKey)
delete?(key)
listSubkeys?({projectKey, sessionId})   // 서브에이전트 트랜스크립트
```

설계 포인트: (a) **append-only JSONL 트랜스크립트** — 엔트리는 불투명 JSON, `uuid` 가 멱등 키; (b) 로컬 디스크가 1차 기록이고 스토어는 미러(dual-write); (c) 실패 시 3회 재시도 후 batch drop + `mirror_error` 메시지; (d) `resume / continue / forkSession / resumeSessionAt` 은 전부 이 로그 위의 연산.

### 4.4 도구·권한·HITL

- 권한 평가 계층: `allowedTools`(자동 승인) / `disallowedTools`(차단) / 규칙(`"Bash(npm *)"`) / `permissionMode`(`'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto' | 'bypassPermissions'`, `sdk.d.ts:2701`) / `canUseTool` 콜백.
- `canUseTool(toolName, input, {signal, suggestions, decisionReason, ...}) → PermissionResult`(`sdk.d.ts:246, 2726-2738`): `{behavior:'allow', updatedInput?, updatedPermissions?}` 또는 `{behavior:'deny', message, interrupt?}`. 거부 메시지는 **도구 결과로 모델에 전달**되어 모델이 다른 경로를 시도.
- 훅의 `PreToolUse` 도 `permissionDecision: 'allow' | 'deny' | 'ask' | 'defer'` 를 낼 수 있다(`sdk.d.ts:1075, 2991`).
- 사용자 질문은 도구(`AskUserQuestion`)로 승격, `onElicitation`(`sdk.d.ts:1896`).

### 4.5 컨텍스트 관리

- `systemPrompt`: `string | string[] | {type:'preset', preset:'claude_code', append?} | {type:'custom', ...}`(`sdk.d.ts:2620-2630`). 배열에 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 를 넣어 **정적(캐시 가능) 접두부와 동적(세션별) 접미부를 명시적으로 분리**(`sdk.d.ts:2519-2555`).
- 프롬프트 캐싱은 자동: "Content that stays the same across turns (system prompt, tool definitions, CLAUDE.md) is automatically prompt cached"(agent-loop 문서).
- 자동 compaction: 컨텍스트 한계 근접 시 오래된 히스토리를 요약, `compact_boundary` 메시지 방출, `PreCompact`/`PostCompact` 훅. 문서의 경고: 초기 프롬프트의 지시는 compaction 에서 보존되지 않을 수 있으므로 **지속 규칙은 매 요청 재주입되는 CLAUDE.md 에 둘 것**.
- 훅으로 컨텍스트 주입: `UserPromptSubmit` 의 `additionalContext`(`sdk.d.ts:2834~`).
- 도구 스키마 지연 로딩: `ToolSearch`(MCP 도구는 기본 defer).

### 4.6 메모리

CLAUDE.md(`settingSources` 로 로드, 매 요청 재주입), 에이전트별 메모리 디렉터리(`AgentDefinition.memory: 'user' | 'project' | 'local'`, `sdk.d.ts:96`), `SDKMemoryRecallMessage`. 파일 기반.

### 4.7 멀티 에이전트

**subagent 만 있고 handoff 는 없다.** `agents: Record<string, AgentDefinition>` 로 정의, `Agent` 도구로 호출. 격리된 컨텍스트에서 실행되고 "returns only its final response". `background: true` 로 비차단 실행. 예산 상한은 서브에이전트 지출을 포함.

### 4.8 스트리밍 프로토콜

`SDKMessage` 유니온(`sdk.d.ts:6026`). 핵심 5종: system(`init`), assistant, user, stream_event(`includePartialMessages` 켰을 때의 원본 API 델타), result. 그 외 관측용: `compact_boundary, status, api_retry, tool_progress, task_started/updated/progress/notification, hook_started/progress/response, rate_limit, permission_denied, memory_recall, informational ...`.

### 4.9 가드레일·evals·관측

- 가드레일이라는 이름의 추상화는 없음. 대응물은 **훅 + 권한 + 샌드박스**. 훅 이벤트 34종(`sdk.d.ts:1036`); 자주 쓰는 것: `PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, UserPromptSubmit, Stop, SubagentStart/Stop, PreCompact/PostCompact, SessionStart/End, PermissionRequest`. 훅은 호스트 프로세스에서 실행되어 컨텍스트를 소비하지 않는다.
- evals: **not found** (SDK 표면).
- 관측: 타입 주석에 OpenTelemetry 이벤트 언급(`prompt.id` 속성, `tool_decision` OTel events, `otelHeadersHelper` — `sdk.d.ts:198, 2680, 9635`). **SDK 차원의 트레이싱 API 는 확인하지 못함** — OTel 은 Claude Code 바이너리의 설정으로 보임.

---

## 5. langchain-ai/langgraphjs (런타임 아이디어만)

- **State graph**: 노드가 공유 state(채널 + reducer)를 갱신. 실행기는 Pregel super-step(`libs/langgraph-core/src/pregel/`). 무한 루프 방지는 `recursionLimit` 기본 25(`pregel/index.ts:2243`).
- **Checkpoint/persistence**: `BaseCheckpointSaver` 가 구현할 것 — `getTuple, list, put, putWrites, deleteThread`(`libs/checkpoint/src/base.ts:200-239`). 키는 `thread_id` + `checkpoint_id` + `parent_checkpoint_id`(`libs/checkpoint-sqlite/src/index.ts:22-24`) → super-step 마다 스냅샷, 부모 포인터로 time-travel/fork. 내구성 수준 `Durability = "exit" | "async" | "sync"`(`pregel/types.ts:35`). SQLite/Postgres/Redis/MongoDB 구현 제공.
- **Interrupt(HITL)**: 노드 안에서 `interrupt(value)` 를 호출하면 `GraphInterrupt` 를 던져 체크포인트에 멈추고, `new Command({ resume })` 로 재호출하면 `interrupt()` 가 그 값을 반환하며 이어짐(`interrupt.ts:62-92`, `constants.ts:575`). 승인뿐 아니라 "임의의 질문-응답"에 쓰이는 범용 중단점.
- **장기 메모리**: 체크포인트(스레드 단위)와 분리된 `BaseStore`(namespace/key: `get, search, put, delete, listNamespaces` — `libs/checkpoint/src/store/base.ts:407-544`).
- **스트림 모드**: `"values" | "updates" | "debug" | "messages" | "checkpoints" | "tasks" | "custom" | "tools"`(`pregel/types.ts:25-33`).
- 멀티 에이전트: `libs/langgraph-supervisor`(매니저), `libs/langgraph-swarm`(handoff).
- 가져갈 아이디어는 그래프가 아니라 **"실행 상태를 스텝 경계에서 스냅샷 → 중단/재개가 같은 메커니즘"** 한 가지.

---

## 6. 공식 가이던스 요약

모든 페이지를 2026-11-26 에 fetch. `anthropic.com/engineering` 목록 페이지에서 현재 URL 경로가 `/research/...` 로 표시됨. 아래 URL 은 실제로 fetch 에 성공한 주소 그대로다(6.1–6.3 은 `/engineering/...`, 6.4–6.8 은 `/research/...`).

### 6.1 Anthropic — Building effective agents (2024-12-19)

https://www.anthropic.com/engineering/building-effective-agents

- **workflow**(미리 정한 코드 경로로 LLM·도구를 오케스트레이션) vs **agent**(LLM 이 스스로 과정과 도구 사용을 지휘). 가장 단순한 해법에서 시작하고 필요할 때만 복잡도 추가.
- 빌딩 블록 = augmented LLM(검색·도구·메모리). 워크플로 패턴 5종: prompt chaining, routing, parallelization(sectioning/voting), orchestrator-workers, evaluator-optimizer.
- 자율 에이전트: 매 스텝 환경의 ground truth(도구 결과)를 얻고, 체크포인트/막힘에서 사람에게 돌아가며, **최대 반복 수 같은 stopping condition** 으로 통제.
- 프레임워크: 추상화가 프롬프트/응답을 가려 디버깅을 어렵게 함 → LLM API 직접 사용으로 시작, 쓴다면 내부 코드를 이해할 것.
- 3원칙: simplicity, transparency(계획 스텝을 드러냄), 공들인 ACI(agent-computer interface). 도구 설계: 모델 입장에서 사용법이 자명한가, 예시·엣지케이스 포함, poka-yoke(예: 절대경로 강제).

### 6.2 Anthropic — Effective context engineering for AI agents (2025-09-29)

https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

- 컨텍스트는 "finite resource with diminishing marginal returns"(context rot, attention budget). 목표는 원하는 결과 확률을 최대화하는 **가장 작은 고신호 토큰 집합**.
- system prompt 는 "right altitude"(하드코딩된 if-else 와 막연한 지침 사이). 최소 프롬프트로 시작해 관찰된 실패에만 지시 추가.
- 도구: 겹치지 않고 자족적이며 토큰 효율적일 것. 사람이 어떤 도구를 쓸지 못 고르면 에이전트도 못 고른다.
- 검색: 사전 임베딩 검색 vs **just-in-time**(경량 식별자만 들고 있다가 도구로 로드). 하이브리드가 권장되며, **법률·금융처럼 덜 동적인 도메인에 하이브리드가 적합**하다고 명시.
- 장기 작업 3기법: compaction(요약 후 재시작. recall 먼저, precision 나중. 가장 가벼운 형태는 tool result clearing), structured note-taking(컨텍스트 밖 노트 = agentic memory), sub-agent(깨끗한 컨텍스트에서 수만 토큰 쓰고 **1,000–2,000 토큰 요약**만 반환).

### 6.3 Anthropic — Writing effective tools for agents (2025-09-11)

https://www.anthropic.com/engineering/writing-tools-for-agents

- 도구 = 결정적 시스템과 비결정적 에이전트 사이의 계약. API 엔드포인트를 그대로 감싸지 말고 고영향 워크플로 단위로 통합(`list_contacts` 보다 `search_contacts`).
- 네임스페이싱(서비스/리소스 접두), 고신호 필드 반환(UUID 보다 자연어 식별자), `response_format: concise | detailed`, pagination/filter/truncation 기본값 — **Claude Code 는 도구 응답을 기본 25,000 토큰으로 제한**. 잘린 경우 더 좁은 검색을 유도하는 안내문. 에러는 고칠 방법을 알려주는 문장으로.
- 프로세스: 프로토타입 → 현실적 다단계 태스크로 eval → 트랜스크립트를 에이전트와 함께 분석해 도구 개선(held-out 세트).

### 6.4 Anthropic — Effective harnesses for long-running agents (2025-11-26)

https://www.anthropic.com/research/effective-harnesses-for-long-running-agents

- compaction 만으로는 부족. 실패 패턴: 한 번에 다 하려다 중간에 컨텍스트 소진 / 진행분을 보고 조기 완료 선언.
- 해법: initializer 세션이 환경·기능 목록(JSON)·진행 로그를 만들고, 이후 세션은 **한 번에 한 기능** + 세션 시작 루틴(로그·목록 읽기 → 기본 테스트) + 종료 시 커밋·진행 기록. 상태를 컨텍스트가 아니라 **아티팩트 파일**에 둔다.

### 6.5 Anthropic — Harness design for long-running application development (2026-03-24)

https://www.anthropic.com/research/harness-design-long-running-apps

- planner / generator / evaluator 3 에이전트. 자기 평가는 관대하므로 **평가자를 분리**하는 것이 강한 레버.
- compaction vs context reset("context anxiety").
- 핵심 원칙: **"하네스의 모든 구성요소는 모델이 혼자 못 하는 것에 대한 가정을 인코딩한다"** → 새 모델이 나오면 구성요소를 하나씩 빼 보며 load-bearing 여부를 확인. 실제로 Opus 4.6 에서 sprint 구조를 제거.
- 비용 감각: solo 20분/$9 vs full harness 6시간/$200.

### 6.6 Anthropic — Scaling Managed Agents: Decoupling the brain from the hands (2026-04-08)

https://www.anthropic.com/research/managed-agents

- 3개의 가상화된 인터페이스: **session**(append-only 이벤트 로그), **harness**(Claude 를 부르고 tool call 을 라우팅하는 루프, 무상태·일회용), **sandbox**(실행 환경). hands 는 `execute(name, input) → string` 하나로 호출.
- **"The session is not Claude's context window"**: compaction/trimming 은 비가역이므로, 내구 로그(저장)와 컨텍스트 조립(하네스)을 분리. 하네스는 `getEvents()` 로 슬라이스를 읽어 변환 후 컨텍스트에 넣는다. 크래시 복구는 `wake(sessionId)` → 로그에서 재개.
- 자격증명은 모델 생성 코드가 닿는 곳에 두지 않는다.

### 6.7 Anthropic — Demystifying evals for AI agents (2026-01-09)

https://www.anthropic.com/research/demystifying-evals-for-ai-agents

- 용어: task, trial, grader, transcript, outcome, eval harness, agent harness, suite. "에이전트를 평가한다" = 하네스+모델을 평가.
- grader: code-based(빠르고 객관적, 취약) / model-based(유연, 캘리브레이션 필요) / human. capability eval vs regression eval. pass@k vs pass^k.
- 로드맵: **실제 실패에서 뽑은 20–50개 단순 태스크로 일찍 시작**, 경로가 아니라 산출물을 채점, 깨끗한 환경에서 trial 격리, 트랜스크립트를 직접 읽을 것.

### 6.8 Anthropic — The components of agent memory (2026-11-06)

https://www.anthropic.com/research/components-of-agent-memory

- 4계층: **transcripts**(검색 가능한 이벤트 로그, 원본 ground truth) → **memory notes**(세션 중 에이전트가 쓰는 파일) → **memory representations**(위키형 구조화 산출물, 주로 오프라인 "dreaming" 이 작성) → **injected context**(매 세션 선적재되는 작은 인덱스; Claude Code 는 `MEMORY.md` 의 첫 200줄/25KB 만 로드).
- compaction 은 메모리의 정의에서 제외.
- 권고: 메모리가 "무엇을 위한 것인지"를 말하고 사용법은 강제하지 말 것 / 다시 읽을 수 있는 것은 저장하지 말 것 / injected context 는 작게 / **transcript 검색을 기반으로 유지**. 실패 모드: 무차별 기록으로 인한 비대, 잘못된 노트의 전파, drift, 동시 쓰기 덮어쓰기.

### 6.9 Anthropic — Building agents with the Claude Agent SDK (2025-09-29)

https://claude.com/blog/building-agents-with-the-claude-agent-sdk (anthropic.com/engineering 경로에서 308 리다이렉트)

- 루프: gather context → take action → verify work → repeat. agentic search 로 시작하고 semantic search 는 필요할 때만. 검증은 규칙 기반 피드백이 최선, LLM judge 는 "generally not a very robust method".

### 6.10 OpenAI — A practical guide to building agents (PDF, 생성일 2025-04-07, 34쪽)

https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf — WebFetch 는 바이너리만 반환해 저장된 PDF 를 로컬 `pdftotext` 로 추출해 읽음(reachable).

- agent = model + tools + instructions. 도구 3분류: **data / action / orchestration**(에이전트 자체가 도구).
- "Every orchestration approach needs the concept of a 'run', typically implemented as a loop that lets agents operate until an exit condition is reached." exit condition: tool call, 특정 구조화 출력, 에러, **최대 턴 수**.
- "maximize a single agent's capabilities first". 분리 신호: 조건 분기가 많은 프롬프트, **겹치는 도구**(수가 아니라 유사성이 문제).
- 멀티 에이전트 2패턴: manager(agents as tools) / decentralized(handoff).
- 가드레일 = 계층 방어: relevance classifier, safety classifier, PII filter, moderation, **tool safeguards(read-only vs write·가역성·금전 영향으로 low/medium/high 위험 등급)**, rules-based(blocklist/길이/regex), output validation. 낙관적 실행 + tripwire 예외.
- 사람 개입 트리거 2가지: 실패 임계 초과, 고위험 행동.

### 6.11 보조 (fetch 하지 않음 — 2차 출처임을 명시)

Messages API 세부(compaction `compact_20260112`, context editing `clear_tool_uses_20250919`, mid-conversation `role:"system"` 메시지, `task_budget`, memory tool `memory_20250818`, tool runner, preserved thinking 의 append-only 요건)는 Claude Code 번들 `claude-api` 스킬 문서(SKILL.md, `shared/agent-design.md`, 캐시 일자 2026-11-03)에서 읽었다. **platform.claude.com 원문으로는 교차 확인하지 않았다.** §8 의 해당 항목은 구현 전에 원문 확인 필요.

---

## 7. (a) 수렴한 아키텍처

3개 이상의 출처가 동의하는 구성요소와 각자의 이름. `—` = 없음/찾지 못함.

| #   | 구성요소                                                                | OpenAI Agents JS                                           | Vercel AI SDK                                              | Mastra                                              | Claude Agent SDK                          | LangGraph JS                        | 가이던스                                                                       |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| 1   | **Agent = 무상태 선언적 설정**(instructions+model+tools), 실행자와 분리 | `Agent` / `Runner`                                         | `ToolLoopAgent` settings / `generateText`                  | `Agent` / loop workflow                             | `Options` + `AgentDefinition` / `query()` | graph 정의 / Pregel                 | OpenAI 가이드 "model+tools+instructions"                                       |
| 2   | **Run loop + 명명된 반복 단위**                                         | turn (`NextStep` 상태기계)                                 | step (`do…while`)                                          | step/iteration (`dowhile` 워크플로)                 | turn                                      | super-step                          | "run … implemented as a loop"(OpenAI), "LLMs using tools in a loop"(Anthropic) |
| 3   | **반복 상한**                                                           | `maxTurns` (기본 10)                                       | `stopWhen: isStepCount(n)` (agent 기본 20)                 | `maxSteps` (기본 5)                                 | `maxTurns` (기본 없음)                    | `recursionLimit` (25)               | "maximum number of iterations"(Anthropic), "maximum number of turns"(OpenAI)   |
| 4   | **조합 가능한 stop condition / 예산**                                   | `toolUseBehavior`, `errorHandlers` (예산 —)                | `stopWhen[]`, `hasToolCall`, `timeout`                     | `stopWhen`, `isTaskComplete`, `onIterationComplete` | `maxBudgetUsd`, `taskBudget`              | —                                   | 예산 권고는 Claude 문서만                                                      |
| 5   | **타입으로 구분되는 종료 사유**                                         | `MaxTurnsExceededError` 등 예외 + `interruptions`          | `stoppedBy`, `finishReason`                                | `finishReason`, `tripwire`                          | `ResultMessage.subtype` 5종               | `GraphInterrupt`/recursion error    | —                                                                              |
| 6   | **스텝 직전 컨텍스트/설정 변경 훅**                                     | `callModelInputFilter`                                     | `prepareStep`, `prepareCall`                               | `processInputStep`, `processLLMRequest`             | `UserPromptSubmit`·`PreToolUse` 훅        | 노드 자체                           | context engineering "매 호출마다 curation"                                     |
| 7   | **라이프사이클 관측 훅**                                                | `agent_start/end`, `agent_tool_start/end`                  | `onStepStart/End`, `onToolExecutionStart/End`              | processor 8종, delegation 훅                        | 훅 34종                                   | callbacks                           | transparency 원칙                                                              |
| 8   | **Tool = name+description+스키마+execute, 입력 검증**                   | `tool()` zod, `strict`                                     | `tool()` `inputSchema`, `strict`                           | `createTool` in/out schema                          | `tool()` zod → MCP                        | LangChain tool                      | Writing tools, ACI                                                             |
| 9   | **도구 에러는 예외가 아니라 모델이 읽는 결과**                          | `errorFunction`, `toolErrorFormatter`                      | `tool-error` part                                          | `tool-error` chunk                                  | deny/에러 메시지가 tool result            | ToolNode                            | "actionable errors"                                                            |
| 10  | **병렬 도구 실행 + 동시성 제어**                                        | `maxFunctionToolConcurrency`                               | `toolCallConcurrency`                                      | `toolCallConcurrency`                               | read-only 병렬 / 변경 도구 순차           | 병렬 노드                           | agent-design: read-only 는 parallel-safe                                       |
| 11  | **모델이 보는 결과 ≠ 전체 결과**                                        | `customOutputExtractor`(asTool)                            | `toModelOutput`                                            | `toModelOutput`                                     | 서브에이전트 최종 응답만                  | —                                   | 25k 토큰 캡, `response_format`                                                 |
| 12  | **HITL 승인 = 중단 + 재개 가능한 상태**                                 | `needsApproval` → `interruptions` → `state.approve/reject` | `needsApproval`/`toolApproval` → approval request/response | `requireApproval`, `suspend()`/`resumeStream()`     | `canUseTool`, permission modes            | `interrupt()` + `Command({resume})` | OpenAI "plan for human intervention"                                           |
| 13  | **세션/스레드 스토어(추가 위주의 히스토리)**                            | `Session` (`getItems/addItems/popItem/clearSession`)       | — (호출자 소유)                                            | thread/resource storage domain                      | `SessionStore` (`append/load`)            | checkpointer (`put/getTuple/list`)  | Managed Agents "session = append-only log"                                     |
| 14  | **모델 비노출 run context (DI)**                                        | `RunContext<T>`                                            | `runtimeContext`, `toolsContext`                           | `RequestContext`                                    | hook/canUseTool 클로저                    | `config.configurable`               | —                                                                              |
| 15  | **동적 instructions**                                                   | `instructions: fn`                                         | `prepareCall/prepareStep`                                  | `DynamicArgument`                                   | `systemPrompt` 배열 + dynamic boundary    | —                                   | "right altitude", 최소 프롬프트                                                |
| 16  | **히스토리 축약(trim/compaction)**                                      | `OpenAIResponsesCompactionSession`                         | `pruneMessages` (요약형 —)                                 | `messageHistory.maxTokens`, observational memory    | 자동 compaction + `PreCompact`            | (prebuilt 미분석)                   | compaction / tool result clearing                                              |
| 17  | **세션과 분리된 장기 메모리**                                           | —                                                          | 문서 패턴(memory tool/provider)                            | working / semantic / observational                  | CLAUDE.md, agent memory dir               | `BaseStore`                         | Components of agent memory 4계층                                               |
| 18  | **서브에이전트(agents-as-tools, 격리 컨텍스트, 요약 반환)**             | `agent.asTool()`                                           | tool 안에서 agent 호출                                     | `agents`                                            | `agents` + `Agent` 도구                   | supervisor                          | sub-agent architectures, manager pattern                                       |
| 19  | handoff(제어 이전) — **수렴하지 않음**                                  | `handoffs`                                                 | —                                                          | —                                                   | —                                         | swarm                               | OpenAI decentralized pattern                                                   |
| 20  | **타입 있는 스트리밍 이벤트(run>step>part)**                            | 3종 `RunStreamEvent`                                       | UI message chunks (SSE)                                    | `ChunkType`                                         | `SDKMessage` 유니온                       | stream modes                        | —                                                                              |
| 21  | **가드레일(input/output/tool)**                                         | 4종 + tripwire                                             | middleware, `toolApproval` (1급 —)                         | processors + tripwire                               | hooks + permissions                       | —                                   | OpenAI layered guardrails                                                      |
| 22  | **트레이싱(run>step>llm/tool span) + usage 집계**                       | 자체 span, OTel —                                          | `telemetry` + `@ai-sdk/otel`                               | OTel exporter/bridge 등                             | cost/usage in result, OTel(바이너리)      | LangSmith(미분석)                   | "read the transcripts"                                                         |
| 23  | **evals**                                                               | —                                                          | —                                                          | scorers                                             | —                                         | —                                   | Demystifying evals, OpenAI "set up evals"                                      |
| 24  | **재시도+백오프, AbortSignal 취소**                                     | `retry.maxRetries`(0), `signal`                            | `maxRetries`(2), `abortSignal`                             | `maxRetries`, abort                                 | api_retry, `abortController`              | `retry.ts`, signal                  | —                                                                              |
| 25  | **도구 스키마 지연 로딩(tool search)**                                  | `deferLoading` + tool search                               | `deferLoading`                                             | —                                                   | `ToolSearch`                              | —                                   | agent-design "tool search"                                                     |
| 26  | **내구 실행/체크포인트**                                                | `RunState` 직렬화                                          | `@ai-sdk/workflow`                                         | workflow snapshot                                   | session resume/fork, file checkpointing   | checkpointer                        | Managed Agents `wake(sessionId)`                                               |

관찰:

- **이름은 갈려도 구조는 같다**: (무상태 Agent 설정) + (step/turn 단위 루프) + (추가 전용 세션 로그) + (도구 레지스트리) + (스텝 경계의 훅) + (타입 있는 이벤트 스트림). 6개 출처 전부.
- **step vs turn**: AI SDK/Mastra 는 _step_, OpenAI/Claude 는 _turn_. 둘 다 "모델 호출 1회 + 그에 딸린 도구 실행"을 뜻한다. FinClaw 는 하나만 골라 일관되게 쓰면 된다(Anthropic 쪽 어휘는 _turn_).
- **가드레일은 독립 서브시스템이 아니라 훅의 한 용법**으로 수렴 중(Mastra processors, Claude hooks). 전용 추상화는 OpenAI 뿐.
- **메모리는 세션과 별개 계층**이라는 점은 수렴(#17), 구현은 발산(파일 노트 vs 벡터 vs 구조화 레코드). Anthropic 최신 글은 "transcript 검색이 기반, 그 위에 작은 노트"를 권한다.
- evals 를 런타임에 내장한 것은 Mastra 뿐이지만, 가이던스는 양사 모두 필수로 본다 → **런타임 바깥의 별도 하네스**로 두는 것이 다수파.

---

## 8. (b) FinClaw 가 가져갈 것

전제: 단일 사용자, read-only 금융 도구, TypeScript/Node 22, SQLite, Anthropic Messages API(API key), 채널 = macOS 앱 + 선택적 Discord + cron. 프레임워크 미채택.

먼저 결정할 것 1건: 루프를 **직접 `while` 로 쓸지, `@anthropic-ai/sdk` 의 beta Tool Runner(`client.beta.messages.toolRunner` + `betaZodTool`)에 맡길지.** Tool Runner 는 루프·검증·재시도·스트리밍·compaction 훅을 주지만 beta 다. 아래 "지금" 항목은 어느 쪽이든 필요한 **주변 구조**이고, 직접 쓰는 루프 본체는 50줄 안팎이다. (호스팅형 Managed Agents 는 로컬 SQLite·자체 호스팅 전제와 맞지 않아 범위 밖.)

### 8.1 지금 구현 (v1)

| 구성요소                                                       | 구체 형태                                                                                                                                                                                                                                                              | 근거                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------ | --------- | --------- | ----------------------------------------------------------------------- | ---------------------------------- |
| `AgentConfig` (무상태)                                         | `{ name, instructions(static), model, tools[], maxTurns, budget }` 평범한 객체. 채널/cron 별로 한 개씩                                                                                                                                                                 | 표 #1                                                      |
| `runAgent(config, input, { sessionId, context, signal })` 루프 | `stop_reason` 분기: `tool_use` → 실행 후 계속, `end_turn` → 종료, `max_tokens`/`refusal`/`pause_turn` 은 각각 처리. assistant 응답은 `response.content` **전체를 그대로** 히스토리에 append(thinking 블록 포함, 편집 금지)                                             | 표 #2, §6.11                                               |
| 종료 사유 타입                                                 | `RunResult.status: 'success'                                                                                                                                                                                                                                           | 'max_turns'                                                | 'max_budget' | 'aborted' | 'refusal' | 'error'`+`usage`, `costUsd`, `numTurns`, `sessionId` 를 **모든** 변형에 | 표 #5 (Claude SDK `ResultMessage`) |
| 상한                                                           | `maxTurns`(10–20), 누적 토큰/USD 예산(턴 종료 후 `usage` 합산해 비교), `AbortSignal`, 도구별 timeout                                                                                                                                                                   | 표 #3·#4·#24. cron 무인 실행에 예산은 필수                 |
| 도구 레지스트리                                                | `{ name, description, inputSchema(zod), execute, readOnly: true }` + `strict: true`. 입력 검증 실패/실행 실패는 `tool_result` + `is_error: true` + **고칠 방법이 담긴 문장**                                                                                           | 표 #8·#9, §6.3                                             |
| 병렬 도구 실행                                                 | 전부 read-only 이므로 `Promise.all`. 한 턴의 모든 `tool_result` 를 **단일 user 메시지**로 반환                                                                                                                                                                         | 표 #10                                                     |
| 도구 결과 상한                                                 | 결과 크기 캡 + "잘렸음, 범위를 좁혀 다시 조회" 안내. 기간/종목 필터와 pagination 을 도구 파라미터로                                                                                                                                                                    | 표 #11, §6.3 (25k 토큰 관례)                               |
| 세션 스토어 (SQLite, 구현 1개)                                 | append-only `session_items(session_id, seq, role, content_json, created_at)` + `getItems(sessionId, limit?)` / `appendItems()` / `clear()`. 인터페이스 추출 없이 함수 3개                                                                                              | 표 #13, §6.6 "session ≠ context window"                    |
| run 기록                                                       | `agent_runs(run_id, session_id, channel, status, turns, usage…, cost, started/ended)` — 이미 있으면 재사용                                                                                                                                                             | 표 #22                                                     |
| 컨텍스트 조립                                                  | 정적 system prompt + 정적·정렬된 tool 목록에 cache breakpoint. **날짜·포트폴리오 스냅샷·채널 정보 같은 가변 컨텍스트는 breakpoint 뒤**(user 턴 앞부분 또는 mid-conversation `role:"system"` 메시지). `usage.cache_read_input_tokens` 를 run 기록에 남겨 캐시 적중 확인 | 표 #15, Claude SDK `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, §6.11 |
| run context (DI)                                               | `context: { db, userId, channel, now }` 를 도구 `execute(input, ctx)` 에 전달. 모델에는 안 보냄                                                                                                                                                                        | 표 #14                                                     |
| 이벤트 스트림                                                  | 작은 판별 유니온 하나: `run_start, turn_start, text_delta, tool_call, tool_result, turn_end(usage), run_end(status), error`. mac 앱/Discord/cron 어댑터가 같은 스트림을 소비                                                                                           | 표 #20 (AI SDK chunk 어휘의 부분집합)                      |
| 관측 = 같은 이벤트의 구독자                                    | `onEvent` 콜백 1개로 감사 로그·트레이스(run > turn > llm_call/tool_call, 소요시간·토큰)를 SQLite 에 기록. 별도 훅 체계 없음                                                                                                                                            | 표 #7·#22                                                  |
| 재시도                                                         | Anthropic SDK 내장 `maxRetries`(기본 2) 사용. 직접 구현하지 않음                                                                                                                                                                                                       | 표 #24                                                     |
| 최소 eval                                                      | 실제 실패/대표 질문 20–50개를 fixture 도구 결과로 돌리고 **code-based grader**(기대한 도구가 불렸는가, 답의 수치가 도구 결과와 일치하는가)로 채점                                                                                                                      | §6.7, §6.10                                                |
| 가드레일                                                       | (1) 도구 표면이 read-only 라는 사실 자체, (2) Discord 는 사용자 ID allowlist(인증이지 LLM 가드레일 아님), (3) 출력 측 결정적 검사 1개 — 답변의 수치가 이번 run 의 tool result 에서 왔는지                                                                              | 표 #21, OpenAI "tool safeguards / rules-based"             |

### 8.2 나중에 (필요가 관측되면)

| 구성요소                          | 도입 신호                                                       | 방식                                                                                                                                                                                                |
| --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 히스토리 축약                     | 세션이 길어져 비용/지연이 체감될 때                             | 먼저 오래된 tool result 제거(context editing), 그다음 서버측 compaction. 세션 스토어는 원본을 계속 보관(§6.6) — v1 에서 content 를 통째로 저장해 두면 추가 작업 없음                                |
| 메모리(노트 계층)                 | "지난번에 말한 내 선호/보유 전제"를 반복 설명하게 될 때         | 작은 노트 파일/테이블 + 매 세션 주입되는 **짧은 인덱스**. 사용자 선호·검증된 규칙만. 시세처럼 다시 조회 가능한 것은 저장 금지(§6.8). 과거 대화 검색은 transcript(FTS/기존 임베딩)를 **도구로** 노출 |
| HITL 승인/interrupt               | write 도구(주문, 알림 생성, 외부 전송)를 처음 넣을 때           | 도구에 `needsApproval`, `RunResult.status` 에 `'interrupted'` 추가, 대기 중 승인을 세션에 저장 후 재개. 지금은 슬롯만 비워 둠                                                                       |
| `prepareStep` 류 스텝별 조정      | 턴에 따라 도구 집합/모델을 바꿀 실제 필요가 생길 때             | 루프에 콜백 1개. 단, 도구 집합·모델 변경은 캐시를 깨므로 신중히                                                                                                                                     |
| 서브에이전트(agents-as-tools)     | 한 질문이 수십 건 조회(다종목 리서치)로 메인 컨텍스트를 채울 때 | 도구 `execute` 안에서 `runAgent` 재귀 호출, 1–2k 토큰 요약만 반환. cron 작업은 서브에이전트가 아니라 **별도 run** 으로 충분                                                                         |
| tool search / 지연 로딩           | 도구가 수십 개를 넘고 선택 오류가 관측될 때                     | 그 전에는 도구 통합·네임스페이싱이 먼저(§6.3)                                                                                                                                                       |
| model-based grader, pass^k        | code grader 로 못 잡는 품질(설명의 적절성)이 문제 될 때         | 사람 판정으로 캘리브레이션                                                                                                                                                                          |
| task budget(모델이 인지하는 예산) | 긴 cron 리서치가 예산 상한에 걸려 끊길 때                       | beta 기능, 원문 확인 후                                                                                                                                                                             |

### 8.3 하지 않을 것 (단일 사용자·read-only 에 과함)

- **handoff / 탈중앙 멀티 에이전트, 에이전트 네트워크·라우팅 에이전트** — 6개 중 1.5개만 가진 비수렴 기능(표 #19). "maximize a single agent's capabilities first".
- **그래프 엔진·내구 워크플로 엔진·super-step 체크포인트·time-travel** — append-only 세션 로그로 재개가 충분.
- **직렬화된 RunState 의 스키마 버저닝**(OpenAI `CURRENT_SCHEMA_VERSION` 계열) — 승인 대기 상태가 없는 동안 불필요.
- **멀티 프로바이더 모델 추상화 / 4계층 메시지 변환** — Anthropic SDK 타입(`MessageParam` 등)을 그대로 사용.
- **교체 가능한 세션 스토어 인터페이스와 다중 백엔드** — 구현이 SQLite 하나.
- **샌드박스/harness 어댑터 계층, 권한 모드 매트릭스(6종), 훅 이벤트 수십 종** — 실행 도구도 write 도구도 없음.
- **LLM 기반 입력 가드레일 분류기(relevance/jailbreak/moderation)** — 사용자가 본인 1명. (외부 텍스트를 가져오는 도구가 생기면 그 **도구 결과**에 대한 주입 방어는 별도 검토)
- **OpenTelemetry 익스포터·벤더 연동** — SQLite 트레이스 테이블 + 트랜스크립트 열람으로 충분.
- **observational memory(Observer/Reflector 에이전트), dreaming, 위키형 memory representation** — 다중 세션 코퍼스 규모에서나 이득.
- **planner/generator/evaluator 3 에이전트 하네스** — 장시간 앱 빌드용. Q&A·리포트형 금융 비서에는 과함.

### 8.4 "modern agent architecture" 체크리스트 (FinClaw 채점용)

각 항목 0(없음) / 1(부분) / 2(충족). 26점 만점. ★ = v1 필수.

| #   | 기준                                                                                             | 판정 방법                                                            |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1★  | Agent 설정이 무상태 객체이고 실행 루프와 분리돼 있다                                             | 같은 config 로 두 세션을 동시에 돌려도 간섭 없음                     |
| 2★  | 루프가 명명된 단위(turn)로 돌고, `stop_reason` 을 빠짐없이 분기한다                              | `tool_use/end_turn/max_tokens/refusal/pause_turn` 각각의 테스트 존재 |
| 3★  | 반복 상한 + 비용/토큰 예산 + 취소(AbortSignal) + 도구 timeout 이 모두 있다                       | 각 한도에 걸리는 테스트                                              |
| 4★  | 종료 사유가 타입으로 구분되고, 실패 종료에도 usage·cost·sessionId 가 남는다                      | `RunResult` 유니온                                                   |
| 5★  | 도구가 스키마로 정의·검증되고, 실패가 예외가 아닌 `is_error` 결과로 모델에 돌아간다              | 잘못된 입력 fixture 로 루프가 계속되는지                             |
| 6★  | 한 턴의 여러 tool call 을 병렬 실행하고 결과를 단일 메시지로 돌려준다                            | 동시 실행 테스트                                                     |
| 7★  | 도구 결과에 크기 상한과 범위 축소 안내가 있다                                                    | 대용량 fixture                                                       |
| 8★  | 세션이 append-only 로그로 저장되고(전체 content 블록 보존), 컨텍스트 조립이 저장과 분리돼 있다   | 재시작 후 동일 세션 재개                                             |
| 9★  | system prompt·tool 목록이 바이트 단위로 안정적이고 가변 컨텍스트가 캐시 breakpoint 뒤에 있다     | 연속 run 의 `cache_read_input_tokens > 0`                            |
| 10★ | 모든 채널이 하나의 타입 있는 이벤트 스트림(run > turn > part)을 소비한다                         | mac 앱·Discord·cron 어댑터가 같은 유니온 사용                        |
| 11★ | run > turn > llm/tool 단위 트레이스와 토큰·비용이 조회 가능하게 기록된다                         | 임의 run 의 전 과정을 SQL 로 재구성                                  |
| 12★ | 회귀 eval 세트(20–50 태스크, code-based grader)가 있고 프롬프트/도구 변경 시 돌린다              | 스크립트 1개                                                         |
| 13  | 확장 슬롯이 설계에 있다: 히스토리 축약, 세션과 분리된 메모리, 도구 승인(interrupt), 서브에이전트 | 구현이 아니라 "붙일 자리"가 명확한지(코드 수정 범위가 1–2 파일인지)  |

채점 해석: 1–12 가 모두 2점이면 현행 프레임워크들이 수렴한 코어와 구조적으로 동등하다. 13 은 v1 에서 1점이면 충분.

---

## 9. 찾지 못했거나 확인하지 못한 것

- Claude Agent SDK 의 **루프 구현 소스**: 비공개(번들). 타입 선언과 공식 문서만 근거.
- Claude Agent SDK 의 SDK 수준 트레이싱 API, evals: not found.
- OpenAI Agents JS: 토큰/비용 예산 중단 옵션 not found, OpenTelemetry 의존성 not found, evals not found, JS 용 SQLite Session 구현 not found. `sandbox/memory/*` 는 존재만 확인.
- Vercel AI SDK: core 의 세션 스토어 인터페이스 not found, 요약형 compaction not found(ai core), evals not found. `@ai-sdk/workflow`·`@ai-sdk/harness` 는 README/설계 문서 수준만 읽음.
- Mastra: 프롬프트 캐싱 처리(`memory/processor-caching.test.ts` 존재) 미분석. `maxSteps` 기본 5 는 문서 근거이며 신규 루프 코드에서 기본값 대입 지점은 찾지 못함(`llm/model/model.ts:124` 의 `maxSteps = 5` 는 구 경로로 보임).
- LangGraph JS: prebuilt ReAct 에이전트의 히스토리 축약, LangSmith 연동 미분석(요청 범위상 짧게).
- OpenAI Agents Python: 클론하지 않음. 세션 구현 목록만 `gh api` 로 확인.
- §6.11 의 Messages API 세부는 2차 출처(번들 스킬 문서). platform.claude.com 원문 미확인.
- stars 는 2026-11-26 조회 시점 값.
