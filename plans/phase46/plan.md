# Phase 46 계획 — 에이전트 코어 재설계 (AgentRuntime + stream-json 드라이버)

> 작성 2026-11-26 · base = main `01fbec2` (phase45 머지 + CONTRIBUTING) · 브랜치 `feature/phase46-agent-core` · 선행: `plans/phase46/kickoff.md`
> 상태: **확정 — /goal 자율 모드에서 메인이 게이트 1·2 를 대행 승인 (2026-11-26). 사용자 사후 검토 대상.** 뒤집을 수 있는 결정은 §9 에 모았다.
> 설계 기준선: `_workspace/feature-research/agent-core/20-comparison-and-recommendation.md`(이하 **[20]**) 추천을 그대로 채택. 파일:라인 근거는 `00-integration-contract.md`(**[00]**), 실측은 `10-scout-L4-local-experiments.md`(**[L4]**)·`05-driver-auth-facts.md`(**[05]**).
> 이 plan 이 [20] 을 바로잡은 사실 2개(코드 재확인): route_task `timeoutMs` 는 **이미 90s**(`skills-general/src/route-task.ts`, [20] 은 30s 로 기술) / Web·TUI 는 `chat.send` 요청을 **30s 클라이언트 타임아웃**으로 await 한다(`web/src/app-gateway.ts:177-182`, `tui/src/gateway-client.ts:153-158`) → §2 D9.

---

## 0. 목표와 경계

**목표:** 채널과 무관한 에이전트 런타임 1개 — `AgentRuntime.run(req) → AsyncIterable<AgentEvent>` — 로 Discord·Web/TUI·cron·`agent.run` 4 경로를 수렴시키고, 그 아래 격리 플래그를 강제하는 `claude -p` stream-json 드라이버를 둔다. = **"같은 sessionKey 의 2턴째가 1턴째를 기억하고, 2턴째에도 RAG 가 모델에 들어가며, Web 에서 토큰 단위 스트리밍 → 도구 진행 → 확정(end) 이 보이고, reset·abort 가 동작한다."** (§7 수동 스모크가 성공 기준.)

**경계:**

- **IN (phase46):** M1~M12 전부(§4). 드라이버·런타임·세션·컨텍스트 주입·서브에이전트 격리·스트림 이벤트·abort/reset RPC·Runner 체인 삭제·B4/B5/B6/B10/B11/B12·N1~N3/N5~N7·Discord 없이 부팅·문서.
- **OUT → phase47:** §8 목록(맥 캐릭터 클라이언트, alerts websocket·proactive, messageId 세그먼트, Discord 스트리밍 프리뷰, `search_memory`, 상주 프로세스, agent.run memory 훅 존폐 등).
- **OUT (영구/보류):** Agent SDK 드라이버(약관 C1), 네이티브 `--agents` 서브에이전트, AG-UI/ACP 프로토콜 채택, 새 도구 추가(도구 표면 불변), 이벤트버스 정리(phase45 이월 — 이번에 안 건드림), N8(레지스트리 전역 루프 감지).

**불변식 (깨면 안 됨 — 각 밀스톤 테스트로 고정):**

| #   | 불변식                               | phase46 에서의 구체 제약                                                                                                                                      |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | 구독 CLI 전용                        | 자식 env 에서 `ANTHROPIC_API_KEY` 삭제 유지. `--bare` 금지(OAuth 미로드). 새 npm 의존성 0                                                                     |
| I2  | read-only 도구, 매수는 사람          | 내장 도구는 어떤 경로로도 0(`--tools ""`) — 서브에이전트 포함. 도구 표면 = 현행 `get_current_datetime`·`route_task`·`list_alerts`·`get_alert_history`·`mcp:*` |
| I3  | 도구 실행은 `toolRegistry.execute`   | HTTP `/mcp` → bridge → registry 경로 유지. 드라이버가 도구를 직접 실행하는 분기 없음                                                                          |
| I4  | 명시 선언 기반 기억                  | capture 정규식 5종만. LLM 출력→memory 경로를 **새로** 만들지 않음(기존 agent.run 훅은 현 동작 유지, §9)                                                       |
| I5  | 인용 가능한 회상                     | `## 사용자 배경지식 (자동 주입)` 헤더·`[mem:<id6>]`/`[txn:…]` 마커·`extractCitedMemoryIds` 계약 유지                                                          |
| I6  | 1인 감사 가능 크기                   | 순감(§5 추정 −450~−600 LOC). 드라이버 seam = 실 구현 1 + 테스트 fake 1(함수 타입, 인터페이스 클래스 없음). 새 프레임워크·이벤트버스 금지                      |
| I7  | mock-only 단위 테스트                | 드라이버 fake / `node:child_process` spy. 실 CLI 는 `*.live.test.ts` → `pnpm test:live` 만                                                                    |
| I8  | 키 없이 부팅 + **Discord 없이 부팅** | 시세/뉴스 키 없음 → degrade(현행). `DISCORD_BOT_TOKEN` 없음 → Discord 만 비활성(M11)                                                                          |
| I9  | 시스템 프롬프트 = 정적               | 턴별 가변(시각·회상·거래·recap)은 user 메시지 앞 블록으로. snapshot 기본(on) 유지                                                                             |
| I10 | 커밋 규율                            | 밀스톤 = 1커밋, 단독 build·typecheck·test 통과, 삭제는 별도 커밋(M5), merge commit                                                                            |
| I11 | **정확히 1 종료**                    | 모든 run 은 `start` 이전 실패를 포함해 정확히 하나의 `done` 또는 `error` 로 끝난다(드라이버·런타임 각각 테스트)                                               |

---

## 1. ★ 확정 아키텍처 — B: `claude -p` stream-json 턴당 spawn + AgentRuntime 수렴

### 1-1. 현재 → 목표

**현재 (실측, [00] §2-1):**

```
Discord ─▶ MessageRouter ─▶ pipeline(capture·retrieval) ─▶ execution-adapter.execute ─┐
Web/TUI ─▶ gateway chat.send ─▶ execution-adapter.executeForTui (RAG 없음) ──────────┤
cron    ─▶ scheduler.runOne ─▶ runnerFactory().execute ──────────────────────────────┼─▶ Runner ─▶ CliProviderAdapter
agent.run RPC ─▶ runnerFactory().execute ────────────────────────────────────────────┘      │ 이력 "User:/Assistant:" 직렬화
route_task ─▶ dispatch ─▶ runSubAgent ─▶ runCliAgent(DEFAULT backend: --dangerously-skip-permissions) ◀── N1
                                                                                             ▼
                                  전역 #cliSessionId 로 --resume (모든 경로 공유) ◀── B1
                                  --output-format json 단일 blob, Runner 는 done 미발행 ◀── B3
                                  설정·CLAUDE.md·훅 미차단, 레포 cwd, --append-system-prompt ◀── N2 (~12K tok 누수)
```

**목표:**

```mermaid
flowchart LR
  D[Discord] --> MR[MessageRouter] --> PL["pipeline<br/>normalize·command·ack·deliver"]
  W[Web/TUI] --> CH["gateway chat.send<br/>(즉시 runId 반환)"]
  C[cron] --> SC[scheduler.runOne]
  AR[agent.run RPC] --> AG[agent.ts]
  PL & CH & SC & AG -->|"AgentRunPort.run(req)"| RT
  subgraph server
    RT["AgentRuntime<br/>① per-session lane ② 전역 lane(2)<br/>③ 세션 바인딩·6h 회전·recap<br/>④ prepareTurn: capture·retrieval·시각<br/>⑤ agent_runs 1행 + conversations upsert"]
  end
  RT -->|"AgentDriver(req)"| DRV
  subgraph agent
    DRV["cli-driver<br/>격리 argv 강제 · readline NDJSON<br/>워치독 · SIGINT→2s→SIGKILL"]
  end
  DRV -->|spawn| CLI["claude -p stream-json"]
  CLI -->|"HTTP /mcp (per-run JWT)"| MCP["gateway mcp host/bridge"] --> REG["toolRegistry.execute"]
  REG -->|route_task| DSP[dispatch] -->|"driver 1-shot<br/>MCP 없음 · 도구 0"| DRV
  RT -.AgentEvent.-> CH -.->|"chat.stream.delta/tool/end/error"| W
  RT -.done.text.-> PL
```

### 1-2. "현대적인 에이전트 아키텍처" 구성요소 ↔ FinClaw

