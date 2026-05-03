# Phase 29 — 실행 가능한 TODO

> 본 문서는 [plan.md](./plan.md) 를 외과적으로 코드로 옮기기 위한 작업 지시서다. 트랙 A-E 는 의존 그래프 (plan.md 의 권장 일정) 대로 진행. 각 단계 끝에 검증 명령. 실패 시 다음 단계로 진행하지 말 것.

브랜치: `feature/phase29-critical-five` (또는 `main` 직접)
작업 디렉토리: `/mnt/c/Users/박/Desktop/hi/FinClaw`
시작 SHA: `30913d7` (`docs(phase28): add review with implementation, refactoring, and test scenarios`)

## 사전 준비

```sh
git status                              # clean working tree
git checkout -b feature/phase29-critical-five
git rev-parse HEAD                      # 시작 커밋 SHA 기록 (= 30913d7)

# 본 Phase 는 v6 → v7 마이그레이션을 포함 (트랙 B). dev DB 백업 필수
DEV_DB="${HOME}/.finclaw/db.sqlite"
[ -f "$DEV_DB" ] && cp "$DEV_DB" "${DEV_DB}.pre-phase29.bak" && echo "backed up to ${DEV_DB}.pre-phase29.bak"

# 감사 결과 백업 (Phase 29 종료 후 비교용)
mv _workspace/audit _workspace/audit_phase29_start
```

## 사용자 결정 사항 확정

plan.md 의 5가지 정책 결정을 진행 전 확정:

- [ ] (A) `runWithModelFallback` cross-provider 폴백: **동일 벤더 내만** (기본) / cross-provider 허용
- [ ] (A) 1차 추가 provider: **OpenAI** (기본) / 다른 벤더
- [ ] (C) 차원 정책: **provider 별 단일 차원 락 + truncation** (기본) / 다중 차원 vec 테이블
- [ ] (D) MCP transport: **stdio 만** (기본) / + SSE/WebSocket
- [ ] (D) MCP 도구 정책: **group=mcp 슬롯 + require-approval 기본** (기본) / 도구별 fine-grained

미정 시 기본값 채택.

---

## 트랙 E — Gateway 운영성 모듈 배선 (먼저 완료 → main.ts 배선 패턴 정립)

### E1. `RequestRateLimiter` 를 router 직후 미들웨어로

`packages/server/src/main.ts` 의 게이트웨이 부트 시퀀스 (router 등록 직후, server.listen 이전) 에 다음 추가:

- `RequestRateLimiter` import (`./gateway/rate-limit.ts`)
- config 키 `gateway.rateLimit.requestsPerMinute` 로딩 (기본 60)
- 미들웨어로 router wrap → 429 응답에 `Retry-After` 헤더

**검증**: `grep -n "RequestRateLimiter" packages/server/src/main.ts` 가 import + 호출 2건 이상.

### E2. `createAccessLogger` 미들웨어

같은 위치에 access logger 등록:

- `createAccessLogger` import (`./gateway/access-log.ts`)
- destination: `process.env.NODE_ENV === 'production'` ? stdout (JSON) : stderr (pretty)
- 미들웨어 chain 의 가장 바깥쪽 (rate-limit 보다 바깥) 에 배치 — 모든 요청 로깅

**검증**: `pnpm dev` 후 RPC 호출 시 stderr 에 `method=system.ping duration=...` 형식 출력.

### E3. `createHotReloader` (dev only)

- `process.env.NODE_ENV !== 'production'` 일 때만 활성화
- 감시 대상: `packages/server/prompts/`, plugin manifest 디렉터리 (D6 와 호환)
- 변경 감지 시 prompts reload + 콘솔 로그

**검증**: `pnpm dev` 후 `packages/server/prompts/system-base.txt` 수정 → 콘솔에 reload 메시지.

### E4. `AuthRateLimiter` 를 auth chain 에 통합

`packages/server/src/gateway/auth/index.ts` (또는 auth 미들웨어 정의 파일):

- 토큰 검증 직전 `AuthRateLimiter` 호출 — IP 기반, 5/min 기본
- 초과 시 401 + `Retry-After`

**검증**: `for i in {1..10}; do curl -s -H "Authorization: Bearer wrong" http://localhost:8787/jsonrpc -d '{}' ; done` → 6번째 이후 429.

### E5. `registerHealthChecker` deep probe

