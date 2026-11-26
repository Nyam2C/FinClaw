# Lane 2 — 오픈소스 에이전트 하네스의 루프/런타임 아키텍처

> 조사 레인 보고서 원문 (2026-11-26). 요약은 [`../agent-architectures.md`](../agent-architectures.md). 경로 · 줄 번호는 본문 표의 분석 커밋 기준이며, 레포 코드는 실행하지 않고 읽기만 했다.

작성일 2026-11-26. 대상은 "코딩 기능"이 아니라 에이전트 루프와 런타임 설계다.
모든 주장은 shallow clone 한 소스의 경로(:줄)로 근거를 달았다. 줄 번호는 아래 표의 커밋 기준이다.
레포 안의 코드는 실행하지 않았고 읽기만 했다.

## 0. 검증한 레포 메타데이터 (`gh api repos/...`, 2026-11-26 조회)

| 요청한 이름      | 실제(현재) 이름                 | stars   | pushed_at         | 기본 브랜치 | 언어       | 라이선스   | 분석 커밋                      |
| ---------------- | ------------------------------- | ------- | ----------------- | ----------- | ---------- | ---------- | ------------------------------ |
| badlogic/pi-mono | **earendil-works/pi** (이전됨)  | 123,926 | 2026-11-26T02:41Z | main        | TypeScript | MIT        | `db79712` (2026-11-26T02:40Z)  |
| sst/opencode     | **anomalyco/opencode** (이전됨) | 229,237 | 2026-11-26T04:51Z | dev         | TypeScript | MIT        | `44344bd` (2026-11-26T04:51Z)  |
| openai/codex     | openai/codex                    | 136,489 | 2026-11-26T04:48Z | main        | Rust       | Apache-2.0 | `af71942` (2026-11-26T04:00Z)  |
| block/goose      | **aaif-goose/goose** (이전됨)   | 57,006  | 2026-11-26T03:34Z | main        | Rust       | Apache-2.0 | `51f875e` (2026-11-26T03:22Z)  |
| (선택 5번째)     | NousResearch/hermes-agent       | 266,149 | 2026-11-26T04:39Z | main        | Python     | MIT        | `010f119d` (2026-11-26T04:31Z) |

참고로 본 후보: cline/cline 71,905, OpenHands/OpenHands 94,356 (둘 다 위 4개보다 "명확히 더 인기"는 아니어서 제외).
5번째로 hermes-agent 를 고른 이유: `gh search repos` (stars 정렬, 최근 3개월 push) 에서 목록에 없는 하네스 중 유일하게 4개 전부보다 star 가 많다. 다만 코딩 에이전트가 아니라 개인 비서 계열이라 다른 레인과 겹칠 수 있다. 그래서 짧게만 다뤘다.

**먼저 알아둘 것 — 네 레포 모두 통념과 구조가 다르다.**

- pi: 루프 패키지(`packages/agent`)는 여전히 작지만(2.5K LOC), 그 위의 `coding-agent` 는 79K LOC 로 커졌다.
- opencode: `packages/opencode` 가 없다. Effect 기반 `packages/core` 로 재작성됐고 세션은 이벤트 소싱이다.
- goose: `agents/agent.rs` 의 큰 reply 루프가 없다. `oi-kit-agent` 크레이트의 "operation 파이프라인 상태기계"로 바뀌었다.
- codex: `codex-rs/core/src` 만 테스트 제외 약 153K 줄이다. 1인이 감사할 수 있는 크기가 아니다.

## 1. 한눈에 보는 비교

| 항목          | pi                                                     | opencode                                                     | codex                                                     | goose                                                            |
| ------------- | ------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| 루프 위치     | `packages/agent/src/agent-loop.ts` (952줄)             | `packages/core/src/session/runner/{llm,step}.ts` (486+408줄) | `codex-rs/core/src/session/turn.rs` (4,045줄)             | `crates/oi-kit-agent/src/machine.rs` (370줄) + operation 약 25개 |
| 종료 판정     | assistant 메시지에 toolCall 블록이 없고 큐가 비면 종료 | step 의 `needsContinuation` + inbox 가 비면 종료             | `needs_follow_up`(모델) 또는 pending input 이 없으면 종료 | 어떤 operation 도 적용되지 않으면 `Yielded`                      |
| 반복 한도     | 루프 자체엔 없음                                       | agent 별 `steps` (도달 시 tool_choice none)                  | `run_turn` 에서 찾지 못함 (예산 게이트는 있음)            | `GOOSE_MAX_TURNS` 기본 1000                                      |
| 병렬 도구     | 기본 병렬, 도구별 `sequential` 옵트아웃                | 스트림 도중 tool-call 이벤트마다 fiber 로 즉시 실행          | `RwLock`: 병렬 가능 도구는 read, 나머지는 write           | `select_all` 로 동시 실행, 끝나는 대로 기록                      |
| 영속화        | JSONL 트리 (id/parentId)                               | SQLite 이벤트 로그 + 프로젝션 테이블                         | rollout JSONL (+ SQLite state db)                         | SQLite                                                           |
| 컴팩션 트리거 | `tokens > window - 16384`                              | `window - max(15%, 16k)` 초과                                | `min(설정, window 의 90%)`                                | 0.8 × context limit                                              |
| 재시도        | 3회, 2s×2^n, 상한 60s                                  | 10회, 2s 지수 (간격 상한 10s) + retry-after (상한 15분)      | 스트림 5회, 200ms×2^n ±10%                                | 3회, 1s×2, 상한 30s                                              |
| 스티어링      | steer 큐 / followUp 큐                                 | inbox `delivery: steer \| queue`                             | `input_queue` pending input                               | `SteerOperation`                                                 |

## 2. pi (earendil-works/pi, 구 badlogic/pi-mono)

### 2.1 에이전트 루프

위치: `packages/agent/src/agent-loop.ts`. 진입점은 `agentLoop()`(47), `agentLoopContinue()`(80), 본체는 `runLoop()`(172-330).

```
runLoop(context, config, signal, emit):                       # agent-loop.ts:172-330
  pending = await config.getSteeringMessages()                # 185: 시작 시 큐 확인
  while true:                                                 # 188: 바깥 = follow-up
    hasMoreToolCalls = true
    while hasMoreToolCalls or pending.length > 0:             # 192: 안쪽 = tool call + steering
      if lastTurn: config.prepareNextTurn(lastTurn)           # 194-217: 컴팩션 등, context/model 교체 가능
      pending 메시지를 context 에 push, message_start/end emit # 220-226
      config.prepareRequest(...)                              # 228-248
      msg = streamAssistantResponse(...)                      # 251: transformContext → convertToLlm → streamFn
      if msg.stopReason in (error, aborted):                  # 254-265
        finishTurn; emit turn_end, agent_end; return
      toolCalls = msg.content.filter(type == toolCall)        # 268
      if toolCalls:
        batch = (msg.stopReason == "length")
                  ? failToolCallsFromTruncatedMessage()       # 276-279: 잘린 인자는 실행 금지
                  : executeToolCalls()                        # 병렬 또는 순차
        hasMoreToolCalls = !batch.terminate                   # 281
      decision = config.finishTurn(turn)                      # 295: {action: continue|end}
      if decision == end: emit agent_end; return              # 298-301
      pending = await config.getSteeringMessages()            # 304
    followUps = await config.getFollowUpMessages()            # 311
    if followUps: pending = followUps; continue               # 312-317
    if explicitContinuation: continue                         # 320-323
    break
  emit agent_end
```

