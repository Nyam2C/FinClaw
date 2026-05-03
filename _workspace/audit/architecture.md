# Architecture Audit

> 대상: FinClaw (`feature/automation` @ commit 30913d7), 11 패키지 / 462 TS 파일 / 56,195 LOC / 173 테스트 파일 (1,522 `it()`) / 29 phase plans / 206 commits.
> 비교 기준: Anthropic Claude.ai (claude-agent-sdk + MCP), OpenAI ChatGPT/Assistants v2, Letta/MemGPT, Hermes/OpenDevin, Microsoft Copilot, MCP 표준.
> 사용자 제약 반영: 1인 전용 → 멀티 테넌시 결손 가중치 ↓ / 학습 인프라 평가 제외 / 감사 가능성·환각 방지·읽기 전용 가중치 ↑.

---

## 점수 카드

| 축                          | FinClaw 점수 (0-5) | 현대 AI 비서 평균 (참조) | 근거 (요약)                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 모듈 분리 / 단방향 의존 | **4**              | 3.5                      | types→infra→(config/storage/agent/channel-discord/skills-\*)→server→tui/web 의 단방향 그래프가 `tsconfig.json` references 와 `package.json` workspace 의존으로 이중 강제. 순환 0건. server 가 21,539 LOC (전체 38%) 로 god-package 신호.                                                                 |
| 1.2 런타임 토폴로지         | **2**              | 3                        | `main.ts` 1 개 프로세스에서 Discord 게이트웨이·HTTP/WS 게이트웨이·SchedulerService(매분 폴러)·alert monitor·embedding provider·circuit breaker 가 모두 같은 이벤트 루프 공유. 워커 스레드/외부 큐/별도 프로세스 0 개. ConcurrencyLane (in-process semaphore) 가 유일한 백프레셔.                         |
| 1.3 확장성                  | **3**              | 3.5                      | 채널 dock/Plugin 5-stage 로더(`packages/server/src/plugins/loader.ts`) + manifest Zod v4 + jiti 동적 import + 6 슬롯 레지스트리. 코어 외부 plugin 디렉터리 사용 사례·예시 plugin 패키지가 부재. MCP 클라이언트/서버 0.                                                                                   |
| 1.4 빌드/타입 안전성        | **4**              | 3                        | TS project references 11 개 + tsgo (`@typescript/native-preview`) 풀 타입체크 + oxlint + oxfmt + lefthook pre-commit + vitest 4-tier (unit / storage maxWorkers=1 / e2e / live) + GitHub Actions CI 매트릭스 1 잡 (lint→format→typecheck→build→test). Turbo/Nx 같은 캐시 레이어 부재 → 캐시 측면에서 -1. |
| 1.5 배포 모델               | **3**              | 3.5                      | Multi-stage `Dockerfile` (node:22-slim, non-root user, healthcheck `/healthz`) + `docker-compose.yml` (server+web, 명명 볼륨) + `release.yml` + `deploy.yml` (Buildx multi-arch amd64/arm64, GHA cache, ghcr.io semver tag). 단일 바이너리/systemd unit/readiness probe/blue-green hot reload 부재.      |

**산술 평균: (4+2+3+4+3) / 5 = 3.2** — "MVP / Production-ready" 구간 (Architecture 단일 영역 기준).

---

## 강점

1. **단방향 의존 그래프가 빌드 시스템으로 강제됨** — `tsconfig.json` references 와 `pnpm-workspace.yaml` 의존을 교차 검증한 결과 (`grep -rh "from '@finclaw/" packages/*/src`):
   - `types` 는 어떤 `@finclaw/*` 도 import 하지 않음 (확인됨, 0건)
   - `infra` 는 `types` 만 (`LogLevel`, `SessionKey`, `Timestamp`)
   - `storage` 는 `types` 만
   - `agent` 는 `types` + `infra` 만
   - `skills-finance` 는 `types` + `infra` + `storage` + `agent` 만 (server 미참조)
   - `server` 만이 모두를 import. 순환 의존 0건.
     → Letta/MemGPT (server / agent / memory / tools 분리) 와 동급 수준의 정적 경계.

