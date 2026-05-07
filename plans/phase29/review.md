# Phase 29 Review: Critical 5 해소 (Production-grade 진입)

> todo.md 기반 구현 코드 리뷰. 5 트랙 (E/A/B/C/D) 의 구현 완료 상태, 자동화 검증 결과, 경계면 정합성, 리팩토링 후보를 기록한다.

base SHA: `4f71722` ↔ HEAD: `ad39dec` (변경 LOC: +2322 / -50, pnpm-lock 제외 ~+1370 / -50)

5 트랙 커밋 chain:

- E `d2696fc` — gateway operability wiring (rate-limit/access-log/health)
- A `59a1990` — OpenAI provider + multi-vendor routing guard
- B `c7bf6ce` — RAG citation [mem:xxxxxx] + agent_runs.usedMemoryIds
- C `0f9c0f5` — embedding dimension guard + provider-aware reindex
- D `ad39dec` — MCP stdio client + plugin loader + main.ts wiring

---

## 1. 구현 사항 (TODO 일치도)

전체: **62 단계 중 61 ✅ + 1 의도적 no-op (B7, todo 명시 허용)**

### 사전 준비

| 단계 | 파일   | 상태    | 비고                                                   |
| ---- | ------ | ------- | ------------------------------------------------------ |
| P-1  | (env)  | ✅ 완료 | clean tree, base `4f71722`, dev DB 미존재로 백업 no-op |
| P-2  | (정책) | ✅ 완료 | 5 결정 모두 기본값 채택                                |

### 트랙 E — Gateway 운영성 (9/9 ✅)

| 단계 | 파일                                             | 상태 | 비고                                                     |
| ---- | ------------------------------------------------ | ---- | -------------------------------------------------------- |
| E1   | `packages/server/src/gateway/router.ts:22`       | ✅   | rate-limit 미들웨어 + 429 + RateLimitHeaders             |
| E2   | `packages/server/src/gateway/context.ts:7`       | ✅   | rateLimiter / accessLogger / authRateLimiter 슬롯        |
| E3   | `packages/server/src/gateway/router.ts`          | ✅   | handleHttpRequest 에 access logger hook                  |
| E4   | `packages/server/src/gateway/router.ts`          | ✅   | authRateLimiter.isBlocked + recordFailure                |
| E5   | `packages/server/src/gateway/server.ts:84-119`   | ✅   | 3 인스턴스 + 2 health checker, stop() dispose            |
| E6   | `packages/server/src/main.ts:563-578`            | ✅   | NODE_ENV !== production 분기 + lifecycle.register(async) |
| E7   | `packages/server/src/gateway/rate-limit.test.ts` | ✅   | router 통합 시나리오 35줄 추가                           |
| E8   | `packages/server/src/main.test.ts`               | ✅   | 부트 시퀀스 e2e 81줄                                     |
| E9   | (검증)                                           | ✅   | typecheck + 34/34 + 0 lint                               |

### 트랙 A — Provider 다중화 (10/10 ✅)

| 단계 | 파일                                                  | 상태 | 비고                                                     |
| ---- | ----------------------------------------------------- | ---- | -------------------------------------------------------- |
| A1   | `packages/agent/package.json` + `pnpm-lock.yaml`      | ✅   | openai SDK dep                                           |
| A2   | `packages/agent/src/models/catalog.ts:4`              | ✅   | `ProviderId = 'anthropic' \| 'openai'`                   |
| A3   | `packages/agent/src/models/catalog-data.ts`           | ✅   | gpt-4o + gpt-4o-mini, capabilities 5종                   |
| A4   | `packages/agent/src/auth/resolver.ts:35`              | ✅   | `ENV_KEY_MAP.openai = 'OPENAI_API_KEY'`                  |
| A5   | `packages/agent/src/providers/openai.ts` (207줄)      | ✅   | ProviderAdapter 100% (chat + stream 5-state SSE)         |
| A6   | `packages/agent/src/index.ts:71`                      | ✅   | OpenAIAdapter export                                     |
| A7   | `packages/agent/src/models/fallback.ts:125-130`       | ✅   | `allowCrossProvider` 기본 false → first provider 외 skip |
| A8   | `packages/agent/test/providers/openai.test.ts` (54줄) | ✅   | vi.mock('openai') stream + chat                          |
| A9   | `packages/agent/test/fallback.test.ts` (+78줄)        | ✅   | default skip + allow=true 통과 시나리오                  |
| A10  | (검증)                                                | ✅   | typecheck + 251/251 + 0 lint                             |

