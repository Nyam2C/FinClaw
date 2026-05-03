# Positioning Dossier

## One-liner

본인 1인이 읽고 감사할 수 있는 금융 특화 AI 비서 코드베이스.

## Elevator pitch

FinClaw 는 사용자 본인의 투자·시장 분석·포트폴리오 판단을 보조하기 위해 만든 개인용 AI 비서다. Anthropic Claude 와 Discord/Web 채널을 기반으로, 시장 데이터·뉴스·알림·거래 이력·기억(RAG)·자동화(cron) 를 SQLite 단일 파일에 영속화한다. 프로덕트 출시·다인 사용·자동 매매를 목표로 하지 않으며, "내가 전체를 읽고 수정할 수 있는 작은 코드베이스" 와 "감사 가능성·환각 방지" 를 설계 우선순위로 둔다.

## 타겟 사용자

- 1순위: **저장소 소유자 본인** — 자신의 자금을 대상으로 분석·기억·정기 보고를 받고 싶고, 비서가 어떤 입력으로 어떤 도구를 거쳐 어떤 답을 냈는지 직접 확인하려는 1인 운영자.
- 비대상:
  - 다중 사용자 / 멀티테넌시 / RBAC / SSO 가 필요한 팀·조직 (memory `project_use_case.md` 가 명시적으로 "엔터프라이즈 기능은 죽은 무게" 로 차단)
  - 자동 매매 실행이 목적인 사용자 (읽기 전용 원칙 — `project_use_case.md`, plans/phase26·28·29 의 "읽기 전용 원칙 유지" 반복 명시)
  - OpenClaw 같은 범용 멀티채널 AI 플랫폼을 찾는 사용자 (FinClaw 는 의도적으로 금융 도메인 1인용 축약본)

## 핵심 가치 제안

1. **금융 도메인에 한정한 축약 코드베이스** — `plans/README.md` 기준 425 TS 파일 / ~42K LOC, 11개 워크스페이스 패키지 (`packages/{types,infra,config,storage,agent,channel-discord,skills-finance,skills-general,server,tui,web}`). 동일 문서가 비교군으로 인용한 OpenClaw 의 ~16% 규모 — "한 사람이 전부 읽고 수정 가능" 을 의도한 크기.
2. **감사 가능성 우선** — 모든 거래 입력·기억·`agent.run` 결과·RAG 주입 ID 가 SQLite (`transactions`, `memories`, `agent_runs`) 에 영속화되며, RAG 주입 시 "어떤 기억이 주입됐는지" 가 로그로 남는다 (plans/phase26 plan 밀스톤 C). Phase 29·30 plan 은 RAG citation `[mem:xxxxxx]` 와 W3C trace ID / span tree 를 추가해 "어느 회상으로 어느 답을 냈는가" 를 trace ID 하나로 따라가는 것을 단일 목표로 둔다.
3. **명시적 선언 기반 기억** — 사용자가 `!finclaw remember`, "기억해", "내 원칙은 X" 같은 정규식 패턴을 사용할 때만 저장 (plans/phase26 밀스톤 B). LLM 자동 추출은 환각 위험으로 의도적 비대상.
4. **읽기 전용 + 수동 입력 거래 이력** — `finance.transaction.add` 는 사용자가 "이미 한 매매" 를 입력하는 경로이지 "FinClaw 가 자동 매매" 가 아님 (plans/phase26 Context). holdings 는 transactions 로부터 파생.
5. **Anthropic Claude 1차 + Discord/Web 채널** — `packages/server/src/main.ts` 가 부팅 시 `AnthropicAdapter`, Discord adapter, HTTP/WS Gateway (JSON-RPC 2.0), Web UI (Lit) 를 wire-up 한다. Phase 29 트랙 A 가 OpenAI provider 를 추가 예정이지만, 현 시점 기본 모델은 Anthropic `claude-sonnet-4-6` 단일 (`main.ts:90-95`).
6. **외부 키 없이도 동작하는 mock-only 테스트 스탠스** — `MEMORY.md` Feedback 항목 "Tests must run without API keys" 와 4-tier vitest (unit / storage / e2e / live) 분리. 라이브 API 호출은 `test:live` 로 격리.

## 사용 시나리오 (Day-in-the-life)

