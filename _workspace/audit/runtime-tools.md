# Runtime & Tools Audit

감사 대상: FinClaw `feature/automation` (commit 30913d7), 2026-05-03.
룰릭: `/.claude/skills/finclaw-maturity-audit/references/rubric.md` § 2 (0–5 척도, 3 = 현대 비서 MVP).
사용자 제약: 1인 전용, 학습 비대상 → 멀티테넌시·RLHF 결손 가중치↓; 감사·환각 방지·읽기 전용 가중치↑.

## 점수 카드

| 축                      | 점수         | 한 줄 평                                                                                                                                       |
| ----------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Agent loop          | **3.5 / 5**  | ReAct 루프·max_turns·abort·retry/회로차단 갖춤. 자기-반성·계획수정·parallel tool 의도적 단순화.                                                |
| 2.2 도구·스킬 시스템    | **4.0 / 5**  | InMemoryToolRegistry + 9-단계 정책 + Zod + result-guard + 그룹·minModel 메타. MCP 미지원.                                                      |
| 2.3 프로바이더 추상화   | **2.0 / 5**  | `ProviderAdapter` 인터페이스는 있으나 구현체는 `AnthropicAdapter` 단 1개, `ProviderId='anthropic'` 단일 union.                                 |
| 2.4 스트리밍 UX         | **3.5 / 5**  | 6-variant `StreamChunk`, 부분 도구 입력 버퍼, 5-state FSM. 사용자 인터럽트 가능 (AbortSignal), 부분 취소는 turn 단위.                          |
| 2.5 관찰성              | **3.5 / 5**  | `agent_runs` 테이블 + EventBus + observer + memory.injected 감사 로그. trace ID/span tree 부재.                                                |
| 2.6 프롬프트 엔지니어링 | **3.5 / 5**  | system 분리·control tokens·RAG 주입 위치 명확·Anthropic prompt caching(`cache_control: ephemeral`) 적용. few-shot/output schema 강제는 일부만. |
| 2.7 에러 회복           | **4.0 / 5**  | `FailoverError` + `classifyFallbackError` + `runWithModelFallback` + per-provider `CircuitBreaker` + tier-floor 보호.                          |
| **평균**                | **3.43 / 5** | **MVP 기준(3.0) 통과, Production-grade(4.0) 직전.**                                                                                            |

## 에이전트 루프 흐름도