`packages/server/src/main.ts` 부트 마지막에:

- `registerHealthChecker({ checks: [dbPing, embeddingProviderPing] })`
- `/healthz` → deep JSON, `/readyz` → shallow OK/FAIL

**검증**: `curl http://localhost:8787/healthz | jq '.checks'` → `db` + `embedding` 상태 포함.

### E6-E7. 부트 시퀀스 e2e + rate-limit 폭주 테스트

```sh
pnpm test --filter @finclaw/server -- main.test
pnpm test --filter @finclaw/server -- gateway/rate-limit
```

**완료 조건**: 트랙 E 검증 명령 모두 통과 + plan.md 의 E 완료 조건 5개 충족.

---

## 트랙 A — Provider 다중화 (E 와 병렬 가능, 본격은 E 종료 후)

### A1. `ProviderId` union 확장 + OpenAI 모델 카탈로그

`packages/agent/src/models/catalog.ts`:

- `export type ProviderId = 'anthropic' | 'openai';`
- `BUILT_IN_MODELS` 에 `gpt-4o`, `gpt-4o-mini` 2개 모델 추가 (`provider: 'openai'`)
- capabilities 정확히: tool_use=true, parallel_tool_calls=true, vision=true, prompt_caching=true (OpenAI Sept 2025+ 지원)

**검증**: `pnpm typecheck` 0 에러.

### A2. `OpenAIAdapter` 신규

`packages/agent/src/providers/openai.ts`:

- `import OpenAI from 'openai'` (의존 추가: `pnpm add openai --filter @finclaw/agent`)
- `streamCompletion(params): AsyncIterable<StreamChunk>` 구현 — Anthropic 의 6-variant chunk 와 동일한 interface 로 변환
- tool_use 변환: OpenAI tools[] ↔ Anthropic tools[] (이미 패키지에 정의된 ToolDefinition 으로 통일)
- 5-state FSM (IDLE → STREAMING → TOOL_USE → COMPLETED → ERROR) 동일 적용
- prompt caching: OpenAI 의 `cache_control` 또는 `prompt_cache_key` 활용

**검증**: `grep -c "implements ProviderAdapter\|extends.*ProviderAdapter" packages/agent/src/providers/openai.ts` ≥ 1.

### A3. provider factory 등록

`packages/agent/src/providers/index.ts`:

- `OpenAIAdapter` export
- `createProvider(id: ProviderId)` 팩토리에서 `id === 'openai'` 분기 추가

### A4. ENV 매핑

`packages/agent/src/auth/resolver.ts`:

- `ENV_KEY_MAP: Record<ProviderId, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }`

### A5. 라우팅 검증

`packages/agent/src/models/routing.ts` 의 4역할 라우팅이 ProviderId union 확장만으로 자동 동작하는지 확인. 동작하지 않으면 (특정 역할이 anthropic 모델만 hardcode) 일반화.

**검증**: `pnpm test --filter @finclaw/agent -- routing` 통과.

### A6. 폴백 정책 가드

`packages/agent/src/models/fallback.ts`:

- `runWithModelFallback` 에 `crossProviderFallback: boolean` 옵션 (기본 false — 사용자 결정 사항 1)
- false 시 chain 의 다음 모델이 다른 provider 면 skip + warn log

**검증**: `pnpm test --filter @finclaw/agent -- fallback` 에 cross-provider skip 시나리오 1개 추가.

### A7. OpenAIAdapter unit test

`packages/agent/test/providers/openai.test.ts` 신규:

- mock SSE response (Vitest 의 `MockReadableStream`) 로 streaming 검증
- tool_use 라운드트립
- retry 정책 (rate-limit 재시도, 5xx 회로차단)

```sh
pnpm test --filter @finclaw/agent -- providers/openai
```

### A8. routing test 확장

`packages/agent/test/models/routing.test.ts`:

- `provider=openai` 모델 선택 시나리오
- 폴백 chain 에 cross-provider 가 있을 때 가드 동작

```sh
pnpm test --filter @finclaw/agent
```

**완료 조건**: 트랙 A 검증 명령 모두 통과 + plan.md 의 A 완료 조건 4개 충족.

---

## 트랙 B — RAG citation

### B1. `formatBackgroundSection` 인용 ID 부착

`packages/server/src/auto-reply/stages/memory-retrieval.ts`:

