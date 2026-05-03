# Interface & Channels Audit

> 평가 대상: `packages/server/src/gateway/`, `packages/server/src/automation/`,
> `packages/server/src/channels/`, `packages/server/src/plugins/`,
> `packages/{channel-discord, tui, web}/` (브랜치 `feature/automation`, 2026-05-03 시점).
>
> 룰릭: `references/rubric.md` §4 "Interface & Channels".
> 사용자 제약: 1인 사용자 → 멀티 테넌시·OAuth 결손 우선순위 ↓; 감사·환각 방지·읽기 전용 가중치 ↑.

---

## 0. 요약 & 점수 카드

| §   | 평가 축                       | 점수      | 한 줄 코멘트                                                                                                                                                                                                     |
| --- | ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 | 채널 다양성                   | **4 / 5** | Discord(인바운드 mention/DM, /ask 슬래시는 placeholder), TUI(ink 풀 클라이언트), Web(Lit + 5개 뷰) 3채널 일관 동작. mobile/voice 부재(의도).                                                                     |
| 4.2 | 게이트웨이 프로토콜           | **3 / 5** | JSON-RPC 2.0 + WebSocket 알림 + 4-tier auth + CORS + health/healthz/readyz 모두 가용. OpenAI-호환 endpoint stub(501) + REST/MCP 부재. **rate-limit / hot-reload / access-log 가 main.ts 에 미배선** (코드 존재). |
| 4.3 | 인증·권한                     | **3 / 5** | API key + JWT(HS256, alg-confusion 방어) + Permission enum + auth-rate-limit; **세션-사용자 매핑 약함** (TUI 가 anon 세션 키 자동 생성), OAuth/RBAC 부재.                                                        |
| 4.4 | 실시간 UX                     | **4 / 5** | WebSocket 자동 재연결(지수 백오프) + 150ms delta 배치 + slow-consumer 보호 + heartbeat + portfolio.changed/schedule.completed 자동 구독. **다중 디바이스 상태 동기화 부재** (개인 1인 한정으로 OK).              |
| 4.5 | 자동화 / proactive            | **4 / 5** | 5필드 cron + 1분 폴러 + 전용 lane(1) + 실패 자동-disable + agent_runs 링크 + Discord/Web 송출 모두 production-ready. **재시도/dead-letter 정책은 명시적으로 X** (단순함 우선 결정).                              |
| 4.6 | 외부 도구 연결 (MCP / plugin) | **1 / 5** | plugin 인프라(매니페스트 Zod / discovery / 5-stage loader / hook-bus)는 **완성됐지만 main.ts 에서 호출되지 않음 (dead module)**. MCP·OAuth·외부 webhook 클라이언트 전무.                                         |
| 4.7 | UI 풍부도                     | **3 / 5** | 5개 view (chat / market / portfolio[holdings+transactions tabs] / alerts / settings) + transaction 모달 + schedule 모달 + 마크다운 렌더링(DOMPurify). Canvas/Artifacts/파일 업로드 부재.                         |

**평균 3.14 / 5** — 룰릭 기준 "MVP / Production-ready" 등급. 자동화·실시간 UX 가 4점대로 강점. 외부 통합(4.6)이 단일 critical 갭.

**Critical gap 수: 2** (외부 통합 부재; gateway 운영성 모듈 unwired). Important: 5. Nice-to-have: 4.

---

## 1. 채널 비교 매트릭스 (Discord vs TUI vs Web vs 현대 비서)