```
ChannelEvent (Discord/TUI/Web/Auto)
  └─> MessageRouter.onProcess(ctx, match, signal)
       └─> AutoReplyPipeline.process()
            ├─[1] normalize           ── trim, mention/url 추출
            ├─[2] command             ── !finclaw 슬래시 처리 (continue/skip)
            ├─[2.5] memory-capture    ── 정규식 5종 → 명시적 fact/preference 저장 (Phase 26 B)
            ├─[3] ack                 ── ack reaction + typing controller
            ├─[4] context             ── enrichContext: alerts/portfolio/news/watchlist 병렬 (3s timeout)
            ├─[4.5] memory-retrieval  ── hybrid(vector+FTS) → SIMILARITY_THRESHOLD 0.65,
            │                            FRESHNESS_HALF_LIFE 90d, MAX_INJECTED 3,
            │                            symbol→listTransactions(limit 3) (Phase 26 C)
            ├─[5] execute             ── ExecutionAdapter.execute()
            │     │
            │     └─> RunnerExecutionAdapter.execute(ctx, signal)
            │          ├─ loadHistory(sessionKey)  ── slice(-20) tool_use/tool_result 페어 보전
            │          ├─ inferRole(message)       ── 키워드: analysis/fetch/chat
            │          ├─ buildDispatcher(registry,ctx) ── per-request, sessionId 캡처
            │          ├─ applyRouting()           ── role+hint+tool-floor → modelId, allowedToolNames
            │          ├─ filter exposed tools     ── minModel 미충족 도구 제외
            │          ├─ formatBackgroundSection(retrievalResult) → systemPrompt 끝에 합성
            │          └─ runWithModelFallback(chain, fallbackOn=[rate-limit,server-error,timeout,model-unavailable])
            │               └─> Runner.execute(params, listener)
            │                    ├─ ConcurrencyLane.acquire(laneId, sessionKey)
            │                    └─ for turn in 1..maxTurns(=10):
            │                         ├─ retry(streamLLMCall, shouldRetry=∈trigger)
            │                         │   └─ provider.streamCompletion()
            │                         │        └─ for chunk: text_delta|tool_use_*|usage|done
            │                         │             └─ ToolInputBuffer.feed() → ToolCall (JSON parse)
            │                         ├─ tokenCounter.add() / checkThresholds (80/95%)
            │                         ├─ if !toolCalls → return 'completed'
            │                         └─ ExecutionToolDispatcher.executeAll(toolCalls)  ─ Promise.all (병렬)
            │                              └─ ToolRegistry.execute(name, input, ctx)
            │                                   ├─ Zod 입력 검증
            │                                   ├─ evaluateToolPolicy() ── 9-단계 (deny→allow→user→channel→group→tool→finance→default)
            │                                   ├─ 루프 감지 (5회 / 10초)
            │                                   ├─ beforeToolExecute hook
            │                                   ├─ AbortController + timeoutMs (default 30s, 도구별 override)
            │                                   ├─ if isExternal: per-tool CircuitBreaker.execute()
            │                                   ├─ executor(input, ctx)
            │                                   ├─ guardToolResult() ── 100k 자르기, 금융 정규식 마스킹, HTML strip
            │                                   └─ afterToolExecute hook
            │          ├─ persistHistory(sessionKey, agentId, messages)
            │          └─ collectToolCalls() ── audit footer 용
            ├─[5.5] extractControlTokens ── <<NO_REPLY>>/<<SILENT_REPLY>>/<<ATTACH_DISCLAIMER>>...
            └─[6] deliver ── splitMessage(maxLen) → 직렬 send(), source footer ("📊 tool @ KST"),
                              capturedMemory 꼬리표, INVESTMENT_DISCLAIMER 옵션
```

별도 경로:

- `agent.run` RPC: 위 흐름 중 [4.5][5]만 직접. `persistAgentRunAndAttach()` → `addAgentRun(db,…)` →
  성공 시 `attachMemoryService.attach()` → `addMemoryWithEmbedding` (실패 시 FTS-only fallback) → `linkMemoryToAgentRun(runId, memoryId)`.
- TUI 경로: `executeForTui(input, listener, signal)` — WebSocket 으로 `text_delta`, `tool_use_*` fan-out.

## 도구 카탈로그

### FinClaw 보유 도구 (총 14개)

| Tool                  | Group   | minModel | external | timeout | transactional                |
| --------------------- | ------- | -------- | -------- | ------- | ---------------------------- |
| get_stock_price       | finance | haiku    | ✓        | 15s     | –                            |
| get_crypto_price      | finance | haiku    | ✓        | 15s     | –                            |
| get_forex_rate        | finance | haiku    | ✓        | 15s     | –                            |
| get_market_chart      | finance | haiku    | ✓        | 15s     | –                            |
| get_financial_news    | finance | haiku    | ✓        | 15s     | –                            |
| analyze_market        | finance | opus     | ✓        | 30s     | –                            |
| get_portfolio_summary | finance | sonnet   | ✓        | 20s     | – (sensitive)                |
| set_alert             | finance | haiku    | –        | 5s      | **✓** (require-approval)     |
| list_alerts           | finance | haiku    | –        | 5s      | –                            |
| remove_alert          | finance | haiku    | –        | 5s      | **✓**                        |
| get_alert_history     | finance | haiku    | –        | 5s      | –                            |
| get_current_datetime  | custom  | haiku    | –        | 1s      | –                            |
| web_fetch             | web     | haiku    | ✓        | 10s+1s  | –                            |
| read_local_file       | system  | haiku    | –        | 2s      | – (sensitive, fileRoot 격리) |

