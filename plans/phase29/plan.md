# Phase 29 — Critical 5 해소 (Production-grade 진입)

## Context

Phase 26 (기억·거래) 와 Phase 28 (자동화) 가 완료된 시점 (2026-05-03, commit 30913d7) 에서 본 저장소에 대한 **현대 AI 비서 성숙도 감사** 가 수행됐다 (`_workspace/audit/SUMMARY.md`). 결과는:

- 종합 **3.30 / 5** (MVP / Production-ready 구간)
- Critical 갭 5건 / Important 16건 / Nice-to-have 10건+

본 Phase 의 목표는 단 하나: **Critical 5건을 모두 해소하여 종합 평균 3.7 이상 (Production-grade) 으로 진입.** Important / Nice-to-have 는 Phase 30 이후로 미룬다.

### Critical 5건 (감사 보고서 인용)

| #   | 갭                                                                                                                                                                          | 발견 audit         | 위치                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| C-1 | `ProviderId='anthropic'` 단일 union — 라우팅·폴백·카탈로그 인프라가 단일 벤더로 락                                                                                          | architecture       | `packages/agent/src/models/catalog.ts:4`                                       |
| C-2 | RAG citation 부재 — system prompt 의 "사용자 배경지식" 섹션이 memoryId 미노출, 감사 가능성 약화                                                                             | memory-knowledge   | `packages/server/src/auto-reply/stages/memory-retrieval.ts`, `prompts/`        |
| C-3 | 임베딩 차원 silently broken — `vec0(float[1024])` 고정인데 `OpenAIEmbeddingProvider`(1536D) 가 런타임 가드 없이 등록 가능                                                   | memory-knowledge   | `packages/storage/src/embeddings/openai.ts`, `tables/memory_chunks_vec`        |
| C-4 | MCP 클라이언트/서버 0건 + plugin 5-stage loader 가 `main.ts` 미배선 (dead module)                                                                                           | interface-channels | `packages/server/src/plugins/loader.ts`, `main.ts`                             |
| C-5 | gateway 운영성 모듈 dead — `RequestRateLimiter` / `createAccessLogger` / `createHotReloader` / `AuthRateLimiter` / `registerHealthChecker` 가 export 만, `main.ts` 호출 0건 | interface-channels | `packages/server/src/gateway/{rate-limit,access-log,hot-reload}.ts`, `main.ts` |

### 사용자 결정 사항 (Phase 29 시작 전)

본 Phase 진입 전 다음 5 가지 정책 결정이 필요하다. 미결정 시 각 트랙 시작 직전에 확정:

1. **(C-1 트랙 A)** `runWithModelFallback` 의 cross-provider 폴백 허용 여부 — 본 plan 은 **동일 벤더 내 폴백만** 으로 기본 채택 (안전성 우선). 사용자가 가용성 우선 원하면 변경.
2. **(C-1 트랙 A)** 1차 추가 provider 는 OpenAI — Voyage/Bedrock/Vertex 는 Phase 30 이후.
3. **(C-3 트랙 C)** 차원 정책은 **provider 별 단일 차원 락** 으로 채택 — `vec0` 컬럼 차원 = 등록된 1차 provider 차원, 다른 provider 는 truncation 옵션으로 차원 맞춤. (대안: 다중 차원 vec 테이블 — 복잡도 증가, 본 Phase 비채택)
4. **(C-4 트랙 D)** MCP transport 1차는 **stdio 만** — SSE/WebSocket 은 Phase 30 이후. plugin loader 가 MCP 도구를 `ToolRegistry` 에 자동 등록.
5. **(C-4 트랙 D)** MCP 도구의 정책 적용 방식 — **9-단계 정책의 group=`mcp` 슬롯 신규** 를 만들어 일괄 권한 분리. 도구별 fine-grained 정책은 Phase 30.

읽기 전용 원칙은 **유지** — provider 다중화도 임베딩 차원 가드도 자동 매매가 아니다.

---

## 트랙 A — Provider 다중화 (C-1)

### 목표

