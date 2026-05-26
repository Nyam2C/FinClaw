# Phase 40 킥오프 — API 완전 제거, Claude 구독(CLI)-only + MCP 도구

> 작성 2026-05-26, base = main HEAD `d5db716` (phase39 #74 머지 직후).
> **사전 조사·스파이크 완료 메모. plan.md 는 아직 없음 — 먼저 plan.md 부터 설계할 것.**

## 목표 (사용자 확정)

FinClaw 를 **Anthropic API 없이 Claude 구독(CLI 로그인)만으로** 구동. `claude` CLI 가 추론 백엔드. **단, FinClaw 의 금융 도구(시세/뉴스/알림/포트폴리오/KIS/메모리)는 MCP 로 보존** (텍스트 전용으로 전락 금지 — 환각 방지 원칙 유지). AskUserQuestion 2026-05-26: "도구 유지 (MCP, 대공사)" 선택.

## 스파이크로 실증된 메커니즘 (2026-05-26, 재조사 불필요)

설치된 `claude 2.1.150 (Claude Code)` + 구독 인증으로 **end-to-end 성공**:

```
env -u ANTHROPIC_API_KEY claude -p \
  --mcp-config <finclaw-tools.json> --strict-mcp-config \
  --allowedTools "mcp__finclaw__<tool>..." \
  --permission-mode bypassPermissions \
  --output-format stream-json --verbose \
  "<prompt>"
```

증거: mock MCP 도구 `get_quote`→ claude 가 `tool_use mcp__finclaw__get_quote{symbol:AAPL}` 호출 → tool_result `{price:231.55,source:SPIKE-MOCK}` 복귀 → 최종 답 `"231.55"`(mock 값 그대로, 환각 X). `result/success`, 4 turns, $0.34, `ANTHROPIC_API_KEY` 비운 채 구독 인증.

**검증된 사실:**

- ✅ `claude -p --mcp-config` 로 FinClaw 도구를 MCP 노출 → CLI 가 자기 루프에서 호출 → 결과 복귀 → 실 데이터로 답변.
- ✅ 구독 인증: `ANTHROPIC_API_KEY` env 제거(`clearEnv`)면 `~/.claude` OAuth 사용 (OpenClaw 와 동일 메커니즘, `_workspace/openclaw-cli-backend.md`). **`--bare` 는 금지** (그 모드는 OAuth 안 읽고 API 키 강제).
- ✅ `--strict-mcp-config` 로 사용자 전역 MCP(Notion 등) 배제. 없으면 병합되어 10턴+로 늘어짐.
- ✅ `--output-format stream-json --verbose` NDJSON: `system/init`(mcp_servers status) → `assistant`(tool_use) → `user`(tool_result) → `result`(subtype/num_turns/total_cost_usd/result). 파싱 가능.
- ⚠️ MCP 서버는 **SDK 를 resolve 가능한 패키지 안**(`packages/server` 등)에 + spawn `command` 는 **node v22 절대경로**여야 함 (`_workspace`/시스템 node v12 면 `ERR_MODULE_NOT_FOUND`/`--import` 실패로 "pending" 연결 실패).
- ⚠️ `--allowedTools` 가 Claude Code **내장 도구(Bash/ToolSearch/file-edit)를 막지 않음** + 모델이 ToolSearch 로 먼저 도구 탐색(턴 낭비). 실 phase 에선 **도구 격리 필수** (사용자 머신에서 Bash/Edit 임의 실행 = 위험).

## 핵심 아키텍처 전환 (plan 이 직면할 것)

**"SDK 제거"가 아니라 "에이전트 루프 주체 교체"다.** 현재 FinClaw 의 `packages/agent` 가 ReAct 루프(Runner + ExecutionToolDispatcher) + 모델 라우팅(LlmRouter) + 폴백(runWithModelFallback) + 컨텍스트 압축(summarizer) + observer/토큰회계를 소유. CLI-only 가 되면 **`claude` CLI 가 이 루프 전부를 자기 안에서** 수행(모델 선택·tool 호출·압축 포함). → FinClaw 의 SDK 런타임 상당 부분이 **우회/사문화**. 이게 phase39 보다 훨씬 큰 범위.

## 확정된 범위 결정 (2026-05-26 AskUserQuestion)

- **① SDK 제거 시점 = phase41 (나중).** phase40 은 "먼저 작동" — CLI+MCP 경로 구축 + 기본화 + `ANTHROPIC_API_KEY` 옵셔널화(부팅 hard-fail 제거). **SDK 런타임(providers/anthropic·ReAct Runner·LlmRouter·runWithModelFallback·summarizer·@anthropic-ai/sdk)은 휴면 상태로 유지** = 안전판. CLI+MCP 실사용 검증 후 phase41 에서 삭제. 목표("키 없이 구독만으로 구동")는 phase40 으로 달성.
- **④ RAG 임베딩 유지.** Voyage/OpenAI 임베딩은 Claude LLM API 와 무관한 별도 서비스 → 유지. 키 없으면 기존대로 FTS-only 자동 강등. phase40 범위 밖.

## plan.md 가 반드시 결정할 것 (남은 감독 포인트)

1. **★ MCP 서버 ↔ FinClaw 서비스 아키텍처 (최대 미해결).** claude 가 spawn 하는 MCP 서버 프로세스가 FinClaw 의 서비스(storage DB·market/news/KIS 클라이언트·memory)에 어떻게 닿나? 후보: (a) MCP 서버가 실행 중인 FinClaw gateway 의 기존 JSON-RPC(finance._/memory._/...) 로 콜백 = 전 자산 재사용, 단 gateway 가 떠 있어야 + auth, (b) MCP 서버가 서비스 in-process 재초기화 = 중복 상태. → plan 이 정해야 함.
2. **도구 격리** — CLI 가 FinClaw MCP 도구만 쓰고 Bash/Edit/내장도구 차단 (`--disallowedTools`? `--strict-mcp-config`+`--allowedTools` 조합 — 스파이크선 allowedTools 가 내장도구 안 막았음). 보안 직결.
3. **ToolRegistry → MCP 브리지** — skills(market/news/alert/portfolio/kis/memory)를 MCP 도구로 노출. 도구 정의(Zod)·실행·세션컨텍스트(userId/sessionId) 전달.
4. **gateway 통합** — `agent.run`·`chat.send`·scheduler 가 SDK Runner 경유 → CLI+MCP 경로 재배선. stream-json partial → WS 스트리밍, 세션 영속(claude session_id 저장), 비용(total_cost_usd) 회계.
5. **부팅 — 키 없이** — `ANTHROPIC_API_KEY` requireEnv 제거. CLI 모드에선 SDK 라우터/요약기 미인스턴스화(없어도 부팅). provider 기본 `claude-cli`.

## 스탠딩 리스크

- 레퍼런스 비대칭: 인증·기동은 OpenClaw 참고 가능, **MCP 도구 경로는 FinClaw 원본 설계**(OpenClaw 는 CLI 도구 안 씀). 스파이크로 1개 도구는 검증됐으나 전체 스킬·격리·스트리밍·세션은 미검증.
- 비용 모델 변화: 스파이크 1쿼리 $0.34(구독 차감). 구독 한도/rate_limit_event 관측됨.
- 되돌리기 난이도 높음 (런타임 제거 시). dual-path 유지가 안전판일 수 있음 — plan §1 결정 사안.

## 컨벤션

- 테스트 baseline: unit **1679** / storage 154 (phase39 기준). mock-only 유지 (실 키/네트워크 테스트 금지 — CLI 스파이크는 수동 검증으로 분리).
- 각 밀스톤: typecheck+build+test+lint green, 밀스톤당 1커밋. 첫 밀스톤 = MCP 브리지 + 격리 실증(스파이크 확장).
- 참고 문서: `_workspace/openclaw-cli-backend.md` (OpenClaw CLI 백엔드 조사), 본 킥오프(스파이크 결과).