추가 RPC 표면(도구 아님 / 내부 핸들러): `finance.transaction.{add,list,update,delete}`, `finance.portfolio.get`, `memory.{list,delete,search}`, `agent.runs.{list,get}`, `agent.run/list/status`, `chat.*`, `schedule.*`.

### 현대 비서 표준 도구 비교

| Capability           | Claude.ai   | ChatGPT         | OpenDevin  | FinClaw                                                |
| -------------------- | ----------- | --------------- | ---------- | ------------------------------------------------------ |
| 시세/뉴스 조회       | (외부 plug) | (Bing/플러그인) | –          | **✓ (4+1+3)**                                          |
| Code interpreter     | (사이드)    | ✓               | ✓          | – (의도적)                                             |
| File read            | ✓           | ✓               | ✓          | ✓ (jail)                                               |
| Web fetch            | ✓           | ✓               | ✓          | ✓ (SSRF 가드 via `safeFetch`)                          |
| Web search           | ✓           | ✓               | ✓          | – (의도적; news 로 대체)                               |
| Vision (image input) | ✓           | ✓               | –          | – (모델 capabilities 에 명시했으나 메시지 변환 미구현) |
| File upload          | ✓           | ✓               | ✓          | –                                                      |
| Computer use         | ✓           | –               | ✓          | – (의도적)                                             |
| Calendar/Email       | (MCP)       | (Plugins/GPTs)  | –          | –                                                      |
| Custom tool 등록     | MCP         | Custom GPT      | Tool/Agent | InMemory + skill 모듈 (MCP X)                          |

## 갭 (Critical / Important / Nice-to-have)

### Critical (현대 비서 본질 결함)

**없음.** 도구 실패시 무한 루프, system prompt 누락, abort 미반영, 토큰 무한 누적 등은 모두 가드되어 있다.

### Important (사용성·신뢰성 손실)

1. **프로바이더 단일 — `ProviderId = 'anthropic'`**
   - 위치: `packages/agent/src/models/catalog.ts:4`, `providers/{adapter,anthropic}.ts`
   - 내용: `ProviderAdapter` 인터페이스는 잘 추상화되어 있으나 구현체 1개. `streamCompletion` SDK 의존(`@anthropic-ai/sdk`)이 모델 메시지 매퍼·tool 변환·`cache_control` 부착 등 핵심 코드에 직결.
   - 영향: 사용자 (장애 시 우회 불가), 운영자 (Bedrock/Vertex 미경유).
   - 작업량: M (OpenAI/Gemini 어댑터 추가는 SDK 차이 + `messages` 매핑 + 스트림 정규화).
   - 룰릭 2.3: 3점 기준 미달 (Anthropic + 1개 이상 통일 어댑터).

2. **`ConversationMessage.tool` 변환의 Anthropic 종속**
   - 위치: `packages/agent/src/providers/anthropic.ts:18-58` `toAnthropicMessages()`
   - 내용: 내부 도메인 모델(`role: 'tool'`, `ContentBlock`)이 Anthropic 의 `role: 'user'`+`tool_result` 형태로만 매핑됨. OpenAI 의 `role: 'tool'` + `tool_call_id` 와 다른 구조라, provider 어댑터를 늘릴 때 매핑 함수가 어댑터 안에 들어가야 함을 의미하며, 현재 위치만 봐서는 OK.
   - 영향: 개발자 (다른 어댑터 추가 비용).
   - 작업량: S.

3. **Vision / 파일 첨부 미구현**
   - 위치: `packages/types/src/...` `ContentBlock` 정의가 `text|tool_use|tool_result` 한정. 모델 catalog 의 `vision: true` (Opus/Sonnet/Haiku 4.5 모두) 와 어긋남.
   - 내용: 채널이 이미지 첨부를 받아도 LLM 으로 image block 전달 경로가 없다. `read_local_file` 도 텍스트만.
   - 영향: 사용자 (차트·캡처 분석 불가). 1인 금융 비서 시나리오에서는 priority 낮춤이지만, 캡처된 차트 해독 같은 요청에 대답 불가.
   - 작업량: M.
   - 룰릭 2.1 4점 (vision) 미달.

