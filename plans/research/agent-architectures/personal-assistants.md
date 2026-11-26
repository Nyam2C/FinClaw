# Lane 1 — 개인 비서형 AI 에이전트 아키텍처 조사

> 조사 레인 보고서 원문 (2026-11-26). 요약은 [`../agent-architectures.md`](../agent-architectures.md). 경로 · 줄 번호는 본문 표의 분석 커밋 기준이며, 레포 코드는 실행하지 않고 읽기만 했다.

작성일 2026-11-26. FinClaw 가 `claude` CLI 래핑을 걷어내고 자체 agent loop 를 만들기 전에, 지금 가장 많이 쓰이는 개인 비서형 오픈소스 에이전트들이 루프·상태·도구·컨텍스트·메모리를 어떻게 짜 놓았는지 소스 코드로 확인한 기록이다.

## 0. 검증과 방법

### 저장소 검증 (`gh api repos/<owner>/<repo>`, 2026-11-26 조회)

| 저장소                      | Stars   | 분석한 HEAD (커밋 시각)                 | 마지막 push | 언어             | 라이선스   | 비고                                                               |
| --------------------------- | ------- | --------------------------------------- | ----------- | ---------------- | ---------- | ------------------------------------------------------------------ |
| `openclaw/openclaw`         | 395,240 | `0f1bb35f` (2026-11-26)                 | 2026-11-26  | TypeScript       | MIT        | 살아 있음. 저장소 17.9GB                                           |
| `NousResearch/hermes-agent` | 266,149 | `010f119d` (2026-11-25)                 | 2026-11-26  | Python           | MIT        | 살아 있음                                                          |
| `letta-ai/letta`            | 25,549  | `archive` 브랜치 `56ba9c2` (2026-08-13) | 2026-10-18  | (main 은 문서만) | Apache-2.0 | **main 은 README 스텁.** 현행 소스는 `letta-ai/letta-code` 로 이전 |
| `letta-ai/letta-code`       | 3,915   | `ed518ca` (2026-11-26)                  | 2026-11-26  | TypeScript       | Apache-2.0 | letta 의 후속. 이 보고서의 주 분석 대상                            |
| `HKUDS/nanobot`             | 50,341  | `c360a10` (2026-11-26)                  | 2026-11-26  | Python           | MIT        | 검색으로 추가한 4번째                                              |

`letta-ai/letta` 에 대해: main 브랜치 README 가 "The current source code lives in `letta-ai/letta-code`" 라고 명시하고, 은퇴한 V1 Python API 서버는 `archive` 브랜치에 남아 있다고 안내한다. 그래서 `letta-code`(현행)를 주로, `letta` 의 `archive` 브랜치(V1 서버)를 보조로 읽었다. 별 25.5K 는 옛 저장소의 것이고 현행 코드 저장소는 3.9K 다.

### 4번째 저장소 선정

`gh search repos` 를 stars 순, `pushed:>2026-08-26` 조건으로 세 번 돌렸다("personal assistant agent", "ai agent", topic `ai-agent`). 사용자가 준 목록보다 별이 많은 개인 비서형 에이전트는 **없다** — openclaw(395K)와 hermes-agent(266K)가 이 범주 1, 2위다. 그 다음이 `HKUDS/nanobot`(50.3K, "Your lightweight open-source personal agent")이고, letta(25.5K)의 두 배이면서 "작은 코드베이스" 를 표방하므로 1인 감사 가능한 TypeScript 재작성의 비교 대상으로 가장 쓸모 있다고 판단해 추가했다.

검색에 함께 잡혔지만 넣지 않은 것:

- `earendil-works/pi`(123,926 stars, TypeScript, "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI"): 개인 비서가 아니라 툴킷/코딩 에이전트라 이 lane 범위 밖이다. 다만 OpenClaw 의 코어 루프가 여기서 나왔으므로(`openclaw/THIRD_PARTY_NOTICES.md:18-24`) 루프만 따로 볼 가치가 있다. 이 보고서에서는 분석하지 않았다.
- `zhayujie/CowAgent`(48,080), `AstrBotDevs/AstrBot`(47,514), `agentscope-ai/QwenPaw`(38,211): 개인 비서형이지만 nanobot 보다 별이 적어 제외.

### 방법과 한계

- openclaw 는 내가 직접, 나머지 셋은 같은 지침을 받은 병렬 하위 에이전트가 읽고 절을 썼다. 하위 에이전트가 쓴 절은 인용 몇 군데를 내가 다시 열어 대조했다(각 절 끝의 "교차 확인" 줄에 대조한 항목을 적었다).
- LOC 는 `wc -l` 기준이고 주석·빈 줄을 포함한다. 규모 감을 잡는 용도다.
- 동작을 실행해서 확인한 것은 하나도 없다. 전부 정적 읽기다.

## 1. 한눈에 비교

| 항목                    | openclaw                                                       | hermes-agent                                                | letta-code (+ V1)                                               | nanobot                                        |
| ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| 루프 위치               | `packages/agent-core/src/agent-loop.ts`                        | `agent/conversation_loop.py` + `agent/turn_*.py`            | 클라이언트 `src/headless.ts` (LLM 호출은 서버 또는 로컬 백엔드) | `nanobot/agent/runner.py`                      |
| 누가 멈추나             | 모델 (tool call 없음)                                          | 모델 (+ stop gate 가 nudge 가능)                            | 모델 (`end_turn`)                                               | 모델 (실행 가능한 tool call 없음)              |
| iteration 상한 기본값   | 없음. 동일 호출 20회 연속 시 정지                              | 무제한 (`sys.maxsize`). sub-agent 250                       | 무제한 (`--max-turns` 선택). V1 은 50                           | 200, 도달 시 tool 없는 마무리 호출 1회         |
| 병렬 tool               | 기본 병렬, 도구가 `sequential` 선언                            | read-only whitelist 만, worker 8                            | `PARALLEL_SAFE_TOOLS` 만, 쓰기는 리소스 키별 직렬               | `read_only` 인 연속 호출만                     |
| Transcript 저장         | SQLite `transcript_events(session_id, seq)`                    | SQLite `sessions` / `messages` + FTS5                       | 서버 DB, 로컬은 `messages.jsonl` append-only                    | SQLite `sessions` / `messages` / `checkpoints` |
| 세션 키                 | `agent:<id>:<channel>:direct:<peer>` (`dmScope` 로 조절)       | `<ns>:<platform>:<chat_type>:<chat_id>…`                    | 채널 route → agent/conversation                                 | `channel:chat_id`                              |
| 턴별 컨텍스트 주입 위치 | system 의 cache boundary 아래 + 별도 Runtime Context 메시지    | 현재 user 메시지 (system prompt 는 세션당 1회 생성 후 저장) | 대화 끝에 `<memory_update>` / `<system-reminder>`               | 현재 user 메시지 뒤                            |
| Compaction 트리거       | window − 16,384. Anthropic 직결이면 서버측 edits               | 0.50 (작은 창은 0.75) + overflow                            | window − min(16,384, 20%). V1 은 90%                            | window − max_tokens − 1,024, 또는 15분 유휴    |
| 장기 메모리             | Markdown (`MEMORY.md`, `USER.md`, 일별 노트) + 하이브리드 검색 | Markdown 2개 (2,200 / 1,375자) + FTS5 세션 검색             | git 으로 관리하는 Markdown (MemFS). V1 은 DB 블록 + 벡터        | Markdown + `history.jsonl`, grep               |
| 메모리 작성자           | 모델 + pre-compaction flush + dreaming                         | 모델(`memory` 도구) + 10턴마다 백그라운드 리뷰              | 모델(파일 편집 + commit) + reflection sub-agent                 | 모델 + compaction 요약 + 2시간마다 Dream       |
| Sub-agent               | `sessions_spawn`, 깊이 5, 비동기 announce                      | `delegate_task`, 깊이 1, 동시 10                            | 자식 프로세스, 깊이 2                                           | `subagent`, 재귀 불가, 동시 4                  |
| Cron                    | Gateway 내 스케줄러, SQLite                                    | 60초 tick, `jobs.json`                                      | 60초 tick, `crons.json`                                         | 단일 타이머, `jobs.json`                       |
| Heartbeat               | cron job 으로 흡수됨                                           | 없음                                                        | 없음 (`Wake` / `Monitor` 도구)                                  | cron 시스템 job, 3단 게이트                    |
| 승인 게이트             | exec 중심 (`deny/allowlist/ask/auto/full`)                     | 터미널 명령 패턴 중심                                       | 권한 엔진 있으나 기본 `unrestricted`                            | 없음 (경계 가드만)                             |
| 규모 (test 제외)        | 코어 1.1만 / 런타임 수십만 줄                                  | 약 118만 줄                                                 | `src/` 33만 줄                                                  | 14.5만 줄 (핵심 16파일 1.2만)                  |

네 프로젝트 어디에서도 찾지 못한 것: 도구의 read-only/mutating 선언 하나로 승인을 결정하는 일반 규칙, 턴 단위 토큰·비용 예산, 답변 내용(수치·사실)을 검증하는 출력 가드.

## 2. openclaw (openclaw/openclaw)

395,240 stars · HEAD `0f1bb35f` (2026-11-26) · TypeScript · MIT · 저장소 크기 17.9GB라 `--depth 1 --filter=blob:none --sparse` 로 `src/`, `packages/`, `extensions/memory-core`, `docs/{concepts,tools,automation,gateway}` 만 체크아웃해 읽었다. 그 밖의 199개 extension(채널 플러그인 포함), `apps/`(macOS/iOS 앱), `qa/` 는 트리 목록만 확인했다.

### 한 줄 요약

코어 루프 자체는 작고 깨끗하다(`packages/agent-core/src/agent-loop.ts` 930줄, pi-mono 에서 가져온 계보 — `THIRD_PARTY_NOTICES.md:18-24`). 하지만 그 위에 얹힌 런타임(`src/agents` 54만 줄, `src/gateway` 54만 줄)은 한 사람이 감사할 수 있는 규모를 한참 넘었다. FinClaw 가 예전에 본뜬 OpenClaw 와는 이미 다른 물건이다: 세션 저장이 JSONL 에서 per-agent SQLite 로, heartbeat 가 일반 automation job 으로 흡수됐다.

### 1. Agent loop

- 위치: `packages/agent-core/src/agent-loop.ts`. 진입점 `runAgentLoop`(87-124), `runAgentLoopContinue`(126-142), 본체 `runLoop`(148-470).
- 모양: 이중 while. 안쪽 루프(`while (hasMoreToolCalls || pendingMessages.length > 0)`, 211행)가 "LLM 스트림 1회 + 도구 배치 1회" 를 한 turn 으로 돌고, 바깥 루프(208행)는 안쪽이 끝난 뒤 `getFollowUpMessages`(456행)로 대기 중인 후속 입력이 있으면 다시 돈다.
- 종료 결정권은 모델에 있다. `hasMoreToolCalls` 계산(342-347행)은 "도구 배치가 실행됐고 `terminate` 가 아니면 계속" 이 전부다. 도구 호출이 없으면 끝난다. 호스트가 끼어드는 지점은 네 곳: (a) `signal.aborted`(`stopIfAborted`, 167-198), (b) `executedToolBatch.repeatStop`(376-393), (c) `config.shouldStopAfterTurn`(431행), (d) `prepareNextTurn` 이 돌려주는 `stop`.
- **max-iteration 이 없다.** `agent-core/src` 전체에서 `maxTurns|maxIterations|maxSteps|maxToolCalls` 를 grep 했지만 0건. 대신 "같은 도구 + 같은 인자" 연속 호출만 센다: `TOOL_REPEAT_NOTE_AT = 3`(결과에 시스템 노트 첨부), `TOOL_REPEAT_STOP_AT = 20`(실행하지 않고 turn 종료, `tool_repeat_limit`) — `packages/agent-core/src/tool-repeat-guard.ts:12-14, 47-71`. 결과가 아니라 인자만 비교하고, 사용자 입력이 커밋되면 리셋된다. polling 도구는 `repeatable` 로 면제(`types.ts` 의 `AgentTool.repeatable`).
- 시간 예산: 모델 attempt 당 타임아웃 기본값이 `DEFAULT_AGENT_TIMEOUT_SECONDS = 48 * 60 * 60`(`src/agents/timeout.ts:13`). 사실상 무제한에 가깝다. cron 실행은 별도 60분 watchdog(`docs/automation/cron-jobs/how-it-works.md`).
- 병렬 도구 호출: 기본이 병렬. `config.toolExecution === "sequential"` 이거나 배치 안에 `executionMode: "sequential"` 도구가 하나라도 있으면 배치 전체가 순차로 내려간다(`agent-loop.ts:527-541`). 병렬 그룹은 "함께 준비 → 실행 → 원래 순서대로 결과 커밋"(`executeToolCallGroups`, 599-780; `launchParallelToolCalls` 는 `agent-loop-tool-execution.ts:382-451`).
- 스트리밍 중 조기 실행: `streamAgentResponse` 에 `executeToolCalls` 콜백을 넘겨, 응답 스트림이 끝나기 전에 완성된 tool call 부터 실행한다. 루프는 `streamed.executedIds` 에 없는 나머지만 스트림 종료 후 실행한다(`agent-loop.ts:285-338`).
- 재시도는 코어 루프 밖에 있다. `src/agents/embedded-agent-runner/run-loop.ts:211` 의 `while (true)` 가 attempt 단위로 돌며, 예산은 `BASE_RUN_RETRY_ITERATIONS = 24`, `RUN_RETRY_ITERATIONS_PER_PROFILE = 8`, `MIN 32`, `MAX 160`(`run/helpers.ts:52-63`). 이 루프가 auth profile 교체, 모델 failover, overflow 시 compaction 후 재시도, timeout 후 compaction 재시도를 모두 맡는다. rate limit 은 "연속 장애당 최대 16회 시도" 라고 문서화돼 있다(`docs/concepts/retry.md:38`; 코드 상수 위치는 확인하지 못함).
- Abort: 표준 `AbortSignal` 하나가 루프·스트림·도구(`execute(toolCallId, params, signal, onUpdate)`)로 전달된다. 중단 시 "aborted" assistant 메시지를 transcript 에 남겨, 이후 compaction/continue 가 짝 없는 `toolUse` 에서 이어가지 않게 한다(`agent-loop.ts:174-197`). 외부에서 끊는 API 는 `abortEmbeddedAgentRun`(`src/agents/embedded-agent-runner/runs.ts:317`).
- Steering: 실행 중인 run 에 새 사용자 메시지를 끼워 넣는 경로가 루프에 내장돼 있다(`getSteeringAtCheckpoint`, `agent-loop-steering.ts`). 큐 모드는 `steer / followup / collect / interrupt` 네 가지(`docs/concepts/queue.md:49-52`).

### 2. Message/state 모델

- 메모리 내 표현: `AgentContext { systemPrompt, messages: AgentMessage[], tools }`(`packages/agent-core/src/types.ts:503-512`). 메시지 role 은 user / assistant / toolResult 이고 assistant content 안에 `toolCall` 블록이 들어간다(provider 중립 포맷, `@openclaw/llm-core`).
- 영속화: agent 별 SQLite 파일 `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`(`docs/concepts/session.md:364`). transcript 는 append-only 이벤트 테이블이다: `transcript_events(session_id, seq, event_json, event_zstd, ...)`, PK `(session_id, seq)`(`src/state/openclaw-agent-schema.sql:456-470`). 예전 `sessions.json` + JSONL 은 import 대상인 레거시다(`docs/concepts/session.md:385-396`).
- 스키마가 크다: 같은 파일에 테이블 50여 개(`session_nodes`, `session_windows`, `conversations`, `conversation_deliveries`, `session_pending_inputs`, `heartbeat_outcomes`, `memory_index_chunks`, `standing_intents`, `session_transcript_fts` …) — `src/state/openclaw-agent-schema.sql` 946줄.
- 세션 키: `agent:<agentId>:<channel>:direct:<peerId>` 같은 문자열. `dmScope` 가 `main`(기본, 모든 DM 이 main 세션 공유) / `per-peer` / `per-channel-peer` / `per-account-channel-peer` 중 하나를 고른다(`src/routing/session-key.ts:195-236`). sub-agent 는 `agent:<agentId>:subagent:<uuid>`, cron 은 `cron:<jobId>`.
- 동시성 안전장치: admit 된 run 이 `activeWriterRunId` 를 기록하고, 모든 transcript append/rewrite 가 `expectedWriterRunId` 를 같은 트랜잭션에서 검증한다. 밀려난 run 은 stale 데이터를 커밋할 수 없다(`docs/concepts/agent-loop.md` "Queueing and concurrency"; 구현은 `src/config/sessions/` 아래 여러 파일에 흩어져 있어 한 곳으로 짚지 못함).
- Resume: `runAgentLoopContinue` 는 마지막 메시지가 assistant 면 `TranscriptNotContinuableError` 를 던진다(`agent-loop.ts:134-141`) — "user 또는 toolResult 로 끝나는 transcript 만 이어갈 수 있다" 는 불변식.

### 3. Tool 인터페이스

- 정의: TypeBox 스키마 기반 `AgentTool<TParameters, TDetails>` — `name/description/parameters` + `label`, `execute(toolCallId, params, signal, onUpdate)`, `executionMode`, `interruptible`, `repeatable`, `resultContentSource`, `prepareArguments`(`packages/agent-core/src/types.ts:458-498`). 실패는 content 에 넣지 말고 throw 하라는 규약이다(같은 파일 주석).
- 결과 타입 `AgentToolResult { content, details, progress?, terminate? }`(`types.ts:438-450`): 모델용 `content` 와 UI/로그용 `details` 를 분리하고, 채널에 보여도 안전한 진행 문구(`progress`)를 따로 둔다.
- 검증: 스키마 검증 → `beforeToolCall` 훅(차단 가능) → 실행 순서(`agent-loop.ts:869-910`). 알 수 없는 도구는 `Tool X not found` 를 tool result 로 돌려준다(924행). 깨진 인자를 복구하는 패키지가 따로 있다(`packages/tool-call-repair`, 4,289줄).
- 권한은 세 겹이다(`docs/gateway/sandbox-vs-tool-policy-vs-elevated.md:9-13`): (1) sandbox — 도구가 어디서 실행되나, (2) tool policy — 어떤 도구가 노출되나(profile → provider profile → allow/deny → sandbox allow/deny 5단), (3) exec 승인 모드 `deny / allowlist / ask / auto / full`(`docs/tools/permission-modes.md`). 구현은 `src/agents/tool-policy*.ts`, `src/agents/agent-tools.before-tool-call*.ts`, `src/agents/bash-tools.exec-approval-*.ts`.
- "read-only vs mutating" 을 도구 속성 하나로 가르는 게이트는 **찾지 못함**. 승인은 exec(셸)와 일부 MCP 도구 중심이고, 나머지는 "노출하느냐 마느냐" 로 통제한다.
- MCP: 클라이언트(`mcp.servers` 설정, stdio / SSE / Streamable HTTP; 런타임은 `src/agents/agent-bundle-mcp-*.ts`)이자 서버(`openclaw mcp serve`, `src/mcp/`)다. MCP 도구도 같은 tool policy 를 탄다. 서버 instructions 는 서버당 2,000자로 자른다(`docs/tools/mcp.md`).
- 도구가 많을 때: Tool Search / Code Mode 로 스키마를 지연 로드한다(`docs/tools/tool-search.md`, `docs/tools/code-mode.md`) — 도구 수십 개 수준에서는 불필요하다.

### 4. Context 관리