### 트랙 B — RAG citation (10/11 ✅ + 1 의도적 no-op)

| 단계 | 파일                                                                                  | 상태     | 비고                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| B1   | `packages/server/src/auto-reply/stages/memory-retrieval.ts:177-205`                   | ✅       | snippet `[mem:<id 6자>]` + tx `[txn:<symbol+ts 12자>]`                                                                         |
| B2   | `packages/server/prompts/finclaw.system.ko.md:19`                                     | ✅       | 6번째 회상 인용 규칙                                                                                                           |
| B3   | `packages/storage/src/database.ts:23, 207, 368-373`                                   | ✅       | SCHEMA_VERSION=7, MIGRATIONS[7] PRAGMA-guarded ALTER (idempotent)                                                              |
| B4   | `packages/storage/src/agent-runs.ts:7-23, 103-105`                                    | ✅       | row + addAgentRun INSERT 14컬럼 + JSON round-trip                                                                              |
| B5   | `packages/types/src/agent.ts:111`                                                     | ✅       | `AgentRun.usedMemoryIds?: string[]`                                                                                            |
| B6   | `packages/server/src/auto-reply/execution-adapter.ts:111-133, 309-322`                | ✅       | extractCitedMemoryIds + prefix 매칭 + dedup                                                                                    |
| B7   | (auto-reply pipeline)                                                                 | ✅ no-op | `rg "addAgentRun" packages/server/src/auto-reply/` 0건 → 영속화 경로 부재. todo.md 가 명시적으로 "매칭 0건이면 단계 생략" 허용 |
| B8   | `packages/server/src/gateway/rpc/methods/memory.ts:228-243`                           | ⚠️       | `memory.getById` 등록 OK, 호출 사이트 0건 → dead RPC (자세한 분석은 §3.1)                                                      |
| B9   | `packages/web/src/views/settings-view.ts:500` + `packages/web/src/app-gateway.ts:492` | ✅       | usedMemoryIds 텍스트 표시 (todo 가 implementer 재량 허용)                                                                      |
| B10  | `packages/server/src/auto-reply/__tests__/memory-citation.test.ts` (36줄)             | ✅       | 5 시나리오 (basic / multi-id / no-marker / no-match / dedup)                                                                   |
| B11  | (검증)                                                                                | ✅       | typecheck + 119/119 + 674/674 + 0 lint                                                                                         |

### 트랙 C — 임베딩 차원 가드 (10/10 ✅)

| 단계 | 파일                                                             | 상태  | 비고                                                                                           |
| ---- | ---------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| C1   | `packages/storage/src/database.ts:396-407`                       | ⚠️→✅ | todo PRAGMA → 실제 sqlite_master 정규식 (vec0 type 빈 문자열 한계)                             |
| C2   | `packages/storage/src/embeddings/registry.ts` (33줄)             | ✅    | EmbeddingDimensionMismatchError + assertEmbeddingDimension                                     |
| C3   | `packages/storage/src/index.ts`                                  | ✅    | registry export                                                                                |
| C4   | `packages/storage/src/embeddings/openai.ts:11-15, 32-42, 54, 80` | ✅    | dimensions 옵션 또는 string 호환                                                               |
| C5   | `packages/storage/src/embeddings/provider.ts:7`                  | ✅    | EmbeddingConfig.dimensions factory forward                                                     |
| C6   | `packages/server/src/main.ts:208-225`                            | ✅    | dimensions: storage.vectorDimension + assertEmbeddingDimension                                 |
| C7   | `packages/storage/src/index.ts`                                  | ✅    | FinClawStorage.vectorDimension 노출                                                            |
| C8   | `packages/storage/src/reindex.ts:28-37, 58-61`                   | ✅    | meta.last_reindex_provider 비교 + INSERT OR REPLACE                                            |
| C9   | `packages/storage/src/embeddings/openai.test.ts` (56줄)          | ✅    | 5 시나리오 (default 1536 / dim=1024 / legacy ctor / mismatch / pass)                           |
| C10  | `scripts/reindex.mjs` (32줄)                                     | ⚠️→✅ | todo `@finclaw/storage` → 실제 `../packages/storage/dist/index.js` (scripts/ workspace 비멤버) |
| C11  | (검증)                                                           | ✅    | typecheck + 119/119 + 0 lint + reindex --dry-run 정상                                          |