2. **타입 시스템 인프라가 Industry-leading 후보** — `@typescript/native-preview` (tsgo, Go-native TS) 사용은 2026 년 4월 prerelease 기준 매우 이른 채택. CI Quality Gate 1 잡에서 lint/format/typecheck/build/test 5 단계가 모두 강제되며 (`.github/workflows/ci.yml`), pre-commit lefthook 이 동일 시퀀스를 로컬에서 재현. Anthropic claude-agent-sdk·OpenAI Python SDK 도 Turbo/Nx 캐시는 안 쓰므로 캐시 결손은 비교 대상 모두의 약점.

3. **테스트 4-tier 분리가 명확** — `vitest.config.ts` (unit, fork pool, maxWorkers 4-16), `vitest.storage.config.ts` (maxWorkers=1, DB 격리), `vitest.e2e.config.ts`, `vitest.live.config.ts` 가 각각 별 실행 컨텍스트. `scripts/test-parallel.mjs` 로 unit+storage 동시 실행. 173 파일 / 1,522 `it()` 케이스, ProviderId 단일이지만 mock 으로 외부 키 없이 모두 통과 가능 (사용자 피드백 `feedback_tests_no_api_keys.md` 충족).

4. **Plugin 5-stage 파이프라인 + globalThis Symbol 싱글턴 레지스트리** — `loader.ts` 의 Discovery → Manifest(Zod v4) → Security(`validatePluginPath` 3 단계) → Load(3-tier: native ESM → Node 24+ TS strip → jiti) → Register(slots) 는 OpenDevin/AutoGen 의 plugin 시스템보다 견고한 구조. 6 슬롯 (plugins/tools/channels/hooks/services/commands/routes/diagnostics) + freeze/diagnostic 추적 포함.

5. **배포 인프라 의외의 완성도** — multi-stage Dockerfile (deps cache layer 분리), non-root `node` user, `/healthz` HEALTHCHECK, multi-arch Buildx (linux/amd64,linux/arm64), GHA semver tagging, `pnpm.minimumReleaseAge: 10080` (zero-day 공급망 방어 7 일 윈도우). 1 인 사용자 프로젝트로서는 over-engineered 한 수준이지만 감사 가능성 우선 원칙에 부합.

---

## 갭 (Critical / Important / Nice-to-have)

### Critical

#### C-1. ProviderId 가 `'anthropic'` 단일 — 라우팅/카탈로그/폴백 인프라가 무력

- **파일**: `packages/agent/src/models/catalog.ts:4` — `export type ProviderId = 'anthropic';`
- **현상**: `BUILT_IN_MODELS` 6 종 모두 `provider: 'anthropic'`. `auth/resolver.ts` 의 `ENV_KEY_MAP: Record<ProviderId, string>` 도 1 키. `models/fallback.ts` 의 `runWithModelFallback` 과 `models/routing.ts` 의 4 역할(fetch/chat/analysis/summarize) 라우팅이 **같은 프로바이더 안에서만 모델 변경** 가능 → 진정한 폴백/라우팅이 아님.
- **현대 비서 비교**: ChatGPT 는 GPT-4o/o1/o3 단일 벤더지만 OpenAI 자체에 다층 모델이 있어 무관. Claude.ai 도 단일이지만 SDK 는 `@anthropic-ai/bedrock-sdk`/`@anthropic-ai/vertex-sdk` 로 클라우드 라우팅 분기. **OpenDevin/AutoGen/Letta 는 LiteLLM 으로 50+ 프로바이더 지원**. FinClaw 의 `ProviderAdapter` 인터페이스(`providers/adapter.ts:19`) 는 잘 추상화되어 있지만 구현이 1 개뿐 → 인터페이스만 있고 다형성 없음.
- **임팩트**: 사용자 (운영자) — Claude API 장애 시 우회 불가. Storage 의 embedding 은 OpenAI/Voyage 2 종 어댑터(`packages/storage/src/embeddings/{openai,voyage}.ts`) 인데 LLM 만 단일은 비대칭 결손.
- **추정**: M (2-4 주) — `providers/openai.ts` 추가, `ProviderId` 유니언 확장, `auth/resolver.ts` ENV 매핑, `BUILT_IN_MODELS` 카탈로그 확장. 폴백/라우팅 코드 자체는 변경 불필요.