`ProviderId` 를 union 확장하고 `OpenAIAdapter` 를 추가하여 모델 카탈로그·라우팅·폴백·인증 인프라가 다중 벤더에서 의미를 갖게 한다.

### 전제

- `packages/agent/src/providers/adapter.ts` 의 `ProviderAdapter` 인터페이스는 다중 구현을 가정해 설계되어 있음 (감사 보고서 확인).
- `runWithModelFallback`, `models/routing.ts` 의 4 역할 라우팅, `auth/resolver.ts` 의 ENV 매핑은 코드는 다중 provider 를 가정하지만 union 이 단일이라 무력.
- `packages/storage/src/embeddings/{openai,voyage}.ts` 는 이미 2 provider — 본 트랙은 **LLM provider** 만 대상.

### 작업

| 단계 | 파일                                                  | 설명                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `packages/agent/src/models/catalog.ts`                | `ProviderId` union 에 `'openai'` 추가. `BUILT_IN_MODELS` 에 OpenAI 모델 (gpt-4o, gpt-4o-mini, o1, o3-mini 중 1차) 추가, `provider: 'openai'`. capabilities 정확히 (vision/tool_use/parallel/streaming). |
| A2   | `packages/agent/src/providers/openai.ts` (신규)       | `@anthropic-ai/sdk` 와 동등 인터페이스로 `OpenAIAdapter` 구현 — `streamCompletion`, tool_use 변환, prompt caching 미지원이면 명시 (`supportsPromptCaching: false`).                                     |
| A3   | `packages/agent/src/providers/index.ts`               | OpenAIAdapter export, factory 등록.                                                                                                                                                                     |
| A4   | `packages/agent/src/auth/resolver.ts`                 | `ENV_KEY_MAP` 에 `openai: 'OPENAI_API_KEY'` 추가.                                                                                                                                                       |
| A5   | `packages/agent/src/models/routing.ts`                | 4 역할 (fetch/chat/analysis/summarize) 라우팅이 cross-provider 모델 선택 가능하게 — 이미 구조는 가능, ProviderId union 확장만으로 자동 동작 검증.                                                       |
| A6   | `packages/agent/src/models/fallback.ts`               | `runWithModelFallback` 의 fallback chain 이 동일 벤더 내로 제한되는지 (본 plan 채택) 확인 — 아니라면 정책에 맞게 가드 추가.                                                                             |
| A7   | `packages/agent/test/providers/openai.test.ts` (신규) | mock SSE response 로 OpenAIAdapter unit test. tool_use 라운드트립, streaming 5-state FSM, retry 정책.                                                                                                   |
| A8   | `packages/agent/test/models/routing.test.ts` (확장)   | `provider=openai` 모델 선택 + 폴백 시나리오 추가.                                                                                                                                                       |

### 검증

```sh
pnpm typecheck
pnpm test --filter @finclaw/agent
# e2e: env OPENAI_API_KEY 설정 후 (또는 MOCK_PROVIDER=openai)
pnpm test:e2e -- providers/openai
```

**완료 조건:**

- `BUILT_IN_MODELS.filter(m => m.provider === 'openai').length >= 2`
- `OpenAIAdapter` 가 `ProviderAdapter` 인터페이스 100% 구현
- 동일 도구 흐름이 anthropic / openai 양쪽으로 통과 (e2e 1 시나리오)
- 회귀 0 — 기존 anthropic 경로 vitest 모두 통과

### 추정

**2 주** (A1-A4: 3일 / A5-A6: 2일 / A7-A8: 4일 / 통합 검증: 1일)

---

## 트랙 B — RAG citation (C-2)

### 목표

RAG 로 회수된 메모리가 system prompt 에 주입될 때 **인용 ID** 를 부착하고, 모델 응답에 인용을 강제하여 사용자가 "어떤 기억에서 그 답이 나왔는지" 추적 가능하게 한다. 사용자 제약 "감사 가능성·환각 방지" 를 정면 충족.

### 전제