| 구성요소                    | FinClaw 에서 무엇인가                                                                                                                                        | 위치 (phase46 후)                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| **Agent loop**              | `claude` CLI 자신의 ReAct 루프(추론→도구→추론). FinClaw 는 루프를 구현하지 않고 1턴 = 1 spawn 으로 구동. `--max-turns 10` 이 상한                            | CLI (`agent/src/runtime/cli-driver.ts` 가 spawn)                          |
| **Tools**                   | MCP 도구. FinClaw ToolRegistry(Zod·9단계 정책·루프 감지·타임아웃·result-guard)를 HTTP `/mcp` 로 노출. 내장 도구 0                                            | `gateway/src/mcp/{host,bridge}.ts` → `agent/src/agents/tools/registry.ts` |
| **Sessions**                | sessionKey(채널·대화) → CLI session uuid. `conversations.metadata.{cliSessionId,lastTurnAt}`. `--session-id` 선지정 → `--resume`, 6h 유휴 시 새 세션 + recap | `server/src/agent-runtime/runtime.ts`                                     |
| **Context injection**       | 매 턴 user 메시지 앞 `<recent_conversation>`(recap) + `<context>`(시각·회상 `[mem:]`·거래 `[txn:]`). 시스템 프롬프트는 정적                                  | `server/src/agent-runtime/prepare-turn.ts`                                |
| **Memory**                  | capture(사용자 선언 정규식 5종) + retrieval(hybrid vector+FTS, rerank) — 기존 서비스 재사용, Web/TUI 에도 적용                                               | `server/src/auto-reply/stages/memory-{capture,retrieval}.ts` (import)     |
| **Sub-agents**              | `route_task` 도구 안의 동기 1-shot(결정적 뉴스 fetch → 고정 프롬프트 → JSON). MCP 없음·도구 0·비영속. 네이티브 `--agents` 비채택                             | `server/src/router/{dispatch,sub-agent}.ts`                               |
| **Guardrails**              | 드라이버가 강제하는 격리 플래그(§3-6) + read-only 도구 표면 + registry 정책·result-guard 마스킹 + `--allowedTools 'mcp__finclaw__*'`                         | `cli-driver.ts` argv 빌더, registry                                       |
| **Streaming events**        | `AgentEvent`(start·text_delta·tool_use·tool_result·done·error) → WS `chat.stream.{delta,tool,end,error}`(모두 runId), 정확히 1 종료                          | `agent/src/runtime/types.ts`, `gateway/src/broadcaster.ts`                |
| **Audit**                   | run 당 `agent_runs` 1행(id=runId, tool_calls_json, used_memory_ids, cli_session_id, usage, error, traceId) + conversations transcript(원문 + done.text)      | runtime                                                                   |
| **Proactive runs**          | cron = `mode:'oneShot'` 비영속 run → delivery(Discord DM / WS `schedule.completed`). 결정적 stagger(B5). alerts websocket 은 phase47                         | `server/src/automation/scheduler.ts`                                      |
| **Control (abort / reset)** | `chat.abort` → per-run AbortController → SIGINT→2s→SIGKILL. `chat.reset`·`/reset` → per-session lane 경유 대화 행 삭제                                       | `gateway/src/rpc/methods/chat.ts`, runtime                                |

### 1-3. 왜 이 선택인가 (조사 근거)