- System prompt 조립: `buildAgentSystemPrompt`(`src/agents/system-prompt.ts:263`, 파일 857줄). `promptMode` 가 `full / minimal / none`(347-418행) — sub-agent 는 `minimal`.
- Bootstrap 파일 주입: workspace 의 `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`(신규 workspace 만), `MEMORY.md` 를 system prompt 에 넣는다(`docs/concepts/system-prompt.md:174-179`). 상한은 파일당 `DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000`(`src/agents/embedded-agent-helpers/bootstrap-limits.ts:3`), 합계 `DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 60_000`(`bootstrap.ts:14`). sub-agent 는 `AGENTS.md` 만 받는다.
- **Prompt cache 경계**: system prompt 문자열 안에 `SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n"` 마커를 박고(`packages/ai/src/utils/system-prompt-cache-boundary.ts:5`, 삽입은 `system-prompt.ts:593`), 안정적인 내용(프로젝트 컨텍스트, 고정 정책)은 위, 자주 바뀌는 내용(도구 카탈로그, 런타임 정보, 채널 정보)은 아래에 둔다. 날짜/시각처럼 매 turn 바뀌는 값은 system prompt 가 아니라 별도 "Runtime Context" 메시지로 실어 이력 캐시를 보존한다(`docs/concepts/system-prompt.md` Structure 절).
- Anthropic `cache_control` 배치(`packages/ai/src/transports/anthropic-payload-policy.ts:286-372`): 마지막 tool 정의 1개 + system 블록 + **마지막 user 메시지 2개**의 마지막 text/image/tool_result 블록. 총량은 `ANTHROPIC_CACHE_CONTROL_LIMIT = 4`(58행). TTL 은 `5m` 또는 `1h`(41-42행).
- Anthropic 서버측 context management 를 쓴다(직접 API key 경로 한정): `clear_tool_uses_20250919`(`keep: { tool_uses: 3 }`, `clear_tool_inputs: false`)와 `compact_20260112`(`instructions` 로 요약 프롬프트 교체) — 같은 파일 557-586행. 서버 compaction 의 최소 트리거는 `ANTHROPIC_COMPACT_THRESHOLD_MIN = 50_000` input tokens(59행).
- 클라이언트측 compaction: `packages/agent-core/src/harness/compaction/`. 기본값 `reserveTokens: 16384`, `keepRecentTokens: 20000`(`compaction.ts:60-64`), 트리거는 `contextTokens > contextWindow - reserve`(`shouldCompact`, 77-92). 요약은 고정 구조 체크포인트다 — Goal / Constraints & Preferences / Progress(Done·In Progress·Blocked) / Key Decisions / Next Steps / Critical Context(`summary-checkpoint-prompt.ts:5-46`). 이전 요약이 있으면 "기존 정보 보존 + 갱신" 프롬프트로 증분 갱신한다(47-65행).
- 잘라낼 지점은 tool_use/tool_result 쌍을 깨지 않게 조정한다(`compaction-cut-point.ts:185, 320-322` 의 `createToolPairCutResolver`). 한 turn 이 너무 커서 중간을 잘라야 하면 turn 앞부분만 따로 요약한다(`TURN_PREFIX_SUMMARIZATION_PROMPT`, 같은 파일 67행).
- Tool result 크기 제한: `src/agents/embedded-agent-runner/tool-result-truncation.ts`(1,186줄) — 집계 상한이 컨텍스트의 절반(`AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = 0.5`, 51행).
- Context engine 은 플러그인 슬롯이다(기본 `legacy`, `docs/concepts/context-engine.md`).

### 5. Memory

- 저장 형태는 workspace 의 평범한 Markdown 이다(`docs/concepts/memory.md:9-11`: "there is no hidden state"). `USER.md`(사용자 모델, 지시문 형태), `MEMORY.md`(선별된 장기 사실 — 매 세션 system prompt 에 주입), `memory/YYYY-MM-DD.md`(일별 노트 — 주입하지 않고 검색 대상), `DREAMS.md`(사람이 검토하는 통합 기록).
- 누가 쓰나 — 세 경로:
  1. 에이전트가 대화 중 파일 도구로 직접 쓴다("Remember that…" → 파일 기록).
  2. **Pre-compaction memory flush**: compaction 직전에 조용한 turn 을 한 번 돌려 `memory/YYYY-MM-DD.md` 에 append 만 하게 한다. `MEMORY.md` 등은 이 turn 에서 읽기 전용이고, 저장할 게 없으면 `NO_REPLY` 로 끝난다(`extensions/memory-core/src/flush-plan.ts:13-39`). 트리거 여유분은 `DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000`.
  3. **Dreaming**: cron 으로 도는 백그라운드 통합(light/deep/REM 단계)이 일별 노트의 강한 신호를 `MEMORY.md` 로 승격한다. 기본 활성(`docs/concepts/dreaming.md`).
- 검색: `memory_search` / `memory_get` 도구. FTS5(trigram) 키워드 + 벡터 하이브리드, MMR 다양성(`docs/concepts/memory-search.md:17-30, 147-152`). 인덱스는 같은 SQLite 의 `memory_index_chunks`, `memory_embedding_cache`.
- Active Memory: 과거를 묻는 메시지일 때만 답변 전에 recall sub-agent 를 한 번 블로킹으로 돌린다(기본 `escalate` 모드, `docs/concepts/active-memory.md`).
- 규모: `extensions/memory-core` 가 44,622줄(test 제외). 메모리 "아이디어" 는 단순한데 구현은 그렇지 않다.

### 6. Sub-agent / delegation

- `sessions_spawn` 도구가 별도 세션(`agent:<agentId>:subagent:<uuid>`)에서 백그라운드 run 을 띄우고, 끝나면 결과를 요청자 세션에 **announce** 한다(`docs/tools/subagents.md:12-15`). 부모는 블로킹하지 않고, 기다리려면 `sessions_yield` 를 쓴다.
- 기본 한도: `DEFAULT_SUBAGENT_MAX_CONCURRENT = 8`, `DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5`, `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 5`(`src/config/agent-limits.ts:20-24`).
- 격리: 자식은 기본적으로 session/message 도구를 받지 못하고, 컨텍스트는 새로 시작한다(`context: "fork"` 로 부모 transcript 복제 가능). system prompt 는 `minimal` 모드.
- 규모: `src/agents/subagents/` 46,067줄(test 제외).

### 7. Streaming / event 모델

- 코어 이벤트는 10종이다: `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`(`packages/agent-core/src/types.ts:520-563`). 루프는 `emit: AgentEventSink` 콜백 하나에만 의존한다.
- 런타임은 이를 세 스트림으로 다시 묶는다: `assistant` / `tool` / `lifecycle`(`phase: start | finishing | end | error`) — `src/agents/embedded-agent-subscribe.handlers.*.ts`(`lifecycle.ts:277`, `tools.start.ts:381`).
- 채널에는 토큰 단위 스트리밍을 하지 않는다. 완성된 블록 단위 전송(block streaming) 또는 미리보기 메시지 편집(preview streaming)이고, delta 는 75ms 주기로 합친다(`docs/concepts/streaming.md:10-23`).
- UI/클라이언트는 Gateway WebSocket 의 `req / res / event` 프레임으로 붙는다(`docs/gateway/protocol/handshake.md`). `agent` RPC 는 `{ runId, acceptedAt }` 를 즉시 돌려주고 결과는 이벤트 또는 `agent.wait` 로 받는다(`docs/concepts/agent-loop.md` Run sequence).

### 8. Proactive (cron/heartbeat/알림)

- 스케줄러는 Gateway 프로세스 안에서 돈다. job 정의·상태·실행 이력은 SQLite 에 저장된다(`docs/automation/cron-jobs/how-it-works.md`). 구현 `src/cron/` 50,478줄.
- **Heartbeat 는 독립 기능으로서는 사라졌다**: "Heartbeat monitoring now uses ordinary automation jobs"(`docs/gateway/heartbeat.md:12-16`). 기존 `HEARTBEAT.md` 는 doctor 가 job 으로 변환한다.
- job 은 세션 대상(`main` 세션에 system event 로 주입 / 격리된 `cron:<jobId>` 세션 / 특정 `session:<key>`)과 전달 대상(채널, webhook, 없음)을 따로 갖는다. `session:<key>` 대상 job 은 그 대화가 idle 이 될 때까지 기다린다.
- 재시작 시 밀린 job 은 즉시 재실행하지 않고 다시 스케줄한다. one-shot job 은 전달이 확인돼야 삭제된다. 동시 실행은 기본 8개.
- 격리 실행의 "가짜 완료" 방어: 첫 결과가 "on it" 류 중간 보고뿐이면 한 번 더 재촉한다(같은 문서 "Isolated run hardening").

### 9. Guardrails / evals / tracing

- Turn taint: 네트워크에서 온 tool result(`resultContentSource: "network"`)가 그 turn 을 "오염" 으로 표시하고, 표시는 assistant 메시지 메타데이터로 transcript 에 남는다(`packages/agent-core/src/turn-taint.ts:1-65`). 이 표시를 어디서 소비해 무엇을 막는지까지는 추적하지 못했다.
- 반복 방어: tool repeat guard(위 1절) + assistant 반복 가드(`assistant-repetition-guard.ts`).
- 플러그인 훅: `before_tool_call`(`{ block: true }` 는 종결적), `after_tool_call`, `tool_result_persist`, `before_prompt_build`, `message_sending` 등(`docs/concepts/agent-loop.md` Plugin hooks 표).
- Trajectory: 세션별 flight recorder. 모델에 보낸 prompt/system prompt/tools, tool call, timeout/abort/compaction 여부, usage 와 prompt-cache 메타데이터를 기록하고 `/export-trajectory` 로 redaction 된 번들을 뽑는다(`docs/tools/trajectory.md`, `src/trajectory/` 3,952줄).
- OpenTelemetry: `diagnostics-otel` 플러그인이 내부 diagnostics 이벤트를 OTLP/HTTP 로 내보낸다(`docs/gateway/opentelemetry.md`).
- Evals: `qa/scenarios/*.yaml` 시나리오 카탈로그(`qa/` 627개 파일)와, 그중 개인 비서용 10개 묶음 "Personal Agent Benchmark Pack"(리마인더 왕복, 선호 기억 회상, 비밀 미노출, 승인 거부 시 정지, 가짜 진행 보고 금지 등 — `docs/concepts/personal-agent-benchmark-pack.md`). 시나리오 파일 자체는 읽지 않았다.

### 10. 규모 (LOC, test 제외 `.ts`)

| 영역                                             | 경로                                          | 줄 수           |
| ------------------------------------------------ | --------------------------------------------- | --------------- |
| 코어 루프 파일                                   | `packages/agent-core/src/agent-loop.ts`       | 930             |
| 코어 루프 패키지 (harness 포함)                  | `packages/agent-core/src`                     | 10,958          |
| 그중 루프 + 도구 실행 + 이벤트 (최상위 파일)     | `packages/agent-core/src/*.ts`                | 5,117           |
| LLM provider 계층                                | `packages/ai`                                 | 39,044          |
| 임베디드 러너 (재시도·compaction 오케스트레이션) | `src/agents/embedded-agent-runner` (+ `run/`) | 34,023 + 44,772 |
| 에이전트 런타임 전체                             | `src/agents`                                  | 543,957         |
| Gateway                                          | `src/gateway`                                 | 538,387         |
| 채널 진입 파이프라인                             | `src/auto-reply`                              | 99,655          |
| Cron                                             | `src/cron`                                    | 50,478          |
| Sub-agent                                        | `src/agents/subagents`                        | 46,067          |
| Memory 플러그인                                  | `extensions/memory-core`                      | 44,622          |

저장소 전체 `.ts` 파일은 52,997개다.

### 지저분한 점 / 찾지 못한 것

- 코어와 런타임의 규모 차이가 100배다. 코어 루프는 그대로 읽고 배울 수 있지만, "OpenClaw 가 X 를 어떻게 하나" 의 답은 대부분 `src/agents` 의 수백 개 파일에 흩어져 있어 문서(`docs/concepts/*.md`) 없이는 따라가기 어렵다. 이 절의 런타임 관련 서술 상당수는 문서를 길잡이로 삼고 상수·함수 위치만 코드로 확인한 것이다.
- 파일명이 책임을 잘게 쪼갠 흔적을 보여준다: `src/agents/embedded-agent-runner/run/` 에 `attempt-*.ts` 만 수십 개, compaction 관련이 `compact.ts`, `compact.queued.ts`, `compaction-session-execution.ts`, `prepared-compaction-*.ts`, `exact-compaction-replay.ts` … 로 나뉜다. `agent-loop.ts` 끝에는 `oxlint-disable max-lines -- TODO: split this grandfathered oversized file` 주석이 있다(930행).
- 메모리 flush 상수가 두 곳에 중복 정의돼 있다(`src/auto-reply/reply/memory-flush-plan.ts:16-17` 과 `extensions/memory-core/src/flush-plan.ts:13-14`).
- 찾지 못함: 코어 루프의 iteration 상한(없음을 확인), read-only/mutating 단일 게이트, rate-limit 재시도 횟수의 코드 상수 위치, turn taint 의 소비 지점, writer-claim 검증의 단일 구현 지점.

## 3. hermes-agent (NousResearch/hermes-agent)

266,149 stars (gh api 2026-11-26 확인) · HEAD `010f119d` (2026-11-25T22:31:52-06:00) · Python · MIT. 경로는 모두 repo 루트 기준.

### 한 줄 요약

"모델이 tool call 을 안 내면 끝" 인 단순 ReAct 루프를, 프롬프트 캐시 바이트 안정성 · 영속화 선행 · 압축 · 승인 게이트로 겹겹이 감싼 거대 Python 코드베이스다. 루프의 형태(약 50줄)와 캐시/압축/인터럽트 규칙은 그대로 베낄 가치가 있지만, 구현 규모(비테스트 Python 약 118만 줄)는 1인 감사 가능 범위를 완전히 벗어나 있다.

### 1. Agent loop

- **위치**: 진입점은 `AIAgent.run_conversation` 이지만 본체는 `agent/conversation_loop.py` 로 추출됐다. 실제 while 문은 `agent/conversation_loop.py:1724-1772`. `AIAgent` 는 14개 mixin 을 상속하는 껍데기다(`run_agent.py:215-219`).
- **형태**: 한 iteration = `begin_iteration → prepare_iteration → route_change_offload → assemble_api_request → run_preflight_gate → announce_api_call → _run_api_retry_loop → apply_retry_restarts → normalize_model_response → (run_tool_round | finish_text_response)`. 각 phase 는 `agent/turn_*.py` 의 함수이고 `action` 이 `return/break/continue/fallthrough` 인 verdict dataclass 를 돌려준다. 루프 지역변수는 `_LoopState` 하나에 모으고 `_run_phase` 가 시그니처 이름으로 주입 · 회수한다(`agent/conversation_loop.py:1434-1470`, `1529-1547`).
- **누가 멈추나**: 모델이다. 응답에 `tool_calls` 가 있으면 `run_tool_round`, 없으면 `finish_text_response` 로 분기(`agent/conversation_loop.py:1761-1763`). 다만 텍스트로 끝나려 할 때도 "stop gate"(verify-on-stop, `pre_verify` 플러그인 훅, LSP 판정 등)가 nudge 를 붙여 턴을 계속시킬 수 있다(`agent/turn_stop_gates.py:1-10`).
- **한도**: while 조건은 `api_call_count < agent.max_iterations and agent.iteration_budget.remaining > 0` 또는 `_budget_grace_call`(`agent/conversation_loop.py:1724-1726`). 생성자 기본값은 `max_iterations: int = sys.maxsize`(`run_agent.py:242`), 설정 기본값도 `"max_turns": None` 즉 무제한이며 주석에 "caps caused silent mid-task truncation" 이라고 적혀 있다(`hermes_cli/config_defaults.py:64-67`). 서브에이전트만 `"max_iterations": 250`(`hermes_cli/config_defaults.py:1310`).
- **예산 카운터**: `IterationBudget` 는 thread-safe `consume()/refund()`(`agent/iteration_budget.py:26-57`). 예산 소진 시 `budget_exhausted` 로 break 하되 도구 없는 grace call 1회를 허용(`agent/turn_iteration_prep.py:404-415`). `execute_code` 만 호출한 iteration 은 환불(`agent/turn_tool_round.py:208-211`). 벽시계 예산(`--run-budget`)은 80% 지점에 1회 wrap-up 안내문을 주입(`agent/conversation_loop.py:89-94`).
- **병렬 tool call**: 호출이 1개면 순차. 2개 이상이면 `_plan_tool_batch_segments` 가 emission 순서를 유지한 채 `("parallel"|"sequential", calls)` 구간으로 자른다(`run_agent.py:1362-1385`, `agent/tool_dispatch_helpers.py:214-262`). 병렬 허용 기준은 화이트리스트다: `_PARALLEL_SAFE_TOOLS`(read_file, search_files, web_search, web_extract, session_search 등 읽기 전용), 경로 겹침 검사를 통과한 `_PATH_SCOPED_TOOLS`, `supports_parallel_tool_calls` 를 켠 MCP 서버(`agent/tool_dispatch_helpers.py:31-52`, `184-211`; `tools/mcp_tool_discovery.py:825-832`). `clarify` 등 `_NEVER_PARALLEL_TOOLS` 와 인자 파싱 실패는 장벽이다. 워커는 `_MAX_TOOL_WORKERS = 8`, 배치 타임아웃 `_DEFAULT_CONCURRENT_TOOL_TIMEOUT_S = 420.0`(`agent/tool_executor.py:144-151`). 결과는 완료 순서가 아니라 원래 호출 순서로 append(`agent/tool_executor.py:1571-1604`).
- **재시도**: API 호출마다 `_run_api_retry_loop`(`agent/conversation_loop.py:1550-1579`). 횟수는 `agent.api_max_retries` 기본 3, 소진 후 자동 복구 사이클 `auto_recovery_cycles` 기본 5(`agent/agent_init.py:1273-1282`). 예외는 `classify_api_error` 가 `FailoverReason` enum(약 30종: rate_limit, overloaded, context_overflow, payload_too_large, thinking_signature ...)으로 분류해 재시도/키 교체/폴백 모델/압축/중단을 고른다(`agent/error_classifier.py:35-65`). 백오프는 `jittered_backoff(base_delay=5.0, max_delay=120.0, jitter_ratio=0.5)`(`agent/retry_utils.py:121-123`). `finish_reason == "length"` 는 이어쓰기 nudge 최대 4회(`agent/turn_truncation.py:1-7`).
- **abort/cancel**: `interrupt()` 는 다른 스레드에서 호출한다. 플래그(`_interrupt_requested`)를 세우고, 진행 중인 HTTP 요청 소켓을 닫고(`_ic_abort_active_request`), 에이전트 실행 스레드와 병렬 도구 워커 tid 에 thread-scoped interrupt 비트를 뿌리고, 자식 에이전트로 전파한다(`agent/interrupt_control.py:163-270`, `131-158`). 인터럽트 비트가 프로세스 전역이 아니라 thread id 단위인 이유는 gateway 가 한 프로세스에 여러 에이전트를 돌리기 때문(`tools/interrupt.py:1-4`, `37-46`). 루프는 iteration 시작에서 플래그를 보고 break(`agent/turn_iteration_prep.py:381-389`).
- **인터럽트 시 pairing 보존**: 시작 전 취소된 호출마다 `[Tool execution cancelled — {name} was skipped. ...]` tool result 를 합성해 assistant 의 tool_call 이 짝 없는 상태로 남지 않게 한다(`agent/tool_executor.py:335-366`, `1549-1568`).
- **steer / redirect**: `steer(text)` 는 인터럽트 없이 현재 도구 배치가 끝난 뒤 별도 user row 로 끼워 넣고, `redirect(text)` 는 진행 중인 모델 요청만 취소하고 정정을 user 메시지로 붙여 같은 턴을 재시도한다(`agent/interrupt_control.py:310-328`).

### 2. Message/state 모델