| 사용자 의도                  | Discord                                                                                                  | TUI                                                                                        | Web                                                                   | ChatGPT iOS/Web  | Claude.ai Web | Slack/Discord 봇 표준 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------- | ------------- | --------------------- |
| "오늘 시세 알려줘" 입력 경로 | DM 전송 / 길드 채널에서 봇 멘션 (auto-reply pipeline)                                                    | 채팅 패널에 자유 텍스트 (chat.send RPC)                                                    | Chat tab 자유 텍스트 (chat.send RPC)                                  | 자유 텍스트      | 자유 텍스트   | slash + 자유 텍스트   |
| 슬래시 명령                  | `/ask`, `/market`, `/news`, `/alert` 등록 — **`/ask` 는 placeholder 응답만** (`commands/ask.ts:19` TODO) | `/help /market /portfolio /alerts /settings /quit` 클라이언트 측 명령 (chat 메시지 전송 X) | 미구현 (메시지 자유 입력만)                                           | n/a              | n/a           | 표준                  |
| 스트리밍 인디케이터          | `sendTyping()` (best-effort) `adapter.ts:90` + ack 메시지 (auto-reply ACK 스테이지)                      | `chat.stream.delta` 누적 + 깜박이는 커서 `▊` `App.tsx:73-87`                               | `streamBuffer` 누적, 마크다운 처리는 종결 메시지에만 `app.ts:222-229` | ✓                | ✓             | typing indicator      |
| 응답 포맷                    | discord embed + 2000자 chunking `sender.ts:25-37` (last chunk 에 임베드)                                 | ANSI 색상 + Static rendering `ChatView.tsx:46-50`                                          | DOMPurify 마크다운 `markdown.ts:17` (h1-h4, code, lists, links)       | Canvas/Artifacts | Artifacts     | 임베드 + 버튼         |
| 첨부/이미지                  | `supportsImages: true` 메타에 노출되나 인바운드 처리 없음 (메시지 본문만 추출, `handler.ts:30`)          | text-only                                                                                  | text-only                                                             | image/file       | image/file    | image                 |
| reactions                    | `addReaction` 미구현 (`adapter.ts:106` TODO)                                                             | n/a                                                                                        | n/a                                                                   | feedback 버튼    | thumbs        | ✓                     |
| threads                      | `threadingMode: 'native'` `dock.ts:55`, threadId 인바운드 추출 `handler.ts:34`                           | n/a                                                                                        | 단일 chat                                                             | branch           | n/a           | ✓                     |
| 승인 버튼                    | `buildApprovalRow` + 5분 타임아웃 `buttons.ts:13,22` (인간-인-루프)                                      | n/a                                                                                        | n/a                                                                   | tools approval   | tool approval | ✓                     |
| 자동화 결과 수신             | DM (delivery.ts → `users.fetch().createDM().send`)                                                       | 없음 (TUI 는 `notification.schedule.completed` 수신 안 함)                                 | toast 3.5초 + 테이블 자동 갱신 (settings-view.ts:260-272)             | Tasks 알림       | (limited)     | bot DM                |

**채널 추상화 품질** (`channels/dock.ts`, `registry.ts`): `ChannelDock` 타입에 capabilities·outboundLimits 가 올바르게 모델됨. Discord/HTTP-Webhook 두 코어 dock 만 등록. `ChannelPlugin` 추상화는 존재 (`channel-discord/src/adapter.ts`) — auto-reply pipeline 이 이를 통해 deliver. **TUI/Web 은 ChannelPlugin 이 아니라 gateway WS 연결 수준에서 처리** — 이중 추상화 (ChannelDock + ChatRegistry session). 일관 UX 지킴.

**격차**: Discord `/ask` 가 stub 응답이라 길드 사용자가 _슬래시_ 로 묻는 경로가 끊김. 본 봇이 활성화된 이후로 `auto-reply pipeline + mention/DM` 로만 작동 — 슬래시 커맨드 routing 이 placeholder 인 채로 노출됐다는 사실은 사용자 혼란을 야기할 수 있음 (Important 갭).

---

## 2. 게이트웨이 메서드 카탈로그

총 **38개** RPC 메서드 (등록 측 기준; system 3 + config 3 + chat 4 + session 3 + finance 9 + agent 3 + agent.runs 2 + memory 3 + schedule 9). 카탈로그 는 `system.info` 응답의 `methods[]` 로 노출 (`gateway/rpc/methods/system.ts:49`).