- 회상된 메모리 마크다운 줄 끝에 `[mem:${id.slice(0, 6)}]` 부착
- 거래 회상에도 `[txn:${id.slice(0, 6)}]` 부착
- 6자 prefix 가 충돌 가능성 — 충돌 감지 시 8자로 확장 (단순함 우선, 충돌 빈도 측정 후 결정)

**검증**: 단위 테스트 — N 개 메모리 입력 → 출력 마크다운에 N 개 `[mem:xxxxxx]` 마커.

### B2. system prompt 에 인용 규칙

`packages/server/prompts/system-base.txt` (또는 RAG 주입 위치 prompts):

규칙 추가:

```
## 인용 규칙

회상한 사실(메모리 또는 거래)에 의존해 답변하면, 해당 문장 끝에
[mem:xxxxxx] 또는 [txn:xxxxxx] 형식으로 인용을 달아라.
추측이나 모델 일반 지식은 인용하지 마라.
복수 인용은 [mem:aaa,bbb] 형식.
```

**검증**: `grep -A 3 "인용 규칙" packages/server/prompts/system-base.txt` 가 매칭.

### B3. 응답 후처리 — 인용 추출

`packages/server/src/auto-reply/stages/execute.ts` (또는 response-formatter):

- 응답 텍스트에서 `\[mem:[a-f0-9]{6,8}(?:,[a-f0-9]{6,8})*\]` 정규식으로 인용 추출
- 추출된 ID prefix → `agent_runs` 의 회상 메모리 ID 중 prefix 매칭 → resolved memoryIds[]
- `agent_runs.usedMemoryIds` 에 JSON 저장

### B4-B5. 마이그레이션 v6 → v7

`packages/storage/src/database.ts`:

- `SCHEMA_VERSION = 7`
- 마이그레이션 SQL: `ALTER TABLE agent_runs ADD COLUMN used_memory_ids TEXT;` (JSON array)

`packages/storage/src/agent-runs.ts`:

- `AgentRun.usedMemoryIds?: string[]` 필드 추가
- `addAgentRun`, `getAgentRun`, `listAgentRuns` 모두 JSON parse/stringify

**검증**:

```sh
pnpm test:storage -- database.migration
```

### B6. `memory.getById` RPC

`packages/server/src/gateway/rpc/methods/memory.ts`:

- 이미 있으면 skip. 없으면 추가 — `memory.getById(id: string): Memory`

### B7. web settings-view 인용 점프

`packages/web/src/views/settings-view.ts` 또는 `agent-runs-detail-panel`:

- agent_run 상세에 `usedMemoryIds` 표시 → 클릭 시 해당 메모리 row highlight

### B8. e2e 테스트

`packages/server/test/auto-reply/memory-citation.e2e.test.ts` 신규:

```ts
// 1. 메모리 저장: "내 원칙은 X 다"
// 2. 동일 주제 질문: "내 원칙이 뭐였지?"
// 3. 응답에 [mem:xxxxxx] 포함 검증
// 4. agent_runs.usedMemoryIds 비어있지 않음
```

```sh
pnpm test:e2e -- memory-citation
```

**완료 조건**: 트랙 B 검증 명령 모두 통과 + plan.md 의 B 완료 조건 3개 충족.

---

## 트랙 C — 임베딩 차원 가드

### C1. `EmbeddingDimensionMismatchError` + registry 가드

`packages/storage/src/embeddings/index.ts` (또는 신규 `registry.ts`):

```ts
export class EmbeddingDimensionMismatchError extends Error { ... }

export function registerEmbeddingProvider(provider: EmbeddingProvider, db: Database) {
  const expected = db.getVectorDimension();
  const actual = provider.dimensions;
  if (actual !== expected) {
    throw new EmbeddingDimensionMismatchError(
      `provider ${provider.id} produces ${actual}-D embeddings but vec0 column expects ${expected}-D. ` +
      `Either configure provider truncation or run reindex with --provider=${provider.id} --recreate.`
    );
  }
  // ...
}
```

### C2. `database.getVectorDimension()`

`packages/storage/src/database.ts`:

- 부트 시 1회 `PRAGMA table_info('memory_chunks_vec')` 또는 schema 메타에서 차원 추출
- 메모리에 캐시
- `getVectorDimension(): number` 노출

### C3. OpenAI truncation

`packages/storage/src/embeddings/openai.ts`:

- `OpenAIEmbeddingProvider` 생성자에 `dimensions?: number` 옵션 — `text-embedding-3-small` API 의 `dimensions` 파라미터 활용 (1024 가능)
- `provider.dimensions` 가 옵션 값 반영

### C4. C3 unit test

`packages/storage/src/embeddings/openai.test.ts`:

- `new OpenAIEmbeddingProvider({ dimensions: 1024 }).dimensions === 1024`
- 잘못된 차원 mock provider 등록 시 throw 검증 (mock DB.getVectorDimension)

```sh
pnpm test:storage -- embeddings/openai
```

### C5. `atomicReindex` provider 변경 감지

`packages/storage/src/reindex.ts`:

- 메타 테이블 또는 KV 에 마지막 reindex 의 `providerId` 저장
- `atomicReindex` 호출 시 현재 등록된 provider id 와 비교, 다르면 강제 전체 reindex
- 동일하면 incremental (기존 동작)

### C6. reindex test

`packages/storage/src/reindex.test.ts`:

- provider 전환 후 `atomicReindex` 호출 → 모든 memory_chunks_vec 재계산 검증
- 미reindex 상태로 hybrid 검색 → 명확한 에러 메시지

### C7. 운영자 reindex 스크립트

`scripts/reindex.mjs` (기존 있으면 확장):

- CLI 인자: `--provider=<id>`, `--dimension=<n>`, `--dry-run`, `--recreate-vec-table`
- `--recreate-vec-table` 옵션 시 `memory_chunks_vec` DROP + CREATE (차원 변경 시 필수)

```sh
pnpm tsx scripts/reindex.mjs --dry-run --provider=openai --dimension=1024
```

**완료 조건**: 트랙 C 검증 명령 모두 통과 + plan.md 의 C 완료 조건 3개 충족.

---

## 트랙 D — MCP 클라이언트 + plugin 배선

### D1. MCP SDK 의존 추가

```sh
pnpm add @modelcontextprotocol/sdk --filter @finclaw/server
```

### D2. `MCPServerSpec` + manifest 확장

`packages/types/src/plugins.ts` (또는 plugin manifest 정의 파일):

```ts
export interface MCPServerSpec {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

// PluginManifest 에 추가
export interface PluginManifest {
  // ... 기존
  readonly mcpServers?: readonly MCPServerSpec[];
}
```

Zod 스키마도 동일 확장.

### D3. MCP transport 모듈

`packages/server/src/plugins/mcp-transport.ts` 신규:

```ts
export async function createMCPClient(spec: MCPServerSpec): Promise<MCPClient> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: [...spec.args],
    env: spec.env,
  });
  const client = new Client({ name: 'finclaw', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}
```

shutdown hook 등록 (client.close()) — plugin loader 가 누적.

### D4. MCP → ToolDefinition 변환

`packages/server/src/plugins/mcp-tool-bridge.ts` 신규:

- `client.listTools()` 호출 → 반환된 `Tool[]` 각각을 FinClaw `ToolDefinition` 으로 변환
- JSON Schema → Zod schema 변환 (라이브러리: `json-schema-to-zod` 또는 직접)
- `group: 'mcp'`, `isExternal: true`, `minModel: 'haiku'` (낮은 floor — 사용자 결정 사항 5 의 group 정책으로 일괄 통제)

### D5. plugin loader Register 확장

`packages/server/src/plugins/loader.ts`:

- 기존 5-stage 의 Register 단계에서 `manifest.mcpServers?.length > 0` 일 때 D3-D4 호출
- MCP 도구를 `ToolRegistry.register` 로 등록
- shutdown hook 누적 (plugin unload 시 client.close)

### D6. `main.ts` 부트 시퀀스 배선

`packages/server/src/main.ts`:

- 부트 시퀀스에 `await pluginLoader.load(config.pluginsDir ?? './plugins')` 추가 (게이트웨이 listen 직전)
- 종료 시 `await pluginLoader.shutdown()` 역순 실행

E6 의 부트 시퀀스 e2e 테스트에 plugin loader 활성화 검증 추가.

### D7. 9-단계 정책 group=`mcp` 슬롯

`packages/agent/src/agents/tools/policy.ts`:

- `EvaluatePolicy` 의 group 슬롯에 `'mcp'` 추가
- 기본 정책: `require-approval` (사용자 결정 사항 5)
- 사용자 settings 에서 group 정책 override 가능 (이미 인프라 있으면 활용)