- **메모리 내 표현**: OpenAI chat-completions 형태의 dict 리스트(`role`, `content`, `tool_calls`, `tool_call_id`)가 정본이다. Anthropic/Bedrock 네이티브 블록(서명된 thinking 포함)은 `provider_data["anthropic_content_blocks"]` sidecar 로 따로 보관해 그대로 replay 한다(`agent/tool_call_batches.py:64-72`).
- **영속화**: SQLite(`state.db`). 스키마는 `persistence/sqlite/_schema_ddl.py` 에 있다. `sessions` 테이블은 `source, user_id, session_key, chat_id, thread_id, model, system_prompt, system_prompt_hash, parent_session_id`, 토큰/캐시/비용 컬럼, `tool_names`, `prompt_cache_clock` 등 70개 가까운 컬럼(`persistence/sqlite/_schema_ddl.py:126-195`). `messages` 는 `role, content, tool_call_id, tool_calls, tool_name, finish_reason, reasoning*, active, compacted, api_content, display_kind, display_metadata` 등(`persistence/sqlite/_schema_ddl.py:197-228`). 검색용 `messages_fts`(FTS5)와 trigram 변형이 붙는다(`persistence/sqlite/_schema_ddl.py:643-649`).
- **system prompt 도 저장한다**: 세션 행에 system prompt 를 저장하고 다음 턴에 그대로 복원한다. 목적은 프롬프트 캐시 prefix 를 턴 간 바이트 단위로 유지하는 것(`agent/conversation_loop.py:822-856`).
- **부수효과 전 영속화**: tool call 이 담긴 assistant 메시지를 도구 실행 전에 DB 에 flush 한다. 실패하면 도구를 실행하지 않고 `session_persistence_failed` 로 턴을 끝낸다(`agent/turn_tool_round.py:133-160`). UI 로 interim 메시지를 내보내는 것도 DB append 이후다(`agent/turn_tool_round.py:158-161`).
- **실패 턴 닫기**: 실패한 턴이 `user` 또는 `tool` row 로 끝나 있으면 Hermes 가 쓴 assistant 경계 row 를 덧붙여 다음 턴에 user;user 병합이 일어나지 않게 한다(`agent/conversation_loop.py:1896-1950`).
- **채널/사용자별 세션**: `build_session_key` 가 `<ns>:<platform>:<chat_type>[:<chat_id>][:<thread_id>][:<user>]` 를 결정적으로 만든다. DM 은 chat_id 단위, 그룹은 기본적으로 참가자별 격리, 스레드는 기본 공유(`gateway/session.py:722-768`). 라우팅 인덱스와 transcript 는 `SessionStore` 가 관리(`gateway/session.py:826-831`).
- **리셋 정책**: 시간 기반 자동 리셋은 현재 없다. `_route_reset_reason` docstring 이 "Only explicit suspension replaces a routed conversation; time never does" 라고 명시(`gateway/session_lifecycle.py:159-161`). 명시적 리셋은 `/new`, `/reset`(`gateway/config.py:623`). 긴 대화는 리셋이 아니라 압축으로 처리한다.
- **resume**: `load_transcript` 가 state.db 에서 읽고, 압축으로 세션이 자식 id 로 넘어간 경우 lineage tip 을 따라간다. 읽기 실패 시 빈 히스토리로 대체하지 않고 `TranscriptReadError` 로 fail-closed(`gateway/session_transcript.py:637-660`). DB 쓰기 실패 시 메모리 큐에 쌓고 한도 초과분은 디스크 spool 로 보낸다(`gateway/session_transcript.py:160-169`, `179-200`).

### 3. Tool 인터페이스

- **정의**: 각 도구 파일이 import 시점에 `registry.register(name, toolset, schema, handler, check_fn, ...)` 를 호출한다(`tools/registry.py:840-861`; 예시 `tools/memory_tool.py:468-479`). 메타데이터는 `ToolEntry` dataclass: `schema`(OpenAI function JSON Schema dict), `handler`, `check_fn`(가용성 게이트), `max_result_size_chars`, `execution_timeout`, `dynamic_schema_overrides`, `deadline_floor`(`tools/registry.py:216-243`).
- **검증**: 등록 시 `schema`/`parameters` 가 dict 인지만 확인(`tools/registry.py:854-861`). 호출 시 `check_tool_args` 가 필수 인자를 확인하고 미지의 인자는 결과에 경고로 덧붙인다. 핸들러 예외는 전부 `{"error": ...}` 문자열로 바뀌어 모델에게 돌아간다(`tools/registry.py:1076-1112`). Pydantic/Zod 같은 전체 스키마 검증기는 찾지 못함.
- **toolset**: 도구는 이름 있는 묶음으로 켜고 끈다. 플랫폼 공통 묶음은 `_HERMES_CORE_TOOLS`, 웹훅처럼 신뢰할 수 없는 입력에는 `_HERMES_WEBHOOK_SAFE_TOOLS = ["web_search", "web_extract", "vision_analyze", "clarify"]` 만 준다(`toolsets.py:11-39`).
- **권한 모델은 "도구별 read-only 플래그" 가 아니다**: 승인 게이트의 중심은 터미널 명령 패턴 탐지다. `tools/approval.py` 가 hardline 차단, 영구/세션 allowlist, CLI 프롬프트, gateway 승인 카드, 무인 컨텍스트 처리를 담당(`tools/approval.py:1-12`). 순서는 yolo/`mode: off` 우회 → 세션 캐시 → 대화형/gateway/무인 분기 → 프롬프트 → 저장(`tools/approval.py:1207-1235`). 설정 기본값은 `"mode": "smart"`(보조 LLM 이 판정), `"timeout": 300`, `"cron_mode": "deny"`, `"unattended_mode": "deny"`, `"denial_breaker_threshold": 3`(`hermes_cli/config_defaults.py:1611-1640`).
- **임의 도구의 승인 승격**: 플러그인 `pre_tool_call` 훅이 `{"action": "approve"}` 를 반환하면 `request_tool_approval` 이 같은 사람 승인 게이트로 보낸다. 승인해 줄 사람이 없는 컨텍스트에서는 fail-closed(`tools/approval.py:1372-1398`).
- **읽기 전용 분류가 쓰이는 곳**: 병렬 실행 허용(`_PARALLEL_SAFE_TOOLS`)과 루프 가드의 `IDEMPOTENT_TOOL_NAMES`(`agent/tool_guardrails.py:21-24`) 두 군데뿐이다. "mutating 도구는 승인 필요" 같은 일반 규칙은 찾지 못함.
- **실행 파이프라인**: tool round 진입 시 이름 검증 → 중복 호출 제거 + `delegate_task` 개수 상한(`agent/turn_tool_round.py:81-100`) → 영속화 → 실행 → 가드레일 halt 검사(`agent/turn_tool_round.py:187-201`).
- **결과 크기 예산**: `DEFAULT_RESULT_SIZE_CHARS = 100_000`, `DEFAULT_TURN_BUDGET_CHARS = 200_000`, `DEFAULT_PREVIEW_SIZE_CHARS = 1_500`, MCP 는 `DEFAULT_MCP_RESULT_SIZE_CHARS = 50_000`. 초과분은 디스크에 저장하고 미리보기만 컨텍스트에 남긴다(`tools/budget_config.py:9-20`).
- **MCP**: 클라이언트다. `mcp_servers` 설정(stdio / Streamable HTTP / SSE)에 연결해 도구를 발견하고 같은 registry 에 등록한다. 데몬 스레드의 단일 이벤트 루프에서 서버당 long-lived Task 로 돌린다(`tools/mcp_tool.py:1-10`). stdio 서버 spawn 전 OSV 악성 패키지 사전 검사가 있다(`tools/mcp_tool.py:38-46`). Hermes 자신을 MCP 서버로 노출하는 코드는 이번 조사에서 확인하지 않음.
- **훅**: `pre_tool_call`(차단 가능, 타임아웃 시 fail-closed), `post_tool_call`, `transform_tool_result`, `pre_llm_call`, `pre_verify` 등(`hermes_cli/plugins.py:113-128`). 셸 스크립트 훅은 stdin JSON, exit code 2 로 차단하는 Claude Code 호환 규약(`agent/shell_hooks.py:1-5`).

### 4. Context 관리

- **system prompt 조립**: 세션당 한 번 만들고 턴 사이에 재사용한다. 다시 만드는 것은 압축 직후뿐(`agent/system_prompt.py:1-9`, `836-846`). 세 tier 를 `\n\n` 로 잇는다: `stable`(정체성, 가이던스, pinned skill, 코딩 brief) → `context`(호출자 `system_message`, 프로젝트 컨텍스트 파일, 워크스페이스 스냅샷) → `volatile`(skills index, MEMORY/USER 블록, 외부 메모리 provider 블록, 프로필 줄, timestamp 줄, 런타임 환경 힌트)(`agent/system_prompt.py:770-833`). 변할 가능성이 큰 것일수록 뒤에 둔다.
- **turn 별 주입은 system prompt 가 아니라 현재 user 메시지에 붙인다**: 메모리 prefetch, `pre_llm_call` 훅 컨텍스트, `ephemeral_system_prompt` 는 API 호출 시점의 복사본에만 들어가고 정본 `messages` 는 건드리지 않는다(`agent/turn_context.py:1452-1458`, `1496-1509`).
- **`api_content` sidecar**: 실제로 전송한 바이트를 메시지 행에 `api_content` 로 저장해 두고, 이후 턴에서 과거 user/assistant 행은 그 바이트를 그대로 replay 한다. 주입 내용이 달라져도 과거 prefix 가 바이트 단위로 유지된다(`agent/turn_context.py:1510-1517`; 컬럼 `persistence/sqlite/_schema_ddl.py:219`).
- **Anthropic 캐시 breakpoint 배치**: 기본은 4개다. static system prefix 끝, system prompt 전체 끝, 그리고 마지막 non-system 메시지 2개. static prefix 를 못 나누면 system 1개 + 마지막 3개(`agent/prompt_caching.py:1-6`, `503-538`). system prompt 는 저장은 문자열 하나로 하고 요청 시점에만 text part 로 쪼개 `cache_control` 을 붙인다(`agent/prompt_caching.py:314-351`).
- **네이티브 Anthropic + tools 배열**: `direct_native_tool_cache` 가 참이면 배치가 바뀐다. static prefix 1개 + `tools` 배열 마지막 원소 1개 + "완료된 트랜잭션 끝점" 마지막 2개(`agent/prompt_caching.py:469-500`). 끝점은 tool run 의 마지막 tool result 이거나 닫힌 일반 턴이며, 열려 있는 user 턴이나 빈 assistant 는 제외(`agent/prompt_caching.py:432-466`).
- **캐시 계획은 요청 조립의 맨 마지막**: 모든 transcript 변형이 끝난 뒤 copy-on-write 로 계산하고 정본에는 마커를 남기지 않는다(`agent/turn_request_assembly.py:1-8`, `108-131`). 적용 전 기존 마커를 벗겨 4개를 넘지 않게 한다(`agent/prompt_caching.py:513-520`).
- **TTL**: 설정 기본 `"cache_ttl": "auto"`(`hermes_cli/config_defaults.py:689`). 사람이 타이핑하는 소스는 `1h`, `MACHINE_PACED_SOURCES`(subagent, cron, oneshot, webhook, api ...)는 `5m`(`agent/prompt_caching.py:158-168`). 재사용될 일이 없는 one-shot 요청(요약, 제목 생성)에는 마커를 달지 않는다(`agent/prompt_caching.py:37-41`).
- **빌더가 선언하는 stable prefix**: cron/skill 빌더가 큰 고정 scaffold + 작은 가변 tail 을 한 user 메시지로 만들 때 고정 부분을 `register_stable_prefix` 로 등록하면 planner 가 그 경계에 breakpoint 를 둔다(`agent/prompt_cache_boundary.py:1-10`).
- **캐시 keep-alive**: 캐시 만료 직전에 마지막 요청을 작은 output cap 으로 다시 보내는 warmer, 유휴 시 압축/오프로드 결정까지 있다(`agent/prompt_cache_lifecycle/__init__.py:1-30`).
- **압축 트리거**: (a) 턴 시작 preflight 와 opt-in idle 압축(`agent/turn_context_compaction.py:1-8`), (b) tool 결과 직후(`agent/turn_tool_round.py:213-229`), (c) 413/context-length 에러 후 복구(`agent/turn_overflow.py:1-8`), (d) 수동 `/compress`, (e) gateway hygiene(메시지 수 `hygiene_hard_message_limit: 5000`). 임계값은 `"threshold": 0.50` 이지만 512K 미만 창은 0.75 로 올림, `"max_attempts": 3`(`hermes_cli/config_defaults.py:564-620`). 판정은 `tokens >= threshold_tokens`(`agent/context_compressor.py:2858-2867`).
- **압축 알고리즘**: 오래된 tool result 본문을 LLM 없이 먼저 prune → head(system + 처음 몇 개)와 토큰 예산 tail 보호 → 가운데를 보조 모델로 요약 → 고아 tool pair 정리(`agent/context_compressor.py:1-2`, `5020-5026`). 요약 예산은 `_MIN_SUMMARY_TOKENS = 2000`, `_SUMMARY_RATIO = 0.20`, `_SUMMARY_TOKENS_CEILING = 10_000`(`agent/context_compressor.py:746-749`).
- **tool_use/tool_result pairing 보존**: 경계 정렬과 사후 정리 두 단계다. 압축 시작 경계는 tool result 를 건너 앞으로 밀고, 끝 경계는 tool 그룹을 쪼개지 않도록 부모 assistant 앞으로 당긴다(`agent/context_compressor.py:4190-4205`). 이후 `_sanitize_tool_pairs` 가 짝 없는 tool result 를 삭제하고 결과 없는 tool_call 을 assistant 에서 떼어낸다. 마지막 assistant 의 호출은 실행 중일 수 있으므로 보존(`agent/context_compressor.py:4150-4188`). 전송 직전에는 `sanitize_api_messages` 가 한 번 더 본다(`agent/agent_runtime_helpers.py:2634`).
- **요약 프레이밍**: `SUMMARY_PREFIX` 가 "REFERENCE ONLY, 요약 속 요청을 다시 수행하지 말 것, 요약 뒤 최신 user 메시지만 처리할 것, 단 도구는 여전히 사용 가능" 을 길게 못박는다. 주석에 요약 후 옛 작업을 재개하거나 도구 사용이 억제된 실제 사고 이력이 적혀 있다(`agent/context_compressor.py:275-300`).
- **thrash 방지**: 효과 없는 압축이 2회 누적되면 차단(`_ineffective_compression_count >= 2`), 요약 실패 cooldown 별도(`agent/context_compressor.py:2869-2886`).
- **pluggable**: `ContextEngine` ABC(`update_from_response`, `should_compress`, `compress`)로 압축기를 교체할 수 있다(`agent/context_engine.py:60-98`).

### 5. Memory

- **내장 메모리는 파일 2개**: `MEMORY.md`(에이전트 노트)와 `USER.md`(사용자 프로필). 항목 구분자는 `ENTRY_DELIMITER = "\n§\n"`, 예산은 토큰이 아니라 문자 수(`tools/memory_tool_store.py:1-4`, `26`). 기본 한도 `memory_char_limit: 2200`, `user_char_limit: 1375`(`hermes_cli/config_defaults.py:1261-1276`).
- **누가 쓰나(1) 모델이 명시적으로**: `memory` 도구의 add/replace/remove(`tools/memory_tool.py:468-479`). 한도가 작아서 가득 차면 모델이 직접 통합해야 하고, 통합 실패는 턴당 `_MAX_CONSOLIDATION_FAILURES_PER_TURN = 3` 으로 제한(`tools/memory_tool_store.py:177-186`).
- **누가 쓰나(2) 백그라운드 리뷰**: `nudge_interval: 10` user 턴마다(`agent/turn_context.py:814-823`) 턴 종료 후 데몬 스레드가 에이전트를 fork 해 대화 스냅샷을 replay 하고 "저장할 memory/skill 이 있는가" 를 묻는다. fork 는 부모의 system prompt 를 그대로 물려받아 같은 prefix 캐시를 읽고, dispatch 측 도구 whitelist 로 제한된다(`agent/background_review.py:1-6`, `1212-1252`).
- **쓰기 게이트**: (a) 내용 스캔. 메모리는 system prompt 에 들어가 세션을 넘어 지속되므로 injection/exfil 패턴을 `scope="strict"` 로 검사해 거부(`tools/memory_tool_store.py:29-32`). (b) `write_approval`(기본 `False`)을 켜면 전경 쓰기는 인라인 승인, 백그라운드 쓰기는 `/memory pending|approve|reject` 대기열로 간다(`hermes_cli/config_defaults.py:1265-1268`). (c) 서브에이전트는 `memory` 도구 자체가 차단(`tools/delegate_tool_toolsets.py:14-22`).
- **검색/주입**: 내장 메모리는 검색하지 않는다. 전체를 system prompt 의 volatile tier 에 넣는다(`agent/system_prompt.py:548-555`). 주입본은 로드 시점에 고정한 `_system_prompt_snapshot` 이라, 세션 중 메모리를 써도 캐시 prefix 가 깨지지 않고 변경은 다음 세션부터 반영된다(`tools/memory_tool_store.py:179-180`).
- **과거 대화 회상**: `session_search` 도구가 세션 DB 를 FTS5 로 검색한다. LLM 호출 없이 실제 DB 메시지를 반환(`tools/session_search_tool.py:1-9`). 벡터 임베딩 기반 검색은 내장 경로에서 찾지 못함.
- **외부 provider**: `MemoryProvider` ABC, 한 번에 하나만 활성. 라이프사이클은 initialize → system_prompt_block / prefetch / sync_turn → shutdown(`agent/memory_provider.py:1-6`). 번들 provider 는 `plugins/memory/` 의 `byterover`, `retaindb` 두 개이고 honcho, mem0 등은 카탈로그 설치(`hermes_cli/config_defaults.py:1273-1275`).
- **절차 기억**: skills. `skills_list/skill_view/skill_manage` 도구로 모델이 스킬 파일을 만들고 고친다(`toolsets.py:16`). 유휴 시간에 도는 curator 도 있다(`agent/curator.py`, 1,220줄; 내부 동작은 깊이 읽지 않음).

### 6. Sub-agent / delegation

- `delegate_task` 도구가 자식 `AIAgent` 를 띄운다. 새 대화, 자체 `task_id`, 부모 toolset 에서 차단 도구를 뺀 집합, 좁힌 system prompt 를 갖고, goal 과 context 는 첫 user 턴으로 들어간다. 부모는 위임 호출과 요약 결과만 본다(`tools/delegate_tool.py:1-12`).
- 자식에게 금지된 도구: `delegate_task`, `clarify`, `memory`, `send_message`, `cronjob_manage`(`tools/delegate_tool_toolsets.py:14-22`).
- 한도: `_DEFAULT_MAX_CONCURRENT_CHILDREN = 10`, `MAX_DEPTH = 1`(`tools/delegate_tool_config.py:19-24`). 한 턴의 `delegate_task` 호출 수도 같은 값으로 잘린다(`run_agent.py:1237-1254`). 자식은 자기 iteration 예산을 따로 갖는다(`agent/iteration_budget.py:1-6`).
- 승인: 서브에이전트 스레드는 항상 비대화형으로 처리하며 기본 자동 거부(`"subagent_auto_approve": False`). 결과 요약은 `"max_summary_chars": 24000` 상한이고 넘치면 디스크로 보낸다(`hermes_cli/config_defaults.py:1311-1339`).
- 인터럽트는 부모에서 자식으로 전파(`agent/interrupt_control.py:257-267`). 재개 가능한 서브에이전트와 비동기 위임용 테이블도 있다(`persistence/sqlite/_schema_ddl.py:384`, `418`).

### 7. Streaming / event 모델

- 코어는 이벤트 버스가 아니라 생성자에 넘기는 동기 콜백 묶음이다: `tool_progress_callback`, `tool_start_callback`, `tool_complete_callback`, `thinking_callback`, `reasoning_callback`, `clarify_callback`, `step_callback` 등(`run_agent.py:253-262`). 텍스트 델타는 `stream_delta_callback`, 세그먼트 종료는 `None` 을 보내 알린다(`agent/turn_tool_round.py:163-167`).
- 메신저 채널: `gateway/stream_consumer.py` 가 에이전트 워커 스레드의 델타를 큐에 받아 async 태스크에서 버퍼링 · rate-limit 하며 플랫폼 메시지 하나를 계속 edit 한다(`gateway/stream_consumer.py:1-7`). 편집 조건은 `edit_interval` 경과 또는 `buffer_threshold` 초과(`gateway/stream_consumer.py:68-73`, `831-833`).
- TUI/Desktop: `tui_gateway` 가 콜백을 이름 붙은 이벤트로 바꿔 내보낸다. grep 으로 확인한 이름: `message.start`, `message.delta`, `message.interim`, `message.complete`, `thinking.delta`, `reasoning.delta`, `tool.start`, `tool.progress`, `tool.complete`, `status.update`, `session.usage`, `error`. 서브에이전트 이벤트는 부모 이벤트 이름으로 매핑(`tui_gateway/agent_callbacks.py:28-29`, `77-88`, `159-160`).
- 지속성 있는 이벤트 로그는 없다. 실패 턴의 에러 카드처럼 다시 그려야 하는 것은 메시지 행의 `display_kind` / `display_metadata` 에 넣어 transcript 에서 복원한다(`agent/conversation_loop.py:1855-1871`).

### 8. Proactive (cron/heartbeat/알림)