| 도메인     | 메서드                                                                                                                                  | authLevel       | 비고                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| system     | `system.health`, `system.info`, `system.ping`                                                                                           | none            | 항상 공개                                                                                       |
| config     | `config.get`, `config.update`, `config.reload`                                                                                          | token           | **stub** (TODO Phase 10 — 본 PR 시점에 미연결)                                                  |
| chat       | `chat.start`, `chat.send`, `chat.stop`, `chat.history`                                                                                  | token / session | session 레벨 = chat.send/stop. WebSocket 만 (chat.start 가 `connectionId` 강제).                |
| session    | `session.get`, `session.reset`, `session.list`                                                                                          | token           |                                                                                                 |
| finance    | `finance.quote`, `finance.news`, `finance.alert.{create,list}`, `finance.portfolio.get`, `finance.transaction.{add,list,update,delete}` | token           | provider 미주입 시 `provider_unavailable`. transaction 변경 → `portfolio.changed` broadcast.    |
| agent      | `agent.list`, `agent.status`, `agent.run`                                                                                               | token           | run 결과 → agent_runs + memory.attach. stream:true 는 명시적 거부 (`use chat.* for streaming`). |
| agent.runs | `agent.runs.list`, `agent.runs.get`                                                                                                     | token           | 감사 이력. prompt 200자 / output 500자 truncate, get 은 toolCalls JSON 파싱.                    |
| memory     | `memory.list`, `memory.delete`, `memory.search`                                                                                         | token           | embeddingProvider 없으면 search 는 FTS-only fallback.                                           |
| schedule   | `schedule.{create,list,update,delete,runNow,history,disable,enable,testCron}`                                                           | token           | testCron 으로 등록 전 미리보기. 9개 — 자동화 도메인에서 가장 두꺼움.                            |

**프로토콜 표면**:

- `POST /rpc` (HTTP): 단일 + 배치 (max 10) 지원 `rpc/index.ts:46`. parse error → -32700.
- `GET /health` (요약), `GET /healthz` (liveness, 항상 200), `GET /readyz` (readiness; DB·provider checker 등록 가능, hasUnhealthy → 503) — Kubernetes-style probe 분리 `health.ts:22-66`.
- `GET /info`: name + version + capabilities (`['streaming', 'batch', 'subscriptions']`).
- `POST /v1/chat/completions` (OpenAI 호환): **stub** — stream:true → `data: [DONE]\n\n` 즉시 종료, non-stream → 501. flag `openaiCompat.enabled` 도 default config 에 미설정 (실질적으로 dead path).
- `WebSocket /` (path 어디든 ws upgrade): 인증 → connection 등록 → message → dispatchRpc → response.
- `OPTIONS /*` CORS preflight.

**REST 부재**: 의도적. WS 가 read/write 모두 처리하므로 별도 REST 엔드포인트 없음. 단점 — curl/script 통합엔 `/rpc` POST 가 충분하지만 수많은 GET-only 의 read-side (예: `finance.quote`) 가 RPC body 안에 갇힘. 1인 비서 한정으론 negligible.

**rate-limit / access-log / hot-reload — 코드 존재, 미배선**:

- `rate-limit.ts` `RequestRateLimiter` (슬라이딩 윈도우, MAX*KEYS=10000 evict, X-RateLimit-* 헤더). 테스트도 있음. `gateway/index.ts:41` 에서 export 되지만 `server.ts` / `main.ts` 어디서도 사용처 없음 — `grep -rn "RequestRateLimiter\|new RequestRateLimiter"` 결과 0건 (`_.test.ts` 제외). **불활성화 모듈** (Critical gap).
- `access-log.ts` `createAccessLogger`: 동일 — barrel re-export 만, 호출 없음. `X-Request-Id` 응답 헤더가 누락되어 운영자가 요청 추적 불가.
- `hot-reload.ts` `createHotReloader`: 마찬가지. `config.reload` RPC 도 stub. Phase 11 산출물이 미연결로 남음.

**auth/rate-limit.ts** (`AuthRateLimiter`) 도 export 만 — `gateway/auth/index.ts:65` re-export, 실제 인증 경로 (`authenticate`) 안에서 호출 없음. 무차별 brute-force 방어 부재.

**보안 정책 정리**:

- API key: SHA-256 + `timingSafeEqual` `api-key.ts:12-31`. ✓
- JWT (HS256): `alg confusion` 방어 `token.ts:32`, sig timing safe, exp 검증. permissions 캐스트만 (TODO review-2 미해결). ✓
- 토큰 우선순위: Bearer > `?token=` (WS browser 호환) > X-API-Key > none. `auth/index.ts:13`.
- HTTP `/rpc` 도 WS 와 동일한 `authenticate()` 호출 (`router.ts:103` Phase 23 post-ship fix 코멘트). ✓
- CORS: origins == `['*']` default — 1인 비서엔 OK 이나 production 배포 시 화이트리스트 권장 (Important).