### D8. transcript-repair MCP timeout 검증

`packages/server/src/auto-reply/execution-adapter.ts`:

- 기존 transcript-repair 가 MCP 도구의 비동기 timeout 케이스 (서버 미응답 → AbortSignal trigger) 를 orphan tool_use 로 감지하는지 검증
- 부족하면 케이스 추가

### D9. 가짜 stdio MCP 서버 e2e 테스트

`packages/server/test/plugins/mcp.test.ts` 신규:

- `child_process.fork()` 로 mock stdio MCP 서버 (도구 1-2 개 노출) 실행
- plugin manifest 에 등록 → loader 호출 → ToolRegistry 등록 검증
- agent.run 에서 해당 도구 호출 → 결과 → agent_runs 기록 검증

```sh
pnpm test --filter @finclaw/server -- plugins/mcp
```

### D10. 운영자 문서

`docs/plugins/mcp.md` 신규 (짧게, 50-80 줄):

- plugin manifest 예시 (mcpServers 포함)
- stdio 서버 등록 절차
- 9-단계 정책에서 group=`mcp` 동작 설명
- 알려진 제약 (transport stdio 만, SSE/WS 는 Phase 30+)

**완료 조건**: 트랙 D 검증 명령 모두 통과 + plan.md 의 D 완료 조건 4개 충족.

---

## 통합 검증 (4 주차)

### 1. 전체 테스트

```sh
pnpm format:fix
pnpm lint
pnpm typecheck
pnpm test:all
```

모두 통과해야 한다.

### 2. Critical 5건 e2e 시나리오 일괄 실행

```sh
pnpm test:e2e -- providers/openai      # C-1
pnpm test:e2e -- memory-citation       # C-2
pnpm test:storage -- embeddings reindex # C-3
pnpm test --filter @finclaw/server -- plugins/mcp # C-4
pnpm test --filter @finclaw/server -- gateway/rate-limit gateway/access-log # C-5
```

각 1개 이상 e2e 시나리오 통과.

### 3. 재감사

```sh
# 이전 SUMMARY 백업은 사전 준비 단계에서 완료 (audit_phase29_start)
# 본 하네스 재실행
```

다음 메시지 패턴으로 메인 채팅에 요청:

> Phase 29 종료 — finclaw-maturity-audit 다시 실행

오케스트레이터가 새 SUMMARY 작성. 검증 항목:

- 종합 평균 ≥ **3.7**
- Critical 5건 모두 해소 또는 "intentional" 라벨
- 회귀 0 — 기존 강점 5건 점수 유지 (4.0+)

### 4. review.md 작성

`plans/phase29/review.md` 신규:

- 트랙별 실제 결정 (정책 결정 5건 + 추가 결정)
- 계획에서 이탈한 부분 + 이유
- 잔여 작업 (Phase 30 이관)
- 시작/종료 SHA 비교 + LOC delta
- 재감사 결과 점수 비교 표

### 5. 커밋·PR

각 트랙마다 별 커밋:

```sh
git commit -m "feat(server/gateway): wire rate-limit/access-log/hot-reload/health (Phase 29 E)"
git commit -m "feat(agent/providers): add OpenAIAdapter + multi-provider routing (Phase 29 A)"
git commit -m "feat(server/auto-reply): RAG citation [mem:xxxxxx] format + agent_runs.usedMemoryIds (Phase 29 B)"
git commit -m "feat(storage/embeddings): dimension guard + provider-aware reindex (Phase 29 C)"
git commit -m "feat(server/plugins): MCP stdio client + ToolRegistry bridge + main.ts wiring (Phase 29 D)"
git commit -m "docs(phase29): review with policy decisions, deviations, audit re-run scores"
```

---

## 종료 체크리스트

- [ ] 사용자 결정 사항 5건 확정
- [ ] 트랙 E 완료 (E1-E7)
- [ ] 트랙 A 완료 (A1-A8)
- [ ] 트랙 B 완료 (B1-B8) — 마이그레이션 v6 → v7 검증
- [ ] 트랙 C 완료 (C1-C7)
- [ ] 트랙 D 완료 (D1-D10)
- [ ] 통합 검증 1-3 통과
- [ ] 재감사 종합 평균 ≥ 3.7 ✅
- [ ] review.md 작성
- [ ] CLAUDE.md 변경 이력에 Phase 29 행 추가