- **드라이버 B 채택.** Agent SDK(A)는 문서가 "Use the API key authentication methods" 를 전제하고 1인 자기 구독 예외가 없다 → C1 차단([05] §근거1). 전송 계층도 같다(SDK 가 같은 바이너리를 subprocess 로 돈다) → 잃는 기능 없음. 상주 프로세스(B')는 프로세스 레지스트리·재시작 감지 +200~300 LOC(I6)·fake 복잡(C13)이고 이득은 첫 토큰 지연 하나 → phase47 G6 측정값으로 재검토([20] §2-1).
- **세션 S2(6h 유휴 회전 + recap) 채택.** 영구 resume 은 30일 transcript 스윕·1M 모델 ~967K 전 compaction 없음·유휴 후 uncached 재읽기로 구독 한도 소모([L3] Q1). 6h 는 1h 캐시 TTL 뒤라 회전으로 잃는 캐시가 없다. L2 는 "연속성 우선, 리셋 기본 off" 반대 — 근거인 cc-connect 30분 리셋에는 맞지만 6h + recap + RAG 에는 약함([20] §2-2). 임계 0 = stateless(S3) 폴백이 상수 1개.
- **서브에이전트 = route_task 안 동기 1-shot.** 네이티브 `--agents` 는 비동기 백그라운드라 첫 `result` 뒤 두 번째 `system:init`+`result` 가 나와 "한 입력 = 한 done"(B3 계약)을 깨고, 내장 `general-purpose` 가 숨겨지지 않는다([L4] §4 실측).
- **기각:** AG-UI/Vercel UI stream/ACP(상호운용 상대 없음 — 어휘 runId·toolCallId 와 "종료 1회"·"취소 응답 = 정해진 종료 신호" 규칙만 차용), SessionStart 훅 주입(`--setting-sources ""` 와 충돌), transcript 사전 확인(slug 규칙 internal, 2.1.223+ resume 이 모든 project 를 뒤짐), supersede(직렬이 감사에 유리), `--fork-session`/`--max-budget-usd`/`--fallback-model`(용도 없음).

### 1-4. 검증된 전제 vs 남은 go/no-go

| #   | 전제                                                                                 | 상태                                                                                                             |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| G1  | 격리: `--setting-sources ""` 등으로 사용자 CLAUDE.md·훅·플러그인·스킬 차단           | **통과(실측)** [L4] §8 — 플러그인 builtin 4·스킬 0·훅 0·지침 누수 0. `CLAUDE_CONFIG_DIR` 불필요                  |
| G5  | `--max-turns` 수용                                                                   | **통과(실측)** [L4] §8 — `--max-turns 3` 에러 없이 동작(help 에는 없음)                                          |
| —   | `--session-id` 선지정·`--resume` 회상·snapshot·tool_use/tool_result 위치             | **통과(실측)** [05] 실측2                                                                                        |
| —   | resume 실패 형태 / SIGINT 동작 / HTTP MCP 요청 순서·DELETE 없음 / stdin pipe 3s 대기 | **통과(실측)** [L4] §1·§6·§3·§2                                                                                  |
| G2  | 도구를 쓴 턴의 `result.result` = 마지막 assistant 텍스트, 비어 있지 않음             | 구현 중 확인 — §7 스모크 2단계. no-go 시 드라이버가 마지막 `assistant` 의 text 블록을 모아 done.text 생성(+10줄) |
| G3  | SIGINT 후 2s 안 exit + `pgrep -f "claude -p"` 고아 0                                 | 구현 중 확인 — M1 live. no-go 시 `detached:true` + `process.kill(-pid)`                                          |
| G4  | resume 실패 형태 재현(픽스처와 일치)                                                 | 구현 중 확인 — M1 live. 다르면 정규식 조정, 불안정하면 회전 임계 0(S3)                                           |
| G5b | `--autocompact 200000`·`--permission-prompts none` 값 수용                           | 구현 중 확인 — M1 live. 거부된 플래그만 argv 에서 뺌(비차단)                                                     |
| G6  | resume 턴 첫 `text_delta` 까지 p50                                                   | 측정만(비차단) — M1 live 로그 → review. phase47 상주 프로세스 판단 근거                                          |
| G7  | init `mcp_servers.finclaw.status = connected`, 도구 ctx `sessionId` = sessionKey     | 구현 중 확인 — §7 스모크. 미연결이면 `error{mcp_unavailable}` 경로 확인, identity 없으면 N3 미해결로 M2 재작업   |

> G1 이 통과했으므로 **phase46 중단 조건(C4 차단)은 해소**됐다. 남은 go/no-go 는 모두 폴백이 1~10줄 단위다.

---

## 2. 확정 결정

### 2-1. Q1~Q14 ([20] §4 그대로 채택 — synthesizer 수정분 포함)

| Q                | 결정                                                                                                                                                               | 근거 한 줄                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Q1 드라이버      | **B** `claude -p --output-format stream-json` 턴당 spawn                                                                                                           | §1-3                                                             |
| 서브에이전트     | 네이티브 비채택, route_task 안 동기 1-shot                                                                                                                         | [L4] §4                                                          |
| Q2 agent.run     | **유지**, `mode:'oneShot'` 으로 얇게 재배선, memory 훅(`attachMemoryService`) **현 동작 유지**. 제품 결정 변경 아님(§9)                                            | README:128 이 기능으로 문서화. I4 충돌은 review 리스크 + phase47 |
| Q3 resume 실패   | `session_not_found` 패턴에서만 새 세션 + recap **1회** 재시도. 그 외 에러는 재시도 없음. transcript 사전 확인 비채택                                               | telegram "모든 예외 재시도" 함정                                 |
| 세션 회전        | 유휴 **6h** → 새 세션 + recap. `--autocompact 200000`                                                                                                              | §1-3                                                             |
| 세션 id          | runtime 이 uuid **선지정**(`--session-id`)                                                                                                                         | 회전을 정하는 쪽이 id 도 정함                                    |
| Q4 cron          | 1-shot 비영속(`--no-session-persistence`), recall 없음(시각만)                                                                                                     | 동시 resume 유실 + OpenClaw cron 기본 fresh                      |
| Q5 Web/TUI       | RAG·capture 적용(N6), sessionKey `tui:{userId}:{agentId}` 공유 유지, run 경계는 runId                                                                              | 채널 무관 런타임                                                 |
| Q6 도구 이벤트   | `chat.stream.tool {sessionId, runId, toolCallId, name, phase, isError?}` — 입력/결과 내용 미포함. runId IN, **messageId OUT**                                      | 병렬 도구 짝짓기, 정본은 done.text                               |
| 취소             | phase46 IN. **SIGINT → 2s → SIGKILL**, exit 를 await 한 뒤 lane 해제                                                                                               | [L4] §6 (SIGTERM 은 result 를 안 남김)                           |
| Q7 동시 상한     | 전역 **2**, **최상위 run 만**. 서브에이전트 1-shot 은 상한 밖(드라이버 직접 호출)                                                                                  | 포함 시 교착(메인 2개가 슬롯 쥐고 서브 대기)                     |
| Q8               | 해당 없음(B 라 `/mcp` 유지)                                                                                                                                        | —                                                                |
| Q9 최종 텍스트   | `done.text` = `result.result` 정본. **Web/TUI 는 end 에서 버퍼를 `result.text` 로 교체** → 화면 = 저장본 = Discord                                                 | 서술 말풍선 보존은 phase47 UX                                    |
| Q10 Discord 에러 | reason → 고정 한국어 문구(§3-8). raw message 미전송. `aborted` 는 무응답                                                                                           | credential 섞임 위험                                             |
| Q11 B6           | `127.0.0.1` 기본(+`GATEWAY_HOST`), CORS 명시, secret 랜덤 생성·0600 영속, **로컬 토큰 파일 IN, B10 IN**                                                            | 랜덤 secret 이면 사용자가 토큰을 만들 수 없음                    |
| Q12 cwd·config   | cwd `~/.finclaw/agent`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CONFIG_DIR` 비채택                                                                            | G1 통과, `cleanupPeriodDays` 미설정(이미 기본 30일)              |
| Q13 타임아웃     | **메인 무출력 120s / overall 300s > route_task 90s(현행 유지) > 서브 무출력 45s / overall 75s**. `chat.ts` 60s 삭제. 서브 spawn 에 registry `ctx.abortSignal` 연결 | 도구가 도는 동안 메인 stdout 은 조용                             |
| Q14 chat.reset   | IN. **per-session lane 경유** 삭제                                                                                                                                 | 진행 중 run 의 종료 기록이 reset 을 무효화하는 경쟁 차단         |
| Discord 선택화   | IN (M11)                                                                                                                                                           | phase47 맥 앱 전제                                               |
| alerts websocket | **phase47**                                                                                                                                                        | phase46 에 소비자 없음                                           |
| 버그 흡수        | B1/B3/B4/B5/B6/B10/B11/B12/N1/N2/N3/N5/N6/N7 IN, N8 OUT                                                                                                            | [00] §6, [20] §4                                                 |

### 2-2. [20] §7 미결 11개 — 해소

| #   | 항목                                     | 결정 (확정 값)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 근거                                                                                                                                                      |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | runId 발급                               | `AgentRunRequest.runId?` — 호출자가 주면 그 값, 없으면 runtime 이 `randomUUID()`. **agent_runs 행은 done/error 를 yield 하기 직전에 1행**(start 시 행 생성 안 함). `AddAgentRunInput.id?: string` 추가(`storage/agent-runs.ts:37` 은 `input.id ?? randomUUID()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 현행 패턴(종료 시 1행). yield 전 기록이라 소비자(scheduler)가 runId 로 후속 UPDATE 가능                                                                   |
| D2  | 서브에이전트 abort 전파                  | `types/src/router.ts` `Dispatcher = (req: RouteRequest, signal?: AbortSignal) => Promise<RouteResult>`. `route-task.ts` executor 가 `ctx.abortSignal`(registry 가 timeout·외부 abort 를 합친 signal, `registry.ts:256-266`)을 넘기고, `dispatchMarketAnalysis` → `runSubAgent` → 드라이버 `signal` 로 연결                                                                                                                                                                                                                                                                                                                                                                                                                    | 지금은 registry timeout 뒤에도 opus spawn 이 계속 돈다                                                                                                    |
| D3  | 클라이언트의 미지 notification           | **변경 불필요.** Web `app-chat.ts:65-96`·TUI `App.tsx:64-95` 모두 `switch(method)` 에 default 없음 → `chat.stream.tool` 은 무시됨. M4 는 end 처리만 수정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 코드 확인                                                                                                                                                 |
| D4  | prepareTurn 위치                         | `packages/server/src/agent-runtime/prepare-turn.ts`. `stages/memory-capture.ts`(`memoryCaptureStage`, `MemoryCaptureService`)·`stages/memory-retrieval.ts`(`MemoryRetrievalService`, `formatBackgroundSection`)를 **import 재사용, 파일 이동 없음**. pipeline 의 capture(Stage 2.5)·retrieval(Stage 4.5) 호출과 rerank 감사 로그는 prepareTurn 으로 이동. `stages/context.ts` 는 **유지**(채널 capabilities 확장에 여전히 사용). 캡처 꼬리표는 `done.captured` → `enrichedCtx.capturedMemory` → `deliver.ts:40-46` 그대로                                                                                                                                                                                                     | 이동은 diff 만 키움. context.ts 는 사용처가 남음                                                                                                          |
| D5  | 에러 reason 타입                         | **`AgentErrorReason` 신설**(`agent/src/runtime/types.ts`). `CliFailoverReason`·`CliFailoverError` 는 M5 에서 삭제하고 `classifyCliError` 반환 타입을 `Extract<AgentErrorReason, 'auth' \| 'rate_limit' \| 'timeout' \| 'unknown'>` 로 교체. session_not_found 판정은 드라이버 내 정규식 1개                                                                                                                                                                                                                                                                                                                                                                                                                                   | 둘 중 하나만(I6). `CliFailoverError` 의 유일 사용처는 삭제 대상 `runner.ts`                                                                               |
| D6  | 동시성 구현                              | 기존 `infra` `ConcurrencyLane` 재사용, 새 lock 코드 0: **전역** `new ConcurrencyLane({maxConcurrent: 2, maxQueueSize: 20, waitTimeoutMs: 300_000})` key `'agent'` / **per-session** `new ConcurrencyLane({maxConcurrent: 1, maxQueueSize: 20, waitTimeoutMs: 600_000})` key = sessionKey(`mode:'chat'` 만 — oneShot 키는 run 마다 고유). 획득 순서 session → 전역. `queue.ts`(`enqueueCliRun`)는 M5 에서 삭제(유일 사용처 runner.ts). Runner 용 `ConcurrencyLaneManager`(`composition/providers.ts:46`)는 M5 삭제. **유지:** `scheduleLane`(1), `agentRunLane`(1, agent.run 현 동작), MessageRouter 자체 lane(Discord 채널 관심사). lane 대기 실패(`LANE_TIMEOUT`/`LANE_QUEUE_FULL`) → `error{reason:'timeout'}`              | 기존 lane 이 key 별 상한 + 대기 타임아웃을 이미 제공                                                                                                      |
| D7  | B6 CORS·토큰                             | host `process.env.GATEWAY_HOST ?? '127.0.0.1'`(Dockerfile·compose 는 `GATEWAY_HOST=0.0.0.0`). CORS origins `['http://localhost:5173', 'http://127.0.0.1:5173']`(vite dev/preview 포트; WS 는 vite proxy 경유라 CORS 무관). secret = `GATEWAY_JWT_SECRET` env 우선, 없으면 `~/.finclaw/gateway.secret`(32바이트 hex, 0600, 최초 1회 생성·영속). 로컬 토큰 = 부팅마다 `signToken({sub:'local', exp: now+30일})` → `~/.finclaw/gateway.token`(0600) 재기록. TUI(`cli/commands/tui.ts`)·CLI(`cli/gateway-client.ts`)는 config `gateway.auth.token` → 없으면 토큰 파일. **Web URL·토큰은 로그에 출력하지 않음** — README 에 `?token=$(cat ~/.finclaw/gateway.token)` 안내. 구현 파일 `server/src/composition/local-auth.ts`(~40줄) | `sessionTtlMs` 30분은 로컬 토큰에 짧음 → 30일. 토큰을 로그에 남기면 credential 이 로그로 샘                                                               |
| D8  | 수치 (전부 코드 상수, config 키 없음)    | 회전 6h · recap 최근 6 메시지 × 500자 · `<recent_conversation>`+`<context>` 합계 6,000자(초과 시 recap 을 오래된 것부터 버림 — 배경지식은 이미 `MAX_INJECTED_MEMORIES 3`·`SYMBOL_TX_LIMIT 3` 로 상한) · 메인 무출력 120s / overall 300s · 서브 무출력 45s / overall 75s · route_task 90s(현행) · abort SIGINT→2s→SIGKILL · MCP 유휴 TTL 10분 · `--max-turns 10`(메인만) · `--autocompact 200000`(메인 chat 만) · 전역 상한 2 · transcript 보관 최근 40 메시지                                                                                                                                                                                                                                                                 | [20] §7-8 기본값. transcript 40 = 현행(이력 20 + 새 2 로 잘라 저장, `execution-adapter.ts:101,127`)과 같은 규모로 둠                                      |
| D9  | conversations 저장 시점 / chat.send 응답 | `mode:'chat'` 만, **run 종료 시 1회 upsert**: messages = 기존 + `{user: 원문}` + (done 이면 `{assistant: done.text}`), 최근 40 으로 trim. metadata `{cliSessionId, lastTurnAt}` 는 `start` 를 받았을 때만 갱신(spawn 실패 시 이전 바인딩 유지). error/abort 턴도 원문은 남기고 assistant 는 생략. 세션 id 를 선지정하므로 start 시점 중간 저장 불필요(서버가 run 도중 죽으면 다음 턴이 새 세션 + recap — 안전). **`chat.send` 는 run 을 백그라운드로 시작하고 즉시 `{runId}` 반환**                                                                                                                                                                                                                                           | 클라이언트 30s 요청 타임아웃(위 헤더) 때문에 300s run 을 await 하면 정상 응답도 "Request timeout" 으로 표시됨. 클라이언트는 응답값을 쓰지 않음(grep 확인) |
| D10 | `agent.test.ts` 재작성 범위              | `packages/gateway/src/rpc/methods/agent.test.ts`(455줄) → port fake 로 다음 **10 케이스**: registration 3 methods · agent.list · agent.status ×2(변경 없음) · agent.run: unknown agentId 거부 · `stream:true` 거부 · fake done → output·runId·tokenUsage 반환 + stats 갱신 · fake error → lastError 기록 + throw · done 이면 `attach({agentRunId: done.runId, sessionKey})` 호출 / error 면 미호출 · attach 실패 swallow · `agentRunLane` 직렬화. **삭제:** agent_runs 행 기록 단언 3건·db 미주입 케이스(기록은 runtime 소관 → `runtime.test.ts` 가 담당)                                                                                                                                                                     | 기록 책임이 runtime 으로 이동                                                                                                                             |
| D11 | go/no-go 기록 위치                       | `plans/phase46/review.md` §검증에 **"G1~G7 표"**(항목·결과·측정값·폴백 적용 여부). G1·G5 는 [L4] §8 인용, G3/G4/G5b/G6 는 M1 `cli-driver.live.test.ts` 출력, G2/G7 은 §7 스모크 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | phase40 관행                                                                                                                                              |

**구현 중 확정 (실측 필요, 판정 기준 명시):**

- **G5b 플래그 값** — M1 live 에서 `--autocompact 200000`·`--permission-prompts none` 각각 단독으로 붙여 `result.subtype === 'success'` 면 유지, CLI 가 인자 에러로 exit≠0 이면 argv 에서 제거하고 review 기록.
- **G2 done.text** — 스모크 2단계(도구 1회 이상 쓴 턴)에서 `done.text` 가 비었거나 마지막 assistant text 블록과 다르면 폴백(+10줄) 적용.
- **G3 고아** — M1 live 에서 SIGINT 후 2.5s 시점 `pgrep -f "claude -p"` 결과가 비어 있지 않으면 `detached` + 그룹 kill 로 전환.

---

## 3. 타입 / 인터페이스 확정안

### 3-1. agent 패키지 — `packages/agent/src/runtime/types.ts` (신규)

```ts
import type { AgentId, SessionKey } from '@finclaw/types';

export type AgentErrorReason =
  | 'aborted'
  | 'timeout' // 무출력/overall 워치독, lane 대기 실패
  | 'auth'
  | 'rate_limit' // rate_limit_event.status === 'rejected' 일 때만
  | 'max_turns' // result.subtype === 'error_max_turns'
  | 'session_not_found' // runtime 이 잡아 1회 재시도. 재시도도 실패할 때만 바깥으로 나감
  | 'mcp_unavailable' // init.mcp_servers 의 finclaw.status !== 'connected'
  | 'spawn' // ENOENT 등 프로세스 시작 실패
  | 'unknown';

export interface AgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type AgentEvent =
  | {
      readonly type: 'start';
      readonly runId: string;
      readonly cliSessionId: string;
      readonly model: string;
    }
  | { readonly type: 'text_delta'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: 'tool_result'; readonly id: string; readonly isError: boolean }
  | {
      readonly type: 'done';
      readonly runId: string;
      readonly cliSessionId: string;
      readonly text: string; // result.result (G2)
      readonly usage: AgentUsage;
      readonly costUsd?: number; // total_cost_usd (클라이언트 추정치)
      readonly durationMs: number;
      readonly numTurns: number;
      // ↓ runtime 이 덧붙임
      readonly usedMemoryIds?: readonly string[];
      readonly captured?: {
        readonly memoryId: string;
        readonly type: 'fact' | 'preference';
        readonly content: string;
        readonly duplicate: boolean;
      };
    }
  | {
      readonly type: 'error';
      readonly runId: string;
      readonly reason: AgentErrorReason;
      readonly message: string; // 드라이버가 만든 짧은 요약. raw stderr 는 로그에만
      readonly usage?: AgentUsage;
    };

export interface DriverRequest {
  readonly runId: string;
  readonly prompt: string; // 조립 완료된 user 메시지 (argv 로 전달)
  readonly systemPrompt: string; // 정적. --system-prompt (교체)
  readonly model: string;
  readonly session:
    | { readonly kind: 'new'; readonly id: string } // --session-id
    | { readonly kind: 'resume'; readonly id: string } // --resume
    | { readonly kind: 'none' }; // --no-session-persistence (1-shot)
  readonly mcp?: { readonly url: string; readonly token: string }; // 없으면 MCP 없음 (서브에이전트)
  readonly maxTurns?: number; // 메인만 10
  readonly autocompact?: boolean; // 메인 chat 만 true → --autocompact 200000
  readonly idleTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly signal: AbortSignal;
}

/** 실 구현 1(createCliDriver) + 테스트 fake 1(async generator). 인터페이스 클래스 없음 (I6). */
export type AgentDriver = (req: DriverRequest) => AsyncIterable<AgentEvent>;

export interface AgentRunRequest {
  readonly sessionKey: SessionKey;
  readonly agentId: AgentId;
  readonly input: string; // 사용자 원문 (컨텍스트 블록 제외)
  readonly mode: 'chat' | 'oneShot'; // chat: 세션 resume + capture·retrieval / oneShot: 비영속, <context> 는 시각만 (cron·agent.run)
  readonly model?: string; // 없으면 runtime 기본 (TUI chat.start 모델 선택 유지)
  readonly runId?: string; // D1
  readonly signal: AbortSignal;
}

/** gateway 가 import 하는 DIP 포트 (ChatExecutionPort 대체). 구현 = server AgentRuntime 1개. */
export interface AgentRunPort {
  run(req: AgentRunRequest): AsyncIterable<AgentEvent>;
  /** per-session lane 경유 conversations 행 삭제. 삭제했으면 true. */
  reset(sessionKey: SessionKey): Promise<boolean>;
}
```

- 드라이버 생성: `createCliDriver({ command, cwd, logger }): AgentDriver` (`agent/src/runtime/cli-driver.ts`). `command` = config `cliBackend.command ?? 'claude'`, `cwd` = `~/.finclaw/agent`(생성 시 `mkdirSync recursive`).
- 원천 이벤트 → AgentEvent 매핑은 같은 파일의 순수 함수 `mapStreamEvent(raw, state)` 로 분리(픽스처 테스트 대상). 무시: `system:status`·`system:thinking_tokens`·`system:compact_boundary`·`system:api_retry`(로그만)·`rate_limit_event`(status≠rejected)·`stream_event` 중 text_delta 외·모르는 type·JSON 파싱 실패 줄(raw 는 로그 금지, 길이만).
- 종료 규칙: `result` 를 받은 뒤에도 stdout EOF 까지 읽고 exit 를 await. abort 후 도착한 delta 는 버리고 마지막 이벤트를 드라이버가 `error{aborted}` 로 확정. `result` 없이 EOF → `error{unknown}`. session_not_found = `subtype === 'error_during_execution' && num_turns === 0 && /no conversation found/i` (stderr 또는 `errors[]`).

### 3-2. server — `packages/server/src/agent-runtime/runtime.ts` (신규)

```ts
export interface AgentRuntimeDeps {
  readonly driver: AgentDriver;
  readonly storage: StorageAdapter; // getConversation / upsertConversation / deleteConversation
  readonly db: DatabaseSync; // addAgentRun
  readonly systemPrompt: string;
  readonly defaultModel: string;
  readonly mcp: { readonly url: string; readonly mintToken: (sessionKey: SessionKey) => string }; // N3: per-run JWT {sub:'finclaw', sessionId: sessionKey}
  readonly capture?: MemoryCaptureService;
  readonly retrieval?: MemoryRetrievalService;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly tracer?: { getCurrentContext(): { traceId: string; spanId: string } | undefined }; // agent_runs.trace_id
  readonly logger: FinClawLogger;
  readonly now?: () => number; // 테스트용 시계
}
export class AgentRuntime implements AgentRunPort {
  run(req: AgentRunRequest): AsyncIterable<AgentEvent>;
  reset(sessionKey: SessionKey): Promise<boolean>;
  abortAll(): void; // lifecycle 종료 훅 — 진행 중 run 의 내부 controller 일괄 abort
}
```

run 순서: ① (chat) per-session lane → 전역 lane ② (chat) metadata 조회 → `resume` / 6h 초과·없음 → `new`(+recap) ③ `prepareTurn` ④ `driver(req)` 이벤트 패스스루, tool_use/tool_result 수집, `start` 수신 플래그 ⑤ session_not_found 면 새 uuid + recap 으로 1회 재시도(그 시도의 이벤트만 바깥으로) ⑥ done 에 `usedMemoryIds`(`extractCitedMemoryIds` 를 `execution-adapter.ts:47-69` 에서 이 파일로 이동)·`captured` 부착 ⑦ agent_runs 1행 + (chat) conversations upsert ⑧ 종료 이벤트 yield ⑨ lane 해제(finally, 드라이버 exit 이후).

### 3-3. 세션 메타데이터 (`conversations.metadata`, 마이그레이션 0)

```ts
// conversations 행 PK = sessionKey. upsertConversation 이 metadata 를 받으면 덮어씀 (tables/conversations.ts:197-200)
interface CliSessionBinding {
  readonly cliSessionId: string; // uuid (runtime 선지정)
  readonly lastTurnAt: number; // epoch ms, start 를 받은 run 의 종료 시각
}
```

`/reset`·`chat.reset` = 행 삭제 → 메시지(CASCADE)와 바인딩이 함께 사라짐 → 다음 턴 `new`(recap 없음). `agent_runs.cli_session_id` 는 run 단위 감사로 채움.

### 3-4. 컨텍스트 블록 (prepareTurn 출력 = DriverRequest.prompt)

```
<recent_conversation>          ← new 세션이고 직전 메시지가 있을 때만 (회전·session_not_found 재시도)
사용자: …(500자 cut)
FinClaw: …
</recent_conversation>

<context>
현재 시각: 2026-11-26T10:00:00+09:00 (Asia/Seoul)
## 사용자 배경지식 (자동 주입)       ← formatBackgroundSection 그대로 (chat 만, 빈 섹션은 생략)
- [fact] … [mem:ab12cd]
## 최근 거래 (AAPL)
- … [txn:AAPL:173210]
</context>

{사용자 원문}
```

recap 은 conversations 원문(user 원문 + done.text)에서 만든다 → 회상 블록이 재주입되는 순환 없음. conversations 에는 원문만 저장.

### 3-5. route_task 계약 변경

`types/src/router.ts`: `export type Dispatcher = (req: RouteRequest, signal?: AbortSignal) => Promise<RouteResult>;` — `skills-general/src/route-task.ts` executor 가 `(input, ctx)` 의 `ctx.abortSignal` 전달. `server/src/router/sub-agent.ts`: `runSubAgent(driver, req, signal)` — `session:{kind:'none'}`, `mcp` 없음, idle 45s / overall 75s, `done.text` 반환·`error` 면 throw. `DispatcherDeps.driver: AgentDriver` 추가. `skills-finance/.../market-analysis.ts:12,82` 의 `timeoutMs` 는 dispatch 가 더 읽지 않으므로 고아 → 제거.

### 3-6. 격리 argv (드라이버가 무조건 조립, 호출자가 끌 수 없음)

```
claude -p <prompt>
  --output-format stream-json --verbose --include-partial-messages
  --tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands
  --system-prompt <정적> --model <model> --permission-prompts none   (G5b)
  session new    → --session-id <uuid>      resume → --resume <uuid>      none → --no-session-persistence
  mcp 있음       → --mcp-config '{"mcpServers":{"finclaw":{"type":"http","url":…,"headers":{"Authorization":"Bearer <jwt>"}}}}' --allowedTools 'mcp__finclaw__*'
  maxTurns       → --max-turns 10           autocompact → --autocompact 200000   (G5b)
spawn: stdio ['ignore','pipe','pipe'], detached 아님, cwd ~/.finclaw/agent
env:   process.env 복사 후 ANTHROPIC_API_KEY 삭제 + CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
금지:  --dangerously-skip-permissions (N1) · --bare · --append-system-prompt (N2)
```

### 3-7. gateway notification payload (`types/src/notification.ts`)

```ts
export interface ChatStreamDeltaParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly delta: string;
} // 150ms 배치 유지
export interface ChatStreamToolParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly phase: 'start' | 'end';
  readonly isError?: boolean; // end 만
}
export interface ChatStreamEndParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly result: {
    readonly text: string;
    readonly usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
    readonly costUsd?: number;
  };
}
export interface ChatStreamErrorParams {
  readonly sessionId: string;
  readonly runId: string;
  readonly error: string;
  readonly reason: string;
}
```

`tool_use` → `phase:'start'`, `tool_result` → `phase:'end'`(name 은 tool_use 에서 기억한 값). `start` 는 WS 로 보내지 않음.

### 3-8. RPC (`gateway/src/rpc/methods/chat.ts`, zod 인라인 — 기존 chat.start/send 패턴)

| method       | params                                              | result               | 동작                                                                                                                                                                                           |
| ------------ | --------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.send`  | `{sessionId, message, idempotencyKey?}` (변경 없음) | `{runId}` (**즉시**) | per-run `AbortController` 를 `activeRuns: Map<sessionId, {runId, controller}>` 에 넣고 `for await (ev of port.run(...)) broadcaster.send(...)` 를 백그라운드 실행. WS 끊김으로 abort 하지 않음 |
| `chat.abort` | `{sessionId: string, runId?: string}`               | `{aborted: boolean}` | 활성 run 이 있고 (runId 가 없거나 일치)면 abort → 종료 신호는 기존 `chat.stream.error{reason:'aborted'}` 1회(ACP 규칙)                                                                         |
| `chat.reset` | `{sessionId: string}`                               | `{reset: boolean}`   | `port.reset(session.sessionKey)` (per-session lane 경유)                                                                                                                                       |

authLevel 전부 `'token'`.

**Discord 고정 문구 (Q10, `stages/execute.ts` 또는 pipeline):** auth → "Claude 로그인이 필요합니다. 서버에서 `claude login` 을 실행해 주세요." / rate_limit → "Claude 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요." / timeout → "응답 시간이 초과되었습니다. 질문을 나눠서 다시 시도해 주세요." / aborted → 전송 안 함 / 그 외 → "응답 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."

---

## 4. 마일스톤 (각 = format·lint·typecheck·build·test green + 1커밋, ASCII subject, scope `phase46`)

의존: **M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9**, M10·M11 독립(M5 이후 권장 — 충돌 최소), M12 마지막. M3 와 M4 는 옛 Runner 경로가 살아 있는 상태에서도 green 이어야 한다(두 경로 공존 → M5 에서 옛 경로 삭제).

### M1 — 드라이버 seam (go/no-go 스파이크)

- **목적:** stream-json 드라이버를 배선 없이 추가하고, 남은 go/no-go(G3·G4·G5b·G6)를 실측.
- **파일:** CREATE `packages/agent/src/runtime/{types.ts, cli-driver.ts}` · CREATE `packages/agent/test/runtime/cli-driver.test.ts` · CREATE `packages/agent/test/runtime/fixtures/{text-only,tool-call,resume-not-found,sigint-abort,rate-limit-allowed,unknown-types}.ndjson` · CREATE `packages/agent/test/runtime/cli-driver.live.test.ts` · EDIT `packages/agent/src/index.ts`(runtime export 추가, 기존 export 유지).
- **구현 노트:** §3-1·§3-6. `node:readline` + `stdout.setEncoding('utf8')`(B11). 픽스처는 [05] "stream-json 이벤트"·[L4] §1·§3·§6·§7 의 실제 shape 로 작성(가공 금지 — 필드명·중첩 그대로). 워치독: 줄 수신마다 idle 타이머 재설정, overall 타이머 별도, 둘 다 abort 경로 재사용(reason `timeout`).
- **검증:** `pnpm vitest run packages/agent/test/runtime/cli-driver.test.ts` — 케이스: argv 에 격리 플래그 전부 존재·`--dangerously-skip-permissions`/`--append-system-prompt`/`--bare` 부재 · session 3종 · mcp 유무 · env 에 `ANTHROPIC_API_KEY` 없음 · 픽스처별 이벤트 시퀀스 · 정확히 1 종료(픽스처 6종 + spawn ENOENT + EOF without result) · abort → SIGINT, 2s 후 SIGKILL(가짜 타이머) · idle/overall timeout · rate_limit_event allowed 무시 / rejected → `error{rate_limit}` · init `mcp_servers` 미연결 → `error{mcp_unavailable}` · 한글 멀티바이트가 청크 경계에서 안 깨짐. live(`pnpm test:live`, 수동): G3·G4·G5b·G6 출력.
- **커밋:** `feat(phase46): add stream-json CLI driver behind AgentDriver seam`

### M2 — AgentRuntime

- **목적:** 세션·컨텍스트·동시성·감사를 소유하는 runtime(배선 없음).
- **파일:** CREATE `packages/server/src/agent-runtime/{runtime.ts, prepare-turn.ts, runtime.test.ts, prepare-turn.test.ts}` · EDIT `packages/storage/src/agent-runs.ts`(`AddAgentRunInput.id?`) + 해당 storage 테스트 1케이스.
- **구현 노트:** §3-2~§3-4, D1·D6·D8·D9. `extractCitedMemoryIds` 는 이 밀스톤에선 import 재사용(이동은 M5 — execution-adapter 가 아직 살아 있음). 전역/세션 lane 은 생성자에서 1회 생성. `abortAll()` 은 run 별 내부 controller 를 `AbortSignal.any([req.signal, internal])` 로 묶어 구현.
- **검증:** `pnpm vitest run packages/server/src/agent-runtime` — 첫 턴 `new`+바인딩 저장 · 2턴째 `resume` + prompt 에 `<context>`·배경지식 포함(**B1 회귀 테스트**) · 6h 경과 → `new` + `<recent_conversation>` · session_not_found → 1회 재시도, 다른 reason 은 재시도 0 · 정확히 1 종료(드라이버 throw / lane timeout / abort) · 같은 sessionKey 직렬화 · 전역 상한 2(3번째 대기) · agent_runs 1행(id=runId, tool_calls_json, used_memory_ids, cli_session_id) 이 종료 이벤트 yield 전에 존재 · oneShot: 바인딩 조회/저장 0, `session.kind==='none'`, `<context>` 시각만 · reset 이 진행 중 run 뒤에 실행되어 바인딩이 되살아나지 않음 · per-run JWT 의 `sessionId` = sessionKey. prepare-turn: 블록 형식·빈 섹션 생략·6,000자 상한 시 recap 앞쪽부터 버림·500자 cut. `pnpm test:storage`.
- **커밋:** `feat(phase46): add AgentRuntime with per-session CLI sessions`

### M3 — Discord·서브에이전트를 runtime 으로

- **파일:** EDIT `packages/server/src/auto-reply/{pipeline.ts, stages/execute.ts}`(capture·retrieval 단계 제거, execute 가 `runtime.run({mode:'chat'})` 를 끝까지 소비해 done.text → control token 처리, `done.captured` → `capturedMemory`) · EDIT `packages/server/prompts/finclaw.system.ko.md`(규칙 6 을 "user 메시지 앞 `<context>` 블록의 '사용자 배경지식 (자동 주입)'" 으로, + "가장 최근 `<context>` 가 정본" 1줄) · EDIT `packages/server/src/router/{sub-agent.ts, dispatch.ts}` · EDIT `packages/types/src/router.ts` · EDIT `packages/skills-general/src/route-task.ts` · EDIT `packages/skills-finance/src/news/analysis/market-analysis.ts`(timeoutMs 고아 제거) · EDIT `packages/server/src/composition/{runtime.ts, skills.ts}`·`main.ts`(driver·runtime 조립, `DispatcherDeps.driver`, 부팅 시 `claude --version` 1회 로그 — 실패는 warn, lifecycle 에 `runtime.abortAll`).
- **검증:** pipeline 테스트를 runtime fake 로 갱신(control token NO_REPLY/disclaimer·capture 꼬리표 유지) · **sub-agent argv 에 `--tools ""` 존재 + MCP 없음 + `--no-session-persistence` 단언(N1)** · route_task abort → 서브 드라이버 signal aborted(D2) · 기존 dispatch 테스트 green.
- **커밋:** `refactor(phase46): route Discord and sub-agent through AgentRuntime`

### M4 — chat·scheduler·agent.run 을 runtime 으로

- **파일:** EDIT `packages/gateway/src/rpc/methods/chat.ts`(D9 즉시 `{runId}`, `CHAT_SEND_TIMEOUT_MS` 삭제, `activeRuns` 맵) · EDIT `packages/gateway/src/broadcaster.ts`(AgentEvent 입력, delta/end/error 에 runId, error 에 reason) · EDIT `packages/types/src/notification.ts`(delta/end/error 필드) · EDIT `packages/gateway/src/server.ts`(deps 타입 `AgentRunPort`) · EDIT `packages/server/src/automation/scheduler.ts`(`runtime.run({mode:'oneShot', sessionKey:'schedule-{id}-{uuid}'})`, 중복 `addAgentRun` 2곳 삭제, done/error 의 runId 로 `schedule_id` UPDATE·`markScheduleRun`) · EDIT `packages/gateway/src/rpc/methods/agent.ts`(port oneShot 소비, `params.timeoutMs` → `AbortSignal.timeout`, `persistAgentRunAndAttach` → attach 만 — 고아가 된 `db` dep·import 제거, `agentRunLane` 유지) · EDIT `packages/gateway/src/rpc/methods/agent.test.ts`(D10) · EDIT `packages/web/src/app-chat.ts`·`packages/tui/src/App.tsx`(end 에서 버퍼를 `result.text` 로 교체) · EDIT `packages/server/src/main.ts`/`composition/*`(gateway·scheduler 에 runtime 주입).
- **검증:** chat 테스트 — send 가 run 종료 전 `{runId}` 반환 · fake 스트림이 delta(runId)→end(result.text) 로 브로드캐스트 · 연결 없음이어도 run 완료. broadcaster 테스트 갱신. scheduler 테스트 — agent_runs 1행만(중복 0)·schedule_id 연결·실패 backoff 유지. agent.test.ts 10 케이스. web/tui: end 시 `result.text` 로 확정(기존 컴포넌트 테스트 있으면 갱신).
- **커밋:** `refactor(phase46): route chat, scheduler and agent.run through AgentRuntime`

### M5 — 옛 실행 체인 삭제 (삭제만, 단독 커밋)

- **삭제 전 재검증:** 각 심볼 `rg "\bSYMBOL\b" packages/*/src` 로 비-self·비-test 소비처 0 확인(phase44 원칙). 소비처가 나오면 삭제 보류 + review 기록.
- **파일:** §5 삭제 목록 전부 + EDIT `packages/agent/src/index.ts`(옛 export 제거) · `packages/agent/src/providers/claude-cli/errors.ts`(D5) · `packages/types/src/agent.ts`(`AgentRunParams` 삭제) · `packages/server/src/composition/providers.ts`(CliProviderAdapter·LaneManager 제거 — toolRegistry 생성만 남으면 유지) · `packages/server/src/composition/runtime.ts`(runnerFactory 제거) · `packages/config/src/zod-schema.ts` + `config.example.json5`(`cliBackend.timeoutMs`·`cliBackend.watchdog` 키 제거, `command` 유지) · `extractCitedMemoryIds` 를 runtime.ts 로 이동.
- **검증:** 전체 게이트 + `pnpm test:storage`. `rg "Runner|CliProviderAdapter|runCliAgent|ChatExecutionPort|StreamEvent\b|executeForTui"` 프로덕션 0.
- **커밋:** `refactor(phase46): remove Runner and provider adapter chain`

### M6 — 도구 이벤트 + chat.abort / chat.reset

- **파일:** EDIT `packages/gateway/src/broadcaster.ts`(tool_use/tool_result → `chat.stream.tool`) · `packages/types/src/notification.ts`(`ChatStreamToolParams`) · `packages/gateway/src/rpc/methods/chat.ts`(`chat.abort`·`chat.reset`) + 테스트. 클라이언트 변경 없음(D3).
- **검증:** tool start/end 짝(toolCallId·isError) · abort → `chat.stream.error{reason:'aborted'}` 정확히 1회 + `{aborted:true}` · runId 불일치 → `{aborted:false}` · reset → port.reset 호출.
- **커밋:** `feat(phase46): stream tool events and add chat.abort and chat.reset`

### M7 — 명령 응답 + Discord 실행 에러 전달 (B4, Q10)

- **파일:** EDIT `packages/server/src/auto-reply/stages/command.ts`(executor 결과를 `CommandStageResult` 로 반환) · `pipeline.ts`(`channel.send`) · `stages/execute.ts`(error → §3-8 고정 문구 전송) + 테스트.
- **검증:** `!finclaw help/status/reset` 응답 전송 · reason 별 문구 · aborted 무응답 · raw message 미포함.
- **커밋:** `fix(phase46): reply to commands and report run errors on Discord`

### M8 — 결정적 cron stagger (B5)

- **파일:** EDIT `packages/server/src/automation/{scheduler.ts, stagger.ts}` — tick 의 `Math.random` skip 삭제, `computeNextRunAt` 결과에 `hash(schedule.id) % staggerMs` 오프셋을 더하는 단일 지점.
- **검증:** 같은 id → 같은 오프셋 · 정각 cron 이 매시 실행됨(가짜 시계) · stagger 0 이면 오프셋 0.
- **커밋:** `fix(phase46): make cron stagger deterministic`

### M9 — MCP 유휴 세션 만료 (B12)

- **파일:** EDIT `packages/gateway/src/mcp/host.ts` — transports 맵 값을 `{transport, lastSeenAt}` 로, 요청마다 갱신, 새 initialize 때 10분 넘게 유휴인 항목 `close()` + 삭제(lazy sweep, 타이머 없음).
- **검증:** 가짜 시계로 10분 경과 transport 정리 · 활성 transport 유지.
- **커밋:** `fix(phase46): expire idle MCP sessions`

### M10 — loopback 바인딩 + 로컬 인증 토큰 (B6, B10)

- **파일:** CREATE `packages/server/src/composition/local-auth.ts`(secret 해석·생성, 토큰 발급·기록, `readLocalToken()`) · EDIT `packages/server/src/composition/constants.ts`(host·CORS·secret 을 import 시점 평가에서 부팅 시 해석으로) · `main.ts` · `cli/gateway-client.ts`(`Authorization: Bearer`) · `cli/commands/tui.ts` · `Dockerfile`·`docker-compose.yml`(`GATEWAY_HOST=0.0.0.0`) · `.env.example`(`GATEWAY_HOST`).
- **검증:** secret 파일 0600·재부팅 시 재사용·env 우선 · 토큰 파일 0600·검증 통과 · gateway-client 헤더 · host 기본 127.0.0.1. (테스트는 `HOME` tmpdir — `test-env.ts:51`.)
- **커밋:** `fix(phase46): bind gateway to loopback and issue local auth token`

### M11 — Discord 없이 부팅 (I8)

- **파일:** EDIT `packages/server/src/main.ts`(`DISCORD_BOT_TOKEN` optional — 없으면 `discord.disabled` warn, adapter setup·`channelPluginRegistry.set`·onMessage 생략) · `composition/skills.ts`(`discordClient?`) · `main.test.ts`.
- **검증:** 토큰 없이 main 부팅 테스트 — gateway·scheduler 기동, Discord 미등록. 토큰 있으면 기존 동작.
- **커밋:** `feat(phase46): boot without Discord token`

### M12 — 문서 동기화

- **파일:** `README.md`(:10·57·92·122·128·191·207-235 시퀀스 다이어그램·245·260·273·341·431·447 — stream-json·AgentRuntime·세션·`chat.stream.tool`·`chat.abort/reset`·127.0.0.1·토큰 파일·Web `?token=` 안내·Discord 선택) · `.env.example`(`DISCORD_BOT_TOKEN` 선택 표기) · `.claude/agents/runtime-tools-auditor.md`(:3·17 의 `packages/agent/src/execution/runner.ts` → `packages/agent/src/runtime/cli-driver.ts` + `packages/server/src/agent-runtime/`) · 그 외 `.claude/agents/*.md`·`.claude/skills/*/references/*.md` 중 삭제 파일을 가리키는 곳(`rg "execution/runner|execution-adapter|providers/claude-cli/(runner|adapter|spawn|parsers)"`) · 시스템 프롬프트는 M3 에서 이미 수정.
- **검증:** `pnpm format`·위 rg 결과 0(문서 포함, `plans/`·`_workspace/` 제외).
- **커밋:** `docs(phase46): sync README, env and agent docs with agent runtime`

---

## 5. 삭제 목록 · LOC 순증감 (추정, `wc -l` 기준)

**삭제 (M5, 프로덕션):**

| 파일                                                                                                         | LOC        |
| ------------------------------------------------------------------------------------------------------------ | ---------- |
| `packages/agent/src/execution/{runner,streaming,chat-execution-port,message-utils,index}.ts`                 | −199       |
| `packages/agent/src/providers/adapter.ts`                                                                    | −20        |
| `packages/agent/src/providers/claude-cli/{adapter,runner,parsers,spawn,backends,types,reliability,queue}.ts` | −633       |
| `packages/agent/src/models/provider-normalize.ts`                                                            | −18        |
| `packages/agent/src/providers/claude-cli/errors.ts` (CliFailoverError/Reason)                                | −25        |
| `packages/server/src/auto-reply/execution-adapter.ts` (extractCitedMemoryIds 23줄은 이동)                    | −232       |
| 소계                                                                                                         | **−1,127** |

**삭제 (테스트):** `packages/agent/test/runner.test.ts`(135) · `packages/agent/test/providers/claude-cli/{adapter,backends,parsers,queue,queue-override,reliability,runner,spawn,runner.live}.test.ts`(521) → **−656**, + execution-adapter 테스트(있으면).

**수정 감소 (M3·M4):** pipeline/execute −40 · scheduler −20 · agent.ts −60 · chat.ts −10 · sub-agent/dispatch −15 · composition −20 → **약 −165**.

**추가:** agent `runtime/types.ts` +90 · `cli-driver.ts` +230 · server `agent-runtime/runtime.ts` +200 · `prepare-turn.ts` +70 · `local-auth.ts` +40 · gateway chat abort/reset/activeRuns +45 · broadcaster +20 · host TTL +20 · notification +15 · B4/B5/I8/Q10 +60 · 기타(storage id·router signal·web/tui) +20 → **약 +810**.

**프로덕션 순증감 ≈ −1,290 + 810 ≈ −480 LOC** (범위 −450~−600, [20] §3-1 의 −550 과 같은 범위. agent.run 유지라 −330 은 미실현). 테스트는 −656 / +~700(픽스처 포함)로 대략 균형.

---

## 6. 리스크 · 완화 · 되돌리기

| #   | 리스크                                                                                       | 완화 / 폴백                                                                                                                                                                                           | 되돌리기                                                                |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| R1  | **stream-json 스키마 drift** — 공개 스키마 없음, CLI 자동 업데이트, 미문서 type 이 이미 섞임 | 아는 type 만 처리·나머지 무시. 실측 shape 픽스처 단위 테스트. 부팅 시 `claude --version` 로그. CLI 업그레이드 후 `pnpm test:live` 1회. "정확히 1 종료" 가 최후 방어(done 없이 EOF → `error{unknown}`) | 픽스처 갱신 + 매퍼 수정 (파일 1개)                                      |
| R2  | **격리 누수** (G1 회귀 — CLI 업데이트로 `--setting-sources ""` 의미 변경)                    | G1 통과(실측). live 테스트에 init `tools`/`plugins`/훅 이벤트 단언 1개 상시 유지                                                                                                                      | `CLAUDE_CONFIG_DIR=~/.finclaw/claude` + `claude setup-token`            |
| R3  | **동시성 교착·경쟁** — 상한 × 서브에이전트, reset vs 진행 중 종료 기록, exit 전 lane 해제    | 상한은 최상위 run 만(서브는 드라이버 직접). reset 은 같은 lane(D6). lane 해제는 드라이버 exit await 이후. runtime 테스트 3종으로 고정                                                                 | 전역 상한 1 로 낮추기(상수)                                             |
| R4  | **구독 한도 소모** — 턴당 부팅 + resume 재읽기 + recap + cron                                | 회전 6h · `--autocompact 200000` · 상한 2 · agent_runs usage 기록 · rejected 일 때만 `error{rate_limit}`                                                                                              | 회전 임계 0(S3, 상수 1개)                                               |
| R5  | **범위 과다** — 7 패키지 + 클라이언트, 4 진입점 이전                                         | 밀스톤마다 단독 green, 옛 경로는 M5 까지 공존, 삭제는 단독 커밋                                                                                                                                       | M5 `git revert` 1커밋으로 옛 체인 복구 가능(M3·M4 는 그 위에서도 green) |
| R6  | **I4 휴면 경로** — agent.run 의 LLM 출력→'financial' memory 가 다음 채팅 배경지식으로 주입   | 현 동작 유지(클라이언트 0 → 휴면). review 리스크 기록 + phase47 제품 결정 항목(§8, §9)                                                                                                                | —                                                                       |
| R7  | **chat.send 의미 변화**(즉시 반환) — 다른 클라이언트가 완료를 응답으로 기대                  | 레포 내 클라이언트는 응답값 미사용(grep). Web 의 큐는 end/error 로 진행. 서버 per-session 직렬화로 중복 전송도 안전                                                                                   | await 로 되돌리기(chat.ts 수 줄)                                        |
| R8  | **Docker 바인딩** — 127.0.0.1 기본이면 컨테이너 포트 publish 불가                            | Dockerfile·compose 에 `GATEWAY_HOST=0.0.0.0` (M10)                                                                                                                                                    | env 1줄                                                                 |
| R9  | **live 테스트 환경** — `test-env.ts` 가 `HOME` 을 tmpdir 로 바꿈 → CLI 인증·cwd 영향         | 기존 `runner.live.test.ts` 가 같은 조건에서 동작해 온 것을 근거로 유지. 실패하면 live 파일에서 실제 HOME 을 드라이버 cwd 에만 사용                                                                    | —                                                                       |
| R10 | `result.result` 가 도구 턴에서 마지막 텍스트가 아닐 가능성(G2)                               | 스모크에서 판정, 폴백 +10줄                                                                                                                                                                           | —                                                                       |

소셜/외부 신호를 새로 붙이지 않으므로 환각 리스크는 기존 경로 그대로다. 오히려 N2(개발 지침 12K 주입) 제거와 2턴째 RAG 복구로 "도구로 확인하고 인용한다" 규칙이 실제로 지켜질 조건이 생긴다.

---

## 7. 테스트 전략 · 수동 검증

**단위 (mock-only, `pnpm test`):** 드라이버 = `node:child_process` spawn spy + 픽스처 NDJSON 스트림(가짜 child: PassThrough stdout/stderr + emit exit). runtime·pipeline·chat·scheduler·agent.ts = fake `AgentDriver`/`AgentRunPort`(async generator). 시계는 `now` 주입·`vi.useFakeTimers`. storage 는 `pnpm test:storage`.

**live (`pnpm test:live`, 수동·CI 제외):** `packages/agent/test/runtime/cli-driver.live.test.ts` — `describe.skipIf(!claudeAvailable)`, haiku. G3(SIGINT→exit≤2s·고아 0), G4(없는 uuid resume → session_not_found), G5b(플래그 값 수용), G6(resume 턴 첫 delta 지연 로그), 격리 단언(init tools `[]`·plugins builtin 만).

**밀스톤 게이트:** `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test` (+ storage 를 건드리면 `pnpm test:storage`). PR 전 `pnpm test:ci`.

**수동 스모크 (M12 후, 실 CLI — 결과를 review.md §검증에):**

1. **Discord 없이 부팅** — `unset DISCORD_BOT_TOKEN; pnpm build && node packages/server/dist/main.js` → 로그 `discord.disabled`·`cli.version`·gateway `127.0.0.1:3000`, `ls -l ~/.finclaw/gateway.{secret,token}` = `-rw-------`.
2. **gateway chat 스트리밍** — `pnpm --filter @finclaw/web dev` → `http://localhost:5173/?token=$(cat ~/.finclaw/gateway.token)` → "애플 주가 알려줘": delta 가 점진 표시 → (devtools WS) `chat.stream.tool` start/end(`route_task`) → `chat.stream.end` 로 확정. **G2:** end 의 `result.text` 비어 있지 않음. **G7:** 서버 로그 init `mcp_servers` connected, `agent_runs` 최신 행 `tool_calls_json` 에 `route_task`, 도구 ctx `sessionId` = `tui:local:default`.
3. **2턴째 기억** — "내 이름은 자두야" → "내 이름이 뭐지?" → "자두". 두 run 의 `agent_runs.cli_session_id` 동일. "기억해: 나는 배당주를 선호해" → 다음 턴 "내 투자 선호 알려줘" 응답에 `[mem:…]` 인용 + 해당 run `used_memory_ids` 채워짐(**B1·N5·N6 해소 확인**).
4. **reset** — WS 로 `chat.reset {sessionId}` → `{reset:true}` → "내 이름이 뭐지?" → 모름(이름은 capture 패턴 아님), 새 `cli_session_id`.
5. **abort** — 긴 질문("주요 빅테크 5개 종합 분석") 전송 직후 `chat.abort {sessionId}` → `{aborted:true}`, 2s 안 `chat.stream.error{reason:'aborted'}` 1회, `pgrep -fl "claude -p"` 비어 있음(G3 재확인).
6. (보너스) `finclaw tui` 가 토큰 파일로 접속 · `finclaw agent list` 가 인증 헤더로 성공(B10) · `schedule.triggerNow` 로 cron 1회 → agent_runs 1행.

WS 수동 호출(4·5)은 `ws` 패키지(gateway 의존성)로 쓴 일회성 `node -e` 스크립트 — 레포에 커밋하지 않음.

---

## 8. phase47 로 넘기는 것

- **맥 캐릭터 클라이언트**(사용자 목표 1) — 이 plan 의 `AgentRunPort`·`chat.stream.*`·토큰 파일 위에 붙는다.
- alerts websocket 핸들러 + `alert.triggered` 기본 구독, `<context>` 의 "최근 알림" 섹션, proactive 알림 UX.
- `messageId` 세그먼트(도구 사이 서술 말풍선 보존) — Q9 의 "end 에서 교체" 재검토.
- Discord 편집 스트리밍 프리뷰.
- read-only `search_memory` 도구.
- 상주 stream-json 프로세스(B') — G6 측정값 근거.
- `CLAUDE_CONFIG_DIR` 전용 dir (G1 회귀 시 또는 보존 기간 변경 시).
- **agent.run RPC 의 LLM 출력→memory 훅 존폐**(I4) 제품 결정.
- 리포트형 cron 의 직전 output 연속성(DB 에서 꺼내 prompt 에 넣기).
- `/status` "지원 채널" 을 실제 등록 기준으로, Discord `/reset` 을 `runtime.reset` 으로 통일, N8, 이벤트버스 정리(phase45 이월), 플러그인 `mcp:*` `require-approval` 실효화(phase45 이월).

---

## 9. 사용자 사후 검토 대상 결정 (자율 모드 — 뒤집을 수 있음)

| #   | 결정                                                                                                                                                                                             | 뒤집으면                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| S1  | 드라이버 = `claude -p` (Agent SDK 기각, 약관 C1)                                                                                                                                                 | 문서에 1인 구독 예외가 생기면 드라이버 파일 1개 교체                    |
| S2  | **agent.run RPC 유지 + LLM 출력→memory 훅 현 동작 유지** — 제품 결정 변경 아님, 얇은 재배선만                                                                                                    | 삭제 시 ~−330 LOC + I4 충돌 해소 (phase47 결정 항목)                    |
| S3  | 세션 6h 유휴 회전 + recap (L2 는 영구 연속성 선호)                                                                                                                                               | 상수 1개 — 0 이면 stateless, 큰 값이면 사실상 영구                      |
| S4  | 네이티브 서브에이전트 비채택, route_task 1-shot 유지                                                                                                                                             | —                                                                       |
| S5  | Web/TUI 는 end 에서 스트림 버퍼를 최종 텍스트로 **교체**(중간 서술 사라짐)                                                                                                                       | phase47 messageId 세그먼트                                              |
| S6  | Discord 실행 에러 = 고정 한국어 문구(원문 미전송), abort 는 무응답                                                                                                                               | 문구 표 수정                                                            |
| S7  | gateway 기본 `127.0.0.1`, CORS 5173 2개, secret 파일 자동 생성, 토큰 파일 30일 — **Web 은 `?token=$(cat ~/.finclaw/gateway.token)` 로 접속, TUI 기본 sessionKey 가 `tui:local:default` 로 바뀜** | `GATEWAY_HOST`·`GATEWAY_JWT_SECRET`·config `gateway.auth.token` 로 덮기 |
| S8  | `chat.send` 가 완료를 기다리지 않고 즉시 `{runId}` 반환                                                                                                                                          | await 로 복귀(클라이언트 30s 타임아웃 문제 재발)                        |
| S9  | WS 연결이 끊겨도 run 은 끝까지 돌아 저장됨                                                                                                                                                       | 끊김 시 abort                                                           |
| S10 | cron·agent.run 은 1-shot(직전 대화 없음), `<context>` 에 현재 시각만 주입(agent.run 도 시각이 새로 붙음)                                                                                         | schedule 별 영속 세션                                                   |
| S11 | 전역 동시 실행 2, 서브에이전트는 상한 밖                                                                                                                                                         | 상수                                                                    |
| S12 | config `cliBackend.timeoutMs`·`cliBackend.watchdog` 키 제거 → 사용자 config 에 남아 있으면 부팅 거부(strict)                                                                                     | 키를 무시 처리로 남기기                                                 |
| S13 | conversations transcript 최근 40 메시지 보관(현행 ~22 와 같은 규모)                                                                                                                              | 상수                                                                    |
| S14 | 도구 결과 내용은 이벤트·감사에 싣지 않음(tool_calls_json = id·name·input·isError)                                                                                                                | phase47 캐릭터 UI 가 필요하면 `tool_result.content` 추가                |
| S15 | per-run JWT 에 `runId` 미포함 — 도구 ctx 엔 sessionKey 만([20] 안에서 축소, 소비자 0)                                                                                                            | 클레임 1개 추가                                                         |

---

## 10. 컨벤션

- **테스트 baseline (phase45 review §2):** unit **960 pass** (134 files) · storage **140 pass** (22 files). phase46 종료 시 회귀 0 + 신규(드라이버·runtime·prepare-turn·chat abort/reset·B4/B5/B12/M10/M11) 추가, 삭제된 Runner/claude-cli 테스트만큼 감소 — 순수치는 review 에 기록.
- **mock-only:** 단위 테스트에서 실 CLI·실 네트워크 금지. 실 CLI 는 `*.live.test.ts` 만. NDJSON 픽스처는 실측 shape 그대로.
- **외과적 변경 (CLAUDE.md §3):** 각 밀스톤이 나열한 파일만. 변경으로 고아가 된 import/변수/필드만 제거. 무관한 dead code 는 review 에 언급만.
- **커밋 (CONTRIBUTING):** 밀스톤당 1커밋, `type(phase46): <ASCII subject>`, 본문은 "왜", `Co-Authored-By` 트레일러, `--no-verify` 금지. M5 삭제는 단독 커밋. PR 은 merge commit.
- **게이트:** 매 밀스톤 `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test` (+`pnpm test:storage`). build(tsc --build) 생략 금지(phase42 교훈).
- **상수 원칙:** §2 D8 수치는 코드 상수. config 키를 새로 만들지 않는다. 단순화로 상한이 있는 곳은 `// ponytail:` 주석(예: 회전 1규칙, lane 대기 상한).