---

## 3. 자동화 신뢰성 평가 (Phase 28)

### 3.1 cron 파서 (`automation/cron.ts`)

- 5필드 (분/시/일/월/요일), `*` `*/N` `M-N` `M,N,O` 조합. POSIX OR 의미 (dom 과 dow 모두 비-`*` → OR). `L` `W` `?` 미지원 — 명시적.
- `parseCron` → `CronParseError` 에 expr/field 포함, RPC 가 `invalid_params:` 로 wrap.
- `nextRunAt`: brute-force 1년 한도 — 단순. 빈 매칭 시 `null` 반환. 시간대 = `Date.getMinutes/Hours` (server local) — **timezone 처리 부재** (Important if 사용자 timezone 이 server 와 다르면 cron 의미가 어긋남).

### 3.2 SchedulerService (`automation/scheduler.ts`)

- 다음 분 경계로 보정 후 `setInterval(60_000)` 시작. 첫 tick timer 별도 — graceful start.
- 매 tick: `findDueSchedules(now)` → 각 schedule lane.acquire → `runOne` (active set 으로 동일 schedule 동시성 차단).
- agent.run 호출 후 `addAgentRun` → `UPDATE agent_runs SET schedule_id = ?` 링크. 모델 fallback chain 활성 (Phase 24 D 의 `runWithModelFallback`).
- 실패 처리:
  - `error` → `consecutiveFailures++`. `>= maxConsecutiveFailures (default 3)` 일 때 `enabled=false, status='disabled'` 자동 disable.
  - 성공 → `consecutiveFailures=0, status='active'`. 자기-치유 ✓.
  - 실패도 `addAgentRun({error})` 로 기록 — 감사 trail 보존.
  - `ModelFloorExhaustedError` 별도 분기 → `model_floor_exhausted: <floor>` error string.
- 동시성: `lane.acquire(s.id)` (main.ts: `maxConcurrent:1, maxQueueSize:50, waitTimeoutMs:5min`). 다음 tick 이 진입 시 `active` set 검사 + `markScheduleRun(nextRunAt 만 미루기)` 로 skip. ✓
- shutdown: `lifecycle.register(scheduler.stop)` + 60초 활성 run 대기 후 `forcedExit:true` 로그.

### 3.3 Delivery (`automation/delivery.ts`)

- discord 채널: `DiscordClientPort` 포트 패턴 (discord.js 직접 의존 회피, 테스트 가능) → `users.fetch(target).createDM().send(...)`. 2000자 초과 시 본문 truncate (`…(잘림)`).
- web 채널: `broadcaster.broadcastToChannel('schedule.completed', payload)` — WS 자동 구독 (`ws/connection.ts:48`).
- **재시도 없음** — 송출 실패 → warn 로그만. `agent_runs` 는 보존되어 사후 조회 가능.
- 에러 메시지에 ⚠️ 이모지 + 한국어 — 사용자 친화적 ✓.

### 3.4 RPC 표면 (`schedule.ts`)

9개 메서드 모두 `authLevel: 'token'`. `testCron` 의 `sampleCount ≤ 20`, `history limit ≤ 200`, `name/prompt` 길이 제한 — 입력 검증 ✓. cron parse 실패 → `invalid_params:` (RPC dispatcher 가 INTERNAL_ERROR 로 wrap; 사용자 메시지엔 노출되지만 코드 -32603 으로 받음. 적절한 -32602 로의 매핑은 없음 — Nice-to-have).

### 3.5 갭 (자동화)