### 트랙 D — MCP 클라이언트 + plugin 배선 (13/13 ✅)

| 단계 | 파일                                                                 | 상태  | 비고                                                                                                                            |
| ---- | -------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| D1   | `packages/server/package.json`                                       | ✅    | `@modelcontextprotocol/sdk@^1` (1.29.0)                                                                                         |
| D2   | `packages/types/src/plugin.ts`                                       | ✅    | MCPServerSpec 13줄                                                                                                              |
| D3   | `packages/server/src/plugins/manifest.ts:10`                         | ✅    | MCPServerSpecSchema (zod v4 strictObject)                                                                                       |
| D4   | `packages/server/src/plugins/mcp-transport.ts` (38줄)                | ✅    | createMCPClient (StdioClientTransport spawn + connect + best-effort shutdown)                                                   |
| D5   | `packages/server/src/plugins/mcp-tool-bridge.ts` (84줄)              | ⚠️→✅ | bridgeMCPTools (group=mcp, namespace `mcp:<id>:<name>`) + callTool 결과 타입 캐스트 (SDK generic 한계)                          |
| D6   | `packages/agent/src/agents/tools/groups.ts:12, 65-71`                | ✅    | BUILT_IN_GROUPS entry (defaultPolicy=require-approval, includeInPromptWhen=on-demand)                                           |
| D7   | `packages/agent/src/agents/tools/policy.ts` (주석만)                 | ✅    | main.ts addPolicyRule 로 등록 — 기존 메커니즘 재사용                                                                            |
| D8   | `packages/server/src/plugins/loader.ts:48-53, 168-252`               | ✅    | LoadResult.mcpHandles + toolRegistry 옵션 + Stage 5 후 mcpServers 처리                                                          |
| D9   | `packages/server/src/main.ts:336-356`                                | ✅    | addPolicyRule(mcp:\*) + loadPlugins + lifecycle.register shutdown loop                                                          |
| D10  | `packages/server/src/auto-reply/execution-adapter.ts` (검증만)       | ✅    | sliceHistoryRespectingToolPairs 가 이미 isOrphanedToolResult 처리 — 코드 변경 X                                                 |
| D11  | `packages/server/src/plugins/__tests__/mcp.test.ts` (93줄) + fixture | ⚠️→✅ | manifest 파일명 `manifest.json` → `finclaw-plugin.json` (todo 오류 보정), fixture: raw → McpServer.registerTool 고수준 (안정성) |
| D12  | `docs/plugins/mcp.md` (51줄)                                         | ✅    | 51줄 (todo 80줄 명시에서 군더더기 축소, 정보 동일)                                                                              |
| D13  | (검증)                                                               | ✅    | typecheck + 2/2 + 1533/1533 + 0 lint                                                                                            |

---

## 2. 자동화 검증 결과

| 명령                | 결과     | 카운트/시간                                    | 비고                                 |
| ------------------- | -------- | ---------------------------------------------- | ------------------------------------ |
| `pnpm typecheck`    | ✅ PASS  | exit 0 / <1s                                   | tsgo --noEmit                        |
| `pnpm test --run`   | ✅ PASS  | 168 files / 1533 / 1533 / 137.58s              | -                                    |
| `pnpm test:storage` | ✅ PASS  | 14 files / 119 / 119 / 95.97s                  | -                                    |
| `pnpm lint`         | ✅ clean | 0 warn / 0 err / 501 files / 126 rules / 599ms | oxlint                               |
| mock-only 격리      | ✅ PASS  | 4/4 신규 테스트 모두 외부 키 unset 통과        | CLAUDE.md feedback_tests_no_api_keys |
| e2e/live tier       | —        | 미실행                                         | 사용자 미요청 (기본 스킵)            |