- 시나리오 A — 거래 입력과 기억 저장: 사용자가 Discord 또는 Web UI 에서 `finance.transaction.add` RPC 로 "AAPL 10주 @ $180 매수" 를 기록 → `portfolio_holdings` 가 트리거/애플리케이션 레벨로 자동 재계산 → `portfolio.changed` WebSocket 이 다른 클라이언트로 broadcast (plans/phase26 밀스톤 A·E).
- 시나리오 B — 대화 중 RAG 회상: "내 투자 철학 뭐였지?" 입력 → MemoryRetrievalStage 가 hybrid (vector + FTS5) 검색으로 `preference` 타입 기억을 시스템 프롬프트의 "사용자 배경지식" 섹션에 주입 → 답변 생성 (plans/phase26 밀스톤 C; Phase 29 트랙 B 에서 `[mem:xxxxxx]` citation 추가 예정).
- 시나리오 C — 정기 보고 (Phase 28 자동화): 사용자가 `schedule.create {cron: '0 12 * * *', prompt: "오늘 포트폴리오 일일 보고"}` 등록 → `SchedulerService` 가 매 분 폴러로 cron 매칭 → `agent.run` 직접 실행 → 결과를 Discord DM 또는 Web 알림으로 송출 (plans/phase28 Context, `packages/server/src/main.ts:401-440`).
- 시나리오 D — 알림 모니터링: `skills-finance/alerts` 의 alert monitor 가 시세·뉴스 조건 매칭 시 Discord 로 알림 (`main.ts:274-292`).

## 메타데이터

- 출처:
  - `~/.claude/projects/-mnt-c-Users---Desktop-hi-FinClaw/memory/project_use_case.md` (1인 사용자 / 읽기 전용 / 엔터프라이즈 비대상 정책의 일차 출처)
  - `~/.claude/projects/-mnt-c-Users---Desktop-hi-FinClaw/memory/MEMORY.md` (패키지 구성, Node.js 22+, mock-only 테스트 원칙)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/CLAUDE.md` (행동 가이드라인 + 하네스 트리거)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/plans/README.md` (FinClaw 정의: "OpenClaw 의 금융 특화 버전", 425 TS 파일 / ~42K LOC, 11 패키지, 채널 4종, 4-tier vitest)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/plans/phase00/plan.md` (스캐폴딩 원칙: Node.js 22+, Rust 기반 도구)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/plans/phase21/plan.md` (Phase 21 = "범용 비서" 활성화: skills-general 추가, Discord 배선)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/plans/phase26/plan.md` (거래·기억·RAG 3축, 명시적 선언 기반 기억, holdings 자동 재계산, 감사 원칙)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/plans/phase28/plan.md` (cron 기반 자동화, 결과 송출 채널 = Discord DM 또는 Web)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/plans/phase29/plan.md` (Production-grade 진입: Critical 5건, RAG citation, 임베딩 차원 가드, MCP plugin loader, gateway 운영성 모듈 배선)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/plans/phase30/plan.md` (관찰성·감사 가능성 표준화: OTel trace ID + span tree, structured output, access-log SQLite, RAG re-ranking)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/main.ts` (실제 부팅 wiring: Anthropic / Discord / Storage / Memory 3 service / Pipeline / Gateway / Scheduler)
  - `/mnt/c/Users/박/Desktop/hi/FinClaw/README.md` (현 README — positioning 부재, 환경 세팅 위주이므로 본 dossier 의 positioning 으로 보강 대상)
- 가정/주의:
  - **현재 시점 vs 계획**: phase29·30 의 OpenAI provider, MCP plugin, OTel trace, RAG citation 은 **plan 단계** (`plans/phase29/plan.md` 변경 이력: 2026-05-03 초기 작성). README positioning 은 "현재 동작" 과 "예정" 을 혼동하지 말 것. `main.ts:90-95` 기준 현 기본 모델은 Anthropic 단일.
  - **"OpenClaw 의 금융 특화 버전"**: `plans/README.md` 가 명시. FinClaw 가 OpenClaw 의 fork/포팅인지 독립 구현인지는 본 자료만으로 확정 불가 — `OpenClaw` 라는 외부 참조 코드베이스 (deep-dive 문서들) 가 Phase 1–20 포팅의 원본임은 plan 들이 반복 인용. README 에 표기 시 "OpenClaw 아키텍처 참조" 정도가 안전.
  - **현 README 정체성 인용 부적합**: 현 README 첫 줄 "OpenClaw 아키텍처 기반의 금융 특화 AI 어시스턴트" 는 한 줄에 그쳐 positioning 정보로 빈약. 본 dossier 가 보강한 "감사 가능성·1인 사용자·읽기 전용" 축이 정체성의 핵심이며 그대로 인용 권장.
  - **OpenClaw / Claude.ai / ChatGPT / Letta·MemGPT 비교**: phase29·30 plan 과 `_workspace/audit/SUMMARY.md` (감사 보고서, 본 dossier 작업 중 직접 미열람) 가 비교 근거 — author 통합 시 verifier 검증 필요.