- **Important**: timezone 처리 없음 — `Date.getHours()` 가 server TZ. 1인 비서가 server 와 같은 TZ 면 OK, 그렇지 않으면 cron 시각이 어긋남. 사용자 `timezone` 컬럼 추가 + `Intl.DateTimeFormat` 사용 권장.
- **Important**: delivery 실패 시 사용자 가시성 부재. agent*runs 는 보존되지만 *송출 실패\_ 사실을 별도 기록하지 않음 → 사용자가 "실행됐는데 알림이 안 왔다"를 디버깅하려면 server log 확인 필요. `schedule_deliveries` 테이블 또는 `agent_runs.delivery_status` 컬럼 권장.
- **Nice-to-have**: dead-letter / 재시도 정책 — 룰릭 4점 기준의 "재시도 / dead letter / 이력 조회". 의도적 결손이지만 명시 가능.
- **Nice-to-have**: 알림 채널 라우팅 / 사용자 승인 흐름 (룰릭 5점) — 1인 비서엔 과잉.

ChatGPT Tasks / Claude.ai schedule (limited) / Slack 봇 scheduler 비교: ChatGPT Tasks 는 자연어 스케줄 + 이메일 알림이 강점. FinClaw 는 **raw cron + DM/Web** 으로 더 정밀하지만 자연어 입력 부재 (의도 — 환각 방지). Slack 봇 scheduler 와는 동급.

---

## 4. 외부 도구 연결 (MCP / Plugin / Webhook / OAuth)

### 4.1 MCP (Model Context Protocol)

- `grep -rn --include='*.ts' --include='*.md' 'model[- ]context[- ]protocol\|@modelcontextprotocol' packages/ plans/` → **0건**.
- MCP 서버 노출 (FinClaw 도구를 다른 LLM 클라이언트로) 부재.
- MCP 클라이언트 (외부 MCP 서버 도구를 FinClaw agent loop 에 주입) 부재.
- 룰릭 4.6 — MCP 클라이언트=4점, MCP 서버=5점 기준 모두 **0**.

### 4.2 Plugin 시스템 (server/src/plugins)

**구현 완성도 높음** — `discovery.ts` (searchPaths 스캔), `manifest.ts` (Zod v4 strict + JSON Schema 자동 생성), `loader.ts` (5-stage 파이프라인: Discovery → Manifest → Security → 3-tier Load[ESM native / Node 24 TS strip / jiti] → Register), `registry.ts` (slot: channels/hooks/services/commands/routes/diagnostics), `hooks.ts` (HookMode), `event-bridge.ts`. **테스트 충실**.

**하지만**: `grep -rn 'loadPlugins' packages/server/src/` 결과는 `plugins/loader.ts:163` (정의) + `plugins/index.ts:31` (re-export) 둘뿐. **`main.ts` 에서 호출 X**. plugin 매니페스트 디렉토리 존재 안 하고, `searchPaths` / `allowedRoots` 가 어디서도 구성되지 않음.

→ **Critical gap**: 룰릭 3점 기준 "plugin 인터페이스 존재"는 충족하나 활성화 안 된 dead module 이라 외부 확장이 사실상 불가. `_workspace/audit/architecture` 와 함께 결정 필요 — 단순화 결정으로 폐기 vs `loadPlugins` 호출 활성화.

### 4.3 OAuth (Gmail / Calendar / Notion / etc)

- `grep -rn --include='*.ts' 'oauth\|OAuth\|OAUTH' packages/` → **0건** (소스 한정).
- 외부 SaaS 통합 부재. 1인 비서 + 읽기 전용 원칙 → **의도적 결손** (Letta/MemGPT 와 ChatGPT custom GPT 연동 비해 약하지만 본 사용자 사이 즈에선 합리적).

### 4.4 Webhook

- `http-webhook` 코어 도크 (`channels/dock.ts:64`) — 메타만 등록. 실제 webhook receive endpoint 없음 (router.ts 에 등록 안 됨). 송신용 `webhook` adapter 도 없음.
- 인바운드 webhook 으로 외부 시스템(github/zapier/etc) 이 FinClaw 를 트리거하려면 별도 RPC 키 만들어 `POST /rpc` 로 호출 가능 — capability 는 있되 specialized integration 없음.

### 4.5 갭 (외부 통합)