### Important

#### I-1. 단일 Node 프로세스 — 스케줄러·임베딩 재인덱스·alert monitor 가 메인 이벤트 루프 공유

- **파일**: `packages/server/src/main.ts:419-440`, `automation/scheduler.ts:67-94`
- **현상**: `SchedulerService.start()` 는 `setInterval(() => void this.tick(), 60_000)` 로 메인 루프 안에서 실행. tick 안에서 agent.run (LLM 호출) 직접 await. ConcurrencyLane 으로 1 개씩 직렬화하지만 **다른 게이트웨이 RPC 와 같은 스레드 공유**. 임베딩 reindex (`packages/storage/src/reindex.ts`), alert monitor 도 동일.
- **현대 비서 비교**: ChatGPT Tasks 는 별도 워커 fleet. Claude.ai Projects 의 background 인덱싱도 별도. Letta 는 `pgboss` 큐 기반. FinClaw 의 룰릭 1.2 는 4 점 기준 = "무거운 작업이 백그라운드 큐". 5 점 = "별도 프로세스".
- **임팩트**: 운영자 — 큰 reindex/스케줄 폭주 시 RPC latency 영향. 개발자 — 워커/큐 도입 시 Storage SQLite WAL 동시 접근 설계 필요 (현재 `node:sqlite` `DatabaseSync`는 단일 스레드 가정).
- **추정**: L (1-3 개월) — Worker Threads 또는 별도 Node 프로세스 + IPC + 큐 (BullMQ/pg-boss/SQLite-기반 자체) 도입.
- **사용자 제약 고려**: 1 인 전용 부하에서는 latency 영향 작음 → 3 점 평가 유지하되 4 점 도달은 실수요 후 결정.

#### I-2. server 패키지의 god-package 경향

- **측정값**: `packages/server/src/` = 166 파일 / 21,539 LOC = **전체의 약 38.3%**. 두 번째로 큰 `skills-finance` (50/5,963) 의 3.6배.
- **세부**: `auto-reply/` (파이프라인 6 스테이지 + commands + helpers + observer), `automation/` (cron+scheduler+delivery), `channels/` (dock/registry), `cli/` (Commander 기반 다명령), `gateway/` (HTTP/WS/RPC 7 메서드 그룹), `plugins/` (5-stage 로더), `process/` (라이프사이클), `services/`. 자연스러운 묶음이긴 하지만 `gateway` 하나만으로도 별도 패키지 (`@finclaw/gateway`) 가 가능한 규모.
- **현대 비서 비교**: claude-agent-sdk 는 `client`/`session`/`tools`/`mcp`/`hooks` 가 별도 export path. ChatGPT 의 backend 는 폐쇄지만 OpenAI Python SDK 는 `agents`/`responses`/`assistants` 분리.
- **임팩트**: 개발자 — 11 패키지의 단방향 그래프 강점이 server 안에서는 약화. 변경 격리 비용 ↑. 빌드 캐시 효율 ↓ (server 1 줄 변경 시 21k LOC 재컴파일).
- **추정**: M (2-4 주) — `gateway`, `auto-reply` 둘은 자연스럽게 분리 가능. `automation`, `plugins` 도 후보.

#### I-3. MCP 클라이언트/서버 미존재