- **누가 멈추나**: `stopReason` 이 아니라 "assistant 메시지에 `toolCall` 블록이 있는가"로 판단한다(268-287). 도구가 `result.terminate = true` 를 돌려주거나(690-692, 배치의 모든 결과가 terminate 일 때만) `finishTurn` 훅이 `end` 를 주면 끝난다.
- **반복/예산 한도**: `runLoop` 에 카운터가 없다. 전체를 읽었는데 max-iteration 은 **없다**. 한도가 필요하면 호출자가 `finishTurn` 으로 넣는다.
- **병렬 도구 호출**: `executeToolCalls()`(518-533). 설정이 `sequential` 이거나 배치 안에 `executionMode: "sequential"` 도구가 하나라도 있으면 전체를 순차 실행, 아니면 병렬. 병렬 경로(592-660)는 준비(검증·권한 훅)를 순서대로 하고 실행만 `Promise.all` 로 돌린다. 결과 메시지는 원래 호출 순서를 유지한다(646-654).
- **stop reason**: 내부 타입은 `"pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"` (`packages/ai/src/types.ts:503`). Anthropic 매핑은 `packages/ai/src/api/anthropic-messages.ts:1830-1856`: `end_turn→stop`, `max_tokens→length`, `tool_use→toolUse`, `refusal→error`(`stop_details.explanation` 을 errorMessage 로), `pause_turn→stop`, `stop_sequence→stop`, `sensitive→error`, 그 외는 throw.
  - `length` 일 때 tool call 이 있으면 전부 "잘렸을 수 있으니 다시 호출하라"는 에러 결과로 돌려준다(488-513). 스트리밍 JSON 을 best-effort 로 복구하기 때문에 잘린 인자가 스키마 검증을 통과할 수 있다는 것이 이유다(주석 481-487).
  - `pause_turn` 은 주석이 "Stop is good enough -> resubmit" 인데, `agent-loop.ts` 에서 `stop` + tool call 없음은 그냥 종료로 이어진다. 자동 재제출 로직은 **찾지 못했다**.