- **Critical**: MCP 클라이언트 부재 — Claude.ai 의 핵심 차별화. 1인 비서라도 외부 MCP 서버(filesystem, github, time, sqlite 등 표준 서버) 를 도구로 추가하면 능력 폭발적으로 확대. Phase 30+ 에서 우선 후보.
- **Important**: plugin loader 미배선. 결정 필요 — (a) 단순함 우선해서 plugins/ 폐기, 또는 (b) main.ts 에서 `loadPlugins(['~/.finclaw/plugins'], [...])` 호출 + 첫 외부 plugin 작성.
- **Nice-to-have**: MCP 서버 노출 — FinClaw 의 finance._ / memory._ / schedule.\* RPC 를 표준 MCP 서버로도 제공하면 Claude.ai 등에서 직접 사용 가능. (자기 상태 외부 노출 → 보안 검토 필요)
- **Nice-to-have**: OAuth 통합 (Google Calendar 일정 → schedule 자동 등록 등) — 의도적 결손이라면 명시.

---

## 5. UI 풍부도 (Web)

### 5.1 컴포넌트 인벤토리

| 뷰        | 라우트 탭   | 내용                                                                                                                                                                                                                                         |
| --------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chat      | `chat`      | 메시지 리스트 + 마크다운 (DOMPurify, h1-h4/code/lists/links/blockquote 만 허용) + streaming 버퍼 + send button. `app.ts:209-247`.                                                                                                            |
| market    | `market`    | 시세 조회 form. `market-view.ts`.                                                                                                                                                                                                            |
| portfolio | `portfolio` | 2 tab: holdings / transactions. `portfolio.changed` notification 자동 갱신 + transaction 추가 모달 (`transaction-form.ts` — Zod 1차 클라 검증 + 서버 2차).                                                                                   |
| alerts    | `alerts`    | 알림 생성 form + 리스트. `alerts-view.ts`.                                                                                                                                                                                                   |
| settings  | `settings`  | **4 섹션**: 기억 (filter + delete) / 자동화 (Phase 28: list + 즉시실행/활성/삭제 + + 등록 모달) / 에이전트 실행 이력 (expand/collapse + tool call detail) / 라우팅 통계 (placeholder). `settings-view.ts:618` "Phase 24+ 산출 가용 시 표시". |

### 5.2 강점

- **마크다운 + XSS 보호**: `markdown.ts` — marked + DOMPurify 화이트리스트. ✓
- **Lit web components** + shadow DOM CSS encapsulation. 11KB ~14KB 정도의 작은 산출물 추정.
- **5 view + modal 2개 (transaction-form, schedule-form)** — 룰릭 4점 "실시간 차트 + 모달 폼 + 상세 뷰" 중 모달·상세 ✓, 차트 부재.
- **schedule-form**: cron preset 4개 + 250ms-debounced testCron 라이브 미리보기 — 룰릭의 "wizard" 표준에 근접.
- **agent_runs detail panel**: prompt/output/error/toolCalls JSON pretty-print + 메타데이터 (model/role/duration/tokens). 감사·환각 방지 사용자 가중치에 직접 부합.

### 5.3 격차 (UI)

- **Important**: 차트 부재 — portfolio 가치 변화 / market chart / agent_runs latency 분포 등. 1인 비서라도 시계열 시각화는 가치 큼. Chart.js / lightweight-charts (TradingView) 추가 가능.
- **Important**: TUI 가 `notification.schedule.completed` 미수신 — Web 만 toast 받고 TUI 사용자는 자동화 결과를 cli 알림으로 못 봄. `tui/src/App.tsx:69-127` notification switch 에 케이스 추가 필요 (작업량 S).
- **Important**: TUI 의 dashboard view 가 portfolio/market/alerts/settings 4개 탭 모두 대응한다고 선언 (`PANELS` `App.tsx:22`), 하지만 `DashboardView.tsx` 를 못 봤다 — Settings 의 memory/automation 등은 Web 전용일 가능성 (TUI 채널 일관성 ↓).
- **Nice-to-have (rubric 4.7=5)**: Canvas / Artifacts — 협업 산출물 영역. ChatGPT Canvas / Claude.ai Artifacts 가 갖는 "in-conversation editable doc" 기능. 1인 금융 비서 use case 에선 _재무 분석 리포트 산출물 영구 보관_ 형태로 가치 있을 수 있으나 우선순위 낮음.
- **Nice-to-have**: 파일 업로드 (분기 실적 PDF, 거래 내역 CSV import) — `transactions` source 가 `'manual' | 'import'` 로 enum 만들어 둔 것 보면 의도한 후속 작업.