- **확인**: `grep -l "MCP\|mcp" packages -r --include="*.ts"` → 매치 0 (코드 내 mcp 키워드 부재).
- **현대 비서 비교**: Claude.ai 는 MCP 가 1 등 시민. ChatGPT 는 2026 년 도입 발표. Letta 는 자체 tool 시스템이지만 MCP 어댑터 존재. FinClaw 는 자체 plugin 매니페스트 (Zod v4) + 5-stage loader 로 동등한 기능을 직접 구현했지만 외부 호환성 0.
- **임팩트**: 사용자 — 외부 도구 (Notion/Drive/Sheets) 연결 시 직접 어댑터 작성 필요. 개발자 — plugin 시스템이 닫힘 생태계.
- **추정**: M-L — `@modelcontextprotocol/sdk` 의 client 측 통합은 M, server 노출은 L (auth/scope 설계 포함).

#### I-4. WebSocket reconnect / 다중 디바이스 상태 동기화 부재

- **파일**: `packages/server/src/gateway/ws/connection.ts`, `gateway/broadcaster.ts`
- **현상**: Heartbeat (30s/10s) + maxConnections=100 + 1MiB payload 는 있음. 그러나 클라이언트 측 (web/tui) reconnect 로직과 서버 측 session resumption (offset/cursor) 부재.
- **임팩트**: 사용자 (1 인) — 데스크톱+모바일 동시 사용 시 한쪽만 업데이트.
- **추정**: M.

### Nice-to-have

#### N-1. Turbo/Nx 등 모노레포 캐시 부재

- 현재: `tsc --build` project references 자체가 incremental 빌드를 제공하나 remote cache 없음.
- ChatGPT/Claude 백엔드 모노레포는 거의 모두 Bazel 또는 Turborepo 사용. FinClaw 규모 (56k LOC) 에서는 incremental tsc 로 충분하나 100k+ 도달 시 도입 가치.
- 추정: S.

#### N-2. systemd unit / 단일 binary 패키징 부재

- Docker 만 제공. `node --experimental-sea-config` (Single Executable Application) 또는 `pkg`/`nexe` 미사용. 1 인 self-host 시 `npm install -g` 또는 docker compose up 외 옵션 없음.
- 추정: S.

#### N-3. Readiness probe 부재 (liveness 만)

- `Dockerfile` HEALTHCHECK 가 `/healthz` 호출. Kubernetes 표준 readiness/startup probe 분리 부재. 1 인 단일 인스턴스에선 불필요하지만 산업 표준 갭.
- 추정: S.

#### N-4. Hot reload (gateway 무중단 재시작)

- `packages/server/src/gateway/hot-reload.ts` 파일은 존재하지만 (테스트도 있음) plugin 한정. config/agent/skill 변경은 재시작 필요. Letta 가 5 점 기준으로 들고 있는 "자기 편집 후 hot reload"는 불가.
- 추정: M.

---

## 측정값

### 패키지 메트릭

| 패키지          |                          파일 |                                 LOC | 직접 의존 (workspace)        | 비고                                                        |
| --------------- | ----------------------------: | ----------------------------------: | ---------------------------- | ----------------------------------------------------------- |
| types           |                            13 |                               1,277 | (없음)                       | 순수 인터페이스 — 단방향 그래프의 뿌리.                     |
| infra           |                            28 |                               2,095 | types                        | 로거/이벤트버스/circuit breaker/lane manager/ports.         |
| config          |                            17 |                               1,160 | types, infra                 | json5 + Zod v4 strict 검증.                                 |
| storage         |                            30 |                               4,871 | types                        | sqlite-vec, 임베딩 (openai/voyage), FTS5 + vector + hybrid. |
| agent           |                            32 |                               4,175 | types, infra                 | provider adapter, model catalog, runner, fallback, routing. |
| channel-discord |                            15 |                                 923 | types, infra                 | discord.js v14.                                             |
| skills-finance  |                            50 |                               5,963 | types, infra, storage, agent | market/news/alerts.                                         |
| skills-general  |                             7 |                                 535 | types, infra, agent          | 가벼운 utility tools.                                       |
| server          |                           166 |                          **21,539** | 위 모두 (10)                 | gateway/auto-reply/automation/cli/plugins/channels.         |
| tui             |                             4 |                                 660 | types                        | ink + react 19.                                             |
| web             |                            13 |                               3,994 | types                        | lit 3 + vite.                                               |
| **합계**        | **375 src** (462 테스트 포함) | **51,192 src** (56,195 테스트 포함) |                              |                                                             |