- **재시도/백오프**: 루프 패키지에는 없다. 상위 `coding-agent/src/core/agent-session.ts` 가 `agent_end` 뒤에 처리한다. 기본값 `maxRetries: 3, baseDelayMs: 2000`, 상한 60초 (`settings-defaults.ts:18-25`, `packages/ai/src/utils/retry.ts:189-195`: `base * 2^(attempt-1)`). 재시도 가능 여부는 에러 문자열 정규식으로 분류한다(`retry.ts:7-120`: overloaded, rate limit, 429/5xx, ECONNRESET 등은 재시도 / quota·billing 은 재시도 안 함). 실패한 assistant 메시지는 원본 히스토리엔 남기고 모델 프로젝션에서만 뺀다(`agent-session.ts:3960` 주석).
- **중단**: `AbortController` 하나가 run 전체를 덮는다(`agent.ts:185, 350-351, 522-527`). 중단 뒤에도 tool call 마다 "Operation aborted" 결과를 만들어 짝 없는 tool call 이 남지 않게 한다(`agent-loop.ts:716-724, 623-631`, 이슈 #9986 언급).
- **스티어링/큐**: `Agent.steer()` 와 `Agent.followUp()` 두 큐(`agent.ts:197-198, 307-315`). steer 는 현재 assistant 턴(도구 실행 포함)이 끝난 직후 주입, followUp 은 에이전트가 멈추려 할 때만 주입. 큐 모드는 `"all" | "one-at-a-time"`(기본 후자, `agent.ts:255-256`). 실행 중 `prompt()` 를 또 부르면 예외(`agent.ts:382-385`).

### 2.2 메시지/상태 모델

- `AgentMessage = Message | 커스텀 메시지`(`packages/agent/src/types.ts:365-374`). 루프는 끝까지 `AgentMessage[]` 로 일하고 LLM 호출 경계에서만 `convertToLlm` 으로 바꾼다(`agent-loop.ts:1-4, 397-404`). UI 전용·커스텀 메시지를 트랜스크립트에 섞어 둘 수 있다.
- 영속화: append-only JSONL. 첫 줄은 `SessionHeader`(`type:"session"`, version 3), 이후 엔트리는 모두 `id` / `parentId` 를 가져 트리가 된다(`coding-agent/src/core/session-manager.ts:41-62, 183-197`). 엔트리 종류: `message`, `thinking_level_change`, `model_change`, `usage`, `compaction`, `branch_summary`, `custom`, `label`, `session_info`, `custom_message`, `context_edit`. 쓰기는 엔트리마다 `appendFileSync`(1199), 첫 기록은 `flushed` 플래그로 지연(1005-1061, 1187-1197).
- resume/fork: `branch(branchFromId)`(1601)로 같은 파일 안에서 분기, 분기 요약 엔트리(1619-1635), `SessionManager.forkFrom()`(1837)으로 새 파일에 복제.

### 2.3 도구 인터페이스

- 정의: `AgentTool`(`types.ts:478-511`) = pi-ai `Tool`(name/description/parameters) + `label`, `execute(toolCallId, args, signal, onUpdate)`, `prepareArguments?`, `executionMode?`, `outputSchema?`. 결과는 `{content, details, structuredContent?, isError?, terminate?}`(424-446). `details` 는 UI·로그용이고 모델에는 `content` 만 간다.
- 스키마 검증: `validateToolArguments()`(`packages/ai/src/utils/validation.ts:54-69`). 실패하면 경로별 메시지와 받은 인자를 담아 throw 하고, 루프가 잡아 에러 tool result 로 만든다(`agent-loop.ts:734-778`).
- 권한/승인: 루프에는 `beforeToolCall`(차단 `{block, reason, terminate}`) 과 `afterToolCall`(결과 교체) 훅만 있다(`types.ts:66-103, 326-341`). 도구가 다른 도구를 부를 때도 같은 훅을 거치도록 `runToolCall()` 을 내보낸다(`agent-loop.ts:804-822`). coding-agent 의 내장 도구에서 호출별 승인 프롬프트는 **찾지 못했다**(`project-trust.ts` 는 프로젝트 신뢰 단위).
- MCP: 별도 패키지 `packages/mcp`(4.9K LOC) + `coding-agent/src/core/mcp-servers.ts`. 세부는 읽지 않았다.

### 2.4 컨텍스트 관리

- 시스템 프롬프트: 이름 붙은 섹션(`preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`)을 `<name>...</name>` 태그로 감싼다(`coding-agent/src/core/system-prompt.ts:128-196`). 날짜·시간은 프롬프트에 **없다**(grep 결과 없음).
- 변동 컨텍스트: 시스템 프롬프트가 세션 중 바뀌면 프리픽스를 고치지 않고 **트랜스크립트에 system 메시지를 추가**한다. `SystemMessage.sections` 가 섹션 패치(`null` 은 삭제), `toolsAdded/toolsRemoved` 가 도구 변경(`packages/ai/src/types.ts:565-589`; diff 는 `system-prompt.ts:216-228`, 사용처 `agent-session.ts:1843`; 루프의 `declareToolChanges` 는 `agent-loop.ts:342-372`).
- 컴팩션 (`coding-agent/src/core/compaction/compaction.ts`):
  - 트리거: `contextTokens > contextWindow - reserveTokens`(267-269), 기본 `reserveTokens 16384`, `keepRecentTokens 20000`(126-129). 토큰 수는 마지막 assistant 응답의 실제 usage + 그 뒤 메시지의 추정치(184-225).
  - 알고리즘: 최신부터 거꾸로 걸으며 추정 토큰을 더하다 `keepRecentTokens` 를 넘으면 그 지점에서 자른다. user 또는 assistant 메시지에서만 자르고 tool result 에서는 자르지 않는다(430-480). 턴 중간에서 잘리면 잘린 턴의 앞부분은 따로 요약(871-879, 프롬프트 933-946).
  - 요약: 고정 템플릿(Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context, 506-536). 이전 요약이 있으면 "기존 요약 갱신" 프롬프트(538-580). `length` 로 끝난 요약은 저장하지 않는다(582-585).
  - 오버플로 복구: 컨텍스트 초과 에러면 실패한 assistant 메시지를 빼고 컴팩션 후 **한 번만** 재시도(`agent-session.ts:3105-3110, 3189-3192`).
- 프롬프트 캐싱 (`packages/ai/src/api/anthropic-messages.ts`): breakpoint 는 (1) system 블록(1377-1397), (2) 마지막 도구 정의(1825), (3) 마지막 user/system 메시지의 마지막 블록(1682-1706). TTL 은 `cacheRetention` 이 `long` 이고 모델이 지원할 때만 `1h`, 아니면 기본(83-106). 도구 목록이 바뀌어도 `tools` 배열은 그대로 두고 `tool_addition` / `tool_removal` 블록으로 표현해 프리픽스를 보존한다(1412-1418).

### 2.5 서브에이전트

`packages/agent` 와 coding-agent core 에서 **찾지 못했다**. `subagent` 문자열은 `coding-agent/src/extensions/codemode/execute.ts` 한 곳뿐이다.

### 2.6 이벤트/스트림 모델

`AgentEvent` 10종(`types.ts:528-551`): `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`. `EventStream<AgentEvent, AgentMessage[]>` 로 내보내고(`agent-loop.ts:162-167`), `message_update` 가 provider 의 델타 이벤트를 그대로 싣는다(433-451). 상위 세션은 `auto_retry_start/end`, `compaction_start` 등을 더한다(`agent-session.ts:223-250`).

### 2.7 프로바이더 추상화

얇지 않다. `packages/ai/src` 29.6K LOC, provider 파일 수십 개(`packages/ai/src/providers/`), API 어댑터는 `packages/ai/src/api/*.ts`(Anthropic 어댑터만 1,856줄). 루프와의 접점은 `StreamFn(model, context, options)` 하나다(`types.ts:33-37`). 에러는 예외가 아니라 `stopReason: "error"` + `errorMessage` 인 assistant 메시지로 흐른다. 분류는 정규식 기반(`utils/retry.ts`, `utils/overflow.ts` 195줄).

### 2.8 테스트/트레이싱

- 스크립트된 가짜 provider `packages/ai/src/providers/faux.ts`(732줄). 루프 테스트 `packages/agent/test/agent-loop.test.ts`(2,357줄), `agent.test.ts`(1,229줄).
- 트레이싱: `packages/telemetry`(1.6K LOC, span 추상화). `packages/evals`(1.4K LOC)는 읽지 않았다.

### 2.9 크기

`packages/agent/src` 2,549줄(agent-loop 952, agent 623, types 551, proxy 398). 런타임 전체로 보면 `coding-agent/src/core` 25,732줄(agent-session 4,579, session-manager 2,040, compaction 1,104).

## 3. opencode (anomalyco/opencode, 구 sst/opencode)

### 3.1 에이전트 루프

`packages/core/src/session/runner/llm.ts`(drain 과 step 정책), `runner/step.ts`(한 번의 시도). Effect 로 작성됐다.

```
drain(sessionID):                                  # llm.ts:71-228, drain 하나 = 턴 하나 = trace root
  settleStaleCompactions(); settleStaleToolCalls() # 86-87, 401-454: 프로세스가 죽어 남은 running 상태 정리
  loop:                                            # 219-227
    next = advanceToStep()                         # 89-217: inbox 에서 steer / queue / compaction / move 승격
    if next != Ready: return next                  # Complete | Moved | Reloaded
    continuing = runStep(ctx, step); step++

runStep(ctx, step):                                # llm.ts:240-399
  loop:
    compaction.compact(auto) → 완료되면 continue   # 256-262: 요청 전 추정치로 판단
    stepLimitReached = agent.steps && step >= agent.steps          # 264
    요청 조립; 한도 도달이면 MAX_STEPS_PROMPT 를 assistant 메시지로 덧붙이고 toolChoice "none"  # 279-283
    outcome = steps.attempt(...)                   # step.ts:79-340
    Completed{needsContinuation} → return
    Retry{decision}              → wait(delay); loop               # 349-357
    OutputLimit                  → 최근 3개가 전부 assistant+length 면 실패,
                                   아니면 "이어서 하라" synthetic 메시지 후 loop   # 358-388
    Compacted                    → recoverOverflow = false; loop (1회)            # 389-392
    RecoverFull                  → recoverContinuation = false; loop              # 393-395

attempt():                                         # step.ts
  LLM 스트림 소비; tool-call 이벤트가 오면 그 자리에서 fiber 로 실행 시작   # 138-169
  스트림 종료 후 모든 도구 fiber 를 기다림                                 # 187-192
  출력 시작 전 컨텍스트 초과 → compact → Compacted                        # 204-215
  재시도 가능하고 출력이 시작되지 않았으면 → Retry                         # 250-265
  미완료 tool call 은 실패로 정산 (interrupted / result-missing)           # 268-293
  finish == "length" → OutputLimit, 아니면 Completed                     # 334-337
```

- **누가 멈추나**: `needsContinuation = !endsTurn && toolChoice != none && record.needsContinuation`(step.ts:334-335). 이후 inbox 에 승격할 입력이 없으면 `Complete`.
- **한도**: agent 정의의 `steps`(llm.ts:264). 도달하면 도구 정의는 **그대로 둔 채** `toolChoice: "none"` 으로 마지막 응답을 받는다. 주석: "Keep tool definitions on the final Step to preserve the provider's cached prefix"(282). 안내문은 `runner/max-steps.ts`. `steps` 의 기본값은 확인하지 않았다.
- **병렬 도구**: 스트림이 끝나길 기다리지 않고 `tool-call` 이벤트마다 fiber 를 fork 한다(step.ts:148-165). 결과는 `toolOutput.truncate` 를 거친다(155).
- **stop reason**: `length` → 연속 2회까지 자동 이어쓰기, 3회째는 `output-limit` 에러(llm.ts:43-44, 358-388). finish 가 `unknown` 이면 `InvalidProviderOutput` 에러로 취급(step.ts:218-226). 거절은 `ContentPolicyError`(`packages/ai/src/schema/errors.ts:88`)라는 타입이 있으나 루프에서의 전용 분기는 추적하지 않았다. pause 는 **찾지 못했다**.
- **재시도**: `packages/core/src/model-retry.ts`. 지수 2s, 간격 상한 10s, 10회, jitter(22-36). 서버의 retry-after 를 존중하되 15분으로 상한(11-20). 네트워크 불통 코드(`ENOTFOUND` 등)는 별도 예산(간격 상한 30s, 최대 1시간, 38-59). 타임아웃 재시도는 3회(61-63). 출력이 이미 시작된 응답은 "스트림이 끊긴 경우"만 재시도하고 그때는 새 assistant 메시지로 시작한다(step.ts:256-264, 323-324). 플러그인 훅이 재시도 결정을 바꿀 수 있다(`runner/retry.ts:32-55`).
- **중단**: 사용자 stop 이면 `cancel` 을 기다리는 도구에는 협조적 종료를 요청하고 나머지는 interrupt, 5초 안에 안 끝나면 전부 interrupt(step.ts:110-120, 377). 마지막 이벤트 기록은 `uninterruptibleMask` 로 보호(172).
- **스티어링**: `session_inbox` 테이블의 `delivery` 컬럼(`session/sql.ts`). `Promotable = "input" | "steer"`: step 경계에서는 steer 만, idle 경계에서는 queue 입력도 승격(`session/inbox.ts:53-58`, llm.ts:102-109, 202). 수동 컴팩션도 inbox 항목이다(110-114).

### 3.2 메시지/상태 모델

- SQLite(drizzle). 테이블: `session_v2`(토큰·비용 누계, `parent_id`, `fork_session_id`, `fork_boundary`, `revert`, `permission` 포함), `session_message`(`session_id`, `type`, `seq`, `data` JSON; `(session_id, seq)` 유니크), `session_part`, `session_inbox`, `instruction_*`, `blob`(`packages/core/src/session/sql.ts:29-110` 외).
- 쓰기 경로는 이벤트다. `bus.publish(SessionEvent.*)` → 이벤트 테이블(`packages/core/src/event/sql.ts:4-10`) → `session/projector.ts`(1,197줄)가 위 테이블로 프로젝션. projector 본문은 읽지 않았다.
- fork/revert: 컬럼과 `session/revert.ts`, `session/transfer.ts` 가 있다. 세부 미확인.

### 3.3 도구 인터페이스

- 레지스트리 `packages/core/src/tool.ts`(582줄), 도구 구현 `packages/core/src/tool/plugin/*.ts`(read, edit, shell, subagent, question, todo 등). 입력 스키마는 Effect `Schema`(`tool/plugin/subagent.ts:35-36`).
- 권한 `packages/core/src/permission.ts`(419줄): 규칙 `{action, resource, effect: allow|deny|ask}`(21), deny 우선(62), 응답 `reject | once | always`, `always` 는 규칙으로 저장(347-390). 무인 실행용 ruleset 이 따로 있어 `ask` 를 명시적으로 허용된 것만 통과시킨다(224-236).
- MCP: `packages/core/src/mcp/`, `tool/mcp.ts`. 세부 미확인.

### 3.4 컨텍스트 관리

- 시스템 프롬프트: `runner/prompt/system.txt` 템플릿에 보유 도구에 따른 지침 줄만 끼워 넣는다(`session/system-prompt.ts`).
- 변동 컨텍스트: 지침 파일(AGENTS.md 류)은 관측값과 저장값을 비교해 **delta 를 `InstructionsUpdated` 이벤트로 기록**하고, 렌더된 텍스트를 이벤트에 고정해 둔다(`session/instruction-state.ts`의 `observe` / `commit`). 프리픽스를 다시 쓰지 않고 히스토리에 덧붙이는 방식이다.
- 컴팩션 (`session/compaction.ts`, 1,320줄):
  - 트리거: `ceiling = window - max(15% of window, 16k)`(`RESERVE_SHARE 0.15`, `RESERVE_MIN 16_000`, 129-137, 1209-1217). 추정은 "마지막으로 usage 가 측정된 assistant 응답의 실측값 + 그 이후 추정치"(1178-1202).
  - 요약 요청은 **평소 요청의 프리픽스를 그대로 두고 끝에 요약 프롬프트만 붙인다**. 주석: "Keeping the normal request's prefix intact lets the summary reuse its prompt cache"(480-482).
  - 결과는 `<conversation-checkpoint><summary>…</summary><recent-context>…</recent-context>` 형태의 user 메시지 하나(484-490). 템플릿: Objective / Requirements / Decisions / Work State / Next Move / Relevant Files / Important Context(175-206).
  - 요약 입력이 너무 크면 단계적으로 깎는다: tool 출력 자르기 → tool 출력 제거 → user 텍스트만 → 생략(142-152). "too long" 거절마다 0.85 / 0.7 / 0.5 / 0.35 로 축소(128-129).
  - 백그라운드 사전 요약: ceiling 6만 토큰 전에 미리 요약을 만들어 두고 교체한다(`PRECOMPUTE_LEAD 60_000`, 155-173). 캐시 수명(5분)이 30초 이상 남았을 때만 시작(161-164).
  - 오버플로 복구는 step 당 1회(llm.ts:249, 330-336, 389-391).
- 프롬프트 캐싱 (`packages/ai/src/cache-policy.ts`): 기본 `auto` 정책은 마지막 도구 정의, system 파트의 첫 번째와 마지막, 대화 꼬리(`tail: 1`)에 breakpoint 를 놓는다. 상한 4개(28-35, 217-229). 수동 힌트는 유지하고 남는 슬롯만 채운다. Gemini 같은 upstream 은 꼬리 breakpoint 가 오히려 비용을 늘려 제외(79-89). 이미지 정리는 trigger/target 히스테리시스로 잘라 프리픽스가 매 요청 바뀌지 않게 한다(`session/model-request.ts:233-242`).

### 3.5 서브에이전트

`tool/plugin/subagent.ts`. 항상 백그라운드로 돈다. 호출은 자식 `sessionID` 를 즉시 돌려주고, 자식이 idle 이 되면 부모가 `<background-result kind="subagent">` 메시지를 받는다(19-23, 51-53). 자식은 `parentID` 를 가진 별도 세션(147). 깊이 제한은 설정 `experimental.subagent_depth`, 기본 1(`session/subagent-depth.ts:14`). 후속 메시지를 기존 자식에게 보낼 수 있다(42).

### 3.6 이벤트/스트림 모델

`SessionEvent.*` 를 Bus 에 발행한다(`Step.Ended`, `Tool.Failed`, `RetryScheduled`, `Compaction.Started/Failed`, `InboxDelivered`, `InstructionsUpdated`, `Synthetic`, `Moved` 등을 llm.ts / step.ts / retry.ts 에서 확인). provider 이벤트 → 세션 이벤트 변환은 `runner/publish-llm-event.ts`(642줄). UI 는 같은 이벤트의 프로젝션을 본다.

### 3.7 프로바이더 추상화

`packages/ai`(38K LOC). 자체 `LLMRequest` / `LLMEvent` 와 프로토콜별 변환(`ai/src/protocols/*`). 에러는 태그된 합 타입: `InvalidRequest`, `UnsupportedOperation`, `ProviderConfiguration`, `Authentication`, `RateLimit`, `QuotaExceeded`, `ContentPolicy`, `ProviderInternal`, `Transport`, `InvalidProviderOutput`, `UnknownProvider`, `Timeout`(`ai/src/schema/errors.ts:32-136`).

### 3.8 테스트/트레이싱

- `TestLLM`(`packages/ai/src/testing.ts`, 218줄): `push(responses)`, `always`, `serve(responder)`, `requests()`, `wait(count)`, `gate()` 로 스크립트된 응답을 주고 관측된 요청을 검사한다(36-47). `packages/core/test/session-runner*.test.ts` 5개 등 10개 파일이 사용. `packages/http-recorder`(1.8K LOC)도 있으나 읽지 않았다.
- 트레이싱: Effect span + OTel `gen_ai.*` 속성(`gen_ai.usage.input_tokens`, `gen_ai.response.finish_reasons` 등, step.ts:85-93, 230-242). drain 하나가 trace root 하나(llm.ts:70-71).

### 3.9 크기

`packages/core/src/session` 15,602줄(`runner/` 2,196, compaction 1,320, projector 1,197, inbox 643). `packages/core` 전체 약 99K, `packages/ai` 약 38K.

## 4. codex (openai/codex, Rust)

### 4.1 에이전트 루프

`codex-rs/core/src/session/turn.rs`. `run_turn()`(228-1075)이 턴 루프, `run_sampling_request()`(2101-2300)이 요청 하나의 재시도 루프, `try_run_sampling_request()`(3115-)가 스트림 소비.

```
run_turn(sess, turn_context, input, cancellation_token):       # turn.rs:228
  run_pre_sampling_compact()                                   # 274-, 1752-1784: 턴 시작 전 컴팩션
  입력 기록 + hook 실행
  loop:                                                        # 557
    pending_input = input_queue.get_pending_input()            # 560-571: 실행 중 들어온 사용자 입력
    기록 (hook 이 중단시키면 break)                              # 573-585
    maybe_record_current_time_reminder()                       # 637-641
    record_step_world_state_if_changed()                       # 644-646: 환경 변화는 diff 로 히스토리에 추가
    result = run_sampling_request(history clone)               # 668-679
    Ok:
      needs_follow_up = model_needs_follow_up || has_pending_input            # 741
      async_compaction::maybe_start(...)                       # 744-757: 백그라운드 컴팩션
      if needs_follow_up && (token_limit_reached || 준비된 후보):
          run_auto_compact(MidTurn); continue                  # 795-843
      if !needs_follow_up:
          stop hook 실행 (block 이면 hook 프롬프트 주입 후 continue)  # 862-909
          post-turn 컴팩션 (조건부); break                      # 921-974
      continue
    Err(ContextWindowExceeded) [특정 조건] → 컴팩션 1회 후 continue  # 977-1008
    Err(interrupted) → return Err                               # 1009-1011
    Err(e) → Error 이벤트 emit; break                           # 1034-1072: "let the user continue the conversation"

run_sampling_request():                                        # 2101-2300
  loop:
    result = try_run_sampling_request(...)
    Ok → return
    ContextWindowExceeded | UsageLimitReached | Fatal | terminal → return Err   # 2236-2250
    그 외 → handle_response_stream_error(백오프 후 재시도)        # 2265-2298
```

- **누가 멈추나**: 모델이 function call 없이 메시지만 내면 끝(doc 주석 214-227). 여기에 pending input 과 stop hook 이 턴을 이어 붙일 수 있다.
- **반복 한도**: `run_turn` 에서 max-iteration 은 **찾지 못했다**(`max_turns|max_iterations|max_steps` grep 결과 없음). 대신 `rollout_budget`(`core/src/rollout_budget.rs`)과 `work.accept_response()` 게이트(684)가 있다. 무한 루프에 대한 태도는 주석 그대로다: "as long as compaction works well ... we shouldn't worry about being in an infinite loop"(812).
- **병렬 도구**: `core/src/tools/parallel.rs`. `parallel_execution: Arc<RwLock<()>>`(60) 하나로, 병렬 가능한 도구(`router.tool_supports_parallel`, 223)는 read lock, 나머지는 write lock 을 잡는다(344-376).
- **stop reason**: Responses API 기반이라 Anthropic 식 stop_reason 이 없다. `content_filter` 와 `incomplete` 처리는 `codex-api/src/sse/responses.rs:484, 506` 에 있으나 자세히 읽지 않았다.
- **재시도**: `core/src/responses_retry.rs`(229줄) + `async-utils/src/backoff.rs`: 200ms 에서 시작해 2배씩, ±10% jitter(7-16). 기본 `stream_max_retries 5`, `request_max_retries 4`(`model-provider-info/src/lib.rs:75-76`). 서버의 retry-after 가 있으면 그 시각까지 대기(`responses_retry.rs:106, 143-144, 181`). 재시도 소진 시 전송 방식 전환 분기가 있다(136).
- **중단**: `CancellationToken` 트리(자식 토큰을 요청·도구에 전달, 677, 2219-2233). 도구가 "취소돼도 끝까지 실행"을 선언할 수 있다(`parallel.rs:226-228`).
- **스티어링**: `session/input_queue.rs`(973줄). 실행 중 입력은 다음 샘플링 요청 직전에 히스토리로 들어간다(560-585). 컴팩션 직후엔 drain 을 미룬다(주석 548-552). 에이전트 간 mailbox 도 같은 큐를 쓴다(707-713).

### 4.2 메시지/상태 모델

- 트랜스크립트 단위는 Responses API 의 `ResponseItem`. 히스토리는 `core/src/context_manager/history.rs`(1,816줄).
- 영속화: rollout JSONL, `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<conversation_id>.jsonl`(`rollout/src/recorder.rs:1, 79-99, 1673`). 줄 타입은 `RolloutItem`(`history/src/lib.rs:424-`): `SessionMeta`, `ResponseItem`, `DynamicToolsUpdated`, `InterAgentCommunication`, `WorldState` 등. SQLite 상태 DB 도 있다(`codex-rs/state/src/sqlite`, 읽지 않음).
- resume/fork: `thread_manager.rs:1656`(`resume_thread_with_history`), `1905`(`fork_thread_from_history`). 재구성은 `session/rollout_reconstruction.rs`(755줄).

### 4.3 도구 인터페이스

- `core/src/tools/registry.rs`(1,315줄), `router.rs`(524줄), 핸들러 `tools/handlers/*`.
- 승인: `AskForApproval = UnlessTrusted | OnRequest | Granular(..) | Never`(`protocol/src/protocol.rs:1174-1195`). `tools/orchestrator.rs`(622줄)가 "승인 → 샌드박스 선택 → 샌드박스 거부 시 재시도"를 조율한다(1-3). UI 로는 `ExecApprovalRequest`, `ApplyPatchApprovalRequest`, `RequestPermissions` 이벤트가 나간다.
- MCP: `core/src/mcp_tool_call.rs`, `session/mcp*.rs`, `codex-mcp`, `rmcp-client` 크레이트.

### 4.4 컨텍스트 관리

- 변동 컨텍스트: "world state" 를 렌더해 이전 baseline 과 비교하고, **바뀐 부분만 대화 아이템으로 추가**한다(`session/mod.rs:4417-4442`, 병합 `context_manager/updates.rs:20-48`). 현재 시각도 리마인더 아이템이다(`session/time_reminder.rs`).
- 컴팩션 (`core/src/compact.rs`, 986줄):
  - 트리거: `auto_compact_token_limit = min(설정값, context_window × 90%)`(`protocol/src/openai_models.rs:575-585`). 턴 전 / 턴 중 / 턴 후 세 시점(`CompactionPhase`).
  - 프롬프트는 짧다(`prompts/templates/compact/prompt.md`: 진행 상황, 제약, 남은 일, 필요한 데이터).
  - 새 히스토리 = 고정 유지 아이템 + 최근 user 메시지(최신부터 20,000 토큰까지, `COMPACT_USER_MESSAGE_MAX_TOKENS`, 69, 745-) + `SUMMARY_PREFIX` 를 붙인 요약(405-406).
  - 컴팩션 요청 자체가 컨텍스트를 넘으면 가장 오래된 아이템부터 제거한다. 주석: "Trim from the beginning to preserve cache (prefix-based) and keep recent messages intact"(359-368).
  - 원격 컴팩션(`compact_remote_v2.rs`, 1,744줄)과 비동기 컴팩션(`session/async_compaction.rs`)은 읽지 않았다.
- 프롬프트 캐싱: 명시적 breakpoint 가 아니라 `prompt_cache_key`(`core/src/client.rs:366, 510-558`). 키가 바뀌면 사유를 기록한다. 세부 미확인.

### 4.5 서브에이전트

`tools/handlers/multi_agents*.rs`, `core/src/agent/`. spawn 깊이 제한(`agent/registry.rs:97-98`), 에이전트 간 통신이 rollout 에 남는다(`history/src/lib.rs:432`). 세부는 읽지 않았다.

### 4.6 이벤트/스트림 모델

Submission Queue / Event Queue. 클라이언트 → 코어는 `Op`(`protocol/src/protocol.rs:698-`, `Interrupt` 등), 코어 → 클라이언트는 `EventMsg`(1542-): `TurnStarted`, `TurnComplete`, `TokenCount`, `AgentMessage`, `ExecCommandBegin/OutputDelta/End`, `McpToolCallBegin/End`, `ExecApprovalRequest`, `ContextCompacted`, `Error`, `Warning` 등 수십 종.

### 4.7 프로바이더 추상화

OpenAI Responses API 형태에 묶여 있다(`model-provider-info`, `codex-api`). 에러는 `CodexErr` / `CodexErrorDetails`: `ContextWindowExceeded`, `UsageLimitReached`, `Fatal`, `Interrupted`, `TurnAborted`, `InvalidImageRequest`, `Stream(..)` 등(turn.rs:977-1060, 2236-2250).

### 4.8 테스트/트레이싱

- `core/tests/suite`(303개 항목) + `core/tests/common/responses.rs` 의 SSE 빌더(`sse(events)`, `ev_function_call`, `ev_assistant_message`, `ev_completed_with_tokens` 등, 799-1109)로 모의 서버에 스크립트된 스트림을 건다. 컨텍스트 스냅샷 테스트 `core/tests/common/context_snapshot.rs`.
- 트레이싱: `codex-rs/otel`, `rollout-trace` 크레이트, turn.rs 곳곳의 `trace_span!`.

### 4.9 크기

`codex-rs/core/src` 테스트 파일 제외 153,309줄. `session/` + `tasks/` + `context_manager/` 만 34,320줄(turn.rs 4,045, session/mod.rs 6,506, session.rs 2,258, history.rs 1,816).

## 5. goose (aaif-goose/goose, 구 block/goose, Rust)

### 5.1 에이전트 루프

`crates/oi-kit-agent/src/machine.rs`. 루프는 "저장소에서 세션을 읽고 → 첫 번째로 적용되는 operation 하나를 실행하고 → effect 를 저장"의 반복이다.

```
StateMachine.run(runtime, session_id):                 # machine.rs:248-263
  loop:
    session = runtime.load(session_id)                 # 매 step 저장소에서 다시 로드
    result  = step(session)                            # 169-227
    apply(runtime, session, result.effects)            # effect 영속화
    if result.status != Continuing: break              # Yielded | Cancelled
  finalize()                                           # 265-300: 취소 시 미완료 tool call 에 에러 응답 합성 (83-95)

step(session):
  for op in steps (고정 순서):
    if cancelled: return Cancelled
    r = op.run(session, conversation)                  # Inference 는 모든 op 의 tools/prompt_parts/moim_parts 를 모아 호출
    if r is Applied(effects, status): return r         # 첫 번째로 적용된 것 하나만
  return Yielded
```

- step 순서(`crates/goose/src/agents/state_machine_builder.rs` 의 `build_state_machine`): bang 명령 → 컴팩션 → final output → **tool approval** → skills → recipe → platform extension → … → extension(도구 실행) → unhandled tool calls → subagent → **steer** → tool pair compaction → retry → empty response → thinking recovery → stop hook → exit on error → **max turns** → status → 마지막에 **Inference**. 주석: 컴팩션이 assistant 응답에 반응하는 모든 것보다 앞에 온다.
- operation 은 상태를 들고 있지 않고 **영속화된 대화에서 다음 행동을 유도**한다. 자신이 한 일은 메시지 메타데이터에 노트로 남긴다(`operation.rs:96-106`: "a pipeline rebuilt from the persisted conversation reaches the same conclusion").
- **누가 멈추나**: 어떤 operation 도 적용되지 않으면 `Yielded`(machine.rs:226). Inference 는 `should_infer` 일 때만 적용(`inference.rs:480-485`).
- **한도**: `MaxTurnsOperation`(`oi-kit-agent/src/max_turns.rs`). 기본 1000(`crates/goose/src/config/base.rs:1374`). 도달하면 "계속할까요?" assistant 메시지를 남기고 양보한다(16, 60-76). 예산을 절반 이상 쓰면 `<turn-budget>n/m used</turn-budget>` 를 턴 컨텍스트에 넣어 모델에 알린다(22-30).
- **병렬 도구**: `ToolCallBatch`(`oi-kit-agent/src/mcp/batch.rs:40-42, 74`). `select_all` 로 동시 실행하고 "끝나는 즉시 기록해 취소된 턴도 완료분을 보존"한다.
- **재시도**: provider 수준 기본 3회, 초기 1s, ×2, 상한 30s(`oi-kit-provider-types/src/retry.rs:14-17`). `RetryOperation`(`state_machine/ops_retry.rs`, 314줄)은 recipe 성공 조건용 재시도로 보이며 자세히 읽지 않았다.
- **중단**: `CancellationToken`. step 실행을 `tokio::select!` 로 경합(machine.rs:196-200), 취소 후 `finalize()` 가 응답 없는 tool request 마다 "Tool call was interrupted before completing" 에러 응답을 만든다(83-95, 281-290).
- **스티어링**: `SteerOperation`(`oi-kit-agent/src/steer.rs`). `SteerQueue = Arc<Mutex<VecDeque<Message>>>`(18), 모델 턴과 도구 턴 사이에 큐를 비운다(1).
- stop reason 별 처리(max_tokens, 거절, pause)는 **찾지 못했다**(`empty_response.rs`, `ops_thinking_recovery.rs` 가 있으나 읽지 않음).

### 5.2 메시지/상태 모델

SQLite. `sessions`, `messages`, `usage_ledger`, `threads`, `thread_messages`(`crates/goose/src/session/session_manager.rs:1178-1237, 1616-1630`). 메시지에 가시성 메타데이터가 있어 "에이전트에게만 보임 / 사용자에게만 보임"을 구분한다(`moim.rs:93`, `tool_approval.rs:50`). fork 는 확인하지 않았다.

### 5.3 도구 인터페이스

- 도구 타입이 처음부터 MCP 의 `rmcp::model::Tool` 이다. 내장 도구도 같은 타입으로 등록(`oi-kit-agent/src/tool.rs:36-58, 204-262`). 서로 다른 operation 이 같은 이름의 도구를 등록하면 에러(machine.rs:97-108).
- 승인: `ToolApproval::check()` → `ApprovalDecision::{Allow, Deny{reason}, Ask{prompt}}`(`oi-kit-agent/src/tool_approval.rs:25-41`). 승인 응답은 사용자에게도 에이전트에게도 보이지 않는 user 메시지로 **대화에 기록**된다(48-56). 그래서 재시작해도 결정이 유지된다.
- MCP 클라이언트: `oi-kit-agent/src/mcp/`(client.rs 1,497줄, streamable_http.rs 1,156줄). 큰 도구 응답 처리 `agents/large_response_handler.rs`.

### 5.4 컨텍스트 관리

- 시스템 프롬프트: 각 operation 이 `prompt_parts()` 로 기여(`operation.rs:125-131`).
- 변동 컨텍스트("MOIM"): `<turn-context>` 블록(현재 시각, 작업 디렉터리, 턴 예산, extension 제공 컨텍스트)을 **agent-only user 메시지로 히스토리에 저장**한다(`crates/goose/src/agents/moim.rs:84-99`의 `turn_context_event`). 주석: "the caller persists the event, so later requests in the turn reuse the same bytes". 시각은 분 단위로 내림(`%H:%M:00`, 113). 시스템 프롬프트에는 "가장 최근 블록만 현재다"라는 고정 설명만 둔다(9-23). 컨텍스트 한도가 32k 미만이면 생략(7, 104-106).
- 컴팩션 (`oi-kit-agent/src/compaction/mod.rs`, 609줄): 임계값 0.8(`oi-kit-context-management/src/lib.rs:34`). 기본은 **in-band**: 평소 inference step 으로 살아 있는 프리픽스 위에서 요약을 요청하고 응답을 수확한다. standalone 은 컨텍스트 초과 에러에서 복구할 때와 in-band 결과를 못 쓸 때의 대안(1-8, 224). 컨텍스트 초과로 인한 컴팩션은 최대 2회(`MAX_CONTEXT_ERROR_COMPACTIONS`, 45).
- 프롬프트 캐싱(`oi-kit-provider-types/src/formats/anthropic.rs`): 마지막 도구 정의(591-597), system(614), **마지막 user 메시지 2개**(539-556)에 breakpoint. 기본 5분 TTL, 1시간은 명시적 옵트인("1h write is billed at 2x input instead of 1.25x", 127-130).

### 5.5 서브에이전트

`SubagentOperation`(`oi-kit-agent/src/subagent.rs`, `state_machine/ops_subagent.rs`). 동시 실행 상한 기본 5(`GOOSE_MAX_CONCURRENT_SUBAGENTS`), 별도 턴 한도 `GOOSE_SUBAGENT_MAX_TURNS`(`platform_extensions/summon.rs:2554-2598` 의 테스트에서 확인).

### 5.6 이벤트/스트림 모델

`AgentEvent` 5종: `Message`, `Usage`, `MessageUsage`, `McpNotification`, `HistoryReplaced`(`oi-kit-agent/src/events.rs:9-17`). 컴팩션은 `HistoryReplaced` 하나로 UI 에 알린다.

### 5.7 프로바이더 추상화

`Provider` trait + `ProviderError`: `NotConfigured`, `Authentication`, `ContextLengthExceeded`, `RateLimitExceeded`, `ServerError`, `NetworkError`, `RequestFailed`, `InvalidValue`, `ExecutionError`, `UsageError`, `NotImplemented`, `EndpointNotFound`(`oi-kit-provider-types/src/errors.rs:9-48`). 자체 컨텍스트 관리를 하는 provider 는 `manages_own_context()` 로 컴팩션 operation 을 통째로 건너뛴다(state_machine_builder.rs).

### 5.8 테스트/트레이싱

- `wiremock` 가짜 API(`state_machine/tests/dummy_api.rs`, 1,056줄; `ApiResponse::{Reply, ToolCall, ToolCalls, Mixed..}`). 테스트: `agent_reply.rs`(1,693줄), `tool_lifecycle.rs`, `compaction_lifecycle.rs`, `hooks_lifecycle.rs`, `pipeline.rs`.
- 트레이싱: OTel `gen_ai.*` span(`oi-kit-agent/src/inference.rs:364-383`), Langfuse 레이어(`crates/goose/src/tracing/langfuse_layer.rs`).

### 5.9 크기

`oi-kit-agent/src` 14,423줄(machine 370, operation 300, inference 699, compaction 609, 나머지는 MCP 클라이언트가 큼). `crates/goose/src/agents/state_machine` 테스트 제외 5,527줄. `crates/goose/src` 전체 약 170K(인라인 테스트 포함).

## 6. (선택) hermes-agent — 짧게

Python, 개인 비서 계열. `agent/*.py` 합계 144,388줄이라 일부만 읽었다.

- 루프: `agent/conversation_loop.py:1619-1780` 의 `_run_conversation_turn`. `while api_call_count < max_iterations and iteration_budget.remaining > 0`(1724-1726). 한 반복은 `begin_iteration → prepare_iteration → assemble_api_request → run_preflight_gate → _run_api_retry_loop → normalize_model_response → run_tool_round | finish_text_response` 단계 함수들이고(1727-1771), 각 단계가 `action: return|break|continue` verdict 를 돌려준다. 단계 구현은 `agent/turn_*.py` 34개 파일(14,155줄).
- 한도: `IterationBudget`(`agent/iteration_budget.py`). docstring 은 부모 500 / 서브에이전트 50 이라 하고, 생성자 기본값은 `sys.maxsize`(`run_agent.py:242`)다. 둘이 어긋나며 실제 유효값은 확인하지 않았다.
- 캐싱: breakpoint 4개 = 정적 system 프리픽스, system 프롬프트 끝, 마지막 non-system 메시지 2개(`agent/prompt_caching.py:1-6`). 다시 읽힐 일이 없는 1회성 요청(요약, 제목)에는 마커를 붙이지 않는다(38-44).
- 프리픽스 안정화: 시스템 프롬프트를 **세션 DB 에 저장했다가 복원**한다(`conversation_loop.py:822-827`). 턴별 변동 컨텍스트는 user 메시지의 `api_content` 사이드카로 보내 "프리픽스를 byte-stable 하게" 유지한다(`agent/turn_context.py:140-147, 156-158`).
- 컴팩션: 기본 `threshold_percent 0.50`, `protect_first_n 3`, `protect_last_n 20`, `summary_target_ratio 0.20`(`agent/context_compressor.py:2663-2664`).
- 병렬 도구: 스레드 풀 + `_NEVER_PARALLEL_TOOLS` 예외 목록(`agent/tool_executor.py:53, 254-261, 955`).
- 에러 분류: `FailoverReason` 약 28종(`agent/error_classifier.py:37-65`). 분류마다 회복 행동(백오프 / 자격 증명 교체 / 압축 / 중단)이 다르다.

## 7. What FinClaw should take

전제: TypeScript, Node 22, SQLite, Anthropic Messages API, 읽기 전용 도구, 1인 사용자, 채널은 macOS 앱 + Discord + cron.

먼저 한 줄: 루프를 직접 쓰지 않는 길도 있다. Anthropic TS SDK 의 Tool Runner(`client.beta.messages.toolRunner`, beta)가 요청 → 도구 실행 → 반복을 대신 돌려 주고, 서버 측 compaction(beta `compact-2026-01-12`)도 있다. 아래는 "그래도 루프를 소유한다"는 결정을 전제로 한 것이다.

### 7.1 가져올 패턴 (여러 프로젝트에 반복되고, 작은 루프에 들어간다)

**P1. 이중 루프 + "tool call 이 없으면 종료"**
안쪽은 tool call 과 steering, 바깥쪽은 follow-up 큐. 종료는 "assistant 메시지에 tool_use 블록이 없고 큐가 비었다"로 판단한다. pi `agent-loop.ts:188-327` 가 약 140줄로 이것을 다 한다. codex(`turn.rs:741`), opencode(`step.ts:334-335`)도 같은 모양이다.
stop reason 별 규칙은 명시적으로 둔다.

- `tool_use`: 실행 후 계속.
- `max_tokens`: 잘린 tool call 은 **실행하지 않고** 에러 결과로 돌려준다(pi 488-513). 텍스트만 잘렸으면 이어쓰기는 2회까지(opencode `llm.ts:358-388`).
- `refusal`: 에러로 사용자에게 드러내고 재시도하지 않는다(pi 1841-1845). `stop_details` 는 이때만 채워진다.
- `pause_turn`: 같은 히스토리로 재요청. pi 는 여기서 그냥 멈추므로 그대로 베끼면 안 된다.
- 알 수 없는 값: 조용히 넘기지 말고 에러(pi 는 throw, opencode 는 `InvalidProviderOutput`).

**P2. append-only 트랜스크립트가 유일한 진실, 매 step 저장**
네 프로젝트 모두 그렇다(pi JSONL, opencode 이벤트 로그, codex rollout, goose 는 매 step 저장소에서 다시 로드). FinClaw 는 SQLite 테이블 하나(`session_id, seq, role, content JSON, usage`)면 된다.
같이 가져올 것: **짝 없는 tool_use 정산**. 중단·크래시 뒤 재개할 때 결과가 없는 tool_use 마다 `is_error` tool_result 를 합성한다(goose `machine.rs:83-95`, opencode `llm.ts:431-454`, pi `agent-loop.ts:716-724`). 안 하면 다음 요청이 API 에서 거절된다.
Anthropic 쪽 이유도 있다. 최신 모델은 thinking 블록을 그대로 되돌려 보내야 하고, 히스토리를 중간에서 고치면 이후 thinking 블록이 무효가 될 수 있다. 히스토리는 덧붙이기만 한다.

**P3. 프리픽스를 얼리고, 변동 컨텍스트는 메시지로**
가장 일관되게 반복되는 패턴이다. 시스템 프롬프트와 도구 목록은 세션 동안 바이트 단위로 고정하고, 시각·포트폴리오 스냅샷·채널 정보 같은 턴별 값은 **user 쪽 메시지에 넣어 히스토리에 저장**한다.

- goose: `<turn-context>` 를 agent-only user 메시지로 저장, 시각은 분 단위(`moim.rs:84-113`).
- codex: world state 의 diff 만 아이템으로 추가(`session/mod.rs:4417-4442`).
- pi: 시스템 프롬프트 변경을 섹션 패치 system 메시지로 추가(`types.ts:565-589`).
- hermes: 시스템 프롬프트를 세션 DB 에 저장·복원(`conversation_loop.py:822-827`).
  FinClaw 에서는 "시스템 프롬프트를 세션 row 에 저장하고 재사용" + "턴 컨텍스트 블록을 user 메시지 앞에 붙여 저장"이면 된다. 지원 모델에서는 `messages` 안의 `role: "system"` 메시지로 운영자 지시를 중간에 덧붙일 수 있어 pi/codex 방식을 API 가 직접 받아 준다.
  breakpoint 는 최대 4개, 렌더 순서는 tools → system → messages. 배치는 opencode 기본값(`cache-policy.ts:28-32`)이 정답에 가깝다: 마지막 도구, system 끝, 대화 꼬리. 도구가 고정이고 system 이 한 덩어리면 system 끝 + 대화 꼬리 2개로 충분하다. `usage.cache_read_input_tokens` 를 로그에 남겨 0 이 이어지면 프리픽스가 깨진 것이다. 최소 캐시 길이(모델별 512–4096 토큰)보다 짧은 프리픽스는 조용히 캐시되지 않는다.

**P4. 도구 파이프라인: 조회 → 검증 → before 훅 → 실행 → after 훅, 예외는 전부 tool_result**
pi `prepareToolCall` / `runToolCall`(`agent-loop.ts:708-822`)이 그대로 쓸 만한 형태다. 도구 실패·검증 실패·차단·중단이 모두 `is_error` 결과가 되어 모델이 스스로 고친다. 루프는 도구 때문에 throw 하지 않는다.
병렬은 기본, 결과는 호출 순서대로, 한 턴의 tool_result 는 **user 메시지 하나에** 담는다(나누면 모델이 병렬 호출을 덜 하게 된다). 읽기 전용 도구뿐이면 codex 의 RwLock 이나 pi 의 `sequential` 플래그는 필요 없고 `Promise.all` 한 줄이면 된다.
도구 출력 상한을 둔다(opencode `toolOutput.truncate`, goose `large_response_handler.rs`). 시세·공시 응답이 길어질 때 컨텍스트를 지키는 가장 싼 수단이다.

**P5. 컴팩션: 실측 usage 로 트리거, 최근 꼬리 유지, 구조화 요약, 초과 복구는 1회**

- 트리거는 마지막 응답의 실제 `usage` + 그 뒤 추정치(pi 184-225, opencode 1178-1202). 여유는 16k 또는 15%(pi 126-129, opencode 129-137).
- 최근 약 20k 토큰은 원문 유지, 자르는 위치는 user/assistant 경계이고 tool_result 에서는 자르지 않는다(pi 430-480).
- 요약은 고정 템플릿, 이전 요약이 있으면 갱신(pi 506-580, opencode 175-206).
- 요약 요청은 평소 프리픽스 뒤에 요약 프롬프트만 붙여 캐시를 재사용한다(opencode 480-482, goose in-band).
- 컨텍스트 초과 에러 → 컴팩션 → 재시도는 **한 번만**(pi `_overflowRecoveryAttempted`, opencode `recoverOverflow`, goose 2회). 안 그러면 무한 루프다.
  단, 1M 컨텍스트 모델에서 단일 사용자 금융 Q&A 세션이 여기에 닿는 일은 드물다. 먼저 "세션이 길어지면 새 세션" + 도구 출력 상한으로 버티고, 실제로 닿는 것이 로그에 보일 때 넣어도 늦지 않다. 넣는다면 직접 구현보다 서버 측 compaction 이 코드가 적다.

**P6. 재시도는 두 층, 분류는 작게**
HTTP 수준은 SDK 기본 재시도(`maxRetries` 기본 2: 408/409/429/5xx, 연결 오류)에 맡긴다. 루프 수준은 스트림 도중 끊김만 다룬다: 출력이 시작되기 전이면 같은 요청 재시도, 시작됐으면 부분 메시지를 버리고 새 assistant 메시지로(opencode `step.ts:256-264, 323-324`; pi 는 실패 메시지를 프로젝션에서 제외).
수치는 어느 것을 골라도 비슷하다: 3–5회, 1–2초에서 2배씩, 상한 30–60초, retry-after 존중(상한을 둘 것 — opencode 는 15분).
분류는 SDK 의 타입드 에러 클래스로 4개면 된다: 재시도 가능 / 컨텍스트 초과 / 인증·과금(중단) / 그 외(중단). pi 의 정규식 100여 줄과 hermes 의 28종은 다중 provider 때문에 생긴 것이다.

**P7. steer 큐와 follow-up 큐, 세션당 실행 하나**
FinClaw 는 채널이 셋이라 같은 세션에 입력이 겹칠 수 있다. 네 프로젝트 모두 "실행 중 입력"을 큐로 받는다: step 경계에서 넣는 steer 와, 멈출 때 넣는 follow-up(pi `agent.ts:307-315`, opencode `inbox.ts:53-58`, codex `turn.rs:560-571`, goose `steer.rs`). 세션당 동시 실행은 하나로 막는다(pi 는 예외, opencode 는 run-coordinator).
최소 구현은 세션별 배열 두 개와 `AbortController` 하나다. cron 실행은 follow-up 으로 넣으면 사용자 대화 중간에 끼어들지 않는다.

**P8. 작은 이벤트 유니온 + 가짜 스트림 함수로 테스트**
이벤트는 pi 의 10종(`types.ts:528-551`)이면 macOS 앱과 Discord 둘 다 그릴 수 있다. goose 는 5종으로도 한다.
테스트는 모델 호출을 함수 하나(`streamFn`)로 주입받게 만들고, 스크립트된 응답을 차례로 내주는 가짜를 쓴다(pi `faux.ts`, opencode `TestLLM` 의 `push` / `requests()`). 검증할 시나리오는 이들의 테스트 파일 이름이 목록이다: 병렬 도구 결과 순서, 잘린 tool call, 중단 후 정산, 초과 → 컴팩션 → 재시도 1회, steer 주입 시점, 한도 도달.

**P9. (작게) 한도에 닿았을 때 우아하게**
pi 와 codex 는 반복 한도가 없지만, 무인 cron 이 있는 FinClaw 는 필요하다. opencode 방식이 가장 낫다: 한도에 닿으면 도구 정의는 그대로 두고 도구 호출만 막은 채 "지금까지 한 일을 요약하라"는 마지막 요청을 한 번 더 보낸다(`llm.ts:264-283`). 도구 배열을 비우면 캐시가 깨진다. goose 처럼 남은 예산을 턴 컨텍스트로 알려 주는 것(`max_turns.rs:22-30`)은 한 줄짜리 추가다.
주의: 최신 Claude 모델 일부는 `tool_choice` 의 `any` / `tool` 강제를 400 으로 거절한다. `none` 은 영향이 없다.

### 7.2 루프 스케치 (P1·P2·P4·P7·P9 를 합친 모양, 의사코드)

```
run(session, input, signal):
  append(session, userMessage(turnContext() + input))            # P3: 변동 값은 메시지로
  settleDanglingToolUses(session)                                # P2
  for step in 1..MAX_STEPS+1:
    drain steer queue → append                                   # P7
    msg = await streamFn({system: session.frozenSystem, tools, messages: load(session),
                          toolChoice: step > MAX_STEPS ? none : auto}, signal)   # P9
    append(session, msg)                                         # content 블록 전체를 그대로
    switch msg.stop_reason:
      refusal    → emit error; return
      pause_turn → continue
      max_tokens → tool_use 가 있으면 전부 is_error 결과로 append; continue
                   없으면 이어쓰기(2회까지)
    calls = msg.content.filter(tool_use)
    if calls.empty: follow-up 큐가 있으면 append 후 continue, 없으면 return
    results = await Promise.all(calls.map(runToolCall))          # P4: 검증 → 훅 → 실행, throw 없음
    append(session, userMessage(results))                        # 한 메시지에 전부, 호출 순서대로
```

pi 의 `agent-loop.ts` 가 952줄인 것은 훅과 이벤트 방출이 많아서고, 위 골격은 200–300줄에 들어간다.

### 7.3 과한 것 (단일 사용자·읽기 전용 비서에는 넣지 말 것)

| 패턴                                                                | 어디에 있나                                                            | 과한 이유                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect + 이벤트 소싱 + projector, location/workspace 이동           | opencode `packages/core`                                               | 다중 클라이언트·다중 위치 동기화용. SQLite 에 메시지 row 를 직접 쓰면 된다                                                                    |
| 백그라운드 사전 컴팩션, 원격 컴팩션, 이미지 예산 히스테리시스       | opencode `compaction.ts:155-173`, codex `compact_remote_v2.rs`         | 수 시간짜리 코딩 세션의 지연을 줄이는 최적화                                                                                                  |
| 샌드박스 / exec policy / 승인 오케스트레이터 / guardian             | codex `tools/orchestrator.rs`, `guardian/`                             | 쓰기·실행 도구가 있을 때만 의미. 읽기 전용이면 `beforeToolCall` 자리의 정적 허용 목록으로 끝                                                  |
| 다중 provider 추상화                                                | pi `packages/ai` 29.6K, opencode `packages/ai` 38K                     | Anthropic SDK 타입을 그대로 쓰고, 테스트용 `streamFn` 이음매만 남긴다                                                                         |
| 세션 트리 / 분기 / fork / 분기 요약                                 | pi `session-manager.ts`                                                | 선형 히스토리로 충분                                                                                                                          |
| operation 25개짜리 상태기계                                         | goose `state_machine_builder.rs`                                       | 아이디어(저장된 대화에서 다음 행동 유도)만 가져오고 파이프라인은 불필요                                                                       |
| 동적 도구 로드아웃 (`tool_addition/removal`, tool search, deferral) | pi `agent-loop.ts:342-372`, goose `ToolDeferral`                       | 도구가 수십 개 이하로 고정이면 불필요                                                                                                         |
| 서브에이전트 (백그라운드 세션, 깊이 제한, mailbox)                  | opencode `subagent.ts`, codex `multi_agents*`, goose `ops_subagent.rs` | 필요해지면 "새 트랜스크립트로 같은 루프를 한 번 더 부르는 도구" 하나로 시작할 수 있다. pi 는 코어에 없이도 12만 star 다                       |
| 플러그인 / 확장 훅 시스템, stop hook                                | 전부                                                                   | 사용자가 1명이면 코드를 고치면 된다                                                                                                           |
| 전용 OTel 파이프라인                                                | opencode, goose, codex                                                 | step 당 SQLite row 하나(모델, usage 4종, stop_reason, 지연, 도구별 소요)로 시작. 컬럼 이름만 `gen_ai.*` 관례에 맞춰 두면 나중에 내보내기 쉽다 |
| 에러 분류 수십 종, 자격 증명 풀 교체                                | hermes `error_classifier.py`, `credential_pool.py`                     | API 키 하나, provider 하나                                                                                                                    |

### 7.4 확인하지 못한 것 (추측하지 않음)

- pi: `pause_turn` 자동 재제출, 내장 도구의 호출별 승인 UI, 코어의 서브에이전트 — 찾지 못함. `packages/evals`, `packages/mcp`, `packages/durable` 은 읽지 않음.
- opencode: agent `steps` 기본값, 거절(`ContentPolicy`)의 루프 내 분기, projector 내부, fork/revert 세부, http-recorder.
- codex: `run_turn` 의 반복 한도(없어 보임), `content_filter` / `incomplete` 처리 세부, `prompt_cache_key` 정책, 원격·비동기 컴팩션, SQLite state db, 멀티 에이전트 세부.
- goose: stop reason 별 처리, `RetryOperation` 의 정확한 역할, 세션 fork, 권한 모드 설정 파일.
- hermes: 전체의 일부만 읽음. `max_iterations` 유효 기본값은 문서(500)와 생성자(`sys.maxsize`)가 어긋남.
- Anthropic API: 컨텍스트 초과가 HTTP 에러로만 오는지 stop reason 으로도 오는지는 확인하지 않았다. 구현 전에 현재 문서로 확인할 것.