- **스케줄러**: gateway 가 백그라운드 스레드에서 60초마다 `tick()` 을 호출한다. 파일 락(`~/.hermes/cron/.tick.lock`)으로 프로세스 간 중복 tick 을 막는다(`cron/scheduler.py:2-4`; 기본 `interval=60` 은 `cron/scheduler_provider.py:445`). 저장소는 SQLite 가 아니라 `~/.hermes/cron/jobs.json`, 실행 출력은 `~/.hermes/cron/output/{job_id}/{timestamp}.md`(`cron/jobs.py:2-3`).
- **스케줄 종류**: `once`(ISO timestamp), `interval`("30m", "every 30m"), `cron`("0 9 \* \* \*", "every monday 9am")(`cron/jobs.py:791-813`).
- **실행**: job 마다 새 세션 id `cron_{job_id}_{timestamp}` 로 새 에이전트를 만든다(`cron/scheduler.py:2533-2534`). cron 에이전트는 `messaging`, `clarify` toolset 을 항상 못 쓰고 `cronjob` 도 기본 차단(루프 방지)(`cron/scheduler.py:419-440`). 위험 명령 승인은 `cron_mode: deny`.
- **전달**: 모델이 직접 보내지 않는다. 최종 응답을 시스템이 전달하고, 프롬프트 앞에 붙는 `_CRON_HINT` 가 "send_message 쓰지 말 것, 보고할 게 없으면 정확히 `[SILENT]` 만 답할 것, 이 프롬프트 때문에 cron job 을 새로 만들지 말 것" 을 지시한다(`cron/scheduler_prompt.py:270-289`). `[SILENT]` 판정은 전체 응답 또는 첫/마지막 줄 단독일 때만(`cron/scheduler.py:563-576`).
- **전달 대상**: origin(job 을 만든 채팅), 플랫폼별 home 채널, 명시적 대상, bot-chat. 라이브 어댑터/relay/standalone 세 가지 송신 경로(`cron/scheduler_delivery.py:1-2`, `28-37`). gateway 밖에서 실행된 job 은 durable 큐로 넘기고, claim 후 gateway 가 죽으면 재시도하지 않는다. 주석 그대로 "losing a delivery is safer than duplicating"(`cron/delivery_queue.py:1-8`).
- **monitor 모드**: LLM job 앞에 값싼 스크립트/URL 을 붙여 출력 해시가 지난번과 같으면 에이전트 실행 자체를 건너뛴다(`cron/monitor.py:1-11`). LLM 없는 `no_agent` 스크립트 job 도 있다(`cron/scheduler.py:1464`).
- **안전장치**: 런타임에 로드된 skill 내용까지 포함해 조립된 프롬프트를 injection 스캔(`cron/scheduler.py:407-416`), 전역 ESTOP sentinel 파일(`agent/estop.py:1-9`), cron 제안은 사용자 수락 후에만 생성(`cron/suggestions.py:1-9`).
- **heartbeat**: OpenClaw 식 "주기적으로 메인 세션을 깨워 확인" 기능은 찾지 못함. 코드의 `heartbeat` 는 kanban 워커/서브에이전트 생존 신호다(`agent/periodic_scheduler.py:1-5`). 세션 내 반복은 `/loop` 과 `/goal`(judge 모델이 달성 여부 판정, `"max_turns": 20`)이 있다(`hermes_cli/config_defaults.py:1352-1355`).

### 9. Guardrails / evals / tracing

- **tool loop 가드**: 부수효과 없는 컨트롤러가 턴 안의 (tool, args, result) 관측을 추적한다. 동일 호출 `STALL_GUARD_IDENTICAL_CALL_THRESHOLD = 3` 회에 notice, 주기 4 이하의 반복 사이클도 탐지, 임계 초과 시 턴을 통제 halt 한다(`agent/tool_guardrails.py:1-6`, `30-39`; halt 처리 `agent/turn_tool_round.py:187-201`).
- **출력 가드**: 긴 문자열 반복으로 output 을 다 쓰는 퇴행 루프 탐지(`agent/repetition_guard.py:1-8`).
- **secret redaction**: 정규식 기반. 18자 미만 토큰은 전부 가리고 긴 것은 앞 6 + 뒤 4자만 남긴다(`agent/redact.py:1-5`). DB 에 저장되는 에러 메타데이터는 `force=True` 로 강제(`agent/conversation_loop.py:1874-1881`).
- **prompt injection**: 공용 패턴 라이브러리. scope 는 누적형 `all` → `context`(컨텍스트 파일, 메모리, tool result: 경고 수준) → `strict`(메모리 쓰기: 차단)(`tools/threat_patterns.py:1-8`).
- **evals**: `evals/` 에 파일 343개(compaction, botmode, browser_use 등). 회귀 probe 스크립트 묶음에 가깝다. 통합 eval 러너나 채점 체계는 깊이 읽지 않아 판단 보류.
- **tracing/observability**: (a) gateway 헬스 이벤트를 OTLP 로 내보내는 `agent/monitoring/`. 내용이 담긴 신호(trajectory, usage)는 범위 밖이라고 명시(`agent/monitoring/__init__.py:1-8`; 의존성 `pyproject.toml:467-468`). (b) SQLite 기반 로컬 집계 `hermes_cli/observability/shared_metrics*.py`(파일 30여 개). (c) 세션 행의 토큰/캐시/비용 컬럼(`persistence/sqlite/_schema_ddl.py:150-166`). (d) `save_trajectories` 와 `batch_runner.py` 로 학습용 trajectory 저장. LangSmith/Langfuse 같은 LLM trace 백엔드 연동은 코어에서 찾지 못함.

### 10. 규모 (LOC)

`wc -l` 기준, `tests/` 제외.

| 영역                 | 파일                                                                                  | 줄 수     |
| -------------------- | ------------------------------------------------------------------------------------- | --------- |
| 루프 코어            | `run_agent.py` + `agent/conversation_loop.py` + `agent/turn_*.py`                     | 17,731    |
| 도구 실행            | `agent/tool_*.py`                                                                     | 3,661     |
| registry/toolset     | `model_tools.py` + `toolsets.py` + `tools/registry.py`                                | 2,796     |
| 압축                 | `agent/context_compressor*.py`, `agent/conversation_compression*.py` 등               | 14,640    |
| 프롬프트 캐시        | `agent/prompt_caching.py`, `agent/prompt_cache_*.py`, `agent/prompt_cache_lifecycle/` | 3,554     |
| system prompt        | `agent/system_prompt.py` + `agent/prompt_builder.py`                                  | 2,718     |
| 메모리               | `tools/memory_tool*.py`, `agent/memory_*.py`, `agent/background_review.py`            | 4,460     |
| 위임                 | `tools/delegate_tool*.py`                                                             | 7,333     |
| 승인                 | `tools/approval*.py`                                                                  | 7,681     |
| MCP 클라이언트       | `tools/mcp_tool*.py`                                                                  | 9,700     |
| 영속화               | `persistence/` (169 파일)                                                             | 53,599    |
| cron                 | `cron/`                                                                               | 22,309    |
| `agent/` 전체        | 478 파일                                                                              | 163,486   |
| `tools/` 전체        |                                                                                       | 137,840   |
| `gateway/` 전체      |                                                                                       | 143,128   |
| `hermes_cli/` 전체   |                                                                                       | 337,492   |
| 비테스트 Python 전체 |                                                                                       | 1,177,884 |
| `tests/`             | 9,308 파일                                                                            | 1,881,473 |

### 지저분한 점 / 찾지 못한 것

- **규모**: 비테스트 Python 이 약 118만 줄이다. 루프 while 문은 50줄이지만 그 한 턴을 이해하려면 `agent/turn_*.py` 30여 개(합계 약 1.4만 줄)를 따라가야 한다. 1,000줄 넘는 파일이 `agent/` 에만 27개(`agent/auxiliary_client.py` 8,228줄, `agent/context_compressor.py` 5,208줄, `agent/conversation_compression.py` 4,217줄).
- **분해는 됐지만 결합은 그대로**: 모든 phase 함수가 `agent: Any` 를 받아 속성 수백 개를 직접 읽고 쓴다(`agent/agent_init.py` 2,199줄이 기본값 목록). `_LoopState` 필드가 전부 `Any` 이고 `_run_phase` 가 시그니처 이름 리플렉션으로 값을 실어 나른다(`agent/conversation_loop.py:1529-1547`). 테스트 patch 경로를 지키려는 lazy import 와 `_ra()` 우회가 곳곳에 있다(`agent/conversation_loop.py:1-6`).
- **stale 문서**: `agent/iteration_budget.py:1-6` docstring 은 부모 기본 500 / 서브에이전트 50 이라고 하지만 실제 기본값은 무제한 / 250 이다. `cli-config.yaml.example:1241` 은 `max_turns: 500` 으로 또 다르다.
- **주석이 사고 이력**: 거의 모든 분기에 이슈 번호가 붙어 있다. 개별 버그 수정이 누적된 결과이고 설계 원칙으로 정리된 문서는 `agent/AGENTS.md`(151줄) 정도다.
- **두 개의 저장소**: 대화는 SQLite 인데 cron job 은 `jobs.json` + 파일 락, 메모리는 Markdown 파일이다.
- **스레드 모델**: 코어 루프가 동기 + 스레드 풀이라 인터럽트가 thread id 비트 전파에 의존한다. async/AbortSignal 로 짜면 훨씬 단순해질 부분이다.
- **찾지 못함**: 도구별 read-only/mutating 선언에 기반한 일반 승인 규칙, 내장 벡터 검색 메모리, OpenClaw 식 heartbeat, 코어의 LLM trace 백엔드 연동, 시간 기반 세션 자동 리셋(명시적으로 제거됨).
- **확인하지 않음**: Hermes 를 MCP 서버로 노출하는 경로, `approvals.mode: smart` guardian LLM 의 프롬프트(`tools/approval_smart.py`), curator 와 kanban 내부, `evals/` 러너 구조, `busy_input_mode`(interrupt | queue | steer, `hermes_cli/config_defaults.py:815` 의 `display` 섹션)가 gateway 에서 실제로 어떻게 소비되는지.

**교차 확인(상위 에이전트가 소스를 다시 열어 대조):** `agent/conversation_loop.py:1724-1726` 의 while 조건, `1761-1763` 의 `run_tool_round` / `finish_text_response` 분기, `run_agent.py:242` 의 `max_iterations: int = sys.maxsize`, `hermes_cli/config_defaults.py:64-67` 의 `"max_turns": None`, `config_defaults.py:1269-1270` 의 메모리 문자 한도(2200 / 1375), `agent/prompt_caching.py:3` 의 "4 cache_control breakpoints" docstring — 모두 일치. 나머지 인용은 다시 열어보지 않았다.

## 4. letta (letta-ai/letta → letta-ai/letta-code)

- `letta-ai/letta`: 25,549 stars, 마지막 push 2026-10-18, Apache-2.0. `main` 브랜치는 README 스텁만 남았고(소스 없음), README 가 "current source lives in `letta-ai/letta-code`", "`archive` branch contains the retired Letta V1 API server" 라고 명시한다.
- `letta-ai/letta-code` (후속, 본 분석의 주 대상): 3,915 stars, HEAD `ed518ca` 2026-11-26, TypeScript(Bun), Apache-2.0, npm `@letta-ai/letta-code` 0.34.70 (`letta-code/package.json:2-3`).
- `letta-ai/letta@archive` (V1 Python 서버, 보조 대상): HEAD `56ba9c2` 2026-08-13, Python, Apache-2.0. 경로 표기는 `letta-archive/...`.
- 주의: 25.5K 스타는 은퇴한 V1 서버가 쌓은 것이고, 현재 활발한 코드는 3.9K 스타의 `letta-code` 다. 인기 지표와 살아있는 코드가 분리돼 있다.

### 한 줄 요약

letta-code 는 "서버가 LLM 한 스텝을 돌리고 `stop_reason` 으로 끊으면, 클라이언트가 도구를 실행해 approval 메시지로 되돌려 보내는" 프로토콜형 루프다. 기본 모드(`api`)에서는 LLM 호출·메시지 저장·컴팩션이 Letta 서버(기본 `https://api.letta.com`)에 있고 이 레포에는 없다. 실험적 `local` 모드만 같은 프로토콜을 로컬 파일 + `@earendil-works/pi-ai` 로 흉내 낸다. 메모리는 V1 의 DB "memory block" 에서 git 으로 버전 관리되는 마크다운 파일시스템(MemFS)으로 바뀌었고, 백그라운드 "reflection" 서브에이전트가 대화 후에 메모리를 정리한다.

### 1. Agent loop

**letta-code — 루프 소유권 (가장 먼저 확정할 사실)**

- 백엔드는 `"api" | "local"` 두 가지이고 기본은 `api` 다: `resolveBackendMode()` 는 `LETTA_LOCAL_BACKEND_EXPERIMENTAL` 이 켜졌을 때만 `local` (`letta-code/src/backend/backend-mode.ts:7-11`, `letta-code/src/backend/local/paths.ts:10-21`). `createBackendForMode` 가 `LocalBackend` 또는 `APIBackend` 를 고른다 (`letta-code/src/backend/backend.ts:763-765`).
- `api` 모드: 클라이언트는 `client_tools`/`client_skills` 를 실어 `conversations.messages` 스트림을 열 뿐이다 (`letta-code/src/agent/message.ts:288-315`, 스트림 생성 `:548-560`). LLM 호출, 프롬프트 조립, 메시지 영속화, 컴팩션은 서버 몫이며 **그 서버 소스는 이 레포에 없다**(`APIBackend.capabilities` 가 `serverSideToolManagement: true`, `promptRecompile: true`, `remoteMemfs: true` — `letta-code/src/backend/backend.ts:370-381`). 기본 서버 URL 은 `LETTA_BASE_URL` 또는 `https://api.letta.com` (`letta-code/src/backend/api/server-url.ts:7-9`, `letta-code/src/auth/oauth.ts:5`).
- `local` 모드: `LocalBackend` 가 같은 Letta 스트림 프로토콜을 로컬에서 에뮬레이트한다. 한 번의 `createConversationMessageStream` = LLM 호출 **1회**. 모델이 tool call 을 내면 실행하지 않고 `approval_request_message` + `stop_reason: "requires_approval"` 로 스트림을 끝낸다 (`letta-code/src/backend/dev/provider-turn-executor.ts:465-503`). 즉 로컬 모드에서도 "루프"는 백엔드가 아니라 클라이언트에 있다.

**letta-code — 클라이언트 루프의 모양** (headless 기준, `letta-code/src/headless.ts:1999-2470`)

- `while (true)`: `sendMessageStream` → `drainStreamWithResume` → `stopReason` 분기. `end_turn` 이면 종료(`:2320-2367`), `requires_approval` 이면 `classifyApprovals` → `executeApprovalBatch` → 결과를 다음 입력으로 넣고 `continue` (`:2369-2462`). 멈출지 여부는 모델(도구 호출 없음 = `end_turn`)이 정한다.
- 한도: `--max-turns` 만 있다. `checkMaxTurns` 가 `buffers.usage.stepCount >= maxTurns` 면 `stop_reason: "max_steps"` 로 종료 (`letta-code/src/headless.ts:1971-1989`). 기본값은 무제한(플래그 없으면 `undefined`). 토큰/비용 예산 한도는 찾지 못함.
- 재시도: `LLM_API_ERROR_MAX_RETRIES = 3`, `EMPTY_RESPONSE_MAX_RETRIES = 2`, `CONVERSATION_BUSY_MAX_RETRIES = 3`, 스트림 재접속 `HEADLESS_STREAM_RESUME_POLICY { initialDelayMs: 250, maxAttempts: 20, maxDelayMs: 2_000 }` (`letta-code/src/headless.ts:219-229`). 재시도 판정 규칙은 문자열 패턴 매칭 모음이다 (`letta-code/src/agent/turn-recovery-policy.ts:8-104`). 로컬 모드 provider 재시도는 `LOCAL_PROVIDER_MAX_RETRIES = 3`, 오버플로 컴팩션 재시도 `LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS = 3` (`letta-code/src/backend/dev/pi-stream-adapter.ts:57-60`, 루프 `:620-770`). SDK 자체 재시도는 꺼 둔다(`maxRetries: 0`, `letta-code/src/backend/dev/pi-stream-adapter.ts:466`).
- 병렬 도구 실행: 읽기 전용 집합 `PARALLEL_SAFE_TOOLS`(`Read`, `Grep`, `Glob`, `Memory`, `web_search`, `Task`, `Agent` 등)는 동시 실행, 나머지는 리소스 키별 직렬. `Edit`/`Write` 는 파일 경로가 키, `Bash`/`ApplyPatch` 는 `__global__` 락 (`letta-code/src/agent/approval-execution.ts:97-145`, 스케줄링 `:480-556`).
- 중단: `SIGINT`/`SIGTERM` → `AbortSignal` 을 스트림과 도구 배치에 전달 (`letta-code/src/headless-interrupt.ts`, `letta-code/src/headless.ts:1992-1996`, `:2428-2439`). 백엔드 인터페이스에 `cancelConversation`/`cancelRun`/`cancelConversationRun` (`letta-code/src/backend/backend.ts:330-344`). 도구 중단 유예 `ABORT_GRACE_MS = 500` (`letta-code/src/agent/approval-execution.ts:24`).

**letta-archive (V1) — 서버 측 루프는 이렇게 생겼다**

- 팩토리 `AgentLoop.load` 가 agent type 에 따라 `LettaAgentV2`/`LettaAgentV3`/`SleeptimeMultiAgentV3|V4` 를 고른다 (`letta-archive/letta/agents/agent_loop.py:15-63`).
- `LettaAgentV3.step`: `for i in range(max_steps)` 로 `_step` 을 반복하고 `should_continue` 가 꺼지면 탈출, 마지막 반복이면 `max_steps` stop reason (`letta-archive/letta/agents/letta_agent_v3.py:328-395`). `DEFAULT_MAX_STEPS = 50` (`letta-archive/letta/constants.py:75`).
- 계속 여부는 `_decide_continuation`: "도구를 안 불렀으면 종료, 불렀으면 계속", 단 tool rule(terminal/continue/required-before-exit)이 덮어쓴다 (`letta-archive/letta/agents/letta_agent_v3.py:1967-2037`).
- 스텝 시작마다 run 취소 확인 (`:1030-1034`), 컨텍스트 초과 시 컴팩션 후 재시도 `for llm_request_attempt in range(summarizer_settings.max_summarizer_retries + 1)` (`:1093`, `:1218-1241`).
- 병렬 도구: 도구별 `enable_parallel_execution` 플래그가 켜진 것만 `asyncio.gather`, 나머지는 직렬 (`:1840-1857`).
- 클라이언트 도구 또는 `requires_approval` 규칙이 걸린 도구는 실행하지 않고 `requires_approval` 로 루프를 멈춘다 (`:1686-1709`). letta-code 클라이언트 루프가 맞물리는 지점이 바로 여기다.

### 2. Message/state 모델

**letta-code**

- `api` 모드: 트랜스크립트의 정본은 서버다. 클라이언트는 `agent` → `conversation` → `run` → `message` 계층을 `@letta-ai/letta-client` 타입 그대로 쓴다 (`letta-code/src/backend/backend.ts:191-368` 의 `Backend` 인터페이스가 SDK 메서드 시그니처를 그대로 본뜸). resume 은 `getConversationResumeTail` (`:299`), 분기는 `forkConversation` (`:357`).
- `local` 모드: 파일 기반. 루트는 `~/.letta/lc-local-backend` 또는 `LETTA_LOCAL_BACKEND_DIR` (`letta-code/src/utils/local-backend-paths.ts:9-18`). 에이전트는 `agents/<id>.json`, 대화는 `conversations/<key>/` 아래 `manifest.json` + `messages.jsonl` + `conversation.json` + `system-prompt.json` (`letta-code/src/backend/local/local-transcript.ts:78-84`, `letta-code/src/backend/local/local-store.ts:465-476`, `:2537-2586`).
- `messages.jsonl` 은 append-only 세션 엔트리 로그다(`LOCAL_TRANSCRIPT_MESSAGE_FORMAT = "pi-session-entry-jsonl"`, 스키마 버전 2 — `letta-code/src/backend/local/local-transcript.ts:17-21`). 각 엔트리는 `id`/`parentId` 를 가지며 `appendFileSync` 로 덧붙인다 (`letta-code/src/backend/local/local-store.ts:2950-2956`). 컴팩션도 삭제가 아니라 `type: "compaction"` 엔트리(`summary`, `firstKeptEntryId`, `tokensBefore`)를 추가하는 방식 (`:2920-2948`).
- 메시지가 두 표현으로 공존한다: provider 포맷 `LocalMessage`(pi-ai) 와 Letta API 포맷 `StoredMessage`. 둘 사이 투영 계층이 따로 있다 (`letta-code/src/backend/local/local-message-projection.ts`, 540줄).
- 채널별 세션: 채널 라우트(`routing.json`)가 채널 스레드를 agent/conversation 에 묶는다 (`letta-code/src/channels/README.md:1-25`, `letta-code/src/channels/routing-store.ts`). 턴 진행 중 들어온 입력은 큐에 쌓인다 (`letta-code/src/queue/queue-runtime.ts`).