---

## 6. 갭 종합 (Critical / Important / Nice-to-have)

### 6.1 Critical

1. **외부 도구 통합 부재 (MCP 클라이언트/서버 + plugin 미배선)**
   - 영향: 사용자 (확장 능력 무), 운영자 (생태계 격리), 개발자 (내부 도구만 가능)
   - 추정: M (MCP 클라이언트 1개 도구 통합 2-4주)
   - 코드: `packages/server/src/plugins/*` 가 dead module, MCP 부재
2. **gateway 운영성 모듈 미배선 (RequestRateLimiter, createAccessLogger, createHotReloader, AuthRateLimiter)**
   - 영향: 운영자 (요청 추적 / brute-force 방어 / 설정 핫리로드 0), 사용자 (간접)
   - 추정: S (각 모듈 wire-up 1-2일, 테스트 보강 포함)
   - 코드: `gateway/index.ts:41` re-export 만 존재, `server.ts` / `main.ts` 에서 호출 X. `config.{get,set,reload}` RPC 도 stub.

### 6.2 Important

3. **OpenAI-호환 endpoint 가 stub** (`openai-compat/router.ts:60` `data: [DONE]` 즉시 반환, non-stream 501)
   - 영향: 외부 OpenAI SDK 사용자가 FinClaw 를 LLM proxy 로 못 씀. flag 로 가려져 있어 발견 어려움.
   - 추정: M (runner 결과 → adaptResponse 배선)
4. **Discord `/ask` 슬래시 placeholder** (`commands/ask.ts:19-26` `'[placeholder] ${question}에 대한 AI 응답'`)
   - 영향: 길드 사용자 혼란. 본 봇은 mention/DM 로만 동작하므로 슬래시는 죽은 표면.
   - 추정: S (auto-reply pipeline 호출 또는 슬래시 disable)
5. **scheduler timezone 처리 부재** — server local TZ 의존 (`cron.ts:118-121`)
   - 영향: 1인 비서가 server 와 다른 TZ 일 때 cron 시각 불일치
   - 추정: S (사용자 timezone 컬럼 + `Intl.DateTimeFormat` 사용)
6. **delivery 실패 가시성 부재** — schedule 결과는 agent_runs 에 있으나 송출 실패는 server log 만
   - 영향: 사용자 디버깅 곤란
   - 추정: S (`agent_runs.delivery_status` 컬럼 또는 별도 테이블)
7. **TUI 의 notification.schedule.completed 미수신** (`tui/src/App.tsx:69-127`)
   - 영향: TUI 사용자만 자동화 결과 toast 못 받음 → 채널 일관성 ↓
   - 추정: S
8. **CORS default `['*']` (`main.ts:69`) + plugin loader 미사용 결정 미명시**
   - 영향: 운영 배포 시 보안. plugin 결정은 architecture-auditor 와 합의 필요.
   - 추정: S

### 6.3 Nice-to-have

9. **차트 / 시각화** (portfolio time series, market chart) — 룰릭 4.7=4점 기준
10. **파일 업로드** (CSV import for transactions) — `source='import'` enum 이미 존재
11. **MCP 서버 노출** (FinClaw 의 RPC 를 외부 Claude.ai/cursor 등이 직접 호출) — 룰릭 4.6=5점
12. **OAuth 외부 통합** (Calendar → schedule auto-import 등) — 의도적 결손이면 README 에 명시

---

## 7. 채널 일관성 — "오늘 시세 알려줘" 시뮬레이션

| 단계           | Discord                                                                                                                 | TUI                                                                      | Web                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 입력           | `@FinClaw 오늘 NVDA 시세 알려줘` (mention)                                                                              | chat 패널에 자유 텍스트                                                  | chat tab 자유 텍스트                                                                           |
| 1. 게이트      | `handler.ts:24` mention 검사, cleanContent                                                                              | `chat.send` RPC (session bound)                                          | 동상                                                                                           |
| 2. 인증        | discord bot 자체 토큰 (앱 단위)                                                                                         | `?token=` 또는 Bearer                                                    | `?token=` (app.ts:154)                                                                         |
| 3. 파이프라인  | auto-reply pipeline 6단계 (normalize → command → memory-capture → ack → context → memory-retrieval → execute → deliver) | gateway adapter `executeForTui` (chat.send 핸들러 안에서 직접 streaming) | 동상                                                                                           |
| 4. 스트리밍    | typing indicator → ack 메시지 → 최종 chunk(2000자 단위)                                                                 | chat.stream.delta → 누적 텍스트 (▊ 커서)                                 | chat.stream.delta → streamBuffer + 마크다운 (단, stream 중엔 plain text, end 시 마크다운 렌더) |
| 5. 결과 영속화 | `memories` (자동 추출 X, 명시적 선언만) + `agent_runs` (Phase 26 D)                                                     | 동상                                                                     | 동상                                                                                           |