### 의존성 그래프 (단방향, 검증됨)

```
                  +---------+
                  |  types  |
                  +----+----+
                       |
                  +----+----+
                  |  infra  |
                  +----+----+
                       |
   +---+---+---+-------+-------+---+---+
   |   |   |   |               |   |   |
config storage             agent  channel-discord
        |                   |
        +--------+----------+
                 |
        +--------+--------+
        |                 |
   skills-finance   skills-general
        |                 |
        +--------+--------+
                 |
              server
              /  |  \
            tui  |  web (web 는 server 미참조 — types 만 사용)
                 |
               (bin)
```

검증 방법: `grep -rh "from '@finclaw/" packages/<pkg>/src --include="*.ts"` 으로 각 패키지의 cross-package import 를 직접 추출. 결과 파일별 단계 깊이 ≤ 4. 순환 0건 (`tsc --build` 가 references 강제).

### 빌드/테스트 인프라

- TS project references: 11 (tsconfig.json + 11 packages/\*/tsconfig.json)
- Node engines: ≥ 22.0 (built-in `node:sqlite` 사용). `@types/node` ^25.6 (root devDep), `typescript` ^6.0.3, `tsgo` 7.0.0-dev.20260426.1.
- Vitest 4-tier: `vitest.config.ts` (unit, fork pool 4-16 workers), `vitest.storage.config.ts` (maxWorkers=1, 30s timeout), `vitest.e2e.config.ts`, `vitest.live.config.ts`.
- 테스트: 173 파일 / 1,522 `it()` 케이스. coverage thresholds = 70% (statements/branches/functions), 55% (lines).
- CI: `.github/workflows/ci.yml` 단일 잡 (Quality Gate, 10 분 타임아웃, lint→format→typecheck→build→test:ci). `deploy.yml` 은 tag push 시 multi-arch Docker push.
- pre-commit hook: lefthook + oxlint + oxfmt + tsgo + Conventional Commits 검증 (commit-msg).

### 런타임 토폴로지

- **단일 프로세스** (`tsx packages/server/src/main.ts`):
  - HTTP gateway (`createServer`, port 3000)
  - WebSocket gateway (`WebSocketServer({ server: httpServer })` — 같은 포트 piggyback)
  - Discord adapter (`discord.js` Client, ws 연결 1 개)
  - SchedulerService (`setInterval` 60s, `setTimeout` 첫 분 경계 대기)
  - Alert monitor (`marketHandle.cache` polling, lifecycle-managed)
  - Embedding provider (HTTPS to OpenAI/Voyage on demand)
  - Auto-reply pipeline (6 stages: normalize→command→ack→context→execute→deliver) — message 당 호출
- **동시성 도구** (모두 in-process):
  - `ConcurrencyLane` (semaphore, agent.run lane maxConcurrent=1 maxQueueSize=10)
  - `ConcurrencyLane` (schedule lane maxConcurrent=1 maxQueueSize=50, waitTimeout=5min)
  - CircuitBreaker per ProviderId (`providers/adapter.ts:27`)
  - ProcessLifecycle (LIFO cleanup)
- **외부 분리 0**: 워커 스레드 / pg-boss / Redis / SQS / 다른 Node 프로세스 부재.

### 배포 단위

- `packages/server/bin/finclaw.js` — 1 줄 shebang → `dist/cli/entry.js` 의 `main()` 호출.
- `packages/server/package.json` `bin` 필드 = `finclaw`.
- `Dockerfile` 멀티 스테이지 (builder/runner), node:22-bookworm-slim, non-root `node` user, `/data` 볼륨, `/healthz` HEALTHCHECK 30s.
- `docker-compose.yml`: server + web (vite preview) 2 컨테이너, named volume `finclaw-data`.
- GHA `deploy.yml`: tag `v*` push 시 Buildx multi-arch (amd64/arm64) → ghcr.io semver tag.