**letta-archive (V1)**

- SQLAlchemy ORM + Postgres(pgvector)/SQLite. 테이블: `agent`, `message`, `block`, `passage`, `conversation`, `run`, `step`, `job` 등 (`letta-archive/letta/orm/`).
- 컨텍스트 창은 메시지 테이블의 뷰다: `agent.message_ids` (JSON 배열)가 "현재 in-context 인 메시지 ID 목록"이고 (`letta-archive/letta/orm/agent.py:71`), 메시지 자체는 지워지지 않는다. 컴팩션은 이 ID 목록을 바꾸는 일이다.

### 3. Tool 인터페이스

**letta-code**

- 정의: 도구 하나 = JSON Schema 파일 + 마크다운 설명 + 구현 함수. `defineTool({ schema, description, impl })` (`letta-code/src/tools/define-tool.ts:21-38`), 등록부는 `letta-code/src/tools/tool-definitions.ts`, 스키마 36개가 `letta-code/src/tools/schemas/*.json`. 이 목록이 매 요청의 `client_tools` 로 서버에 전달된다 (`letta-code/src/agent/message.ts:309`).
- 실행: `executeTool` (`letta-code/src/tools/manager.ts:2232-2293`). 결과에서 시크릿을 지우고(`scrubSecretsFromString`), mod 훅이 출력을 덮어쓸 수 있다. 출력 상한은 `LIMITS`(`BASH_OUTPUT_CHARS: 30_000`, `READ_MAX_LINES: 2_000`, `GREP_OUTPUT_CHARS: 10_000` 등 — `letta-code/src/tools/impl/truncation.ts:4-18`).
- 권한 모드 4종: `"standard" | "acceptEdits" | "unrestricted" | "strict"`, 그리고 **기본값이 `unrestricted`** 다 (`letta-code/src/permissions/mode.ts:1-7`). `unrestricted` 는 모든 도구를 allow (`:66-74`).
- 판정 순서(`checkPermissionForEngine`, `letta-code/src/permissions/checker.ts:257-566`): workspace-sandbox → cross-agent-guard → deny 규칙 → CLI disallow → alwaysAsk 규칙 → mode override → CLI allow → Skill/Memory 자동 허용 → 읽기 전용 셸 자동 허용 → 자기 메모리 디렉터리 쓰기 허용 → session/allow 규칙 → ask 규칙 → 기본값. deny 가 mode override 보다 앞에 있어서 `unrestricted` 에서도 deny 규칙은 먹는다.
- 읽기/쓰기 구분: 기본 판정에서 `Read`, `Glob`, `Grep`, `LS`, `TaskList` 등 읽기 도구만 `allow`, 나머지는 `ask` (`letta-code/src/permissions/checker.ts:709-761`). 셸 명령은 1,945줄짜리 분석기로 "읽기 전용 명령인지" 판별해 자동 허용한다 (`letta-code/src/permissions/read-only-shell.ts`, 호출부 `checker.ts:427-445`).
- headless 에서는 물어볼 사람이 없으므로 `needsUserInput` 은 전부 거부로 바뀐다: `"Tool requires approval (headless mode)"` (`letta-code/src/headless.ts:2395-2411`).
- 훅: `PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`PermissionRequest` + `UserPromptSubmit`/`Stop`/`SubagentStop`/`PreCompact`/`SessionStart`/`SessionEnd`, command 또는 prompt(LLM 판정) 타입 (`letta-code/src/hooks/types.ts:1-31`).
- MCP: 클라이언트 측 stdio/HTTP/SSE 연결 (`letta-code/src/mcp-client.ts:18-41`, `@modelcontextprotocol/sdk` 1.32.2 — `letta-code/package.json:166`), 도구 이름은 `mcp__<server>__<tool>` (`letta-code/src/mcp-runtime.ts:157`). `api` 모드에는 서버 측 MCP 관리도 별도로 있다 (`letta-code/src/backend/api/mcp-servers.ts`, `unified-mcp.ts`).
- OS 샌드박스 래퍼(seatbelt/bwrap)도 있다 (`letta-code/src/sandbox/seatbelt.ts`, `bwrap.ts`).

**letta-archive (V1)**

- 도구는 Python 함수 + docstring 에서 스키마를 뽑는 방식 (`letta-archive/letta/functions/function_sets/base.py:246-260` 이 전형). 실행기는 종류별로 나뉜다: core/builtin/files/mcp/composio/sandbox (`letta-archive/letta/services/tool_executor/`), 커스텀 도구는 E2B/Modal/local 샌드박스 (`letta-archive/letta/services/tool_sandbox/`).
- 게이트는 "tool rule" 그래프다: `ChildToolRule`, `InitToolRule`, `TerminalToolRule`, `ContinueToolRule`, `RequiredBeforeExitToolRule`, `MaxCountPerStepToolRule`, `RequiresApprovalToolRule` (`letta-archive/letta/schemas/tool_rule.py:64-348`). 읽기 전용/변경 구분 개념은 찾지 못함 — 승인이 필요한 도구를 이름으로 지정할 뿐이다.

### 4. Context 관리

**letta-code (local 모드에서만 소스로 확인 가능)**

- 시스템 프롬프트 = 원본 프롬프트의 `{CORE_MEMORY}` 자리에 메모리 투영을 주입 + `<available_skills>` 블록 (`letta-code/src/backend/local/system-prompt-compilation.ts:13`, `:377-382`, `:388-418`, 컴파일 본체 `:429-461`). 원본 프롬프트는 `letta-code/src/agent/prompts/letta_root_memfs.md`(190줄) 등 마크다운 파일.
- **프롬프트를 대화당 한 번 컴파일해 저장하고, 메모리가 바뀌어도 다시 만들지 않는다.** `getOrCompileSystemPrompt` 는 `rawSystemHash` 와 `memfsRevision`(메모리 git HEAD)을 비교해, 메모리만 바뀐 경우 시스템 프롬프트는 그대로 두고 `<memory_update>` 를 **대화 끝에 system 메시지로 덧붙인다** (`letta-code/src/backend/local/local-backend.ts:806-851`, 문구 `:124-135`, 주입 `letta-code/src/backend/dev/pi-stream-adapter.ts:436-442`). 프롬프트 프리픽스가 안정되므로 캐시에 유리한 설계다(코드 주석으로 의도가 적혀 있지는 않음 — 해석).
- 턴마다 넣는 컨텍스트는 `<system-reminder>` 카탈로그: `session-context`, `agent-info`, `permission-mode`, `mcp-servers-info`, `toolset-change`, `disk-space` 등 (`letta-code/src/reminders/catalog.ts:26-110`).
- 컴팩션 트리거 2개: (a) 호출 전 압력 검사 — 추정 토큰이 `contextWindow - min(16_384, 20%)` 를 넘으면 (`letta-code/src/backend/dev/provider-turn-executor.ts:38-39`, `:222-250`), (b) provider 가 context overflow 를 반환했을 때 사후 컴팩션 후 재시도 (`letta-code/src/backend/dev/pi-stream-adapter.ts:648-668`).
- 컴팩션 모드 4종 `"all" | "sliding_window" | "self_compact_all" | "self_compact_sliding_window"`, 기본 `sliding_window` + `LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE = 0.3` (`letta-code/src/backend/local/compaction.ts:49-56`). sliding window 는 앞부분을 요약하고 뒤를 남기되, 잘린 지점이 유효한 assistant 경계인지와 미완료 tool call 을 깨지 않는지 검사한다 (`:615-680`). 실패하거나 여전히 넘치면 `all` 로 폴백 (`letta-code/src/backend/local/local-backend.ts:649-698`).
- 요약 프롬프트는 고정 섹션(목표 / 일어난 일 / 중요한 세부·식별자 원문 보존 / 오류와 수정 / 현재 상태 / 다음 단계 / lookup hints), 길이 상한 `ALL_WORD_LIMIT = 500`, `SLIDING_WORD_LIMIT = 300` (`letta-code/src/backend/local/compaction.ts:29-30`, `:233-255`). 요약은 `system_alert` JSON 으로 포장돼 대화에 들어간다 (`:714-740`). 컴팩션 뒤에는 메모리를 반영해 시스템 프롬프트를 새로 컴파일한다 (`letta-code/src/backend/local/local-backend.ts:631-647`).
- 프롬프트 캐싱: letta-code 소스에 `cache_control` 을 직접 다는 코드는 찾지 못함. `sessionId: input.conversationId` 를 pi-ai 에 넘길 뿐이고 (`letta-code/src/backend/dev/pi-stream-adapter.ts:467`) 실제 캐시 마킹은 의존성 `@earendil-works/pi-ai` 안이다(미확인). 사용량 통계에는 `cacheRead`/`cacheWrite` 가 잡힌다 (`letta-code/src/backend/dev/provider-turn-executor.ts:287-306`).

**letta-archive (V1)**

- 시스템 프롬프트에 `CORE_MEMORY` 키워드로 메모리 블록을 컴파일해 넣는다 (`letta-archive/letta/constants.py:64`, `letta-archive/letta/prompts/prompt_generator.py:107`, `:181`).
- 컴팩션 임계값: 컨텍스트 창의 90% — `SUMMARIZATION_TRIGGER_MULTIPLIER = 0.9` (`letta-archive/letta/constants.py:83`), `get_compaction_trigger_threshold` 가 모든 모델에 `int(context_window * 0.9)` 를 반환한다 (`letta-archive/letta/services/summarizer/thresholds.py:27-41`). 같은 함수의 docstring 은 "GPT-5 계열만 90%, 나머지는 100%"라고 쓰여 있어 코드와 어긋난다(코드가 실제 동작). 임계값 계산 `letta-archive/letta/agents/letta_agent_v3.py:938`, 스텝 후 검사 `:1439-1464`. 모드는 letta-code 로컬과 같은 4종 (`letta-archive/letta/services/summarizer/summarizer_config.py:76-81`) — 로컬 백엔드가 V1 서버를 이식한 것임을 보여준다.
- Anthropic 캐싱은 명시적: 마지막 tool 정의, system 메시지, 마지막 메시지에 `cache_control: {"type": "ephemeral"}` (`letta-archive/letta/llm_api/anthropic_client.py:660`, `:671`, `:714`).
- 도구 반환 절단 `TOOL_RETURN_TRUNCATION_CHARS = 5000` (`letta-archive/letta/constants.py:443`).

### 5. Memory

**letta-code — MemFS (git 으로 버전 관리되는 마크다운)**

- 저장: 에이전트별 git 레포 `memfs/<agentId>/memory` (`letta-code/src/backend/local/paths.ts:39-41`). 포맷 v2 는 루트의 `MEMORY.md` 유무로 판별 (`letta-code/src/agent/memory-format.ts:6-11`).
- 고정(pinned) vs 지연(deferred): 루트의 `*.md` 가 "core memory" 로 시스템 프롬프트에 통째로 들어가고 (`isCoreMemoryPath` — `letta-code/src/agent/memory-format.ts:13-21`), 하위 디렉터리는 `<deferred-memory>` 에 경로와 인덱스 파일명만 나열된다 (`letta-code/src/backend/local/system-prompt-compilation.ts:151-196`). 임베딩 검색은 없다 — 에이전트가 `Memory("projects")` 로 한 단계씩 여는 progressive disclosure 다 (`letta-code/src/tools/descriptions/Memory.md`, 구현 `letta-code/src/tools/impl/memory.ts`).
- 쓰는 주체 1 — 에이전트 본인: 전용 쓰기 도구가 아니라 일반 `Edit`/`Write`/`Bash` 로 파일을 고치고 `git commit` 한다. `Memory` 도구는 읽기 전용이다. 시스템 프롬프트는 **커밋된 HEAD 만** 읽으므로 (`letta-code/src/backend/local/system-prompt-compilation.ts:65-79`, `:81-140`) 커밋 전 변경은 컨텍스트에 안 들어간다. 프롬프트도 "메모리 편집은 현재 턴의 행동을 바꾸지 않는다"고 명시 (`letta-code/src/agent/prompts/letta_root_memfs.md` 의 "Syncing memory, state, and context" 절).
- 쓰는 주체 2 — 백그라운드 reflection 서브에이전트: 트리거는 `"off" | "step-count" | "compaction-event"` (`letta-code/src/reflection-settings.ts:1`), 기본값 `trigger: "compaction-event"`, `stepCount: 25`, `merge: "auto"` (`letta-code/src/cli/helpers/memory-reminder.ts:12`, `:48-53`). 도구는 `Bash`, `Edit` 뿐 (`letta-code/src/agent/subagents/builtin/reflection.md:1-8`). 메모리 레포의 **git worktree** 에서 트랜스크립트를 읽고 편집한 뒤 부모에 머지하며 충돌/dirty 결과를 구분한다 (`letta-code/src/cli/helpers/reflection-launcher.ts:518-552`, `:554-640`).
- 검증: pre-commit 훅이 frontmatter 와 제약(`maxDepth`, `maxFileCharacters`, `maxCoreMemoryCharacters`, `readOnlyFiles`)을 검사한다 (`letta-code/src/agent/memory-git-hooks.ts:15-50`, `letta-code/src/memory-constraints.ts:11-18`). 자기 메모리 디렉터리 쓰기는 권한 검사에서 자동 허용 (`letta-code/src/permissions/memory-write-allowance.ts:26-49`).
- 회상(recall): 과거 메시지 검색. 로컬 모드는 `messages.jsonl` 전체 스캔 + 직접 구현한 BM25(`k1 = 1.2`, `b = 0.75`), CJK 토크나이저 포함, 벡터/하이브리드는 미지원 에러 (`letta-code/src/backend/local/transcript-search.ts:190-218`, `:281-320`, `:545-548`). `api` 모드는 서버 검색(`vector`/`fts`/`hybrid`)에 위임 (`letta-code/src/backend/message-search.ts:19-45`).

**letta-archive (V1) — 고전 MemGPT 3계층**

- core memory: DB 의 `block` 행. 시스템 프롬프트에 `<memory_blocks>` 로 렌더링되고 블록마다 `chars_current`/`chars_limit`/`read_only` 메타데이터가 붙는다 (`letta-archive/letta/schemas/memory.py:149-170`). 한도 `CORE_MEMORY_PERSONA_CHAR_LIMIT = 20000`, `CORE_MEMORY_BLOCK_CHAR_LIMIT = 100000` (`letta-archive/letta/constants.py:433-435`).
- 쓰는 주체: 에이전트의 도구 호출 — `core_memory_append`/`core_memory_replace`, 이후 세대 `memory_replace`/`memory_insert`/`memory_rethink`/`memory_apply_patch` (`letta-archive/letta/functions/function_sets/base.py:246-520`). 도구 세트가 세대별로 4벌 공존한다 (`letta-archive/letta/constants.py:115-140`).
- archival memory: `archival_memory_insert`/`archival_memory_search`, 임베딩 + pgvector(또는 SQLite 용 `CommonVector`) (`letta-archive/letta/functions/function_sets/base.py:164-200`, `letta-archive/letta/orm/passage.py:34-40`). 그런데 `DEPRECATED_LETTA_TOOLS = ["archival_memory_insert", "archival_memory_search"]` 로 이미 폐기 표시 (`letta-archive/letta/constants.py:116`).
- recall memory: `conversation_search` (`letta-archive/letta/functions/function_sets/base.py:87`). 내부 검색 방식은 확인하지 않음.
- sleeptime: 주 에이전트 턴이 끝난 뒤 `sleeptime_agent_frequency` 턴마다 백그라운드 태스크로 별도 에이전트를 돌려, 처리 안 된 메시지 트랜스크립트를 주고 메모리 블록을 갱신시킨다 (`letta-archive/letta/groups/sleeptime_multi_agent_v4.py:132-200`, 프롬프트 `:216-240`). letta-code 의 reflection 이 이것의 후신이다.
- 교훈: V1 → letta-code 로 오면서 "벡터 archival + DB 블록"을 버리고 "파일 + git + 인덱스 탐색"으로 갔다.

### 6. Sub-agent / delegation

**letta-code**

- 서브에이전트는 **자식 프로세스**다. 같은 `letta` 바이너리를 `-p <prompt> --output-format stream-json --permission-mode unrestricted` 로 띄우고 stdout 의 stream-json 을 부모가 파싱한다 (`letta-code/src/agent/subagents/manager.ts:137-203`, 스트림 파서 `letta-code/src/agent/subagents/subagent-stream.ts`). 부모의 allow/disallow 규칙과 `--tools` 범위, `--max-turns` 를 인자로 물려준다.
- 정의는 frontmatter 달린 마크다운: `fork`, `general-purpose`, `init`, `memory`, `recall`, `reflection` (`letta-code/src/agent/subagents/builtin/`). `fork` 는 부모 대화를 복제해 컨텍스트를 물려받는다 (`letta-code/src/agent/subagents/fork-conversation.ts`).
- 깊이 한도 `MAX_SUBAGENT_DEPTH = 2`; 한도에 닿으면 `Agent` 도구를 빼고 `SendAgentMessage` 만 준다 (`letta-code/src/agent/subagents/subagent-depth.ts:6-29`).
- 외부 코딩 에이전트(Claude Code, Codex, Cursor, OpenCode)를 워커로 띄우는 도구도 있다 (`letta-code/src/tools/impl/external-coding-agent.ts`, `claude-stream-session.ts`, `codex-app-server.ts`).

**letta-archive (V1)**: 프로세스가 아니라 DB 의 "group" 이다 — `SleeptimeMultiAgentV3|V4` 와 multi-agent 도구 세트 (`letta-archive/letta/groups/`, `letta-archive/letta/constants.py:180-183`).

### 7. Streaming / event 모델

**letta-code** — 계층이 셋이다.

- (1) 백엔드 → 클라이언트: Letta 스트림 청크, `message_type` 으로 구분. `assistant_message`, `reasoning_message`, `approval_request_message`, `usage_statistics`, `stop_reason`, `event_message`(retry/compaction) 등 (`letta-code/src/backend/dev/provider-turn-executor.ts:404-520`). V1 정의는 `letta-archive/letta/schemas/letta_message.py:54-65`.
- (2) headless → 부모 프로세스/SDK: stdout JSON lines `WireMessage` — `system`(init), `message`, `stream_event`, `approval_requested`, `approval_received`, `auto_approval`, `tool_execution_started`, `tool_execution_finished`, `retry`, `recovery`, `error`, `result`, `control_request`/`control_response`, `queue_*` (`letta-code/src/types/protocol.ts:488-509`).
- (3) App Server(WebSocket) → 데스크톱/웹: `stream_delta`, `turn_finished`(`stop_reason`, `usage`), `loop_status`, `queue_update`, `subagent_state_update` 등 (`letta-code/src/types/protocol_v2.ts:479-493`, 유니온 `:2027-2043`). 이 파일 하나가 2,129줄로, CRUD 요청/응답 타입이 스트림 이벤트와 한 유니온에 섞여 있다.
- 채널(Slack/Telegram/Discord/WhatsApp/Signal/custom)은 SSE 에서 assistant 텍스트와 진행 상황 업데이트만 추려 쓴다 (`letta-code/src/channels/core-stream.ts:1-50`). 채널 플러그인 계약은 `start`/`stop`/`sendMessage`/`onMessage` 어댑터 (`letta-code/src/channels/README.md:48-75`), 에이전트 쪽 발신은 공용 `MessageChannel` 도구 하나.

**letta-archive (V1)**: SSE. stop reason 13종 (`end_turn`, `max_steps`, `requires_approval`, `cancelled`, `llm_api_error`, `context_window_overflow_in_system_prompt` 등 — `letta-archive/letta/schemas/letta_stop_reason.py:9-22`).

### 8. Proactive (cron/heartbeat/알림)

**letta-code**

- cron 은 로컬 JSON 파일 + 디렉터리 락이다: `crons.json`, `crons.lock`, `LOCK_STALE_AGE_MS = 30_000`, `MAX_ACTIVE_TASKS_PER_AGENT = 50` (`letta-code/src/cron/cron-file.ts:101-109`). 태스크 필드는 `cron`, `timezone`, `recurring`, `prompt`, `status`, `fire_count`, `jitter_offset_ms`, `expires_at`, `last_run_outcome` (`:57-80`).
- 스케줄러는 60초 틱: `TICK_INTERVAL_MS = 60_000`, `GC_INTERVAL_MS = 60 * 60_000` (`letta-code/src/cron/scheduler.ts:100-105`). 발화하면 새 세션을 띄우는 게 아니라 **대상 대화의 입력 큐에 프롬프트를 넣는다** (`:367-374`). 놓친 one-shot 은 `missed` 로 기록한다 (`:414-447`). 실행 기록은 `letta-code/src/cron/run-log.ts`.
- 프롬프트 포장: 이름, 예정 시각, 현재 시각, 반복 여부, 몇 번째 발화인지를 구조화해 넣는다 (`letta-code/src/cron/prompt.ts:35-53`).
- 에이전트가 스스로 예약하는 도구 2종: `Wake`(시간 조건, 현재 대화에만 묶임)와 `Monitor`(조건이 충족되면 깨움) (`letta-code/src/tools/descriptions/Wake.md:1-12`). 시스템 프롬프트가 "미래 작업은 반드시 명시적으로 예약하라, 주기는 가능한 한 길게"라고 지시한다 (`letta-code/src/agent/prompts/letta_root_memfs.md` 의 "Working across time" 절).
- `Notification` 훅 이벤트가 있다 (`letta-code/src/hooks/types.ts:9`).

**letta-archive (V1)**: 사용자용 cron 은 찾지 못함. APScheduler 는 LLM 배치 잡 폴링용이다 (`letta-archive/letta/jobs/scheduler.py:5-16`, `llm_batch_job_polling.py`). 옛 MemGPT 의 "heartbeat" 는 V3 루프에서 "도구를 부르면 계속" 규칙으로 대체됐다 (`letta-archive/letta/agents/letta_agent_v3.py:1976-1986`).

### 9. Guardrails / evals / tracing

**letta-code**

- 가드레일은 3절의 권한 엔진 + 훅 + 샌드박스가 전부다. 그 외: 다른 에이전트의 메모리 접근을 막는 `cross-agent-guard` (`letta-code/src/permissions/cross-agent-guard.ts`), 도구 출력 시크릿 스크럽 (`letta-code/src/tools/manager.ts:2240-2289`), 발신 메시지 스크럽 (`letta-code/src/agent/message.ts:348-357`). 출력 내용 필터나 환각 검사류는 찾지 못함.
- 권한 판정은 단계별 trace 를 남긴다 (`PermissionCheckTrace` — `letta-code/src/permissions/types.ts:33-40`). v1/v2 엔진을 나란히 돌려 비교하는 shadow 필드도 있다 (`:27-31`).
- 텔레메트리: 세션/에러 이벤트를 Letta 로 전송, `LETTA_CODE_TELEM=0` 또는 `DO_NOT_TRACK=1` 로 끔 (`letta-code/src/telemetry/index.ts:370-375`). 외부 코딩 에이전트의 raw LLM 호출은 로컬 프록시로 캡처해 업로드한다 (`letta-code/docs/external-agent-traces.md:1-12`). OpenTelemetry 의존성은 `package.json` 에서 찾지 못함.
- evals: 이 레포에는 없다(별도 레포 `letta-ai/letta-evals`). 있는 것은 테스트 466개 파일 / 약 160,000줄, 결정론적 가짜 실행기(`DeterministicPongExecutor`, `DeterministicToolCallExecutor` — `letta-code/src/backend/dev/headless-turn-executor.ts:94-172`), 지연 벤치마크 `letta-code/scripts/latency-benchmark.ts`.
- 구조 린트를 스크립트로 강제한다: 파일당 1,000줄 상한(`MAX_LINES = 1000`, `letta-code/scripts/check-source-file-size.js:6`, 기존 초과 파일은 baseline 으로 면제), 레이어 경계 검사 (`letta-code/scripts/check-layer-boundaries.js`).

**letta-archive (V1)**: OpenTelemetry 계측 (`letta-archive/letta/otel/tracing.py`, `metrics.py`), provider 요청/응답 trace 테이블 (`letta-archive/letta/orm/provider_trace.py`), step 단위 메트릭 (`letta-archive/letta/orm/step_metrics.py`, `run_metrics.py`).

### 10. 규모 (LOC)

**letta-code** (`wc -l`, 테스트 제외 `src/` 합계 331,283줄; 테스트 별도 약 160,000줄)
| 영역 | 줄 수 |
|---|---|
| `src/cli/` (TUI) | 85,774 |
| `src/websocket/` (App Server) | 53,656 |
| `src/channels/` | 43,540 |
| `src/tools/` | 36,632 |
| `src/agent/` | 24,394 |
| `src/backend/` (api + local + dev) | 22,479 |
| `src/mods/` | 9,647 |
| `src/permissions/` | 6,953 |
| `src/cron/` | 3,172 |
| `src/hooks/` | 1,918 |

- 루프 핵심만: `headless.ts` 4,448 + `use-conversation-loop.ts` 2,540 + `websocket/listener/turn.ts` 997 + `cli/helpers/stream.ts` 851 + `agent/message.ts` 665 + `agent/approval-execution.ts` 598 + `agent/turn-recovery-policy.ts` 657 + `tools/manager.ts` 2,351 = 약 13,100줄.
- 로컬 백엔드에서 "LLM 한 번 호출 + 컴팩션 + 저장"에 해당하는 부분: `provider-turn-executor.ts` 538 + `pi-stream-adapter.ts` 772 + `compaction.ts` 740 + `local-backend.ts` 876 + `local-store.ts` 3,179 + `system-prompt-compilation.ts` 461 = 약 6,600줄.

**letta-archive (V1)**: `letta/` Python 전체 137,850줄. `agents/` 8,050줄(`letta_agent_v3.py` 2,134 + `letta_agent_v2.py` 1,487 + `letta_agent.py` 1,983), `services/` 41,334줄, `llm_api/` 9,494줄, `services/summarizer/` 2,116줄.

### 지저분한 점 / 찾지 못한 것

- **턴 루프가 최소 4벌이다.** headless one-shot (`letta-code/src/headless.ts:1999`), headless 양방향 (`:3971`), TUI (`letta-code/src/cli/app/use-conversation-loop.ts:716`), App Server (`letta-code/src/websocket/listener/turn.ts:304`). 재시도/승인/복구 분기가 각각 복제돼 있고, `headless.ts` 한 파일에 `while (true)` 가 6개다. 1인이 감사할 수 있는 구조가 아니다.
- **프로덕션 로컬 백엔드가 `dev/` 의 "fake" 파일을 상속한다.** `LocalBackend extends HeadlessBackend` 인데 `HeadlessBackend` 는 `letta-code/src/backend/dev/fake-headless-backend.ts:198` 에 있고, 실제 LLM 어댑터도 `backend/dev/pi-stream-adapter.ts` 다. 실험 코드가 그대로 굳은 흔적.
- **원격 프로토콜을 로컬에서 에뮬레이트하는 비용.** 로컬에서도 모든 tool call 이 "승인 요청 → 스트림 종료 → 새 요청" 왕복을 타고, 메시지를 두 포맷으로 들고 다닌다. 서버가 없는 단일 사용자 앱이 따라 할 이유가 없는 구조다.
- **기본 권한 모드가 `unrestricted`** (`letta-code/src/permissions/mode.ts:7`), 서브에이전트도 항상 `--permission-mode unrestricted` 로 뜬다 (`letta-code/src/agent/subagents/manager.ts:170`). 정교한 권한 엔진이 기본값에서는 대부분 우회된다.
- 재시도 가능 여부를 에러 메시지 문자열 조각으로 판정한다 (`letta-code/src/agent/turn-recovery-policy.ts:8-104`).
- V1 루프에는 주석 처리된 요약 로직 블록이 그대로 남아 있고 (`letta-archive/letta/agents/letta_agent_v3.py:364-385`, `:397-405`), 에이전트 루프 3세대(`letta_agent.py`/`v2`/`v3`)와 메모리 도구 4세대가 공존한다.
- V1 컴팩션 임계값 함수는 docstring 과 구현이 다르다: 설명은 모델별 분기인데 본문은 무조건 90% 한 줄이고, 같은 파일의 `is_gpt5_model_family` 는 그 함수에서 쓰이지 않는다 (`letta-archive/letta/services/summarizer/thresholds.py:19-41`).
- 찾지 못함: (a) `api` 모드 서버의 현재 소스 — 현행 Letta Cloud 서버가 `archive` 브랜치와 같은 코드인지 알 수 없다. (b) letta-code 내 `cache_control` 직접 지정. (c) 턴 단위 토큰/비용 예산 한도. (d) 이 레포 안의 eval 스위트. (e) 메모리 임베딩/벡터 검색(로컬 모드에는 명시적으로 없음).

**교차 확인(상위 에이전트가 소스를 다시 열어 대조):** `letta-code/src/permissions/mode.ts:1-7`(`DEFAULT_PERMISSION_MODE = "unrestricted"`), `letta-code/src/headless.ts:219-229`(재시도 상수 4종), `letta-code/src/agent/subagents/subagent-depth.ts:6`(`MAX_SUBAGENT_DEPTH = 2`), `letta-code/src/cron/scheduler.ts:100-101`(`TICK_INTERVAL_MS = 60_000`), `letta-code/src/backend/local/compaction.ts:49-56`(기본 `sliding_window`, 0.3), `letta-code/src/agent/approval-execution.ts:97`(`PARALLEL_SAFE_TOOLS`), `letta-archive/letta/constants.py:75, 83`(`DEFAULT_MAX_STEPS = 50`, `SUMMARIZATION_TRIGGER_MULTIPLIER = 0.9`), `letta-code/LICENSE`(Apache-2.0) — 모두 일치. 나머지 인용은 다시 열어보지 않았다.

## 5. nanobot (HKUDS/nanobot) — 검색으로 추가한 4번째

스타 50,341 · HEAD `c360a10` (2026-11-26T10:54:12+08:00) · Python · MIT (`LICENSE:1-3`). 모든 경로는 레포 루트 기준 상대 경로.

### 한 줄 요약

"채널 → `MessageBus`(asyncio.Queue 2개) → 세션별 FIFO 워커 → `AgentRunner` 루프 → 다시 bus → 채널"이라는 구조가 가장 읽기 쉬운 형태로 남아 있는 레포다. 다만 "lightweight"라는 설명은 더 이상 사실이 아니다. 테스트 제외 Python이 144,813줄이고, 루프 두 파일(`agent/runner.py` 1,572 + `agent/loop.py` 2,663)만 4,235줄이다. FinClaw가 가져갈 것은 뼈대(버스, 세션 키, 턴 파이프라인 7단계, 파일 기반 메모리 + 주기적 Dream, cron에 얹은 heartbeat)이고, 복구/프로바이더 상태/WebUI 관련 두께는 버려도 된다.

### 1. Agent loop

- **두 층으로 분리.** 제품 로직이 없는 순수 tool loop는 `AgentRunner`(`nanobot/agent/runner.py:169-170`, docstring "Run a tool-capable LLM loop without product-layer concerns"), 세션/버스/명령/저장을 아는 바깥 층은 `AgentLoop`(`nanobot/agent/loop.py:210-220`). 서브에이전트, Dream, heartbeat가 모두 같은 `AgentRunner.run(AgentRunSpec)`을 재사용한다(`nanobot/agent/loop.py:1283`, `nanobot/agent/subagent.py:886`).
- **입력 스펙이 dataclass 하나.** `AgentRunSpec`(`nanobot/agent/runner.py:115-142`): `tools`, `runtime`, `max_iterations`, `max_tool_result_chars`, `hook`, `concurrent_tools`, `checkpoint_callback`, `injection_callback`, `continuation_callback`, `events` 등. 결과는 `AgentRunResult`(`runner.py:145-166`)이고 `stop_reason` 기본값은 `"completed"`.
- **종료 결정은 모델.** `while` 조건은 `iteration + 1 < spec.max_iterations or followup_requested or await self._continuation_prompt(spec) is not None`(`runner.py:483-487`). 응답에 실행 가능한 tool call이 있으면 실행 후 `continue`(`runner.py:550-658`), 없으면 그 텍스트가 최종 답이 되어 `break`(`runner.py:863-879`). "실행 가능" 판정은 `LLMResponse.should_execute_tools`로, `finish_reason`이 `tool_calls`/`function_call`/`stop`일 때만 참이다(`nanobot/providers/base.py:370-376`). refusal/content_filter 아래의 tool call은 무시하고 경고만 남긴다(`runner.py:661-666`).
- **한도.** `max_tool_iterations: int = 200`(`nanobot/config/schema.py:191`)이 `AgentLoop.max_iterations`로 들어간다(`loop.py:334-336`). 한도 도달 시 `while ... else`로 빠져 `stop_reason = "max_iterations"`(`runner.py:880-882`), tool 없이 한 번 더 호출해 마무리 답변을 받고(`_try_finalize_after_max_iterations`, `runner.py:1335-1394`), 그것도 실패하면 템플릿 문구로 대체한다(`runner.py:1433-1442`). 토큰/비용 예산 기반 중단은 찾지 못함. 반복 횟수와 컨텍스트 창 압력만 본다.
- **예외: sustained goal.** `continuation_callback`이 문자열을 돌려주면 `max_iterations`를 넘겨서도 계속 돈다(`runner.py:807-825`, 구현은 `nanobot/goal/runtime.py:33-46`). goal 연장 횟수의 상한은 찾지 못함(`_sustained_goal_continuation_rounds` 키는 `goal/runtime.py:17-19`에 volatile 키로만 등장).
- **병렬 tool call.** 메인 루프는 `concurrent_tools=True`(`loop.py:1296`). `_partition_tool_batches`가 연속된 `concurrency_safe` 호출만 한 배치로 묶어 `asyncio.gather`하고, 그 외는 순차 실행한다(`nanobot/agent/tools/execution.py:108-128`, `312-336`). `concurrency_safe = read_only and not exclusive`(`nanobot/agent/tools/base.py:96-109`). 서브에이전트 spec은 이 값을 주지 않아 순차(기본 `False`, `runner.py:126`).
- **재시도는 세 겹.** (a) 프로바이더: `_CHAT_RETRY_DELAYS = (1, 2, 4)`, transient 오류만, `Retry-After` 존중, `persistent` 모드는 동일 오류 `_PERSISTENT_IDENTICAL_ERROR_LIMIT = 10`회까지(`providers/base.py:385-388`, `1602-1700`). (b) 빈 응답 `_MAX_EMPTY_RETRIES = 2`, 출력 잘림(`finish_reason == "length"`) 이어쓰기 `_MAX_LENGTH_RECOVERIES = 3`(`runner.py:98-99`, `676`, `713-734`). (c) 깨진 tool call은 전부 버리고 1회 재요청, 또 깨지면 tool 없이 요청(`runner.py:1203-1247`).
- **같은 외부 조회 반복 차단.** 같은 시그니처의 외부 lookup은 `_MAX_REPEAT_EXTERNAL_LOOKUPS = 2`회 초과 시 실행하지 않고 오류 결과를 돌려준다(`nanobot/utils/runtime.py:11`, `103-115`, 호출부 `tools/execution.py:144-155`).
- **취소.** `/stop`은 priority 명령이라 세션 큐를 거치지 않고 즉시 처리된다(`nanobot/command/builtin.py:547`, `loop.py:1440-1442`). 실제 취소는 세션 키로 추적하던 asyncio task에 `task.cancel()`을 걸고, 그 세션의 서브에이전트와 exec 세션까지 같이 끊는다(`loop.py:943-989`). runner는 모델 호출 전후마다 `_raise_if_cancelling()`을 확인한다(`runner.py:70-74`, `1003-1005`). 실행 중 끊긴 tool call은 "outcome is unknown. Check its effects before retrying"라는 합성 결과로 닫아 transcript의 call/result 짝을 유지한다(`runner.py:607-614`).
- **턴 중간 주입.** 턴이 도는 동안 같은 세션으로 온 메시지는 새 턴이 아니라 다음 모델 호출 직전에 transcript에 끼워 넣는다(`runner.py:497-500` → `PendingInputs.drain`, `nanobot/agent/pending_inputs.py:28-59`).

### 2. Message/state 모델

- **버스.** `MessageBus`는 `inbound`/`outbound` 두 개의 `asyncio.Queue`와 타입별 로컬 구독자 목록이 전부다(`nanobot/bus/queue.py:18-52`, 160줄). 메시지 타입은 `InboundMessage`(channel, sender_id, chat_id, content, media, metadata, session_key_override)와 `OutboundMessage`(`nanobot/bus/events.py:29-82`, 82줄).
- **세션 키.** `session_key = session_key_override or f"{channel}:{chat_id}"`(`bus/events.py:45-48`). 즉 채널+대화방 단위이고 사용자 단위가 아니다. cron/서브에이전트 결과는 `session_key_override`로 원 세션에 꽂는다(`nanobot/cron/bound_runner.py:116-123`, `agent/subagent.py:982-989`). 내부용 키는 `"heartbeat"`와 `dream:` 접두(`nanobot/session/keys.py:3-13`).
- **세션당 직렬화.** `_enqueue_session_message`가 세션 키별 `SessionInbox`를 만들고 워커 task 하나가 FIFO로 소비한다(`loop.py:1506-1561`). 세션 간에는 병렬이고, 전역 상한은 환경변수 `NANOBOT_MAX_CONCURRENT_REQUESTS`(미설정이면 무제한, `loop.py:432-436`).
- **턴 파이프라인 7단계.** `restore → compact → command → build → run → save → respond`를 단계별 소요 시간 로그와 함께 순서대로 실행한다(`loop.py:1903-1913`, 래퍼 `1915-1952`).
- **영속화는 SQLite.** `<sessions_dir>/sessions.sqlite3`, WAL, `PRAGMA synchronous = FULL`, 파일 권한 0600(`nanobot/session/sqlite_store.py:174-175`, `227-228`, `287-291`). 테이블: `sessions`(key PK, metadata JSON, provider_state, last_archived, revision, generation), `messages`(session_key, position, record JSON), `checkpoints`, `pending_inputs`(`sqlite_store.py:62-87`), 그리고 표시용 `history_heads/turns/entries`(`90-113`). 마이그레이션은 `PRAGMA user_version` + 함수 튜플(`148-159`, `292-297`). 과거 JSONL 세션 가져오기 코드가 남아 있다(`nanobot/session/jsonl_migration.py`, 289줄).
- **transcript 표현.** OpenAI chat 형식 dict 리스트(`role`, `content`, `tool_calls`, `tool_call_id`, `timestamp`)가 그대로 저장/재생된다(`nanobot/session/manager.py:99-153`). Anthropic 형식 변환은 프로바이더 안에서만 한다(`nanobot/providers/anthropic_provider.py:590`).
- **재개(resume).** `Session.get_history()`는 개수 제한 없이 마지막 summary checkpoint 이후 전부를 돌려준다(`session/manager.py:176-194`). 요약 지점은 `last_consolidated` 오프셋과 `metadata["_last_summary"]`로 기록하고 원문 메시지는 지우지 않는다(`session/manager.py:155-174`).
- **크래시 복구.** runner가 `model_input / awaiting_tools / tools_completed / final_response` 네 단계마다 checkpoint를 내보내고(`runner.py:77-87`, `570`, `628`, `772`), `AgentLoop._checkpoint_turn`이 세션에 저장한다(`loop.py:1121-1140`). 다음 턴의 `restore` 단계에서 미완 턴을 복원한다(`loop.py:2073-2080`, 로직 `nanobot/session/recovery.py:323-470`). 사용자 메시지는 모델 호출 전에 먼저 저장한다(`loop.py:2245-2250`).

### 3. Tool 인터페이스

- **정의.** `Tool` 추상 클래스: `name`, `description`, `parameters`(JSON Schema), `execute(**kwargs)`, 선택 속성 `read_only`/`exclusive`/`concurrency_safe`(`nanobot/agent/tools/base.py:75-159`, 파일 194줄). 스키마는 `@tool_parameters({...})` 데코레이터로 붙인다(`base.py:162-194`). 실패는 예외가 아니라 `ToolResult.error(...)`(str 서브클래스)로 반환(`base.py:58-72`).
- **검증.** `ToolRegistry.prepare_call`이 이름 확인(오타면 "Did you mean" 힌트) → 문자열 인자 JSON 파싱 → 자체 JSON Schema 검증기로 검사하고, 오류는 tool 결과 문자열로 모델에게 돌려준다(`nanobot/agent/tools/registry.py:120-157`, 검증기 `nanobot/agent/tools/json_schema.py` 118줄). 모든 오류 결과 끝에 재고 힌트 한 줄을 붙인다(`registry.py:12-22`).
- **등록.** `ToolLoader`가 `agent/tools` 패키지 스캔 + `nanobot.tools` entry point 플러그인으로 발견하고, 클래스의 `_scopes`(`core`/`subagent`/`memory`)와 `enabled(ctx)`로 거른다(`nanobot/agent/tools/loader.py:66-133`). 내장 tool 이름: `read_file write_file edit_file apply_patch list_dir grep find_files rg exec exec_session message cron subagent create_goal update_goal read_session search_sessions send_session_message run_cli_app generate_image my` + 웹 tool(`agent/tools/web.py`).
- **권한/승인 게이트는 없다.** tool 실행 전 사용자 승인을 받는 경로는 찾지 못함. `read_only`는 병렬 실행 판정에만 쓰인다(`base.py:96-104`, 사용처 `tools/execution.py:326`뿐). 시스템 프롬프트가 "명확한 요청은 실행 승인으로 간주"라고 지시한다(`nanobot/templates/agent/tool_contract.md:3-4`). 저장소에서 "approve"가 나오는 곳은 DM 발신자 pairing과 자체 업데이트뿐이다(`nanobot/pairing/store.py:1-4`).
- **대신 있는 것은 경계 가드.** (a) 셸 deny 정규식 목록(`rm -rf`, `dd if=`, `shutdown` 등)과 메모리 내부 파일 쓰기 차단(`nanobot/agent/tools/shell.py:193-211`), (b) `restrict_to_workspace` 경로 제한과 선택적 샌드박스(`config/schema.py:439`, `nanobot/execution/sandbox.py` 295줄), (c) SSRF 차단: 사설망 대역 거부 + DNS 고정(`nanobot/security/network.py:14`, `77-157`, `220-327`), 위반 시 "우회 금지" 문구를 붙인 소프트 오류(`tools/execution.py:22-36`, `271-279`), (d) 세션 정책 `disabled_tools`로 턴마다 registry를 축소(`session/manager.py:83-88`, `loop.py:2045-2053`).
- **MCP.** 공식 `mcp` SDK 클라이언트로 stdio/SSE/streamableHttp 연결(`nanobot/agent/tools/mcp.py:973-1118`), tool을 `mcp_<server>_<tool>` 이름의 `MCPToolWrapper`로 감싸 같은 registry에 넣는다(`mcp.py:715-728`). 서버별 `enabled_tools` allowlist와 `tool_timeout: int = 30`(`config/schema.py:411-424`, `mcp.py:1142-1167`). `readOnlyHint`/`idempotentHint`는 연결 복구 후 재실행 가능 여부(`replay_safe`)에만 쓰고 권한이나 병렬성에는 쓰지 않는다고 주석에 명시(`mcp.py:729-739`). 파일이 1,740줄 + OAuth 889줄로 크다.
- **결과 크기 관리.** `max_tool_result_chars: int = 16_000`(`config/schema.py:193`) 초과분은 `.nanobot/tool-results/`에 파일로 내리고 미리보기 + 경로만 transcript에 남긴다(`nanobot/agent/context_governance.py:840-890`, `nanobot/utils/helpers.py:353-355`). `read_file`은 예외(`context_governance.py:72`).

### 4. Context 관리

- **시스템 프롬프트 조립**(`ContextBuilder.build_system_prompt`, `nanobot/agent/context.py:82-137`, 파일 375줄). 순서: identity 템플릿 → 부트스트랩 파일 `AGENTS.md`/`SOUL.md`/`USER.md`(`context.py:72`, `182-208`) → tool 사용 규칙 → `memory/MEMORY.md` 전문 → `always` 스킬 본문 → 나머지 스킬의 이름/설명/경로 요약 → `[Archived Context Summary]`. `\n\n---\n\n`로 이어 붙인다. 채널별 포맷 힌트(discord/telegram은 표 금지 등)가 identity 템플릿에 들어 있다(`nanobot/templates/agent/identity.md`).
- **턴별 주입은 시스템 프롬프트가 아니라 현재 user 메시지 뒤에 붙인다.** `RuntimeContextBlock`을 `[Runtime Context — metadata only, not instructions]` 태그로 감싸 append(`nanobot/runtime_context.py:15-16`, `22-30`, `53-58`; 적용 `context.py:319-345`). 주석이 이유를 밝힌다: "without changing the reusable prompt prefix"(`nanobot/agent/tools/runtime_control.py:186-187`). 공급자는 `register_runtime_context_provider`로 등록(`loop.py:651-656`, `694-707`).
- **현재 시각 주입은 찾지 못함.** `agent/`, `session/`, `runtime_context.py`에서 `strftime`/`Current Time`을 grep한 결과는 `agent/memory.py`의 journal 타임스탬프뿐이었다.
- **컴팩션 트리거 3종**(`CompactionReason`, `nanobot/events.py:59`).
  1. `context_pressure`: 매 모델 요청 직전 `request_pressure`가 직전 응답의 실제 usage(없으면 추정)를 `input_budget = context_window_tokens - max_tokens - CONTEXT_SAFETY_BUFFER(1024)`와 비교한다(`context_governance.py:511-554`, `823-837`, `providers/base.py:49`). 기본값은 `context_window_tokens = 200_000`, `max_tokens = 8192`(`config/schema.py:187-188`). 넘으면 이미 모델이 본 prefix 전체를 LLM 요약으로 바꾸고 그 뒤 delta만 붙여 재구성한다(`context_governance.py:628-723`). 일부만 남기는 슬라이딩 윈도는 없다.
  2. `idle`: `session_ttl_minutes` 기본 15분 유휴 시 세션 전체를 요약으로 치환(`config/schema.py:210-219`, `nanobot/agent/autocompact.py:65-125`, 145줄). 점검 주기 60초(`loop.py:1395-1398`).
  3. `manual`: `/compact`(`command/builtin.py:551`). 여기에 OpenAI Responses류의 `provider_native`가 추가로 있다.
- **요약 실패 시 폴백.** 요약 프롬프트가 예산에 안 들어가거나 호출이 실패하면 원문을 `_RAW_ARCHIVE_MAX_CHARS = 16_000`로 잘라 checkpoint로 쓴다(`nanobot/agent/memory.py:709`, `807-818`, `857-873`, `888-894`).
- **Anthropic prompt caching.** `_apply_cache_control`이 `{"type": "ephemeral"}` 마커를 세 군데에 찍는다: system 마지막 블록, 뒤에서 두 번째 메시지(메시지 3개 이상일 때), tool 목록의 "마지막 내장 tool"과 "맨 끝 tool"(`providers/anthropic_provider.py:540-572`, `providers/base.py:709-726`). 이를 위해 tool 정의를 내장 → MCP 순으로 이름 정렬해 고정한다(`tools/registry.py:96-118`). `cache_read_input_tokens`를 usage에 기록(`anthropic_provider.py:699-711`). TTL 지정(1h)이나 캐시 워밍은 찾지 못함.

### 5. Memory

- **전부 워크스페이스의 평문 파일.** `MemoryStore`(`agent/memory.py:53-82`): 매 턴 프롬프트에 들어가는 `memory/MEMORY.md`, `SOUL.md`, `USER.md`, 필요할 때만 읽는 `memory/wiki/`, append-only journal `memory/history.jsonl`(레코드 `{cursor, timestamp, content, session_key}`, `memory.py:295-309`), 커서 파일 `memory/.cursor`·`memory/.dream_cursor`(`nanobot/config/paths.py:8-10`). 벡터 DB, 임베딩, FTS는 찾지 못함.
- **쓰는 주체 셋.**
  1. 컴팩션: 세션을 요약할 때 그 요약문을 `history.jsonl`에 한 줄 추가한다(`memory.py:960-962`). 요약 프롬프트가 사실마다 `[permanent]/[durable]/[ephemeral]/[correction]` 태그를 붙이게 한다(`nanobot/templates/agent/consolidator_archive.md`).
  2. Dream: cron 시스템 잡이 기본 2시간마다(`DreamConfig.interval_h = 2`, `config/schema.py:71-91`; 등록 `nanobot/cli/gateway_runtime.py:838-846`) `.dream_cursor` 이후의 journal 구간을 읽고 메모리 파일을 직접 고친다. 일회용 세션 `dream:*`에서 같은 runner로 돌고(`nanobot/agent/dream.py:24-67`, 67줄), tool은 read/edit/patch/write 네 개뿐이며 쓰기 허용 경로가 `MEMORY.md`, `SOUL.md`, `USER.md`, `memory/wiki/`, `skills/`로 제한된다(`memory.py:545-590`). 정상 종료(`_stop_reason == "completed"`)일 때만 커서를 전진시키고(`dream.py:46-49`), 변경은 git 자동 커밋(`dream.py:55-60`, `nanobot/utils/gitstore.py` 689줄). `/dream-log`, `/dream-restore`로 조회/되돌리기(`command/builtin.py:558-561`).
  3. 메인 에이전트: `memory` 스킬 지침에 따라 사용자가 "기억해"라고 하면 파일 tool로 즉시 수정(`nanobot/skills/memory/SKILL.md`).
- **검색.** 상주 파일은 통째로 주입하고, 나머지는 에이전트가 `grep`/`read_file`로 `history.jsonl`과 wiki를 직접 찾는다(`skills/memory/SKILL.md`의 "Search Past Events"). journal은 `_DEFAULT_MAX_HISTORY = 1000` 항목으로 정리(`memory.py:56`, `386-415`).

### 6. Sub-agent / delegation

- `subagent` tool(`nanobot/agent/tools/subagent.py:57-71`, 147줄) → `SubagentManager.spawn`이 `asyncio.create_task`로 백그라운드 실행하고 즉시 "started (id: ...)"를 반환한다(`agent/subagent.py:660-686`, 파일 1,067줄). 동시 실행 `max_concurrent_subagents = 4`(`config/schema.py:192`, 세마포어 `subagent.py:275`), 등록 상한 `MAX_ACTIVE = 128`(`subagent.py:287`).
- 자식은 `subagent` scope tool만 받는다(`subagent.py:565-587`). 파일/셸/웹/검색류가 여기에 해당하고(`tools/shell.py:122`, `tools/filesystem.py:248` 등), `message`·`cron`·`subagent`는 `_scopes` 기본값이 `{"core"}`라 빠진다(`tools/base.py:114`). 따라서 재귀 spawn이 불가능하다. 자체 시스템 프롬프트와 자체 세션(`subagent:*`)을 쓴다(`subagent.py:824-828`).
- **결과 회수.** `channel="system"`, `sender_id="subagent"`, `session_key_override=<부모 세션>`인 `InboundMessage`를 bus에 다시 넣는다(`subagent.py:960-992`). 부모 턴이 살아 있으면 턴 중간 주입으로, 끝났으면 새 턴으로 처리된다. 부모는 최종 응답 직전 서브에이전트가 남아 있으면 최대 `terminal_wait_seconds = 300.0`초 기다린다(`agent/pending_inputs.py:25`, `61-81`).

### 7. Streaming / event 모델

- runner는 UI를 모르고 `AgentHook` 콜백(`on_stream`, `on_stream_end(resuming=...)`, `before_execute_tools`, `on_tool_execution_event`, `emit_reasoning`, `after_iteration`)만 호출한다(`nanobot/agent/hook.py:68-174`, 348줄). `AgentProgressHook`이 이를 typed event로 바꾼다(`nanobot/agent/progress_hook.py:20-186`).
- 이벤트는 frozen dataclass: `StreamDeltaEvent`, `StreamEndEvent(resuming, merge_next)`, `ProgressEvent(tool_hint, reasoning_delta, tool_events, ...)`, `TurnEndEvent(usage, latency_ms, outcome, ...)`, `TurnFailureNotice`(`nanobot/bus/outbound_events.py:24-112`), `ModelRequestEvent`, `ContextCompactionEvent`, `RetryStatusEvent`(`nanobot/events.py:12-93`).
- 전달 경로는 일반 메시지와 같은 outbound 큐다(`bus/queue.py:54-70`). `ChannelManager._dispatch_outbound_loop`가 채널 능력에 맞춰 버리거나 합친다. reasoning은 `show_reasoning` 채널에만, tool hint는 채널 설정에 따라(`nanobot/channels/manager.py:909-967`). 채널은 `send`만 필수이고 `send_delta`를 오버라이드해야 스트리밍 채널로 인정된다(`nanobot/channels/base.py:111`, `198-220`, `295-304`).
- cron 결과처럼 재전송 가능해야 하는 출력은 스트림을 끄고 최종 메시지 하나로 보낸다(`cron/bound_runner.py:55-58`).

### 8. Proactive (cron/heartbeat/알림)

- **cron.** `CronService`(`nanobot/cron/service.py`, 923줄): `at`/`every`/`cron` 세 종류(`nanobot/cron/types.py:23-34`), 저장은 `<workspace>/cron/jobs.json` + `action.jsonl` + `runs/`(`cli/gateway_runtime.py:549-550`, `service.py:207-210`). 다음 실행 시각까지 `asyncio.sleep`하는 단일 타이머이고 최대 수면 `max_sleep_ms = 300_000`(`service.py:202`, `469-493`). tick 실패 시에도 `finally`에서 타이머를 다시 건다(`service.py:541-545`). 잡별 실행 이력 `_MAX_RUN_HISTORY = 20`(`service.py:192`).
- **cron 결과 전달.** 잡은 만들어진 세션에 묶인다. LLM이 `cron` tool로 추가할 때 현재 요청의 session_key/channel/chat_id를 저장한다(`nanobot/agent/tools/cron.py:173-189`). 실행 시 그 세션에 `sender_id="cron"`인 일반 턴을 제출하고(`cron/bound_runner.py:63-123`), 세션이 바쁘면 유휴가 될 때까지 미룬다(`CRON_DEFER_UNTIL_IDLE_META`, `bound_runner.py:95`; `nanobot/agent/cron_turns.py:14-29`). 답변은 그 턴의 일반 응답으로 원 채널에 나간다(`nanobot/templates/agent/cron_reminder.md`). 세션에 묶이지 않은 잡은 건너뛴다(`cli/gateway_runtime.py:706-716`).
- **heartbeat는 cron 시스템 잡.** 기본 30분(`HeartbeatConfig.interval_s = 30 * 60`, `config/schema.py:395-399`; 등록 `cli/gateway_runtime.py:853-863`). 판단이 3단계다(`cli/gateway_runtime.py:628-704`).
  1. LLM 호출 전 필터: `HEARTBEAT.md`가 없거나 `## Active Tasks` 섹션에 내용이 없으면 즉시 반환(`_heartbeat_has_active_tasks`, `gateway_runtime.py:229-250`).
  2. 전용 세션 `"heartbeat"`에서 에이전트 턴 실행. 이때 `message` tool의 직접 전송을 막아(`set_suppress_delivery(True)`, `gateway_runtime.py:653-669`) 출력이 반드시 게이트를 거치게 한다.
  3. 별도 LLM 호출 `evaluate_response`가 `evaluate_notification(should_notify, reason)` tool call로 알림 여부를 정하고, 실패 시 `default_notify=False`로 침묵한다(`nanobot/utils/evaluator.py:60-139`, `gateway_runtime.py:683-703`).
     전달 대상은 가장 최근의 외부 채널 세션이고 없으면 보내지 않는다(`gateway_runtime.py:253-272`, `639-641`).