implementer-log 보고 수치와 100% 재현됨.

---

## 3. 경계면 검증

### 3.1 RPC ↔ UI

- **`memory.getById`**: ⚠️ 등록 OK, 호출 사이트 0건
  - 등록: `packages/server/src/gateway/rpc/methods/memory.ts:228-243` schema/execute 정상.
  - `grep -rn "memory.getById" packages/web/ packages/tui/` 매칭 0건.
  - settings-view.ts:500 은 `usedMemoryIds` 를 `(run.usedMemoryIds ?? []).join(', ')` 텍스트 표시만 — client 호출 X.
  - todo.md 가 "구체 점프 동작은 implementer 재량, 최소 토스트" 허용 → 명세적 ✅, 실용적 dead RPC. Phase 30 에서 web 인용 점프 UI 만들 때 client 추가 필요.

- **`AgentRunFull.usedMemoryIds?` ↔ settings-view**: ✅ 정확히 same field (`packages/web/src/app-gateway.ts:492` ↔ `packages/web/src/views/settings-view.ts:500`).

### 3.2 storage ↔ RPC ↔ types (B 트랙)

전 체인 일관:

- DB 컬럼 `agent_runs.used_memory_ids TEXT NULL` (`database.ts:207`) ↔ `MIGRATIONS[7]` PRAGMA guard
- snake_case row `AgentRunRow.used_memory_ids: string | null` (`agent-runs.ts:7-23`)
- INSERT 14컬럼 14 placeholders 정확 (`agent-runs.ts:103-105`)
- JSON.parse null 가드 (`rowToAgentRun`)
- camelCase types `AgentRun.usedMemoryIds?: string[]` (`types/agent.ts:111`)
- web shape `AgentRunFull.usedMemoryIds?: readonly string[]` (`app-gateway.ts:492`)

### 3.3 pipeline ↔ prompt (B 트랙)

- 마커 생성: `[mem:${s.id.slice(0, 6)}]` (6자) ✅
- 시스템 프롬프트 가이드: `[mem:xxxxxx]` (6자) + 복수 `[mem:aaa,bbb]` ✅
- 추출 정규식: `/\[mem:([a-f0-9]{6,8}(?:,[a-f0-9]{6,8})*)\]/g` ✅
  - 6-8자 허용은 LLM 출력 길이 변동 흡수 — 실해는 없으나 의도 명시 안 됨 (P2 후보, §4.3 참조)
- prefix 매칭 `c.id.startsWith(p)` ✅
- 호출: `execution-adapter.ts:309-313` `ctx.retrievalResult?.snippets` candidates ✅

### 3.4 plugin loader ↔ ToolRegistry ↔ 9-단계 정책 (D 트랙)

세 면 정확히 same group/verdict/pattern:

- `mcp-tool-bridge.ts:37` `group: 'mcp'`
- `BUILT_IN_GROUPS` `id: 'mcp'`, `defaultPolicy: 'require-approval'`
- `main.ts:336-341` `addPolicyRule({ pattern: 'mcp:*', verdict: 'require-approval', priority: 100 })`
- `loader.ts:226-252` 도구 등록 전후 shutdown handle 누적 ✅

### 3.5 embedding registry ↔ vec0 차원 (C 트랙)

전 체인 정합 — silent corruption 차단:

- DDL 고정 `float[1024]` (`database.ts:78-81`)
- `readVectorDimension` sqlite_master `float\[(\d+)\]` 추출 → 1024
- `Database.vectorDimension` boot 1회 캐시
- `FinClawStorage.vectorDimension` 노출
- `main.ts:210-213` `createEmbeddingProvider('auto', { dimensions: storage.vectorDimension })` + `assertEmbeddingDimension`
- OpenAI body 에 dimensions=1024 → 출력 1024D
- 에러 메시지가 `OpenAIEmbeddingProvider({ dimensions: ${expectedDim} })` 권장 동작까지 안내