- `packages/server/src/auto-reply/stages/memory-retrieval.ts` 가 system prompt 의 "사용자 배경지식" 섹션을 빌드 (Phase 26 C 산출).
- `packages/storage/src/agent-runs.ts` 에 `memoryId` 컬럼 존재 (Phase 26 D 산출) — citation 매칭 검증에 활용.
- `packages/web/src/views/settings-view.ts` 에 메모리 목록 가시화 존재.

### 작업

| 단계 | 파일                                                                         | 설명                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | `packages/server/src/auto-reply/stages/memory-retrieval.ts`                  | `formatBackgroundSection` 마크다운 빌드 시 각 메모리 줄 끝에 `[mem:<id 첫 6자>]` 인용 ID 부착. 거래 회상에도 `[txn:<id 첫 6자>]` 부착. |
| B2   | `packages/server/prompts/system-base.txt` (또는 상응)                        | system prompt 에 "회상한 사실에 의존하면 인용을 마지막에 `[mem:xxxxxx]` 형식으로 달아라. 추측은 인용하지 마라." 규칙 추가.             |
| B3   | `packages/server/src/auto-reply/stages/execute.ts` (또는 response-formatter) | 응답 후처리 — `\[mem:[a-f0-9]{6}\]` 정규식으로 인용 추출, `agent_runs.usedMemoryIds` JSON 컬럼에 저장.                                 |
| B4   | `packages/storage/src/agent-runs.ts`                                         | `usedMemoryIds: string[]` 컬럼 추가 (마이그레이션 v6 → v7, JSON TEXT).                                                                 |
| B5   | `packages/storage/src/database.ts`                                           | SCHEMA_VERSION bump + 마이그레이션 SQL.                                                                                                |
| B6   | `packages/server/src/gateway/rpc/methods/memory.ts`                          | `memory.getById(id)` RPC 추가 (이미 있으면 skip) — settings-view 인용 클릭 시 점프용.                                                  |
| B7   | `packages/web/src/views/settings-view.ts` (또는 chat-view)                   | agent_runs 상세 패널에서 `usedMemoryIds` 클릭 시 해당 메모리로 점프.                                                                   |
| B8   | `packages/storage/src/memory-retrieval.test.ts` (신규/확장)                  | 회상 → 인용 부착 → 응답 정규식 매칭 → agent_runs 기록 e2e 시나리오.                                                                    |

### 검증

```sh
pnpm typecheck
pnpm test:storage
pnpm test:e2e -- memory-citation
```

**완료 조건:**

- 회상된 메모리 N 개 → system prompt 에 N 개 `[mem:xxxxxx]` 마커
- e2e: "내 원칙은 X" 저장 → 동일 주제 질문 → 응답에 `[mem:...]` 포함 → `agent_runs.usedMemoryIds` 비어있지 않음
- web settings-view 에서 인용 ID → 메모리 점프 동작 (수동 테스트)

### 추정

**1 주** (B1-B2: 1일 / B3-B5: 2일 / B6-B7: 2일 / B8: 1일 / 통합: 1일)

---

## 트랙 C — 임베딩 차원 가드 (C-3)

### 목표

`vec0` 가상 테이블의 차원과 등록된 임베딩 provider 의 출력 차원이 불일치하면 **런타임에 즉시 throw** 하여 silent corruption 을 차단. provider 전환은 명시적 reindex 워크플로우로만 허용.

### 전제

- `packages/storage/src/embeddings/openai.ts` (1536D) 와 `voyage.ts` (1024D) 가 모두 등록 가능하지만, `memory_chunks_vec` 의 `embedding float[1024]` 컬럼은 1024D 고정.
- 현재 OpenAI provider 활성화 시 `vec_distance` 가 silently broken (감사 발견).
- `database.ts` SCHEMA_VERSION 은 v6 (Phase 26 D 산출).

### 작업 (정책: provider 별 단일 차원 락 + truncation 옵션)