- **local trigger.** 파일 큐를 0.5초 간격으로 폴링해 세션 턴으로 제출하는 외부 트리거 경로가 따로 있다(`nanobot/triggers/local_runner.py`, `poll_interval_s = 0.5`). 용도는 깊이 확인하지 않음.

### 9. Guardrails / evals / tracing

- **가드레일**은 3절의 경계 가드가 전부다. 여기에 채널 발신자 allowlist(`allow_from` → pairing 승인, `channels/base.py:306-322`)와 외부 콘텐츠 비신뢰 지시문(`nanobot/templates/agent/_snippets/untrusted_content.md`)이 더해진다. 출력 검증, 사실 검증, 금액/수치 검증 같은 내용 가드는 찾지 못함.
- **evals.** 에이전트 품질 평가 하네스는 찾지 못함. 있는 것은 단위/통합 테스트(패키지 내 `tests/` 약 50K줄 + 루트 `tests/` 약 175K줄)와 import 경계 테스트(`tests/architecture/test_import_boundaries.py`)다.
- **tracing.** Langfuse는 OpenAI 호환/Codex 프로바이더에만 연결된다(`nanobot/providers/langfuse.py`, `providers/openai_compat_provider.py:547-548`). `anthropic_provider.py`에는 langfuse 참조가 0건이다. OpenTelemetry는 찾지 못함.
- **usage 회계.** 모든 LLM 호출을 SQLite `llm_calls`(시작 시각, 소요, provider, model, source)에 기록하고(`nanobot/llm_usage/store.py:208-214`), source를 세션 키에서 유도해 chat/cron/dream/heartbeat를 구분한다(`nanobot/llm_usage/context.py:21`, `runner.py:279-281`).
- **로그.** loguru 구조화 로그에 `turn_id`/`session_key`를 바인딩하고 단계별 `duration_ms`를 남긴다(`loop.py:1902`, `1930-1947`). 세션 정책 `log_content=False`면 본문 대신 `[content hidden]`.