### 3.6 broadcaster / shutdown ordering (D 트랙)

ProcessLifecycle LIFO 순서로 안전:

- `main.ts:560` gateway.stop() 등록 (later)
- `main.ts:352-356` plugin shutdown 등록 (earlier)
- 종료 순서: gateway listen 종료 → MCP handles shutdown ✅ (gateway 가 MCP 도구 호출 중일 가능성 차단)

---

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

**상속된 부채 1건** (phase 29 가 도입한 위반은 아니지만 C 트랙 의도와 충돌):

1. **`packages/storage/src/embeddings/openai.ts:91-96` — embedBatch 의 silent fallback (catch-all 후 개별 임베딩)**
   - 현 상태: `try { fetch batch } catch { for text of batch: results.push(await embedQuery(text)) }`. 어떠한 에러든 (네트워크 / 401 / 422 / dimension mismatch) 모두 삼키고 N 회 단건 호출.
   - 근거: dimension mismatch 가 원인이면 단건 호출도 같은 이유로 실패 → N 배 비용·시간 소모. 401/4xx 도 동일 대응 → 운영자 신호 손실. **C 트랙의 dimension guard 의도와 모순**.
   - 제안: catch 제거 또는 `res.status >= 500` retriable 케이스만 fallback. 가장 단순한 옵션은 fallback 자체 제거 (batch 실패 시 throw).
   - 머지 차단성: 본 phase 가 **도입** 한 위반이 아니라 **상속** 한 부채. 즉시 수정 권장이지만 phase 29 머지 차단 사유는 아님 (병합 후 P0 으로 follow-up).

### P1 — 권장 (다음 phase 안에)

1. **`packages/server/src/plugins/loader.ts:225-252` — MCP 등록 블록 인라인 (32줄, 들여쓰기 4단)**
   - 5-stage 파이프라인 (`Stage 1..5` 주석) 일관성을 깸. 사실상 Stage 6 (MCP-Bridge) 가 끼어든 형태.
   - 제안: `registerManifestMCPServers(manifest, toolRegistry, recordDiagnostic)` 한 함수로 추출 (~25줄). loader 본체는 5-stage 형태 유지.
   - 외과적: todo D8 직접 결과 → §3 위반 아님. 향후 transport (SSE/WS) 추가 시 재작업 비용 감소 목적.

2. **`packages/agent/src/providers/openai.ts:115-182` — streamCompletion SSE 매핑 67줄 단일 함수 직조**
   - chunk 6종 (text_delta/tool_use_start/tool_input_delta/tool_use_end/usage/done) 분기가 한 for-await 루프. `startedToolIndices` stateful Set.
   - 제안: `mapOpenAIChunkToStreamChunks(chunk, startedToolIndices): StreamChunk[]` 추출 → 67줄 → ~25줄 (호출부) + ~40줄 (helper). 현재 streamCompletion 통합 테스트만 — helper 직접 검증 가능해짐.

3. **`packages/server/src/main.ts:563-578` — dev 분기 동적 import + hot reloader 16줄**
   - tsc 빌드 (번들러 X) 환경에서 동적 import 의 dev-only 효과 무의미. 일반 import 또는 `setupHotReload(...)` 함수 추출.
   - 외과적: todo E3 가 동적 import 까지 요구하지 않음 → 약한 §3 의심.

4. **`packages/server/src/plugins/mcp-tool-bridge.ts:33-43` — RegisteredToolDefinition 4 필드 hard-code**
   - `requiresApproval: true`, `isTransactional: false`, `accessesSensitiveData: false`, `isExternal: true` 일괄 부여. group=`mcp` policy rule 과 **이중 강제**. 또한 MCP 도구가 file/DB write 가능한데 false 가정 → finance-safety 우회 가능성.
   - 제안: bridge 는 group/isExternal/timeoutMs 만 설정, 나머지는 default 또는 spec 옵션 (`MCPServerSpec.transactional?`). spec 옵션 추가는 Phase 30.