| 단계 | 파일                                                                      | 설명                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1   | `packages/storage/src/embeddings/registry.ts` (신규 또는 `index.ts` 확장) | `registerEmbeddingProvider(provider)` — provider.dimensions 와 `database.getVectorDimension()` 비교. 불일치면 `EmbeddingDimensionMismatchError` throw. |
| C2   | `packages/storage/src/database.ts`                                        | `getVectorDimension(): number` — `memory_chunks_vec` 정의에서 차원 추출 (PRAGMA table_info 또는 schema 메타). 부트 시 1회 읽기.                        |
| C3   | `packages/storage/src/embeddings/openai.ts`                               | OpenAI `text-embedding-3-small` 의 `dimensions` 파라미터로 1024 truncation 옵션 추가 (OpenAI API 지원). 기본값은 모델 native 1536, 옵션 1024.          |
| C4   | `packages/storage/src/embeddings/openai.test.ts` (확장)                   | dimension=1024 truncation 호출 + 잘못 등록 시 throw 검증.                                                                                              |
| C5   | `packages/storage/src/reindex.ts`                                         | `atomicReindex` 가 provider 변경 감지 시 (이전 provider id != 현재) 강제 실행. CLI 플래그 `--reindex-on-provider-change` 또는 자동.                    |
| C6   | `packages/storage/src/reindex.test.ts`                                    | provider 전환 후 reindex → 모든 memory_chunks_vec 재계산 검증.                                                                                         |
| C7   | `scripts/reindex.mjs` (신규 또는 기존 확장)                               | 운영자 명령 — `pnpm reindex --provider=openai --dimension=1024`.                                                                                       |

### 검증

```sh
pnpm typecheck
pnpm test:storage -- embeddings reindex
# 운영 검증
DEV_DB="${HOME}/.finclaw/db.sqlite"
pnpm tsx scripts/reindex.mjs --dry-run
```

**완료 조건:**

- 잘못된 차원 provider 등록 시 에러 throw (타입 + 메시지에 권장 동작 안내)
- OpenAI 1024 truncation 으로 hybrid 검색 정상 동작 (e2e)
- provider 전환 시 reindex 미실행 상태로 검색하면 분명한 에러 메시지

### 추정

**1 주** (C1-C2: 2일 / C3-C4: 2일 / C5-C7: 3일)

---

## 트랙 D — MCP 클라이언트 + plugin 배선 (C-4)

### 목표

`@modelcontextprotocol/sdk` 의존을 추가하고 stdio MCP 서버를 plugin 형태로 등록 가능하게 한다. plugin 5-stage loader 를 `main.ts` 부트 시퀀스에 배선하여 dead module 상태를 해소한다.

### 전제

- `packages/server/src/plugins/loader.ts` 의 5-stage 파이프라인 (Discovery / Manifest / Security / Load / Register) 은 완성되어 있음 (감사 발견).
- `main.ts` 가 plugin loader 를 호출하지 않음 — 본 트랙에서 배선.
- `ToolRegistry` (`packages/agent/src/agents/tools/`) 는 9-단계 정책 지원.

### 작업

| 단계 | 파일                                                    | 설명                                                                                                                                                                               |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | `packages/server/package.json`                          | `@modelcontextprotocol/sdk` dep 추가.                                                                                                                                              |
| D2   | `packages/types/src/plugins.ts` (또는 상응)             | `MCPServerSpec` 타입 신규 — `{ command: string; args: string[]; env?: Record<string,string>; timeoutMs?: number }`. plugin manifest schema 에 `mcpServers?: MCPServerSpec[]` 확장. |
| D3   | `packages/server/src/plugins/mcp-transport.ts` (신규)   | `createMCPClient(spec)` — stdio transport 로 MCP 서버 spawn → 연결 → 도구 디스커버리. shutdown hook 등록.                                                                          |
| D4   | `packages/server/src/plugins/mcp-tool-bridge.ts` (신규) | MCP 도구를 FinClaw `ToolDefinition` 으로 변환 — JSON Schema → Zod schema, group=`mcp`, minModel=기본, isExternal=true (CircuitBreaker 적용).                                       |
| D5   | `packages/server/src/plugins/loader.ts`                 | Register 단계에서 `manifest.mcpServers` 가 있으면 D3-D4 호출, 도구를 `ToolRegistry.register` 로 등록. shutdown hook 누적.                                                          |
| D6   | `packages/server/src/main.ts`                           | 부트 시퀀스에 `await pluginLoader.load(pluginsDir)` 추가 (게이트웨이 listen 직전). 종료 시 shutdown hook 역순 실행.                                                                |
| D7   | `packages/agent/src/agents/tools/policy.ts` (또는 상응) | 9-단계 정책의 group 슬롯에 `'mcp'` 추가 — 기본 `require-approval` (사용자 제약 "감사 가능성" 부합).                                                                                |
| D8   | `packages/server/src/auto-reply/execution-adapter.ts`   | transcript-repair 가 MCP 도구의 비동기 timeout 케이스 (서버 미응답) 대응 — orphan tool_use 자동 제거 검증.                                                                         |
| D9   | `packages/server/test/plugins/mcp.test.ts` (신규)       | 가짜 stdio MCP 서버 (Node child_process) → 도구 디스커버리 → 호출 → 결과 → agent_runs 기록 e2e.                                                                                    |
| D10  | `docs/plugins/mcp.md` (신규, 짧게)                      | 운영자용 — manifest 예시, stdio 서버 등록 절차.                                                                                                                                    |