---

## 현대 비서 비교

### vs Anthropic Claude.ai (claude-agent-sdk + MCP)

| 항목          | Claude.ai SDK                                                                     | FinClaw                                                    | 평가                                                                                                 |
| ------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 모듈 분리     | `@anthropic-ai/claude-agent-sdk` 의 hooks/MCP/session/tools 가 명시적 export path | 11 패키지 단방향 그래프 + 빌드 시스템 강제                 | **FinClaw 우위** (검증 가능성).                                                                      |
| Plugin 시스템 | MCP 표준 (JSON-RPC over stdio/SSE)                                                | 자체 manifest (Zod v4) + 5-stage loader (jiti 동적 import) | **FinClaw 자체 시스템은 견고하지만 외부 호환 0** — MCP 어댑터 부재가 critical 갭은 아니나 important. |
| 프로세스 모델 | sdk 자체는 라이브러리, host app 책임                                              | 단일 Node 프로세스 다중 책임                               | 비교 무의미 (sdk 는 host-agnostic).                                                                  |
| Hot reload    | 없음                                                                              | plugin 한정 존재 (`gateway/hot-reload.ts`), config 미지원  | **동등**.                                                                                            |

### vs OpenAI ChatGPT (Memory + Tasks + Canvas)

| 항목                 | ChatGPT                                                        | FinClaw                                  | 평가                                     |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| 백엔드 분리          | 폐쇄, 추정 multi-service (gateway/agent/memory/tools 별 fleet) | 단일 Node                                | **FinClaw 열위** (1.2 점수 2 의 근거).   |
| Tasks (스케줄)       | 별도 워커 fleet                                                | SchedulerService (메인 루프 setInterval) | **FinClaw 열위** — 1 인 부하에서는 무관. |
| 다중 디바이스 동기화 | 표준                                                           | 부재 (I-4)                               | **FinClaw 열위**.                        |
| 모노레포 빌드        | (아마도) Bazel                                                 | tsc project references                   | 동등 (FinClaw 규모에서는 충분).          |

### vs Letta/MemGPT

| 항목                                 | Letta              | FinClaw                                               | 평가                                                  |
| ------------------------------------ | ------------------ | ----------------------------------------------------- | ----------------------------------------------------- |
| server / agent / memory / tools 분리 | 명시적 패키지 분리 | 11 패키지 분리 (storage / agent / skills-\* / server) | **동등 또는 FinClaw 우위** (project references 강제). |
| 큐 기반 백그라운드                   | pgboss             | 부재                                                  | **FinClaw 열위** (I-1).                               |
| LLM 프로바이더 다양성                | LiteLLM (50+)      | anthropic only (`ProviderId = 'anthropic'`)           | **FinClaw 열위 critical** (C-1).                      |
| Hot reload                           | 자기 편집 + reload | 미지원                                                | **FinClaw 열위** (N-4).                               |

### vs Hermes 류 / OpenDevin / AutoGen

| 항목            | OpenDevin/AutoGen        | FinClaw                                            | 평가              |
| --------------- | ------------------------ | -------------------------------------------------- | ----------------- |
| Plugin manifest | 단순 Python entry_points | Zod v4 + 3-tier 로더 + 보안 검증 + diagnostic 추적 | **FinClaw 우위**. |
| 멀티 프로바이더 | LiteLLM                  | anthropic only                                     | **FinClaw 열위**. |
| 워커 분리       | 별도 컨테이너            | 단일 프로세스                                      | **FinClaw 열위**. |

### vs MCP 표준