**일관성 점수**: 동일 sessionKey 정책은 채널마다 다름 — TUI 는 `tui:${userId}:${agentId}` (`chat.ts:42`), Web 은 URL `?session=` 또는 random UUID (`app.ts:157`), Discord 는 auto-reply pipeline 내부에서 derive. 같은 사용자가 Web ↔ Discord 를 오가면 **세션 격리** — 의도적이지만 cross-channel memory 공유는 `memory.list` 가 모든 sessionKey 를 가로지르므로 (`memory.ts:77`) 결과적으로 _기억_ 은 공유, _대화 이력_ 은 격리. ChatGPT 의 "Continue this chat on iOS" 같은 cross-device sync 부재 — 1인 비서엔 OK.

---

## 8. observability 노출

- `access-log.ts` 미배선 (Critical 1) → 운영자가 RPC 호출 이력을 stdout JSON 으로 못 받음.
- `getEventBus()` 가 `gateway:rpc:request`, `gateway:rpc:error`, `gateway:auth:failure`, `gateway:ws:connect`, `gateway:ws:disconnect`, `system:ready` 등 발행 (`rpc/index.ts:78`, `auth/index.ts:27`, `ws/connection.ts:54,90`) — listener 측은 `infra` 의 logger 가 다룸.
- `broadcaster.test.ts` 에서 slow consumer 보호 (1MB / market.tick 256KB) 검증 — 운영 robust.
- `health.ts` 컴포넌트 헬스 체커 등록 가능 (`registerHealthChecker`) — `main.ts` 에서 DB/provider 헬스 등록 확인 필요. **현재 `main.ts` 에 `registerHealthChecker` 호출 0건** — `/readyz` 가 components: [] 로 항상 ok 반환 (Important).

---

## 9. 통신 노트 (다른 audit 와의 합의)

- `runtime-tools-auditor` 와 합의 필요: streaming 끝단 (`broadcaster.send` → `chat.stream.delta`) 가 runtime 의 `StreamEvent` 와 일치. 본 audit 결과 `tool_use_start/end` 가 즉시 + `text_delta` 150ms 배치 + `done`/`error` 즉시 — 표준 동작. listener 미주입 시 (chat.send 의 conn 미발견) 응답은 정상 반환되되 stream notification 만 drop — 정상 fallback.
- `architecture-auditor` 와 합의 필요: **plugins/ 모듈을 활성화 vs 폐기**. Critical gap 1 의 결정 의존. 룰릭 1.3 (확장성: 5점=external plugin/MCP runtime 등록) 과 4.6 동시 영향.

---

## 10. 결론

FinClaw 의 인터페이스 표면은 **현대 1인 AI 비서 MVP 기준을 충족** (평균 3.14/5). 자동화 (Phase 28) 와 실시간 UX 가 4점대 강점. 단점은:

1. **외부 통합 (MCP/plugin/OAuth) 0** — 1인 비서로 의도된 결손이지만 MCP 클라이언트 1개라도 추가하면 능력 비약.
2. **운영성 모듈 dead code** — rate-limit, access-log, hot-reload 가 export 만 됨. wire-up 비용 작음.
3. **채널 일관성 미세 결손** — Discord `/ask` placeholder, TUI 가 schedule 알림 미수신.

읽기 전용·감사·환각 방지 가중치에 비추면 **현재 점수 + cron timezone + delivery_status + access-log 만 보강해도 4.0** 도달 가능.

---

interface-channels audit done — 점수 평균 3.14/5, critical gap 수 2