### 검증

```sh
pnpm typecheck
pnpm test --filter @finclaw/server -- plugins/mcp
# e2e: 로컬 filesystem MCP 서버 등록
# (검증용으로 @modelcontextprotocol/server-filesystem 패키지를 plugin manifest 에 등록 후)
pnpm dev
# RPC: agent.run --tool=fs.read_file 호출 후 agent_runs 확인
```

**완료 조건:**

- `pluginLoader.load()` 가 `main.ts` 에서 호출됨 (코드 존재 + 부트 로그)
- stdio MCP 서버 1개 등록 → 도구 N 개가 `ToolRegistry` 에 등록됨
- 9-단계 정책 group=`mcp` 동작 (require-approval 트리거)
- e2e 1 시나리오 통과 + agent_runs 에 `tool_calls[].source = 'mcp'` 기록 (옵션)

### 추정

**2-3 주** (D1-D2: 2일 / D3-D5: 5일 / D6-D8: 4일 / D9-D10: 3일 / 통합: 2일)

---

## 트랙 E — Gateway 운영성 모듈 배선 (C-5)

### 목표

이미 작성된 운영성 모듈 5종 (`RequestRateLimiter`, `createAccessLogger`, `createHotReloader`, `AuthRateLimiter`, `registerHealthChecker`) 을 `main.ts` 에 배선하여 dead module 상태를 해소한다.

### 전제

- 5 개 모듈 모두 unit test 있음 (감사 발견 — `gateway/rate-limit.test.ts`, `access-log.test.ts`, `hot-reload.test.ts` 등).
- `main.ts` 의 게이트웨이 부트 시퀀스가 명확 (`gateway/server.ts` listen 호출 직전).

### 작업

| 단계 | 파일                                                    | 설명                                                                                                                         |
| ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1   | `packages/server/src/main.ts`                           | router 등록 직후 `RequestRateLimiter` 미들웨어로 wrap. config 키 `rateLimit.requestsPerMinute` 기본 60.                      |
| E2   | `packages/server/src/main.ts`                           | `createAccessLogger` 미들웨어 + 로그 destination = stdout (production) / file (dev).                                         |
| E3   | `packages/server/src/main.ts`                           | `createHotReloader` 는 `process.env.NODE_ENV !== 'production'` 일 때만 활성. plugin manifest 변경 감지 시 reload.            |
| E4   | `packages/server/src/gateway/auth/index.ts` (또는 상응) | `AuthRateLimiter` 를 auth 미들웨어 chain 안에 통합. 토큰 검증 직전 IP 기반 rate limit.                                       |
| E5   | `packages/server/src/main.ts`                           | `registerHealthChecker` 의 deep health probe (DB ping, 임베딩 provider ping) 등록. `/healthz` 가 deep, `/readyz` 가 shallow. |
| E6   | `packages/server/src/main.test.ts` (확장)               | 부트 시퀀스 e2e 검증 — 5 개 모듈 모두 활성 상태 확인.                                                                        |
| E7   | `packages/server/src/gateway/rate-limit.test.ts` (확장) | 인위적 RPC 폭주 시나리오 e2e.                                                                                                |