- FinClaw 의 plugin 시스템은 manifest schema 측면에서 MCP 와 유사 (name/version/main/type) 하지만 **JSON-RPC 메시지 프로토콜 미사용**. JSON-RPC 는 게이트웨이 내부 (`gateway/rpc/methods/`) 에만 사용 — MCP server 로 노출하면 외부 도구가 FinClaw 의 finance.\*/memory.\*/agent.\* 를 호출 가능하나 미구현 (I-3).

---

## 영역별 결론

- **모듈 분리 (4)** 는 11 패키지 단방향 그래프 + tsconfig references 강제로 Letta/SDK 와 동등 이상이며, 사용자 우선순위인 **감사 가능성** 가중치를 반영하면 강점 영역.
- **런타임 토폴로지 (2)** 가 1 인 사용 가정 하에서도 룰릭 3 점 (단일 Node + 같은 루프 동작) 의 "최소 기준" 에 미달하지는 않으나, alert monitor + scheduler + embedding 이 모두 메인 루프인 점이 4 점 (백그라운드 큐) 도달의 명백한 차단 요인. 1 인 부하에서는 latency 임팩트 작아 우선순위는 Important.
- **확장성 (3)** 은 plugin 자체 시스템은 견고하나 MCP 호환 부재로 외부 생태계 단절. ProviderAdapter 인터페이스가 잘 추상화되어 있지만 구현이 단일 → C-1 해소 시 4 도달.
- **빌드/타입 (4)** 은 tsgo + 4-tier vitest + lefthook + GHA 로 현대 평균 초과. Turbo/Nx 캐시 도입 시 5 가능.
- **배포 모델 (3)** 은 multi-arch Docker + non-root + healthcheck + zero-day 보호 (`minimumReleaseAge`) 로 1 인 self-host 사용자에게 적합. systemd/SEA/readiness 분리 등은 N-급.

**Architecture 영역 평균 3.2** — 룰릭의 "MVP / Production-ready" 구간 상단. 단일 프로바이더 (C-1) 와 단일 프로세스 (I-1) 두 갭만 해소하면 4.0 도달 가능.

---

## Critical / Important 갭 요약 (synthesizer 인덱스용)

| ID  | 라벨                                     | 영역                  | 영향          | 작업량 | 코드 경로                                                                            |
| --- | ---------------------------------------- | --------------------- | ------------- | ------ | ------------------------------------------------------------------------------------ |
| C-1 | ProviderId = 'anthropic' 단일            | 1.3 확장성 / 1.4 빌드 | 사용자/운영자 | M      | `packages/agent/src/models/catalog.ts:4`, `providers/adapter.ts`, `auth/resolver.ts` |
| I-1 | 단일 프로세스, 백그라운드 큐 부재        | 1.2 런타임            | 운영자        | L      | `packages/server/src/main.ts`, `automation/scheduler.ts`                             |
| I-2 | server god-package (38% LOC)             | 1.1 모듈 분리         | 개발자        | M      | `packages/server/src/{gateway,auto-reply,automation,plugins}/`                       |
| I-3 | MCP 클라이언트/서버 미존재               | 1.3 확장성            | 사용자/개발자 | M-L    | `packages/server/src/plugins/` (확장 포인트)                                         |
| I-4 | WS reconnect / 다중 디바이스 동기화 부재 | 1.2 런타임            | 사용자        | M      | `packages/server/src/gateway/ws/`, `web/`, `tui/`                                    |
| N-1 | Turbo/Nx 모노레포 캐시                   | 1.4 빌드              | 개발자        | S      | repo root                                                                            |
| N-2 | systemd unit / 단일 binary               | 1.5 배포              | 운영자        | S      | (신규)                                                                               |
| N-3 | Readiness probe 미분리                   | 1.5 배포              | 운영자        | S      | `Dockerfile`, `gateway/health.ts`                                                    |
| N-4 | Config/agent hot reload                  | 1.5 배포 / 1.3 확장   | 개발자        | M      | `packages/server/src/gateway/hot-reload.ts`                                          |

총 갭 9 건 (Critical 1, Important 4, Nice-to-have 4).