5. **`packages/server/src/main.ts:336-356` — MCP wiring 3단계 (policy rule + loadPlugins + shutdown) main() 인라인**
   - main() 본체 ~470줄. `setupMCPPlugins(toolRegistry, lifecycle, logger)` 추출 시 ~15줄 감소.
   - **단 1회 호출** → CLAUDE.md §2 "한 번만 쓰는 추상화 X" 와 충돌. 즉시 추출 비권장. plugin loader 가 main() 외 (e.g. 테스트 부트) 에서도 호출되면 그때.

### P2 — 선택 (선호 차이)

1. **`packages/storage/src/database.ts:396-408` — readVectorDimension sqlite_master 정규식**
   - vec0 type 컬럼 빈 문자열 한계 → `sqlite_master.sql` 의 `float\[(\d+)\]` 추출. sqlite-vec 0.x → 1.x 시 형식 변경 (e.g. `f32[1024]`) 가능성.
   - 제안: 단위 테스트 1개 추가 — fresh DB → 1024 반환 확인.

2. **`packages/storage/src/embeddings/provider.ts:24-26` — 1024D 단정 docstring 스테일**
   - 주석: `// vec0 DDL declares float[1024]. Only voyage-finance-2 (1024D) fits.` → C 트랙이 OpenAI truncation 도입했으므로 무효화.
   - 제안: 주석 갱신 (voyage 직접 / OpenAI dimensions=1024 truncation).

3. **`packages/server/src/auto-reply/execution-adapter.ts:111-133` — extractCitedMemoryIds 정규식 6-8자 hex**
   - 마커 생성은 6자 고정인데 추출은 6-8자 허용. 의도 불명. 풀 확장 시 의도가 더 명확해짐.
   - 제안: `{6,8}` → `{6}` 또는 "LLM 출력 길이 변동 흡수" 주석 추가.

4. **`packages/storage/src/agent-runs.ts:103-105` — usedMemoryIds 직렬화 inline 조건**
   - `input.usedMemoryIds && input.usedMemoryIds.length > 0 ? JSON.stringify : null` (3줄). 빈 배열 round-trip 정책 명시 안 됨.
   - 제안: 미래 update 함수 (`linkMemoryToAgentRun`) 추가 시 helper `serializeMemoryIds` 추출. 현재 1회 호출 → §2 위반 우려로 즉시 추출 비권장.

---

## 5. 범위 밖 발견 (참고만)

> phase 29 가 도입한 dead 가 아니므로 §3 "기존 dead code 제거 X" 에 따라 언급만.

- `packages/server/src/plugins/loader.ts:24-30, 70-74, 298-299` — `PluginExports` interface / `resetJiti` / `loadPluginModule` re-export 가 `TODO(review)` 마커로 미사용 표기. 별도 phase 에서 의도 확인 후 처리 권장.
- `packages/storage/src/index.ts:137-154` — `ConversationRow` / `MemoryRow` interface 가 다른 파일과 중복 (`NOTE(review-1 R-2): duplicates ...`). 자체 NOTE 로 알려진 중복.

---

## 6. scope creep 의심 (사용자 확인)

**없음.** 핵심 의심 영역 6 건 모두 외과적 변경 원칙 부합 (자기 변경의 직접 결과 또는 환경 적응):