### 검증

```sh
pnpm typecheck
pnpm test --filter @finclaw/server -- gateway/rate-limit gateway/access-log gateway/hot-reload
pnpm dev &
# 인위 폭주
for i in {1..200}; do curl -s http://localhost:8787/jsonrpc -d '{"jsonrpc":"2.0","method":"system.ping","id":1}' & done; wait
# 200개 중 일부가 429 응답
curl http://localhost:8787/healthz | jq  # deep health JSON
```

**완료 조건:**

- 5 모듈 모두 부트 로그에 활성화 메시지 출력
- 인위 폭주 시 `429 Too Many Requests` 발생
- `/healthz` 가 DB / 임베딩 provider 상태 포함 deep JSON 반환
- dev 모드에서 plugin manifest 수정 시 hot reload 동작

### 추정

**3 일** (E1-E5: 2일 / E6-E7: 1일)

---

## 의존 그래프 / 권장 일정

```
Week 1: A1-A3 │ B1-B2 │ C1-C2 │ E 전체           (E 가장 먼저 종료)
Week 2: A4-A6 │ B3-B5 │ C3-C4 │ D1-D3            (E 의 main.ts 배선 패턴 → D6 가 따라감)
Week 3: A7-A8 │ B6-B8 │ C5-C7 │ D4-D8
Week 4: 전체 통합 e2e + 회귀 테스트
Week 5: D9-D10 + Phase 29 종료 감사 (`finclaw-maturity-audit` 재실행)
```

A·B·C·E 는 서로 독립. D 는 E 가 만든 main.ts 배선 패턴을 활용하므로 1주 시차 권장.

---

## 종료 기준 (Definition of Done)

1. **테스트** — `pnpm test:all` 통과 (4-tier: unit / storage / e2e / live). mock-only, 외부 키 없이.
2. **타입체크** — `pnpm typecheck` 0 에러.
3. **포맷·린트** — `pnpm format` `pnpm lint` 0 위반.
4. **Critical 5건 E2E 시나리오** — 각 트랙당 e2e 시나리오 1개씩 명시적 통과.
5. **재감사** — `_workspace/audit/SUMMARY.md` 를 `_workspace/audit_prev_phase29-start/` 로 백업 후 `finclaw-maturity-audit` 스킬 재실행. 새 SUMMARY 의 종합 평균 **≥ 3.7**.
6. **문서** — `plans/phase29/review.md` 작성 — 트랙별 실제 결정·이탈·잔여 작업 기록.
7. **사용자 결정 검증** — Phase 시작 전 5 가지 정책 결정이 모두 확정됨 (`Context.사용자 결정 사항` 표).

---

## 의도적 비대상 (Phase 30 이후)

본 Phase 에서 **건드리지 않는** 것:

- **Important 16건** — 단일 Node 프로세스 분리, vision/file 첨부, 거래 회계 무결성, 메모리 자동 추출, 메모리 편집 UI, OpenAI-호환 endpoint, Discord `/ask` 슬래시 정상화 등
- **Nice-to-have 10건+** — Letta 식 3계층 메모리, re-ranking, span tree, Canvas/Artifacts, Turbo/Nx 캐시
- **추가 LLM provider** — Voyage / Bedrock / Vertex / 로컬 (llama.cpp, vLLM)
- **MCP transport 확장** — SSE / WebSocket
- **MCP 서버 노출** — FinClaw 자체를 MCP 서버로 만들기
- **OAuth 외부 연동** — Gmail / Calendar / Notion

Critical 5건만으로 평균 3.30 → 3.7 이상 달성 가능 (감사 보고서 추정).

---

## 변경 이력

| 날짜       | 변경      | 사유                                                   |
| ---------- | --------- | ------------------------------------------------------ |
| 2026-05-03 | 초기 작성 | `_workspace/audit/SUMMARY.md` Critical 5건 해소 로드맵 |