4. **자기-반성 / 계획 수정 / planner-executor 분리 부재**
   - 위치: `runner.ts` 의 turn 루프가 `텍스트 또는 toolCalls` 로 단순 종결 → 다음 턴.
   - 내용: 도구 실패·결과 빈약 시 자가 진단 후 다른 도구 시도, 계획 갱신, scratchpad 등 ReAct→Plan-and-Solve 패턴이 없다. `analyze_market` 도구 자체가 LLM 재호출이라 부분적 plan-execute 구조이긴 함.
   - 영향: 사용자 (잘못된 도구 선택 시 1턴 낭비), 룰릭 2.1 5점 영역.
   - 작업량: M (system prompt + reflection turn 추가).

5. **trace/span tree 표준(OTel) 부재**
   - 위치: `auto-reply/observer.ts`, EventBus(`getEventBus()`), `agent_runs` 테이블.
   - 내용: stage 별 logger.info / EventBus emit 은 충실하나, **trace ID 가 stage·tool·LLM 호출을 한 줄에 묶는 span tree** 가 없음. `agent_runs.id` 는 1건당 1행, 그 안의 도구 호출은 `tool_calls_json` 문자열로 응축.
   - 영향: 운영자 (Langfuse/Helicone import 불가 → 비교/재실행 곤란).
   - 작업량: M (`traceId` 컬럼 + EventBus payload 통일).
   - 룰릭 2.5: 3점 통과(`agent_runs` 채움), 4점(span tree)·5점(OTel) 미달.

6. **structured output / JSON schema 강제는 부분적**
   - 위치: `packages/skills-finance/prompts/news/analyze.standard.ko.md` 가 strict JSON 스키마를 prompt 에 박아두고, `JSON.parse` 책임을 `analyzeMarket()` 호출자에 둠.
   - 내용: Anthropic SDK 의 `tool_use` 강제 호출(예: `tool_choice: {type: 'tool', name: ...}`) 또는 JSON-mode 활용 X. prompt 만으로 schema 보장 → 실패 시 fallback 미정의.
   - 영향: 사용자 (드물게 분석이 비-JSON 으로 깨질 수 있음).
   - 작업량: S.
   - 룰릭 2.6: 5점 영역.

### Nice-to-have

7. **도구 결과 streaming back-to-LLM 부재.** 도구가 큰 결과(예: `web_fetch` 100KB)를 한 번에 컨텍스트로 끼워넣음. 청킹·요약 후 주입은 `result-guard` 만 함.
8. **prompt caching 적용 범위 제한.** `cache_control: ephemeral` 이 system prompt 와 마지막 도구에 부착되었으나, **대화 이력 prefix** 나 **자주 사용되는 사용자 배경지식 섹션**에는 미적용. RAG로 매 턴 주입되는 `formatBackgroundSection` 변동 → 캐시 적중률 저하 가능.
9. **루프 감지 = 경고만.** `policy.ts` 가 5회/10초 루프 감지 시 `console.warn` 만 함, 강제 중단 X.
10. **MCP 미연동.** 도구 정의를 외부에 노출/소비하는 표준 인터페이스 없음. Claude.ai 의 표준이 됨.
11. **Computer use·code interpreter** — 의도적 제외. 1인 금융 비서 시나리오에 비핵심.
12. **자동 도구 우회 선택.** 도구 실패 시 LLM 이 다음 턴에 다른 도구를 자발적으로 고르긴 하나, 폴백 도구 매핑이 명시적이지 않음.

## 현대 비서 비교 표