1. C1 PRAGMA → sqlite_master 정규식 — vec0 한계의 정당한 우회
2. C10 dist 상대경로 import — scripts/ workspace 비멤버 환경 적응 (사전 `pnpm build` 필요)
3. D11 manifest 파일명 — discovery.ts MANIFEST_FILENAME 상수 일치 (todo 오류 보정)
4. D11 fixture 고수준 API — SDK 안정성 우선
5. 테스트 갱신 (catalog/database.migration/agent-runs/transactions/tool-groups/memory-retrieval) 6 파일 — schema/count 변경의 자기 정리
6. lint/format 후속 (Array#sort→toSorted, for-of curly, async wrap, AgentRunFull.usedMemoryIds?) — 자기 변경 lint 자기 정리

---

## 7. 위험 신호

### 즉시 의사결정 불필요 (즉시 영향 낮음)

- **ID prefix 충돌 감지 부재** (P2): `[mem:<id 6자>]` 충돌 시 `extractCitedMemoryIds` 가 첫 candidate 만 매칭 후 `break` → 두 번째 메모리 누락. RAG 회상 풀 ≤ 3 (MAX_INJECTED_MEMORIES) 이라 16^6 ≈ 16.7M 조합 대비 실해 가능성 무시 가능. 풀 확장 시 표면화.
- **`memory.getById` dead RPC**: 등록 OK, 호출 0건. todo 명시 허용 범위 안. Phase 30 에서 web 인용 점프 UI 만들 때 client 추가 필요.

### 회귀 위험 — 없음

- v6→v7 SCHEMA 마이그레이션 idempotent 확인 (PRAGMA table_info 가드).
- shutdown ordering LIFO 안전.

---

## 8. 다음 phase 후보 (제안)

- **(P0 follow-up)** `embeddings/openai.ts:91-96` silent fallback 제거 — C 트랙 dimension guard 의도와 충돌.
- **(P1 #1)** `loader.ts` MCP 등록 32줄 인라인 → `registerManifestMCPServers` 추출.
- **(P1 #4)** `mcp-tool-bridge.ts` 4 필드 hard-code → `MCPServerSpec` spec 옵션 (`transactional?`, `accessesSensitiveData?`) 추가 + bridge 단순화.
- **(B7 활성화)** auto-reply pipeline 의 `addAgentRun` 호출 추가 → `usedMemoryIds: result.usedMemoryIds` 전달. 본 Phase 의 컬럼/타입/추출기는 모두 준비 완료.
- **(B8 활성화)** web 인용 점프 UI — `[mem:xxxxxx]` 마커 클릭 → `memoryClient.getById(prefix-resolved-id)` → 메모리 row highlight.
- **(C10 사용성)** `scripts/reindex.mjs` 의 dist import 운영 가이드 (사전 `pnpm build`) — README 또는 docs/operations.md.
- **(B6 충돌 가드)** prefix 충돌 시 8자 확장 또는 경고 로그.

---

## 9. 측정값

- 변경 파일 수: 51 (코드 ~38, 테스트 ~10, 문서/lock 3)
- 변경 LOC: +2322 / -50 (pnpm-lock 제외 ~+1370 / -50)
- 신규 파일 ≥30 LOC: 11
- 신규 테스트 카운트: A 87 + B 5 + C 5 + D 2 = ~99 시나리오 (이미 1533 PASS 풀 안에 포함)
- 5 트랙 + 5 커밋 + 1 docs 커밋 = 6 커밋
- 검토 소요: ~10분 (refactor + qa 병렬, 각 ~5분)
- review-draft 생성 일시: 2026-05-08

---

## 10. 권고 — 머지 가능 여부

**판정**: ✅ **머지 가능**

근거:

- TODO 일치도 61/62 ✅ (1 의도적 no-op, todo.md 명시 허용)
- 자동화 검증 4종 모두 PASS (typecheck / 1533 unit / 119 storage / 0 lint)
- 외과적 변경 원칙 100% 준수 (CLAUDE.md §3 위반 없음)
- 6 경계면 검증 5/6 ✅ + 1 ⚠️ (dead RPC, 명세적 OK)
- mock-only 외부 API 격리 100%
- v6→v7 마이그레이션 idempotent 보장
- shutdown ordering LIFO 안전

조건: 없음 (P0 1건은 상속된 부채로 phase 30 follow-up).

**Critical 5 해소 종합**:

- C-1 (Provider 다중화) ✅ A 트랙 완료
- C-2 (RAG citation) ✅ B 트랙 10/11 + 의도적 no-op (B7 영속화 경로는 Phase 30 활성화)
- C-3 (임베딩 차원 가드) ✅ C 트랙 완료
- C-4 (MCP + plugin loader) ✅ D 트랙 완료
- C-5 (Gateway 운영성) ✅ E 트랙 완료

Production-grade entry 기준 충족.
