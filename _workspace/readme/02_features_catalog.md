# Feature Catalog

> 작성일: 2026-05-03 / 브랜치: `feature/automation`
> 범위: 사용자가 실제로 호출/사용할 수 있는 기능만. 내부 추상은 architecture-mapper 영역.

## 기능 매트릭스

| 카테고리   | 기능                                                                     | 진입점 / 트리거                                                                              | 관련 패키지                                               | 외부 의존성                                                               |
| ---------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- | ------------------- | -------------------------- | -------------------------------------------------------------------------- | ------------------- | ----------------------------------- | ------ |
| 대화       | 자연어 대화 (auto-reply 6단계 파이프라인)                                | Discord DM/멘션 (`!finclaw <메시지>` 또는 봇 멘션)                                           | server/auto-reply, channel-discord                        | `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`        |
| 대화       | 명시적 기억 저장 (정규식 5종)                                            | Discord 발화: `!finclaw remember …`, `기억해: …`, `메모: …`, `선호: …`, `내 (투자) 원칙은 …` | server/auto-reply/stages/memory-capture                   | (선택) `VOYAGE_API_KEY` / `OPENAI_API_KEY` (없으면 FTS-only)              |
| 대화       | 자동 회상 RAG 주입                                                       | 매 발화 (Context→Execute 사이) hybrid vector+FTS 검색 → system prompt                        | server/auto-reply/stages/memory-retrieval, storage/search | (선택) `VOYAGE_API_KEY`/`OPENAI_API_KEY`                                  |
| 대화       | 인-채팅 명령어                                                           | Discord 발화: `!finclaw help                                                                 | reset                                                     | status                                                                    | price                                                                    | portfolio                                | alert`              | server/auto-reply/commands | (`status`/`reset` 은 `/help`,`price`,`portfolio`,`alert` 제외 placeholder) |
| Discord    | `/ask <question>` 슬래시 커맨드                                          | Discord slash: `/ask`                                                                        | channel-discord/commands/ask.ts                           | **死(Dead): placeholder 응답만** (TODO Phase 9 runner 연결)               |
| Discord    | `/market <ticker>` 시세 조회                                             | Discord slash: `/market`                                                                     | channel-discord/commands/market.ts                        | `financeService` 미주입 — 기본 "준비 중" 응답                             |
| Discord    | `/news [query] [count]`                                                  | Discord slash: `/news`                                                                       | channel-discord/commands/news.ts                          | `financeService` 미주입 — 기본 "준비 중" 응답                             |
| Discord    | `/alert set\|list\|remove`                                               | Discord slash: `/alert`                                                                      | channel-discord/commands/alert.ts                         | `alertStorage` 미주입 — 기본 "준비 중" 응답                               |
| 금융(스킬) | 주식 시세 (`get_stock_price`)                                            | LLM 도구 호출 (자연어 대화 중)                                                               | skills-finance/market                                     | `ALPHA_VANTAGE_KEY`                                                       |
| 금융(스킬) | 암호화폐 시세 (`get_crypto_price`)                                       | LLM 도구 호출                                                                                | skills-finance/market                                     | (선택) `COINGECKO_API_KEY`                                                |
| 금융(스킬) | 외환 환율 (`get_forex_rate`)                                             | LLM 도구 호출                                                                                | skills-finance/market                                     | 무료 Frankfurter (키 불필요)                                              |
| 금융(스킬) | 시세 차트 (`get_market_chart`) sparkline                                 | LLM 도구 호출                                                                                | skills-finance/market                                     | `ALPHA_VANTAGE_KEY` 또는 `COINGECKO_API_KEY`                              |
| 금융(스킬) | 금융 뉴스 (`get_financial_news`)                                         | LLM 도구 호출                                                                                | skills-finance/news                                       | `ALPHA_VANTAGE_KEY` (RSS 자동 fallback)                                   |
| 금융(스킬) | AI 시장 분석 (`analyze_market`)                                          | LLM 도구 호출                                                                                | skills-finance/news/analysis                              | `ANTHROPIC_API_KEY` (Opus floor 강제)                                     |
| 금융(스킬) | 포트폴리오 요약 (`get_portfolio_summary`)                                | LLM 도구 호출                                                                                | skills-finance/news/portfolio                             | `quoteService`, `newsAggregator`                                          |
| 금융(스킬) | 알림 CRUD (`set_alert`/`list_alerts`/`remove_alert`/`get_alert_history`) | LLM 도구 호출                                                                                | skills-finance/alerts                                     | (없음 — 내부 SQLite)                                                      |
| 금융(스킬) | 알림 모니터 (30초 polling) + 송출 (Discord DM / WS / 로그)               | 백그라운드 자동                                                                              | skills-finance/alerts/monitor                             | `DISCORD_BOT_TOKEN` (DM용)                                                |
| 일반(스킬) | 현재 시각 (`get_current_datetime`)                                       | LLM 도구 호출                                                                                | skills-general/datetime                                   | (없음)                                                                    |
| 일반(스킬) | 웹 페치 (`web_fetch`)                                                    | LLM 도구 호출                                                                                | skills-general/web-fetch                                  | 공개 URL 한정 (사설 IP 차단)                                              |
| 일반(스킬) | 로컬 파일 읽기 (`read_local_file`)                                       | LLM 도구 호출                                                                                | skills-general/file-read                                  | `FINCLAW_FILE_ROOT` (기본 `~/.finclaw/workspace`)                         |
| RPC        | `system.health                                                           | info                                                                                         | ping`                                                     | HTTP/WebSocket JSON-RPC                                                   | server/gateway/rpc/methods/system                                        | (없음, auth=none)                        |
| RPC        | `chat.start                                                              | send                                                                                         | stop                                                      | history`                                                                  | WebSocket JSON-RPC                                                       | server/gateway/rpc/methods/chat          | `ANTHROPIC_API_KEY` |
| RPC        | `session.get                                                             | reset                                                                                        | list`                                                     | JSON-RPC                                                                  | server/gateway/rpc/methods/session                                       | (없음)                                   |
| RPC        | `agent.list                                                              | status                                                                                       | run`                                                      | JSON-RPC (`agent.run` 큐잉)                                               | server/gateway/rpc/methods/agent                                         | `ANTHROPIC_API_KEY`                      |
| RPC        | `agent.runs.list                                                         | get` (감사 이력)                                                                             | JSON-RPC                                                  | server/gateway/rpc/methods/agent-runs                                     | (DB 미주입 시 `provider_unavailable`)                                    |
| RPC        | `finance.quote                                                           | news`                                                                                        | JSON-RPC                                                  | server/gateway/rpc/methods/finance                                        | 시세: `ALPHA_VANTAGE_KEY`/`COINGECKO_API_KEY`, 뉴스: `ALPHA_VANTAGE_KEY` |
| RPC        | `finance.alert.create                                                    | list` (+`portfolio.changed` broadcast)                                                       | JSON-RPC                                                  | server/gateway/rpc/methods/finance                                        | (alertStore 필요)                                                        |
| RPC        | `finance.portfolio.get` (+ `recentTransactions` 10건)                    | JSON-RPC                                                                                     | server/gateway/rpc/methods/finance                        | (없음)                                                                    |
| RPC        | `finance.transaction.add                                                 | list                                                                                         | update                                                    | delete`                                                                   | JSON-RPC (Phase 26 A)                                                    | server/gateway/rpc/methods/finance       | (없음)              |
| RPC        | `memory.list                                                             | delete                                                                                       | search` (hybrid/FTS)                                      | JSON-RPC                                                                  | server/gateway/rpc/methods/memory                                        | (선택) `VOYAGE_API_KEY`/`OPENAI_API_KEY` |
| RPC        | `schedule.create                                                         | list                                                                                         | update                                                    | delete                                                                    | runNow                                                                   | history                                  | enable              | disable                    | testCron`                                                                  | JSON-RPC (Phase 28) | server/gateway/rpc/methods/schedule | (없음) |
| RPC        | `config.get                                                              | update                                                                                       | reload`                                                   | JSON-RPC                                                                  | server/gateway/rpc/methods/config                                        | **TODO (stub만 반환, Phase 10 미완)**    |
| 자동화     | cron 기반 schedule 실행 (분 단위)                                        | 백그라운드 폴러 (1분 주기)                                                                   | server/automation/scheduler, cron                         | `ANTHROPIC_API_KEY`, `AUTOMATION_MAX_CONSECUTIVE_FAILURES` (선택, 기본 3) |
| 자동화     | schedule 결과 송출 (Discord DM / Web WS)                                 | scheduler 의 `onRunComplete` 콜백                                                            | server/automation/delivery                                | `DISCORD_BOT_TOKEN` (Discord 채널 선택 시)                                |
| Web UI     | Chat 탭 (LLM 스트리밍)                                                   | 브라우저: 게이트웨이 WS                                                                      | web/app.ts                                                | gateway 연결                                                              |
| Web UI     | Market 탭 (시세 카드)                                                    | 브라우저: `finance.quote`                                                                    | web/views/market-view.ts                                  | (위 RPC 의존성)                                                           |
| Web UI     | Portfolio 탭 (보유 종목 + 거래 이력 + 거래 추가 모달)                    | 브라우저                                                                                     | web/views/portfolio-view.ts, transaction-form.ts          | `portfolio.changed` 자동 갱신                                             |
| Web UI     | Alerts 탭 (알림 CRUD)                                                    | 브라우저                                                                                     | web/views/alerts-view.ts                                  | (위 RPC 의존성)                                                           |
| Web UI     | Settings 탭 (기억 / agent_runs / 자동화 / 라우팅 placeholder)            | 브라우저                                                                                     | web/views/settings-view.ts, schedule-form.ts              | (위 RPC 의존성)                                                           |
| TUI        | 5탭 패널 (chat / market / portfolio / alerts / settings)                 | `finclaw tui` CLI                                                                            | tui/App.tsx, DashboardView.tsx                            | `FINCLAW_API_KEY` (선택)                                                  |
| CLI        | `finclaw start [-p][-H][-d]` 게이트웨이 기동                             | 셸                                                                                           | server/cli/commands/start.ts                              | (Discord/Anthropic env 必)                                                |
| CLI        | `finclaw stop`                                                           | 셸                                                                                           | server/cli/commands/stop.ts                               | **死: `system.shutdown` RPC 미등록**                                      |
| CLI        | `finclaw health` / `finclaw status`                                      | 셸 → `system.health` / `system.info`                                                         | server/cli/program.ts                                     | (없음)                                                                    |
| CLI        | `finclaw market quote <ticker>`                                          | 셸 → `finance.quote`                                                                         | server/cli/commands/market.ts                             | 위 RPC 의존성                                                             |
| CLI        | `finclaw market watch`                                                   | 셸                                                                                           | server/cli/commands/market.ts                             | **死: "not yet implemented"**                                             |
| CLI        | `finclaw news [query] [-s]`                                              | 셸 → `finance.news`                                                                          | server/cli/commands/news.ts                               | 위 RPC 의존성                                                             |
| CLI        | `finclaw alert add\|list\|remove`                                        | 셸 → `finance.alert.*`                                                                       | server/cli/commands/alert.ts                              | `remove` 는 **死: `finance.alert.remove` RPC 미등록**                     |
| CLI        | `finclaw agent list\|status`                                             | 셸 → `agent.list`/`agent.status`                                                             | server/cli/commands/agent.ts                              | 위 RPC 의존성                                                             |
| CLI        | `finclaw channel list\|status`                                           | 셸 → `channel.list`/`channel.status`                                                         | server/cli/commands/channel.ts                            | **死: 두 RPC 모두 미등록**                                                |
| CLI        | `finclaw config list\|get\|set`                                          | 셸 → `config.*`                                                                              | server/cli/commands/config.ts                             | RPC 자체가 stub                                                           |
| CLI        | `finclaw tui`                                                            | 셸 → TUI 진입                                                                                | server/cli/commands/tui.ts                                | (위 TUI)                                                                  |
| 확장       | 플러그인 템플릿 (`register(api)`)                                        | 사용자 정의                                                                                  | extensions/plugin-template                                | **死: `PluginBuildApi` 로더가 server 에 미배선**                          |