| 기능                     | Claude.ai                     | ChatGPT                   | OpenDevin | **FinClaw**                                 |
| ------------------------ | ----------------------------- | ------------------------- | --------- | ------------------------------------------- |
| ReAct 루프 + max_turns   | ✓                             | ✓                         | ✓         | ✓ (10)                                      |
| Parallel tool calls      | ✓                             | ✓                         | ✓         | ✓ (`Promise.all`)                           |
| 부분 도구 입력 streaming | ✓                             | ✓                         | –         | ✓ (`ToolInputBuffer`)                       |
| 사용자 인터럽트          | ✓                             | ✓                         | ✓         | ✓ (AbortSignal.any)                         |
| Prompt caching           | ✓                             | –                         | –         | ✓ (system + last tool)                      |
| Structured output 강제   | ✓ (tool_use)                  | ✓ (json_schema)           | –         | △ (prompt 만)                               |
| Vision / 이미지 입력     | ✓                             | ✓                         | –         | –                                           |
| 파일 업로드              | ✓                             | ✓                         | ✓         | –                                           |
| Computer use             | ✓                             | –                         | ✓         | – (의도)                                    |
| Code interpreter         | △                             | ✓                         | ✓         | – (의도)                                    |
| 다중 프로바이더          | (Bedrock/Vertex)              | (OpenAI 단일)             | ✓         | – (Anthropic 단일)                          |
| 자기-반성 / 계획 수정    | △ (extended thinking)         | △ (o-series)              | ✓         | –                                           |
| Trace/Audit              | (Langsmith·Anthropic console) | (Helicone 등)             | (logs)    | △ (`agent_runs`+EventBus, span tree X)      |
| 회로차단 / fallback      | ✓                             | ✓                         | –         | ✓ (per-provider, tier floor)                |
| Tool 정책 / 권한         | ✓ (MCP roots)                 | ✓ (Function calling auth) | (sandbox) | ✓ (9-stage policy + group + finance-safety) |
| 메모리 / RAG 주입        | (Projects)                    | (Memory)                  | –         | ✓ (hybrid + freshness + audit)              |
| Control tokens           | (XML/role)                    | –                         | –         | ✓ (NO_REPLY/SILENT_REPLY 등 6종)            |

## 핵심 강점 (현대 비서 평균을 상회)

- **금융 안전 정책 9-stage 파이프라인** (`policy.ts`) — `isTransactional → require-approval`, `accessesSensitiveData → warn`, `FINANCIAL_REDACT_PATTERNS` (카드/SSN/계좌). 이는 ChatGPT plug-in 이나 Claude.ai 가 일반 정책으로 표준화하지 않은 도메인 특화 가드.
- **모델 tier floor** (`ModelFloorExhaustedError`) — `analyze_market.minModel=opus` 일 때 Opus 503 → Sonnet 자동 다운그레이드 X, 60s 후 재시도 안내. 환각 방지·읽기 전용 원칙과 정합.
- **transcript-repair** — orphan tool_result, missing tool_result, duplicate, invalid sequence 5종 자동 복구. 다른 비서들은 보통 transcript 재생성에 의존.
- **per-tool CircuitBreaker** + `isExternal` 플래그 — 외부 API 도구만 회로차단, 내부 store 도구는 즉시 실패.
- **Result guard** — 100KB 절단·금융 정규식 마스킹·HTML strip·JSON 제어문자 제거가 한 함수에 응축. 도구 응답 신뢰도 ↑.

## 권장 우선순위

1. (Important #5) `traceId` 컬럼 도입 + EventBus payload 통일 → 기본적인 span tree 가능. **S–M**.
2. (Important #6) `analyze_market` 등 JSON 응답 도구를 Anthropic `tool_use` 강제 호출로 전환 → schema 보장. **S**.
3. (Important #1) OpenAI 또는 Gemini 어댑터 추가 — `ProviderId` union 확장 + 메시지 매퍼 분리. **M**.
4. (NTH #8) prompt caching 을 사용자 배경지식 섹션에도 적용 (변동 시만 무효화) → 캐시 적중률 ↑. **S**.
5. (Important #4) 한 턴짜리 `<<REFLECT>>` 제어 토큰 + 도구 실패 시 reflection prompt → 재시도 정책. **M**.
6. (Important #3) 채널 이미지 첨부 → ContentBlock 'image' 추가 → vision 활용. **M**.

---

**평균 3.43/5, MVP(3.0) 통과, Production-grade(4.0) 직전.**
**Critical 0 / Important 6 / Nice-to-have 6.**