### 10. 규모 (LOC)

`wc -l` 기준, 테스트 제외.

| 조각                                                 | 파일                                                             |                        줄 |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------: |
| tool loop                                            | `nanobot/agent/runner.py`                                        |                     1,572 |
| 세션/버스/턴 오케스트레이션                          | `nanobot/agent/loop.py`                                          |                     2,663 |
| 컨텍스트 빌더                                        | `nanobot/agent/context.py`                                       |                       375 |
| 컨텍스트 거버넌스(압력 측정, 컴팩션, tool 결과 정리) | `nanobot/agent/context_governance.py`                            |                     1,080 |
| 메모리(store + archiver + consolidator)              | `nanobot/agent/memory.py`                                        |                     1,260 |
| Dream / idle 컴팩션                                  | `nanobot/agent/dream.py` / `autocompact.py`                      |                  67 / 145 |
| 서브에이전트                                         | `nanobot/agent/subagent.py` (+ `tools/subagent.py`)              |              1,067 (+147) |
| hook 인터페이스 / progress hook                      | `nanobot/agent/hook.py` / `progress_hook.py`                     |                 348 / 186 |
| 메시지 버스                                          | `nanobot/bus/queue.py` + `events.py` (디렉터리 전체)             |            160 + 82 (841) |
| tool base / registry / 실행                          | `tools/base.py` / `registry.py` / `execution.py`                 |           194 / 224 / 336 |
| MCP 클라이언트                                       | `tools/mcp.py` (+ `mcp_oauth.py`)                                |              1,740 (+889) |
| 세션 저장                                            | `session/sqlite_store.py` / `manager.py` / `state.py` (디렉터리) | 880 / 677 / 1,188 (6,516) |
| cron                                                 | `cron/service.py` (디렉터리)                                     |               923 (1,435) |
| heartbeat                                            | `cli/gateway_runtime.py` 안의 약 80줄 + `utils/evaluator.py`     |                       143 |
| 프로바이더                                           | `providers/base.py` / `anthropic_provider.py` (디렉터리)         |      1,735 / 868 (17,573) |

- 핵심 16개 파일 합계 11,986줄. `nanobot/agent` 전체 24,739줄(tool 제외 11,743 + tool 12,996).
- 전체 144,813줄 중 `channels` 32,391, `webui` 24,971, `providers` 17,573, `cli` 9,665.

### 지저분한 점 / 찾지 못한 것