---

## 카테고리별 상세

### 1. 대화 / 자동응답 (auto-reply 파이프라인)

**진입점:** Discord 메시지 (멘션 또는 `!finclaw ` 접두사) → `MessageRouter.route` → `AutoReplyPipeline.process`. CLI/Web 채팅은 별도 경로 (`chat.send` RPC).

**파이프라인 6+2 단계** (`packages/server/src/auto-reply/pipeline.ts:79-319`):

1. **Normalize** (`stages/normalize.ts`) — body 트림, 멘션·URL 추출, 공백 정규화.
2. **Command** (`stages/command.ts`) — `commandPrefix`(`!finclaw `) 매칭 시 인-채팅 명령어 실행 후 파이프라인 종료. 코드 펜스(```) 안의 명령어는 무시.
3. **Memory Capture** (`stages/memory-capture.ts`, Phase 26 B) — 정규식 5종 매칭 시 `memories` 테이블 저장. SHA-256 해시 dedup. 임베딩 실패 시 FTS-only fallback. best-effort.
4. **ACK** (`stages/ack.ts`) — 채널이 typing/reaction 지원 시 ack indicator 송신.
5. **Context** (`stages/context.ts`, `pipeline-context.ts`) — `MsgContext` → `PipelineMsgContext` 확장. 채널 capabilities, 사용자 권한, 금융 컨텍스트(현재 stub) 결합.
6. **Memory Retrieval** (`stages/memory-retrieval.ts`, Phase 26 C) — hybrid vector+FTS RAG 검색 (임베딩 미주입 시 FTS-only). 임계값 0.65 / 신선도 반감기 90일 / 상한 3개. 발화에서 추출된 티커 심볼별 거래 이력 3건 동시 주입. system prompt 의 "사용자 배경지식" 섹션 빌드.
7. **Execute** (`stages/execute.ts`, `execution-adapter.ts`) — Anthropic Runner 호출 (`@finclaw/agent`). 도구 dispatcher 빌드.
8. **Deliver** (`stages/deliver.ts`) — chunk 분할 후 채널로 송출. 출처·시각 자투리 부착 (Phase 22 결정).

**인-채팅 내장 명령어** (`commands/built-in.ts`):

- `/help [명령어]` — 등록된 명령어 목록.
- `/reset` (alias `clear`, `초기화`) — `storage.deleteConversation(sessionKey)` 호출.
- `/status` (alias `상태`) — toolRegistry/storage/profileHealth 기반 상태 (`status.ts`).
- `/price <symbol>` — placeholder ("skills-finance 모듈 연동 후 활성화"). **현재 LLM 자연어 호출이 실 기능. 명령어 자체는 stub.**
- `/portfolio` — placeholder.
- `/alert <symbol> <op> <price>` — placeholder.

명시적 명령어 prefix (default `!finclaw `) 는 `main.ts:342` 에서 설정.

### 2. 금융 스킬

**Market** (`packages/skills-finance/src/market/index.ts`) — 도구 4개. `ALPHA_VANTAGE_KEY` 또는 `COINGECKO_API_KEY` 미설정 시 모두 미등록. 외환은 Frankfurter (무료, 키 불필요).

**News** (`packages/skills-finance/src/news/index.ts`) — 도구 3개. Market 가 등록되고 + `ALPHA_VANTAGE_KEY` 가 있을 때만 등록. `analyze_market` 은 `ANTHROPIC_API_KEY` 추가로 필요. RSS 프로바이더는 항상 fallback 으로 등록.

**Alerts** (`packages/skills-finance/src/alerts/index.ts`) — 도구 4개 + 백그라운드 monitor (30초 polling, ConcurrencyLane 기반). 가격/변동률/거래량/뉴스 키워드 4종 조건 평가. delivery handler 3종(log / Discord DM / WebSocket broadcast). `evaluateOnce(alertId)` 훅으로 RPC 생성 직후 1회 평가 (`finance.alert.create` 의 `immediateTrigger` 응답).

**라우팅 minModel** (Phase 24): 시세·뉴스·CRUD 는 Haiku, 포트폴리오 요약은 Sonnet, AI 시장 분석은 **Opus floor 강제** (환각 방지).

### 3. 채널

**Discord** (`packages/channel-discord/src/`) — `discord.js` 기반. 4개 슬래시 커맨드 등록 (`commands/index.ts`). 메시지 이벤트는 `DiscordAdapter.onMessage` → `MessageRouter` → `AutoReplyPipeline`.

- `/ask <question>` — **placeholder 응답만**. TODO 주석에 "Phase 9 runner 통합" (`commands/ask.ts:18`).
- `/market <ticker>` — `deps.financeService` 가 주입되지 않으면 "준비 중". 본 핸들러를 위한 financeService 배선이 `main.ts` 에 없음 (실 시세는 자연어 대화에서 LLM 도구 호출로 처리).
- `/news [query] [count]` — 동일 패턴 (financeService 미주입).
- `/alert set|list|remove` — `alertStorage` v2 인터페이스 (TODO 주석: v3 AlertStore 마이그레이션 필요, `commands/alert.ts:54`).

**HTTP Webhook** (`packages/server/src/channels/dock.ts:64-89`) — `ChannelDock` 정의는 등록되어 있으나 실제 inbound 어댑터/라우트 미구현 (Plain capability metadata 만).

**Channel registry** (`channels/registry.ts`) — `initChannels()` 가 코어 도크 2종(`discord`, `http-webhook`) 만 자동 등록.

### 4. 자동화 (Phase 28)

**SchedulerService** (`packages/server/src/automation/scheduler.ts`) — 매 분 0초 폴러. `findDueSchedules` → 각 schedule 의 `agent.run` 직접 실행 → `agent_runs` 영속화 → `delivery` 콜백. `ConcurrencyLane(maxConcurrent: 1, queue: 50, wait: 5분)` 으로 직렬화.

**Cron parser** (`automation/cron.ts`) — 5필드 (분 시 일 월 요일). `*`, `*/N`, `M-N`, `M,N,O` 지원. `L`/`W`/`?` 비지원. POSIX OR 규칙 (dayOfMonth + dayOfWeek 둘 다 비기본 시 OR).

**연속 실패 자동 비활성화** — `AUTOMATION_MAX_CONSECUTIVE_FAILURES` (default 3) 회 연속 실패 시 `enabled=false`, `status='disabled'` 자동 전환.

**Delivery** (`automation/delivery.ts`) — `deliveryChannel === 'discord'` 면 Discord DM (DiscordClientPort), `'web'` 이면 `broadcastToChannel(connections, 'schedule.completed', payload)` WS notification. 송출 실패는 warn + agent_runs 보존.

**RPC**: `schedule.create/list/update/delete/runNow/history/enable/disable/testCron` 9개 (위 표 참조). `testCron` 은 표현식 검증 + 다음 N회 시각 미리 계산.

### 5. 운영 인터페이스

**Gateway RPC** (HTTP + WebSocket JSON-RPC, `packages/server/src/gateway/server.ts`) — 등록되는 메서드 모듈 9개:

- `system.*` (3개), `config.*` (3개, **stub**), `chat.*` (4개), `session.*` (3개)
- `finance.*` (9개: quote, news, alert.create/list, portfolio.get, transaction.add/list/update/delete)
- `agent.*` (3개) + `agent.runs.*` (2개)
- `memory.*` (3개), `schedule.*` (9개)

총 38개 (등록 기준).

**Web UI** (`packages/web/src/`) — 단일 페이지, Lit 기반. 5탭 (chat / market / portfolio / alerts / settings).

- **Portfolio 탭**: 보유 종목 + 거래 이력 (Phase 26 E), `portfolio.changed` WS notification 자동 갱신, "거래 추가" 모달.
- **Settings 탭**: 기억 목록 + 삭제, 자동화 (schedule CRUD + 즉시 실행 + enable/disable), agent_runs 이력 + 상세 펼침, 라우팅 통계 placeholder.

**TUI** (`packages/tui/`, Ink/React) — 5패널 (chat / market / portfolio / alerts / settings). market/portfolio/alerts 패널은 RPC 응답을 단순 렌더 (`DashboardView.tsx`). chat 은 `chat.start` → `chat.stream.*` notification 라우팅.

**CLI** (`packages/server/src/cli/`) — `commander` 기반 9개 커맨드 그룹. 위 표의 死 표시는 호출 RPC 가 미등록인 경우.

### 6. 확장 (Plugins / Extensions)

**`extensions/plugin-template/`** — `register(api: PluginBuildApi)` + `deactivate()` 패턴의 템플릿. `finclaw-plugin.json` manifest, `type: "skill"`. **본 코드는 死 — `packages/server/src/plugins/loader.ts` 가 존재하지 않으며, 어떤 플러그인 로더도 server 에 배선되지 않음.** 템플릿 파일 자체의 TODO 주석에 "@finclaw/server 가 exports 필드로 PluginBuildApi 를 노출하면 직접 import 로 전환" 라고 명시.

### 7. 기억 · RAG (Phase 26 — 활성화 완료)

**저장**: `memories` 테이블 (4 type: `fact`/`preference`/`summary`/`financial`), `memory_chunks_vec` (1024-d), `memory_chunks_fts` (trigram). `addMemory` / `addMemoryWithEmbedding` API.

**경로**:

- **수동 저장 (capture)**: 정규식 5종 — `!finclaw remember …`, `기억해: …`, `메모: …`, `선호: …`, `내 (투자) 원칙은 …` (`stages/memory-capture.ts`).
- **RAG 회상 (retrieval)**: 매 발화 hybrid vector+FTS, 임계값 0.65, 신선도 반감기 90일, 상한 3 (`stages/memory-retrieval.ts`).
- **agent.run 결과 → memory**: `attachMemoryService` (`auto-reply/agent-memory-hook.ts`) — output 길이 > 100 자, error 없음일 때 `type='financial'` 로 저장 후 `agent_runs.memory_id` 링크.
- **거래 이력 동시 주입**: 발화에서 티커 심볼 추출 (대문자 2-5자 정규식 + 통화/시간/약어 블록리스트) → 심볼별 최근 거래 3건 system prompt 에 함께 주입.

**임베딩 프로바이더**: `VOYAGE_API_KEY` 또는 `OPENAI_API_KEY` 가 있으면 `createEmbeddingProvider('auto')` 시도. 실패/미설정 시 모든 경로 FTS-only fallback (best-effort, 파이프라인 차단 없음).

**감사 로그**: `memory.injected` JSON 이벤트 (memoryIds/rawScores/adjustedScores/mode/transactionSymbols) — `logger.info` 로 emit.

---

## 死 코드 / 비활성 기능 (코드는 있으나 등록되지 않음)

1. **CLI → 미등록 RPC 호출 4종**:
   - `finclaw stop` → `system.shutdown` (RPC 미등록, `broadcaster.ts` 의 shutdown notification 송출 코드만 존재)
   - `finclaw alert remove` → `finance.alert.remove` (`finance.ts` 에 미존재)
   - `finclaw channel list` / `channel status` → `channel.list` / `channel.status` (RPC 미등록)
   - `finclaw market watch` — `commands/market.ts:39` 직접 "not yet implemented" 응답.
2. **Discord 슬래시 커맨드 4종 모두 비활성**:
   - `/ask` — placeholder 응답 ("Phase 9 runner 통합" TODO).
   - `/market`, `/news`, `/alert` — `deps.financeService` / `deps.alertStorage` 가 `main.ts` 에서 주입되지 않아 항상 "준비 중" 응답.
3. **HTTP Webhook 채널** — Dock 메타만 등록, 실제 inbound 라우트/어댑터 부재.
4. **`config.*` RPC** — 3개 모두 stub. TODO Phase 10 로 표시.
5. **Plugin 시스템** — `extensions/plugin-template/` 만 존재. 로더(`packages/server/src/plugins/loader.ts`) 자체 부재.
6. **Phase 27 (free APIs + key rotation)** — `plans/phase27/plan.md` 만 존재. Finnhub / Twelve Data / KeyRotator 코드 미반영. provider-registry 는 여전히 Alpha Vantage + CoinGecko + Frankfurter 만.

---

## 메타데이터

### 출처 (라인 단위)

- 파이프라인: `packages/server/src/auto-reply/pipeline.ts:79-319`
- 정규화: `packages/server/src/auto-reply/stages/normalize.ts:25-49`
- 명령어 단계: `packages/server/src/auto-reply/stages/command.ts:20-51`
- 컨텍스트 단계: `packages/server/src/auto-reply/stages/context.ts:14-39`, `pipeline-context.ts:1-60`
- 인-채팅 명령어: `packages/server/src/auto-reply/commands/built-in.ts:17-144`
- Memory Capture: `packages/server/src/auto-reply/stages/memory-capture.ts:26-149` (정규식 5종 25-35행)
- Memory Retrieval: `packages/server/src/auto-reply/stages/memory-retrieval.ts:14-336` (상수 14-31행)
- agent.run → memory hook: `packages/server/src/auto-reply/agent-memory-hook.ts:14-133`
- Scheduler: `packages/server/src/automation/scheduler.ts:69-351`
- Cron parser: `packages/server/src/automation/cron.ts:35-160`
- Schedule delivery: `packages/server/src/automation/delivery.ts:33-109`
- RPC system: `packages/server/src/gateway/rpc/methods/system.ts:9-72`
- RPC config (stub): `packages/server/src/gateway/rpc/methods/config.ts:8-49`
- RPC chat: `packages/server/src/gateway/rpc/methods/chat.ts:46-178`
- RPC session: `packages/server/src/gateway/rpc/methods/session.ts:38-94`
- RPC finance: `packages/server/src/gateway/rpc/methods/finance.ts:195-595`
- RPC agent: `packages/server/src/gateway/rpc/methods/agent.ts:157-451`
- RPC agent.runs: `packages/server/src/gateway/rpc/methods/agent-runs.ts:33-137`
- RPC memory: `packages/server/src/gateway/rpc/methods/memory.ts:106-229`
- RPC schedule: `packages/server/src/gateway/rpc/methods/schedule.ts:93-395`
- RPC 등록 사이트: `packages/server/src/gateway/server.ts:84-115`
- Channel docks: `packages/server/src/channels/dock.ts:33-92`, `channels/registry.ts:1-36`, `channels/init.ts:10-16`
- CLI 진입점: `packages/server/src/cli/program.ts:26-81`
- CLI 커맨드: `packages/server/src/cli/commands/{start,stop,agent,channel,config,market,news,alert,tui}.ts`
- Discord commands: `packages/channel-discord/src/commands/{index,ask,market,news,alert}.ts`
- skills-finance/market: `packages/skills-finance/src/market/index.ts:35-247`
- skills-finance/news: `packages/skills-finance/src/news/{index.ts:60-123, tools.ts:28-241}`
- skills-finance/alerts: `packages/skills-finance/src/alerts/{index.ts:65-150, tools.ts:1-80}`
- skills-general: `packages/skills-general/src/{index.ts:24-52, datetime.ts, web-fetch.ts, file-read.ts}`
- Web UI views: `packages/web/src/{main.ts, app.ts:1-100, views/*.ts}` (특히 `settings-view.ts:1-672`)
- TUI: `packages/tui/src/{App.tsx:24-120, DashboardView.tsx:28-60}`
- main.ts wiring: `packages/server/src/main.ts:135-504`
- env example: `/.env.example:1-26`
- Plugin template: `extensions/plugin-template/{finclaw-plugin.json, src/index.ts}`
- Phase 21+ 컨텍스트: `plans/phase{21,22,23,24,25,26,27,28}/plan.md` (각 헤더)

### 누락 가능성 (탐색했으나 확신 못 한 영역)

- **`/help` 등 명령어가 한국어 alias 와 한자 alias 를 가짐** — `built-in.ts` 에 `'h', '도움말'`, `'clear', '초기화'`, `'상태'`, `'시세', 'quote'`, `'포트폴리오', 'pf'`, `'알림'` — 표에는 영어 1개만 표기.
- **`MarketCache` SQLite 캐시 정책** — TTL/eviction 동작은 별도 카탈로그 항목 없음 (관리 기능이 아니라 내부 최적화로 분류).
- **`chat.stream.*` notification 5종** (delta/end/error/tool_start/tool_end) — TUI/Web 양쪽 핸들링 확인했으나 notification 자체는 RPC 메서드가 아니므로 표에서 제외.
- **`portfolio.changed` notification** — finance.transaction.\* 가 broadcast. WebSocket subscriber 가 자동 수신.
- **`notification.schedule.completed`** — Web settings-view 에서 toast 처리. 본 카탈로그에서는 자동화 송출 항목으로 흡수.
- **모델 라우팅 (Phase 24)** — 사용자 가시 surface 가 아니라 정책 (`role` 필드, `modelHint`). `chat.send.modelHint`, `agent.run.role` 옵션으로 사용자 노출.
- **HTTP REST 엔드포인트** (`router.ts`) — JSON-RPC 외 REST 라우트 존재 가능성 미확인.
- **`http-webhook` 채널 dock** — 등록되어 있지만 inbound 라우트 부재. 내부 dispatcher 는 있을 수 있으나 본 카탈로그에서는 死 처리.
- **Phase 27 영문/미국 주식 확장** — plan.md 만 존재. 코드 미반영을 확인했지만 Twelve Data/Finnhub provider 파일이 다른 위치에 존재할 가능성은 별도 검증 필요.
