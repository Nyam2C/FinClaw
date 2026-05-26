# Phase 40 계획 — Claude 구독(CLI)-only + MCP 도구로 "먼저 작동"

> 작성 2026-05-26 · base = main HEAD `d5db716` (phase39 #74) · 선행: `plans/phase40/kickoff.md`
> 상태: **초안 — 사용자 승인 대기.** 승인 후 todo.md 분해 → 코드. (자동 풀사이클 금지, 코드 전 plan 승인 게이트.)

## 0. 목표와 경계

**phase40 목표:** FinClaw 를 `ANTHROPIC_API_KEY` **없이** Claude 구독(CLI OAuth)만으로 구동하되, 금융 도구(시세/뉴스/알림/포트폴리오/KIS/메모리)를 **MCP 로 보존**하여 CLI 가 실제 도구를 호출하게 한다. = "먼저 작동."

**경계 (명시적 비대상):**

- **SDK 런타임 제거는 phase41.** phase40 은 `providers/anthropic`·ReAct Runner·LlmRouter·`runWithModelFallback`·summarizer·`@anthropic-ai/sdk` 를 **휴면 상태로 유지** (안전판). 키가 있으면 dual-path, 키가 없으면 pure-CLI.
- **실시간 토큰 스트리밍 비대상.** CLI 의 `--output-format json` 최종 블롭으로 충분. 기존의 합성 단일 `text_delta` 유지. stream-json NDJSON → WS partial 스트리밍은 후속 phase.
- **CLI session_id 영속화 비대상(스트레치).** 현재 adapter 메모리(`#cliSessionId`)에만 — 재시작 시 멀티턴 유실은 phase40 에서 수용. storage 영속화는 후속.
- **RAG 임베딩 비대상.** Voyage/OpenAI 임베딩은 LLM API 와 무관 → 유지. 키 없으면 기존대로 FTS-only 강등.

## 1. ★ 확정된 아키텍처 — C: in-process HTTP MCP (2026-05-26 사용자 확정)

claude CLI 가 FinClaw 가 **자기 프로세스 안에서 호스팅하는** HTTP MCP 엔드포인트에 URL 로 접속한다. 별도 프로세스도, 상태 중복도, phone-home hop 도 없다.

```
FinClaw server (always-on, node v22)
 ├─ gateway HTTP/WS 서버  ── + NEW /mcp 라우트 (StreamableHTTP, stateful: mcp-session-id) ──┐
 ├─ ToolRegistry  ◄──────────────────────────────────────────────────────────┘
 │    (Zod 검증 · 9-stage policy · loop-detect · result-guard · audit events)   direct in-proc call
 └─ claude-cli adapter 가 spawn:
      env -u ANTHROPIC_API_KEY claude -p
        --mcp-config '{"mcpServers":{"finclaw":{"type":"http","url":"http://127.0.0.1:<port>/mcp",
                       "headers":{"Authorization":"Bearer <per-spawn JWT>"}}}}'
        --strict-mcp-config  --tools ""  --allowedTools "mcp__finclaw__*"
        --permission-mode bypassPermissions  --output-format json
           └─ claude 가 URL 로 /mcp 접속 → tool_use → /mcp 핸들러가 toolRegistry.execute() → 실데이터 복귀
```

**왜 C 인가 (조사 근거):**

- **(b) in-process 재초기화 = 기각.** skills 는 무거운 공유 상태 — 단일 SQLite writer, in-memory market cache, **백그라운드 alert monitor**(`skills.ts:147-159`), stateful KeyRotator. 재초기화 시 2번째 SQLite writer(쓰기 충돌)·캐시 2배(rate-limited 키 2배 소진)·**alert monitor 2배(Discord 알림 중복 발송)**. 1인 상시가동 서버에 치명적.
- **(a) stdio phone-home 대비 C 의 우위:** 추가 프로세스 0, 2-hop → 0, node-v22-절대경로/tsx 제약(kickoff §30) 소멸, 그리고 결정적으로 **ToolRegistry 의 policy/guard/audit 파이프라인을 그대로 통과** — 이게 프로젝트의 "환각 방지 + 감사 가능성" 핵심 가치. (a)의 finance._/memory._ RPC 는 curated 부분집합이고 이 파이프라인을 우회함(`finance.ts` 가 서비스 직접 호출).
- **CLI 도구면 = SDK 도구면 (단일 소스).** MCP 도구가 `toolRegistry.list()` 에서 생성되므로 phase41 에서 SDK 를 제거해도 별도 RPC 매핑이 고아가 되지 않음.
- **관찰성 무료.** tool_use 가 in-process `/mcp` 핸들러를 통과 → 호출별 audit/observer 이벤트를 stdout 파싱 없이 직접 emit.

**검증된 전제 (조사 완료):**

- `claude 2.1.150` 이 HTTP transport + header 인증을 1급 지원 (`--transport http --header`). MCP SDK `1.29.0` 이 `StreamableHTTPServerTransport`(stateless 모드 `sessionIdGenerator: undefined`) 보유 — `packages/server` 기존 의존성, 신규 패키지 불필요.
- `handleRequest(req, res, body)` 가 `node:http` IncomingMessage/ServerResponse 를 직접 받음 → `router.ts` 의 openai-compat 조건부 라우트와 동일 패턴으로 mount.
- 격리: `--tools ""` 가 내장 도구(Bash/Edit/Read) 전체를 끔 + `--strict-mcp-config` 가 사용자 전역 MCP 배제 + `--allowedTools "mcp__finclaw__*"` 가 FinClaw 도구만 자동 승인.

**유일한 미확인 (Milestone A go/no-go):** `--mcp-config` 의 **인라인 JSON 이 `type:"http"` + `headers` 형태를 수용**하는지. `claude mcp add --transport http --header` 는 확인됨(대화형 경로). `-p --mcp-config` 비대화형 경로의 http 수용은 첫 밀스톤 스파이크로 실증한다. **실패 시 (a) stdio phone-home 으로 폴백** (transport 만 교체, 나머지 설계 유지).

### 1-1. OpenClaw 충실도 (2026-05-26 서브에이전트 검증, `_workspace/openclaw-mcp-hosting.md`)

**C 의 코어("HTTP 가 살아있는 ToolRegistry 를 정책 통과시켜 Bearer 인증 하에 in-process execute")는 OpenClaw `src/gateway/tools-invoke-http.ts`(`POST /tools/invoke`)에 검증된 1:1 레퍼런스가 있다.** OpenClaw 패턴: `POST` only → Bearer 인증 → `createOpenClawTools()` 라이브 빌드 → `applyToolPolicyPipeline()` 전체 통과 → **gateway-HTTP 강제 deny**(`DEFAULT_GATEWAY_HTTP_TOOL_DENY`, allowlist 와 무관하게 모든 HTTP 호출자에 적용) → `tool.execute("http-${Date.now()}", args)` **stateless** → 에러 분류 상태코드. → FinClaw `/mcp` 핸들러 실행부는 이 코어를 1:1 참고, **MCP 는 그 위에 transport 만 얹는다.**

**C 의 나머지(그 엔드포인트를 spawn 한 claude CLI 에 `--mcp-config` 로 MCP 프로토콜 연결)는 OpenClaw 레퍼런스 없음 = FinClaw 원본 설계.** OpenClaw 는 MCP 미사용(`@modelcontextprotocol/sdk` import 0건), 외부 도구 노출은 ACP-over-stdio(IDE 용)로 풀고, claude CLI 엔 도구를 안 줌. claude 와 붙으려면 claude 가 이해하는 MCP 가 필요하므로 **MCP 선택 자체는 정당.** **※ 세션 모델 보정 (Milestone A 실증):** MCP-over-HTTP 는 **stateful** 프로토콜 — initialize→tools/list→tools/call 가 별도 HTTP 요청이라 mcp-session-id 로 transport/server 를 재사용해야 함(요청마다 새 서버 = stateless 패턴은 tools/list 에서 -32601). OpenClaw `/tools/invoke` 가 stateless 였던 건 그게 MCP 프로토콜이 아니라 커스텀 단발 엔드포인트라서. → FinClaw `/mcp` 는 세션맵(`createMcpHost` 캡슐화)으로 stateful 구현.

## 2. kickoff "plan 이 반드시 결정할 것" 5개 — 해소

| #   | 항목                      | 결정                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ★ MCP↔서비스 아키텍처     | **C: in-process HTTP**, ToolRegistry 직접 경유 (위 §1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2   | 도구 격리                 | (CLI측) `--tools "" --strict-mcp-config --allowedTools "mcp__finclaw__*"`. **(서버측, OpenClaw 패턴) `--allowedTools` allowlist 를 신뢰하지 말고 `/mcp` 노출 목록에 group allowlist + 강제 deny 를 둘 것** — OpenClaw `DEFAULT_GATEWAY_HTTP_TOOL_DENY` 처럼 allowlist 와 무관하게 적용되는 최후 방어선. FinClaw 는 read-only 우선이라 deny 가 작겠으나 **mutating 도구(alert.create / memory write / transaction.add·update·delete / KIS) 와 file_read/web_fetch 는 노출 검토 대상**(bypassPermissions 라 무프롬프트 실행). |
| 3   | ToolRegistry → MCP 브리지 | `toolRegistry.list()` → 각 `RegisteredToolDefinition` 을 `McpServer.registerTool` 로 노출. inputSchema(JSON Schema) 그대로 매핑, executor 는 `toolRegistry.execute(name, input, ctx)`. ctx 의 userId/sessionId 는 per-spawn JWT claim 에서, abortSignal 은 요청에서.                                                                                                                                                                                                                                                        |
| 4   | gateway 통합              | `/mcp` 라우트를 gateway HTTP 서버에 mount. CLI adapter 가 spawn 시 MCP url + per-spawn JWT 주입. 비용(`total_cost_usd`) 회계는 CLI json result 에서 캡처. **실시간 스트리밍은 비대상(§0).**                                                                                                                                                                                                                                                                                                                                 |
| 5   | 부팅 — 키 없이            | `main.ts:91` `requireEnv('ANTHROPIC_API_KEY')` → optional. provider 기본값 `claude-cli` 로 전환. 키 있으면 SDK 휴면 dual-path, 없으면 sdkAdapter/routerLlm/sdkFallback **미인스턴스화**.                                                                                                                                                                                                                                                                                                                                    |

## 3. 마일스톤 (각 밀스톤 = typecheck+build+test+lint green, 1커밋)

### A. MCP 호스트 스파이크 + 격리 실증 (go/no-go 게이트)

- gateway 에 `/mcp` 라우트 추가 (StreamableHTTP stateful: mcp-session-id). **실 도구 1개**(`get_stock_price`)를 `toolRegistry.execute` 경유로 노출.
- 수동 검증: `claude -p --mcp-config '{...http...}' --tools "" --strict-mcp-config --allowedTools mcp__finclaw__get_stock_price` 로 spawn → (1) **http+headers JSON 수용 여부 [go/no-go]**, (2) 격리(Bash/Edit 차단·ToolSearch 미사용), (3) tool_use → toolRegistry → 실데이터 복귀 확인. **✅ 2026-05-26 GO 확정.**
- **게이트:** http 수용 실패 시 (a) stdio phone-home 으로 즉시 pivot, plan §1 갱신.
- 자동 테스트: `/mcp` 핸들러 + 단일 도구 브리지를 **mock toolRegistry** 로 (실 CLI/네트워크 금지). 라이브 CLI 검증은 수동 분리.
- **검증:** mock 단위 테스트 green + 수동 spawn 1회 성공 로그.

### B. ToolRegistry → MCP 브리지 (전체) + 인증

- 제너릭 브리지: `toolRegistry.list()` → **group allowlist + 강제 deny 필터**(OpenClaw `/tools/invoke` 의 `DEFAULT_GATEWAY_HTTP_TOOL_DENY` 패턴 참고) → `registerTool` 일괄. inputSchema 매핑, ctx 조립(JWT claim → userId/sessionId/channelId).
- **`/mcp` 실행 핸들러 = OpenClaw `src/gateway/tools-invoke-http.ts` 1:1 참고:** Bearer 게이트 → 도구 필터 → `toolRegistry.execute()`(정책/가드/감사 통과) → 에러 분류(input→400, authz→403, 기타→500). MCP SDK 는 이 코어 위 transport 레이어.
- `signToken({sub, sessionId, exp})` HS256 헬퍼 신규 (~15줄, `validateToken` 대칭). gateway config 에 `mcp?: { enabled, allowedGroups, denyTools }` 추가. `/mcp` 는 기존 `authenticate()`(Bearer) 재사용.
- **검증:** mock registry → allowlist/deny 필터 적용 + 올바른 MCP 도구 정의 생성 / 도구 호출이 execute 경유 / JWT round-trip 단위 테스트.

### C. CLI runner MCP 배선 + provider 경로

- `runCliAgent`/backend config 확장 — `--mcp-config`(http url+Bearer)·`--tools ""`·`--strict-mcp-config`·`--allowedTools` 주입. `--output-format json` 유지(CLI 가 tool 루프 수행, `/mcp` 가 도구 제공).
- adapter/runner 에 MCP 엔드포인트 url + **spawn 별 JWT mint**(sessionId 운반) 전달. providers.ts 에서 gateway MCP url + token minter 배선.
- **검증:** runner 가 MCP 플래그 포함 argv 를 올바르게 빌드 (mock spawn) 단위 테스트.

### D. 키 없이 부팅 (옵셔널화) + 기본 provider 전환

- `requireEnv('ANTHROPIC_API_KEY')` → optional. 키 없음+`claude-cli` → 정상 부팅. 키 없음+`anthropic-sdk` → 명확한 fatal.
- providers.ts: 키 있을 때만 sdkAdapter/routerLlm/sdkFallback 생성 (없으면 pure-CLI). **routerLlm(LLM 오케스트레이터) 의존성 조사 — 키 없는 CLI 모드에서 무엇이 깨지는지 확인 후 게이트/no-op 결정** (열린 조사 항목).
- skills.ts news 분석: 키 없으면 sentiment LLM **degrade**(분석 skip, 부팅 정상) — RAG→FTS 와 동형.
- provider 기본값 `anthropic-sdk` → `claude-cli` (defaults.ts:61). 키 없는 구독 부팅이 기본 경험.
- **기존 경고 정정:** `skills.ts:214,269` 의 "CLI mode disables tool_use / tools inactive" 경고는 이제 **거짓** (MCP 로 도구 활성). 갱신/제거.
- **검증:** 키 없는 부팅 composition 단위 테스트 + provider 기본값.

### E. 관찰성·비용 회계·정리 (필수분만; 나머지 스트레치)

- `/mcp` 핸들러가 호출별 audit/observer/tracer 이벤트 emit (in-process, 무료).
- CLI json result 의 `total_cost_usd` → agent_runs/observability 회계.
- 문서: README/CLAUDE.md/관련 phase 노트 갱신. (session_id 영속화는 비대상 §0.)
- **검증:** audit 이벤트 emit 단위 테스트 + 비용 캡처 단위 테스트.

## 4. 스코프 IN / OUT

**IN:** in-process `/mcp` 호스트, ToolRegistry→MCP 브리지(allowlist), per-spawn JWT 인증, CLI runner MCP 플래그, 키 없는 부팅, provider 기본 CLI 전환, 도구 격리, 호출별 관찰성·비용 회계.

**OUT (phase41+):** SDK 런타임 제거, 실시간 토큰 스트리밍(stream-json), CLI session_id 영속화, RAG 임베딩 변경, KR 종목.

## 5. 리스크

- **#1 go/no-go:** `-p --mcp-config` 의 http 인라인 수용 미확인 → Milestone A 에서 실증, 실패 시 (a) stdio 폴백. (transport 외 설계는 불변이라 폴백 비용 제한적.)
- **routerLlm/오케스트레이터의 SDK 강결합** (providers.ts:35-37): 키 없는 CLI 모드에서 오케스트레이션 경로가 깨질 수 있음 → Milestone D 조사 항목. 최악의 경우 CLI 모드에서 다중-chain 라우팅 degrade 수용.
- **위험 도구 무프롬프트 노출:** bypassPermissions 라 `file_read`/`web_fetch` 등이 무승인 실행 → group allowlist 필수 (Milestone B).
- **비용:** 스파이크 1쿼리 $0.34(구독 차감). rate_limit_event 관측됨.
- **되돌리기:** SDK 휴면 유지가 안전판(phase40 은 제거 안 함).

## 6. 컨벤션

- 테스트 baseline: unit **1679** / storage 154 (phase39 기준). mock-only 유지 — 실 키/네트워크 테스트 금지, 라이브 CLI 는 수동 검증 분리.
- 각 밀스톤: typecheck + build + `test --run` + `test:storage` + lint green, 밀스톤당 1커밋.
- 외과적 변경 (CLAUDE.md §3): kickoff/plan 이 요구하지 않은 인접 코드 비건드림.