- **"lightweight"는 과거형.** 루프 본문 `_run_core` 하나가 `runner.py:376-938`로 560줄이 넘고 중첩 클로저 5개를 품는다. `AgentLoop.__init__`은 인자가 30개 이상이다(`loop.py:277-311`). 대부분이 프로바이더 서버측 대화 상태(`ProviderConversationState`), 크래시 복구, WebUI 표시용 이력 때문에 생긴 두께로, Anthropic Messages API 하나만 쓰는 단일 사용자 앱에는 필요 없다.
- **heartbeat가 CLI 조립 파일의 클로저에 들어 있다**(`cli/gateway_runtime.py:609-716`). 설정 docstring도 "now backed by cron"이라고만 적혀 있어(`config/schema.py:396`) 별도 서비스였다가 흡수된 흔적이다. 프롬프트에 "nothing이면 'All clear.'만 답하라"는 지시와 LLM 평가 게이트가 겹쳐 있다(`gateway_runtime.py:220-226`).
- **레거시 이름이 남아 있다.** `Session.last_consolidated`를 `last_archived` 프로퍼티로 감쌌고(`session/manager.py:108-142`), `compact_idle_session`의 `max_suffix` 인자는 "accepted for SDK compatibility and no longer retains"(`memory.py:1196-1197`).
- **`read_only` 플래그가 권한 의미를 갖지 않는다.** 이름과 달리 병렬 실행 판정 전용이다. 읽기 전용 금융 tool을 전제로 하는 FinClaw는 이 플래그를 그대로 가져오되 "mutating이면 승인 필요" 게이트를 직접 붙여야 한다.
- **찾지 못함:** tool 실행 전 사용자 승인 흐름, 토큰/비용 기반 턴 예산, 현재 시각의 프롬프트 주입, sustained goal 연장 상한, 임베딩/벡터 검색, 에이전트 eval 하네스, Anthropic 경로의 tracing, prompt cache TTL 설정.
- **깊이 읽지 않은 부분:** `nanobot/webui/`(24,971줄), 개별 채널 런타임, `nanobot/session/state.py`(1,188줄), 자체 업데이트 모듈들(`nanobot/update_*.py`), `nanobot/triggers/`.

**교차 확인(상위 에이전트가 소스를 다시 열어 대조):** `nanobot/agent/runner.py:483-487` 의 while 조건, `nanobot/config/schema.py:191-193`(`max_tool_iterations = 200`, `max_concurrent_subagents = 4`, `max_tool_result_chars = 16_000`), `nanobot/bus/events.py:45-48` 의 세션 키, `nanobot/providers/anthropic_provider.py:540-572` 의 `_apply_cache_control`, `nanobot/agent/tools/base.py:96-109` 의 `read_only` / `concurrency_safe`, `nanobot/cli/gateway_runtime.py:229-250` 의 `_heartbeat_has_active_tasks`, `runner.py` 1,572줄 · `loop.py` 2,663줄 · `bus/queue.py` 160줄 — 모두 일치. 나머지 인용은 다시 열어보지 않았다.

## 6. What FinClaw should take

전제: FinClaw 는 단일 사용자, TypeScript/Node 22, SQLite, Anthropic Messages API(API key), 읽기 전용 금융 도구, 채널은 macOS 앱 + 선택적 Discord + cron 이다. 아래는 네 프로젝트의 코드를 읽고 내린 판단이고, FinClaw 코드는 이 조사에서 읽지 않았다. 줄 수 목표 같은 숫자는 추정이다.

### 6.0 먼저 물어볼 것: 루프를 직접 짤 필요가 있나

네 프로젝트가 루프를 직접 가진 이유는 대부분 다중 provider 다(OpenClaw `packages/ai` 39,044줄, nanobot `providers/` 17,573줄). FinClaw 는 Anthropic 하나만 쓴다. `@anthropic-ai/sdk` 에는 tool-call 루프를 대신 돌려 주는 beta Tool Runner(`client.beta.messages.toolRunner` + `betaZodTool`)가 있고, 서버측 compaction(`compact_20260112`, beta `compact-2026-01-12`, 기본 트리거 150K)과 tool result 정리(`clear_tool_uses_20250919`, beta `context-management-2025-06-27`)도 있다. OpenClaw 가 Anthropic 직결 경로에서 실제로 이 둘을 쓴다(2절 4항, `anthropic-payload-policy.ts:557-586`).

직접 짜는 루프가 정당한 경우는 아래 패턴 1, 2(부수효과 전 영속화, abort 시 합성 tool result, 실행 중 메시지 주입)를 Tool Runner 의 턴별 훅으로 표현하기 어려울 때다. 이건 FinClaw 쪽에서 프로토타입으로 확인해야 하고, 이 조사로는 답하지 못한다. 어느 쪽이든 아래 패턴은 "루프 바깥의 계약" 이라 그대로 적용된다.

### 6.1 가져갈 패턴 (네 프로젝트에서 반복되는 것)

**1. 순수 runner 와 제품 계층을 나눈다. 루프는 모델이 끝낸다.**

- 근거: OpenClaw `runLoop`(세션·채널을 모름, `emit` 콜백만 의존) vs embedded runner, nanobot `AgentRunner` vs `AgentLoop`, hermes 의 50줄 while + phase 함수, letta V1 `_decide_continuation`. 네 곳 모두 "tool call 이 없으면 종료" 가 유일한 정상 종료 조건이다.
- 가져갈 형태: `runTurn({ system, messages, tools, signal, emit })` 한 함수. 세션 로드, 저장, 채널 전달은 호출자가 한다. cron 과 (만든다면) sub-agent 도 같은 함수를 쓴다(nanobot 이 Dream·heartbeat·sub-agent 를 runner 하나로 돌리는 방식).
- 상한: 넷 중 셋이 기본 무제한인데, 긴 코딩 작업을 중간에 자르지 않으려는 선택이다(hermes 주석: "caps caused silent mid-task truncation"). 금융 질의 한 턴은 짧으니 FinClaw 는 유한 상한을 두는 편이 싸다. nanobot 방식이 가장 낫다: 상한 도달 시 tool 없이 한 번 더 호출해 지금까지 결과로 답하게 한다. 여기에 OpenClaw 의 동일 인자 반복 가드(3회에 노트, N회에 정지 — 110줄)를 더한다.

**2. Transcript 는 append-only SQLite 행이고, 부수효과보다 먼저 쓴다. tool_use/tool_result 짝은 어떤 종료 경로에서도 닫는다.**

- 근거: OpenClaw `transcript_events(session_id, seq)`, hermes 는 tool call 이 담긴 assistant 행을 도구 실행 전에 flush 하고 실패하면 도구를 실행하지 않는다, nanobot 은 user 메시지를 모델 호출 전에 저장한다, letta 로컬은 `messages.jsonl` append-only.
- abort/취소 시 네 곳 모두 합성 메시지로 짝을 맞춘다: OpenClaw 는 aborted assistant 메시지, hermes 는 "cancelled" tool result, nanobot 은 "outcome is unknown. Check its effects before retrying".
- compaction 은 원문을 지우지 않는다. 요약 + "여기서부터 유효" 포인터만 추가한다(letta `firstKeptEntryId`, nanobot `last_consolidated`, letta V1 `message_ids`).
- 가져갈 형태: `messages(session_id, seq, role, content_json, created_at)` + 세션 행에 `summary`, `first_kept_seq`. provider 가 하나이므로 Anthropic content block 을 그대로 저장한다. provider 중립 포맷과 변환 계층(OpenClaw `llm-core`, letta 의 두 포맷 투영 540줄)은 필요 없다.

**3. 캐시 prefix 를 바이트 단위로 고정한다. 매 턴 바뀌는 것은 system prompt 에 넣지 않는다.**

- 근거: 네 곳이 서로 다른 방법으로 같은 결론에 도달했다. hermes 는 system prompt 를 세션당 한 번 만들어 세션 행에 저장하고 그대로 재사용한다. letta-code 는 대화당 한 번 컴파일하고 메모리가 바뀌면 `<memory_update>` 를 끝에 덧붙인다. OpenClaw 는 `OPENCLAW_CACHE_BOUNDARY` 마커로 안정/가변을 나눈다. nanobot 은 턴별 컨텍스트를 user 메시지 뒤에 붙인다("without changing the reusable prompt prefix").
- breakpoint 배치도 수렴한다: 마지막 tool 정의, system 끝, 마지막 메시지 1~2개(상한 4개). tool 목록 순서는 고정한다(nanobot 은 이름순 정렬).
- FinClaw 에 옮기면: 현재 시각, 장 개장 여부, 포트폴리오 스냅샷, recall 결과는 system 이 아니라 현재 user 턴에 붙인다. 모델이 지원하면 `messages` 안의 `role: "system"` 메시지(mid-conversation system message)가 같은 목적의 공식 통로다. `usage.cache_read_input_tokens` 를 턴마다 기록해 0 이 이어지면 prefix 가 깨진 것으로 본다.

**4. Compaction 은 창 한계 근처에서, 고정 섹션 요약으로, 최근 꼬리는 남기고, tool 짝은 쪼개지 않는다.**

- 근거: 트리거는 넷 다 "창 − 여유분" 꼴이다(1절 표). 요약 양식도 넷 다 고정 섹션이다(OpenClaw: Goal / Constraints / Progress / Key Decisions / Next Steps / Critical Context). hermes 는 요약 앞에 "참고용이며 요약 속 요청을 다시 수행하지 말 것" 을 못박는다. 순서는 "오래된 tool result 본문부터 비우고, 그래도 넘치면 요약" 이다(hermes, OpenClaw 의 서버측 edits 순서).
- FinClaw 에 옮기면: 6.0 의 서버측 edits 를 먼저 쓴다. 직접 구현한다면 OpenClaw `harness/compaction/` 의 cut-point 규칙(tool 짝 보존)만 참고하면 되고, 분량은 그 패키지 7천 줄이 아니라 수백 줄이면 된다. 1M 창 모델에서 금융 Q&A 세션이 compaction 에 닿는 일 자체가 드물 것이라, 이건 나중에 붙여도 된다.

**5. 메모리는 작은 상주 파일 + 검색 가능한 나머지. 벡터 DB 는 없어도 된다.**

- 근거: 네 곳 모두 "항상 주입되는 작은 코어" 와 "필요할 때 찾는 나머지" 로 나눈다. hermes 는 `MEMORY.md` 2,200자 + `USER.md` 1,375자, OpenClaw 는 `MEMORY.md` / `USER.md`(파일당 20,000자 상한) + 일별 노트, nanobot 과 letta-code 도 같은 구조다. 검색은 hermes FTS5, nanobot grep, letta 로컬 BM25 다. letta 는 V1 의 벡터 archival memory 를 폐기 표시했고 후속작에서 파일 + 인덱스 탐색으로 갔다. 벡터 검색을 유지하는 곳은 OpenClaw 뿐이고 그 구현이 44,622줄이다.
- 작성자는 둘이다: 대화 중 모델의 명시적 도구 호출, 그리고 백그라운드 통합(OpenClaw dreaming, hermes 10턴 리뷰, nanobot Dream 2시간, letta reflection).
- 상주 메모리는 세션 시작 시 스냅샷으로 고정한다(hermes, letta-code). 턴 중 메모리를 고쳐도 system prompt 는 그대로 둔다 — 패턴 3 과 같은 이유다.
- 쓰기에는 게이트를 둔다: hermes 는 메모리가 system prompt 에 들어가 세션을 넘어 남는다는 이유로 injection 패턴을 스캔해 거부한다. nanobot 과 letta-code 는 git 으로 되돌릴 수 있게 한다.
- FinClaw 에 옮기면: 문자 수 상한이 있는 코어 메모리(사용자 프로필, 투자 성향, 관심 종목) + 기존 SQLite FTS 로 과거 대화 검색. 백그라운드 통합은 첫 버전에서 빼고 "명시적 도구 + compaction 직전 flush(OpenClaw `flush-plan.ts`)" 로 시작한다.

**6. 도구는 스키마 검증 → 실패는 tool result 로 반환 → 결과 크기 상한. read-only 플래그는 병렬성에 쓴다.**

- 근거: 검증 실패와 미지의 도구를 예외가 아니라 tool result 로 모델에 돌려준다(OpenClaw `Tool X not found`, nanobot "Did you mean" 힌트). 결과 상한은 nanobot 16,000자(초과분은 파일로 내리고 경로만 남김), hermes 100,000자, letta 5,000~30,000자다. 병렬 실행은 read-only 로 분류된 도구만 허용한다(hermes, letta-code, nanobot).
- 승인 엔진은 가져오지 않는다. 네 곳의 승인 로직은 전부 셸 실행을 겨냥하고(hermes `tools/approval*.py` 7,681줄, letta `permissions/` 6,953줄), FinClaw 에는 셸 도구가 없다. 대신 도구 정의에 `mutating: boolean` 한 필드만 두고, 사람이 없는 컨텍스트(cron, Discord)에서 `mutating` 도구는 기본 거부한다(hermes 의 sub-agent 자동 거부, letta headless 의 "Tool requires approval" 거부와 같은 규칙). 지금은 전부 read-only 이므로 이 필드는 병렬 실행 허용에만 쓰인다.
- 외부에서 온 tool result(뉴스, 웹)는 신뢰하지 않는 내용으로 표시한다(OpenClaw `resultContentSource: "network"`, hermes 의 `context` scope 스캔).

**7. 루프는 타입 있는 이벤트 하나만 내보내고, 채널 어댑터가 그것을 소비한다. 세션당 직렬.**

- 근거: OpenClaw 의 10종 `AgentEvent`, nanobot 의 frozen dataclass 이벤트, hermes 의 `message.delta` / `tool.start` / `tool.complete`, letta 의 `stream_delta` / `turn_finished`. 이름은 달라도 집합은 같다: 턴 시작, 텍스트 delta, tool 시작/종료, 턴 종료(usage, stop reason 포함), 오류.
- 메신저 채널에는 토큰 delta 를 보내지 않는다. OpenClaw 는 블록 단위 전송 또는 미리보기 메시지 편집(75ms 합치기), hermes 는 `edit_interval` 로 메시지 하나를 계속 편집한다. Discord 어댑터는 이 방식으로, macOS 앱은 delta 를 그대로 받는다.
- 세션 키마다 FIFO 하나(nanobot `SessionInbox`, OpenClaw session controller). 실행 중 들어온 메시지는 "다음 모델 호출 직전에 끼워 넣기" 또는 "끝난 뒤 다음 턴" 둘 중 하나만 고른다. OpenClaw 의 네 가지 큐 모드는 필요 없다.

**8. Cron 은 같은 프로세스의 스케줄러이고, 실행은 평범한 턴이며, 전달은 모델이 아니라 시스템이 한다.**

- 근거: 넷 다 in-process 스케줄러다. hermes 는 cron 프롬프트에 "send_message 쓰지 말 것, 보고할 게 없으면 `[SILENT]`" 를 붙이고 최종 응답을 시스템이 전달한다. nanobot 은 heartbeat 턴에서 `message` 도구의 직접 전송을 막고 별도 판정(`should_notify`, 실패 시 침묵)을 거친다. OpenClaw 는 `NO_REPLY`.
- LLM 호출 전에 값싼 사전 검사로 건너뛴다: nanobot 은 `HEARTBEAT.md` 에 활성 항목이 없으면 즉시 반환, hermes monitor 는 스크립트 출력 해시가 지난번과 같으면 에이전트를 실행하지 않는다. FinClaw 라면 "가격·공시가 임계값을 넘었는가" 를 코드로 먼저 보고, 넘었을 때만 모델을 부른다.
- 별도 heartbeat 서브시스템은 만들지 않는다. OpenClaw 와 nanobot 둘 다 heartbeat 를 cron job 으로 흡수했다.
- 재시작 시 밀린 job 을 한꺼번에 재실행하지 않는다(OpenClaw 는 재스케줄, letta 는 `missed` 기록).
- job 은 FinClaw 의 SQLite 에 둔다. hermes/letta/nanobot 의 `jobs.json` + 파일 락은 DB 가 없던 시절의 모양이다.

### 6.2 단일 사용자 앱에는 과한 것

| 과한 것                                                                 | 어디서 봤나                                                                           | 왜 빼도 되나                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 다중 provider 추상화, 모델 failover, auth profile 순환                  | OpenClaw `packages/ai` 39K, retry 예산 24~160회; hermes `auxiliary_client.py` 8,228줄 | provider 하나, key 하나. SDK 기본 재시도(2회)면 출발점으로 충분                                                   |
| 원격 프로토콜을 로컬에서 에뮬레이트                                     | letta-code local 백엔드 (tool call 마다 승인 왕복, 메시지 두 포맷)                    | 서버가 없다                                                                                                       |
| Gateway WebSocket 프로토콜, 다중 클라이언트 pairing, writer-claim fence | OpenClaw `src/gateway` 54만 줄                                                        | 프로세스 하나, 사용자 하나. 세션당 FIFO 로 충분                                                                   |
| 셸 승인 엔진, 샌드박스                                                  | hermes 7.7K, letta 6.9K, OpenClaw 3겹 정책                                            | 셸 도구가 없다                                                                                                    |
| Sub-agent                                                               | OpenClaw 46K, hermes 7.3K                                                             | 읽기 전용 금융 질의는 한 컨텍스트로 충분. 필요해지면 hermes 방식(깊이 1, 금지 도구 목록, 요약만 반환)이 가장 작다 |
| 벡터 메모리, 임베딩 캐시, dreaming 3단계                                | OpenClaw memory-core 44.6K                                                            | 패턴 5 로 대체. letta 가 버린 방향이다                                                                            |
| 플러그인 훅 체계, context engine 슬롯, Tool Search / Code Mode          | OpenClaw, hermes                                                                      | 도구 수십 개 이하, 확장 주체가 본인 하나                                                                          |
| 큐 모드 4종, 실행 중 steering 세분화                                    | OpenClaw `steer/followup/collect/interrupt`                                           | 하나만 고른다                                                                                                     |
| 4단계 checkpoint 크래시 복구                                            | nanobot `recovery.py`, hermes resumable sub-agent                                     | "부수효과 전 영속화 + 짝 닫기" 면 재시작 후 transcript 가 유효하다. 읽기 전용 도구는 재실행해도 안전하다          |
| 캐시 warmer / keep-alive                                                | hermes `prompt_cache_lifecycle/`                                                      | 1인 사용량에서는 TTL `1h` 설정 하나로 대신한다                                                                    |
| OpenTelemetry, trajectory 번들                                          | OpenClaw, letta V1                                                                    | nanobot 의 `llm_calls` 테이블(시작 시각, 소요, 모델, source = chat/cron) 하나 + usage/캐시 컬럼이면 된다          |
| `dmScope` 류 세션 키 체계                                               | OpenClaw                                                                              | `channel:chatId` (nanobot)                                                                                        |

### 6.3 네 프로젝트가 주지 못한 것

- **eval 은 스스로 만들어야 한다.** 저장소 안에 에이전트 품질 평가가 있는 곳은 OpenClaw(`qa/scenarios` YAML, 개인 비서용 10개 묶음)와 hermes(`evals/` probe 스크립트) 정도이고, letta 는 별도 저장소, nanobot 은 없다. OpenClaw 의 10개 시나리오 목록(리마인더 왕복, 선호 기억 회상, 비밀 미노출, 거부 시 정지, 가짜 진행 보고 금지)은 FinClaw fixture 테스트의 출발점으로 쓸 만하다.
- **수치·사실 검증 가드는 어디에도 없다.** 금융 비서에서 가장 중요한 "모델이 말한 숫자가 도구 결과에 있는 숫자인가" 는 네 프로젝트 모두 다루지 않는다. 참고할 선례가 없다.
- **비용 예산도 없다.** 넷 다 턴당 토큰·비용 상한이 없다. 필요하면 iteration 상한과 `usage` 누적으로 직접 건다.

### 6.4 규모 감각

- 가장 작은 nanobot 도 핵심 16개 파일이 11,986줄이고, 그 두께의 대부분은 provider 상태·크래시 복구·WebUI 이력 때문이다. OpenClaw 의 코어 루프 계층(`packages/agent-core/src/*.ts`)이 5,117줄이다.
- 위 8개 패턴을 Anthropic 전용, 단일 사용자로 좁히면 루프 + 도구 실행 + 저장 + 컨텍스트 조립 + cron 연결을 합쳐 1,500~2,500줄 TypeScript 로 들어갈 것으로 본다. 이건 측정이 아니라 추정이다.
- 네 프로젝트의 공통된 실패 양상은 "루프는 작게 시작했는데 예외 경로마다 파일이 하나씩 생겼다" 는 것이다(hermes `turn_*.py` 30여 개, OpenClaw `attempt-*.ts` 수십 개, letta 의 루프 4벌). 루프를 한 벌만 두고 채널·cron 이 모두 그것을 부르게 하는 것이 이를 피하는 가장 값싼 방법이다.
