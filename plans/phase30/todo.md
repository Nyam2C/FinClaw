# Phase 30 — 실행 가능한 TODO

> 본 문서는 [plan.md](./plan.md) 를 외과적으로 코드로 옮기기 위한 작업 지시서다. 트랙 A → C → B → D 순서가 권장 (의존 + 마이그레이션 단계 분리). 각 트랙 끝에 검증 명령. 실패 시 다음 트랙으로 진행하지 말 것.

브랜치: `feature/phase30-observability`
작업 디렉토리: `/mnt/c/Users/박/Desktop/hi/FinClaw`
시작 SHA: Phase 29 종료 SHA (각자 시작 시점 기록)

## 사전 준비

```sh
git status                              # clean working tree
git checkout -b feature/phase30-observability
git rev-parse HEAD                      # 시작 커밋 SHA 기록

# 본 Phase 는 v7 → v10 (3 단계) 마이그레이션 포함. dev DB 백업 필수
DEV_DB="${HOME}/.finclaw/db.sqlite"
[ -f "$DEV_DB" ] && cp "$DEV_DB" "${DEV_DB}.pre-phase30.bak" && echo "backed up to ${DEV_DB}.pre-phase30.bak"

# 감사 결과 백업 (Phase 30 종료 후 비교용)
mv _workspace/audit _workspace/audit_phase30_start
```

## 사용자 결정 사항 확정

plan.md 의 5가지 정책 결정 진행 전 확정:

- [ ] (A) OTel backend: **자체 web 뷰만 1차** (기본) / + Langfuse / + Jaeger
- [ ] (A) trace ID 형식: **W3C Trace Context** (기본 — 변경 불권장)
- [ ] (B) structured output 강제 도구 범위: **analysis 역할만 1차** (기본) / 모든 도구
- [ ] (C) access-log retention: **30일** (기본) / 다른 값
- [ ] (D) re-ranker: **로컬 cross-encoder ONNX** (기본) / Cohere API / 둘 다

미정 시 기본값 채택.

---

## 트랙 A — OpenTelemetry trace + span tree + web 뷰 (먼저 완료 — C/D 가 의존)

### A1. OTel SDK 의존 추가

```sh
pnpm add @opentelemetry/api @opentelemetry/sdk-trace-base --filter @finclaw/server
```

`@opentelemetry/sdk-node` 는 미사용 — Node 자동 instrumentation 은 본 plan 비대상.

### A2. trace 타입 정의

`packages/types/src/trace.ts` 신규:

```ts
export interface TraceContext {
  readonly traceId: string; // 32 hex chars (W3C)
  readonly spanId: string; // 16 hex chars
  readonly parentSpanId?: string;
}

export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer';
export type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startNs: bigint;
  readonly endNs?: bigint;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<{
    name: string;
    ts: bigint;
    attributes?: Record<string, unknown>;
  }>;
  readonly status: SpanStatus;
  readonly statusMessage?: string;
}
```

`packages/types/src/index.ts` 에 re-export.

**검증**: `pnpm typecheck` 0 에러.

### A3. SCHEMA_VERSION v7 → v8 마이그레이션

`packages/storage/src/database.ts`:

- `SCHEMA_VERSION = 8`
- 마이그레이션 SQL:

  ```sql
  ALTER TABLE agent_runs ADD COLUMN trace_id TEXT;
  ALTER TABLE agent_runs ADD COLUMN parent_span_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_agent_runs_trace_id ON agent_runs(trace_id);

  CREATE TABLE IF NOT EXISTS spans (
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL PRIMARY KEY,
    parent_span_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_ns INTEGER NOT NULL,
    end_ns INTEGER,
    attributes TEXT NOT NULL DEFAULT '{}',
    events TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'unset',
    status_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_spans_trace_start ON spans(trace_id, start_ns);
  ```

`packages/storage/src/database.migration.storage.test.ts` 에 v7→v8 시뮬레이션 추가.

### A4. spans 스토리지

`packages/storage/src/spans.ts` 신규:

```ts
export function addSpan(db: Database, span: SpanRecord): void;
export function listSpansByTrace(db: Database, traceId: string): SpanRecord[];
export function getSpanTree(db: Database, traceId: string): SpanTreeNode[];

interface SpanTreeNode extends SpanRecord {
  children: SpanTreeNode[];
}
```

bigint serialize: SQLite INTEGER 는 8-byte signed → ns 값 안전 범위 내.

### A5. tracer helper

`packages/server/src/observability/tracer.ts` 신규:

```ts
import { trace, context, SpanStatusCode } from '@opentelemetry/api';

export interface FinclawTracer {
  withSpan<T>(name: string, attrs: Record<string, unknown>, fn: (ctx: TraceContext) => Promise<T>): Promise<T>;
  getCurrentContext(): TraceContext | undefined;
}

export function createTracer(db: Database, redactor: PIIRedactor): FinclawTracer { ... }
```

내부에서 OTel API 의 `tracer.startActiveSpan` 사용, span 종료 시 `addSpan(db, ...)`. PII redact 는 attributes 의 string 값에 적용.

`PIIRedactor` 는 기존 `FINANCIAL_REDACT_PATTERNS` 와 통합.

### A6. pipeline stage span 부여

`packages/server/src/auto-reply/pipeline.ts`:

- 각 stage 진입 시 `await tracer.withSpan(\`stage.${stage.name}\`, { sessionKey }, () => stage.process(ctx))`
- ctx 에 traceContext 전파 (PipelineContext 인터페이스 확장)

### A7. agent runner span 부여

`packages/agent/src/execution/runner.ts`:

- turn 마다 `await tracer.withSpan('agent.turn', { turn }, ...)`
- child span: `provider.stream` (provider/model 속성), `tool.execute.<name>` (input redacted, duration_ms)
- tool 실패 시 span.status='error' + statusMessage

### A8. agent_runs trace 컬럼

`packages/storage/src/agent-runs.ts`:

- `addAgentRun(input)` 의 input 에 `traceId`, `parentSpanId` 추가
- `getAgentRun(id, opts?: { withSpans?: boolean })` — withSpans=true 면 spans 동시 반환

### A9. trace RPC

`packages/server/src/gateway/rpc/methods/trace.ts` 신규:

```ts
export const traceMethods = {
  'trace.get': { params: TraceGetParams, result: TraceGetResult, authLevel: 'token', handler: ... },
  'trace.list': { params: TraceListParams, result: TraceListResult, authLevel: 'token', handler: ... },
};
```

`registry.ts` 에 등록.

### A10. types/gateway.ts 확장

Zod schema:

```ts
export const TraceGetParams = z.object({ traceId: z.string().length(32) });
export const TraceGetResult = z.object({
  traceId: z.string(),
  spans: z.array(SpanRecordSchema),
  agentRuns: z.array(AgentRunSummarySchema),
});
```

### A11. web trace-view

`packages/web/src/views/trace-view.ts` 신규:

- 좌측: trace 목록 (시간 desc, traceId, root span name, duration, status)
- 우측: 선택 trace 의 span tree (들여쓰기 트리 또는 flame graph; 1차는 들여쓰기로 단순)
- 각 span 의 attributes JSON 펼침/접힘
- agent_runs detail panel 과 양방향 링크 (있는 화면이면)

### A12. app-gateway RPC 래퍼

`packages/web/src/app-gateway.ts`:

- `trace.get(traceId)`, `trace.list({ since, limit })` 래퍼

### A13. spans storage test

`packages/storage/src/spans.test.ts` 신규:

- 트리 구성 (parent-child 관계)
- 시간 정렬
- N개 span 입력 → getSpanTree 가 정확한 트리

```sh
pnpm test:storage -- spans
```

### A14. tracer test

`packages/server/test/observability/tracer.test.ts` 신규:

- withSpan 중첩 (child trace context 가 parent span 참조)
- 에러 시 status='error' + message 기록
- PII redact — 이메일/전화/SSN 패턴이 attributes 에서 `[REDACTED]` 로 치환

```sh
pnpm test --filter @finclaw/server -- tracer
```

### A15. e2e

`packages/server/test/auto-reply/trace.e2e.test.ts` 신규:

- Discord mock 메시지 1개 → 전체 pipeline 실행
- 종료 후 `trace.get(traceId)` 호출 → spans ≥ 7 (stage 7개)
- agent_runs.trace_id 와 동일

```sh
pnpm test:e2e -- trace
```

**완료 조건**: 트랙 A 검증 명령 모두 통과 + plan.md 의 A 완료 조건 4개 충족.

---

## 트랙 C — Access-log SQLite + web 뷰 (스키마 v8 → v9, A 의 trace_id 사용)

### C1. SCHEMA_VERSION v8 → v9

`packages/storage/src/database.ts`:

```sql
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  method TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  actor TEXT,
  ip TEXT,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  trace_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_log_ts ON access_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_method_ts ON access_log(method, ts DESC);
```

마이그레이션 시뮬레이션 테스트 추가.

### C2. access-log 스토리지

`packages/storage/src/access-log.ts` 신규:

```ts
export interface AccessLogEntry {
  /* 컬럼과 동일 */
}

export function addAccessLog(db: Database, entry: AccessLogEntry): void;
export function listAccessLog(db: Database, opts: ListOpts): AccessLogEntry[];
export function purgeAccessLog(db: Database, olderThanDays: number): number; // 삭제 행 수 반환
```

### C3. logger SQLite 기록

`packages/server/src/gateway/access-log.ts`:

- 기존 stdout 출력 후 `addAccessLog(db, ...)` 호출
- params 는 sha256 hash (PII 보호) — `params_hash`
- ctx 의 traceContext 가 있으면 `trace_id` 부착

### C4. retention purge cron

`packages/server/src/automation/scheduler.ts` (또는 별도 internal cron 파일):

- 신규 internal cron — `0 4 * * *` (매일 04:00) `purgeAccessLog(retentionDays)`
- config 키 `accessLog.retentionDays` 기본 30
- 사용자 설정으로 override 가능

### C5. audit RPC

`packages/server/src/gateway/rpc/methods/audit.ts` 신규:

```ts
'audit.list': {
  params: z.object({ since: z.number().optional(), limit: z.number().max(500).default(100), method: z.string().optional(), actor: z.string().optional(), status: z.string().optional() }),
  result: z.array(AccessLogEntrySchema),
  authLevel: 'token',
  // operator 권한만 (Permission.AUDIT_READ 신설)
}
```

`packages/server/src/gateway/auth/permissions.ts` (또는 상응) 에 `Permission.AUDIT_READ` 추가.

### C6. types/gateway.ts 확장

Zod schema 추가.

### C7. web audit-view

`packages/web/src/views/audit-view.ts` 신규:

- 테이블: 시간 / 메서드 / actor / duration / status / trace
- 필터: method (multi-select), actor, 시간 범위, status
- 행 클릭 시 trace-view (트랙 A) 점프
- 페이지네이션 (limit=100 default)

### C8. app-gateway 래퍼

`packages/web/src/app-gateway.ts`:

- `audit.list({ since, limit, method, actor, status })`

### C9. access-log 스토리지 test

`packages/storage/src/access-log.test.ts` 신규:

- insert / list / purge 검증
- list 필터 동작
- purge 가 retention 내는 안 지움

```sh
pnpm test:storage -- access-log
```

### C10. gateway access-log e2e

`packages/server/test/gateway/access-log.test.ts` 확장:

- mock RPC 50회 → SQLite 50행
- params_hash 가 sha256(JSON.stringify(redacted_params))
- trace_id 부착 검증

```sh
pnpm test --filter @finclaw/server -- gateway/access-log
```

**완료 조건**: 트랙 C 검증 명령 모두 통과 + plan.md 의 C 완료 조건 3개 충족.

---

## 트랙 B — Structured output 강제 (A 와 독립, C 와 병렬 가능)

### B1. ToolDefinition 확장

`packages/types/src/tool.ts` (또는 `packages/agent/src/agents/tools/types.ts`):

```ts
export interface ToolDefinition {
  // ... 기존
  readonly outputSchema?: z.ZodType;
  readonly enforceStructuredOutput?: boolean;
}
```

### B2. ProviderAdapter forceToolChoice

`packages/agent/src/providers/adapter.ts`:

```ts
export interface StreamCompletionOptions {
  // ... 기존
  readonly forceToolChoice?: { name: string };
}
```

### B3. AnthropicAdapter

`packages/agent/src/providers/anthropic.ts`:

- request body 에 `tool_choice: forceToolChoice ? { type: 'tool', name: forceToolChoice.name } : undefined`

### B4. OpenAIAdapter

`packages/agent/src/providers/openai.ts` (Phase 29 트랙 A 산출):

- `tool_choice: forceToolChoice ? { type: 'function', function: { name: forceToolChoice.name } } : undefined`

### B5. analysis 도구 outputSchema 정의

분석 역할 도구들 (Phase 26 이후 정착) 의 outputSchema 추가:

- `packages/skills-finance/src/news/analyze.ts` (또는 상응): 예 — `{ summary, sentiment, topTickers, citationUrls }`
- `packages/skills-finance/src/market/analyze.ts`: 예 — `{ trend, volatility, drivers }`
- `packages/skills-finance/src/alerts/risk.ts`: 예 — `{ riskScore, factors[], recommendation }`

각각 `enforceStructuredOutput: true`.

### B6. runner 강제 호출 + 검증

`packages/agent/src/execution/runner.ts`:

- 분석 역할 (`role === 'analysis'`) 호출 시 1차 노출 도구 중 `enforceStructuredOutput=true` 인 도구 1개 선택 → `forceToolChoice` 전달
- tool_result 수신 시 `outputSchema.parse(toolOutput)` — 실패 시 1회 retry (도구 재호출)
- 두 번째 실패 시 `StructuredOutputValidationError` throw, fallback 으로 자유 텍스트 응답 허용 (정책 결정 — 단순함 우선)

### B7. policy 우선순위

`packages/agent/src/agents/tools/policy.ts`:

- 9-단계 정책에서 `require-approval` 이 결정되면 `enforceStructuredOutput` 무시 (사람이 승인 후 자유 결정)

### B8. provider structured output test

`packages/agent/test/providers/structured-output.test.ts` 신규:

- mock Anthropic/OpenAI provider 로 `forceToolChoice` 가 request body 에 정확히 전달되는지

```sh
pnpm test --filter @finclaw/agent -- structured-output
```

### B9. analysis 도구 schema test

`packages/skills-finance/test/analyze-portfolio-risk.test.ts` (예시):

- 도구 호출 → outputSchema 통과 시나리오
- 일부러 잘못된 출력 → 1회 retry → 두 번째 실패 시 명확한 에러

### B10. e2e

`packages/server/test/auto-reply/structured-output.e2e.test.ts` 신규:

- analysis 메시지 ("내 포트폴리오 리스크 분석해줘") → 강제 도구 호출 → schema 통과 → 응답 마크다운 렌더 검증

```sh
pnpm test:e2e -- structured-output
```

**완료 조건**: 트랙 B 검증 명령 모두 통과 + plan.md 의 B 완료 조건 4개 충족.

---

## 트랙 D — RAG re-ranking (스키마 v9 → v10, A·C 종료 후)

### D1. ONNX runtime 의존

```sh
pnpm add @huggingface/transformers --filter @finclaw/storage
```

`@huggingface/transformers` (Xenova) 가 ONNX runtime 자체 번들. CPU 추론 충분.

### D2. Reranker 모듈

`packages/storage/src/rerank/index.ts` + `packages/storage/src/rerank/local.ts` + `packages/storage/src/rerank/mock.ts`:

```ts
export interface Reranker {
  readonly id: string;
  rerank(query: string, candidates: string[]): Promise<number[]>;
}

export class LocalReranker implements Reranker {
  // Xenova/bge-reranker-v2-m3 (또는 jina-reranker-v2-base-multilingual)
  // pipeline('text-classification', modelName) 또는 직접 cross-encoder 호출
}

export class MockReranker implements Reranker {
  // 입력 순서 그대로 점수 반환 (테스트용 deterministic)
}
```

### D3. hybrid search rerank 통합

`packages/storage/src/search/hybrid.ts` (또는 `mergeHybridResults` 위치):

- 옵션 추가: `{ reranker?: Reranker; topKFirst?: number; topKFinal?: number }`
- topKFirst (기본 10) 까지 1차 hybrid → reranker.rerank → 점수순 정렬 → topKFinal (기본 3)
- reranker 미주입 시 기존 동작

### D4. SCHEMA_VERSION v9 → v10

`packages/storage/src/database.ts`:

```sql
ALTER TABLE agent_runs ADD COLUMN rerank_meta TEXT;
```

JSON: `{ model, scoresBefore, scoresAfter, swaps }`. swaps = topKFinal 안에서 1차 순서가 변한 횟수.

### D5. memory-retrieval rerank 호출

`packages/server/src/auto-reply/stages/memory-retrieval.ts`:

- config 키 `rag.rerank.enabled` (기본 true) 면 reranker 주입
- 결과 메타를 trace span attributes 와 agent_runs.rerank_meta 에 동시 기록 (트랙 A 활용)
- citation 형식 (Phase 29 B) 은 최종 top-3 ID 기준

### D6. 모델 다운로드 스크립트

`scripts/download-rerank-model.mjs` 신규:

- HF Hub 에서 ONNX 모델 다운로드 (`Xenova/bge-reranker-v2-m3` 또는 `Xenova/jina-reranker-v2-base-multilingual`)
- 다운로드 실패 시 명확한 에러 + "MockReranker 로 fallback 됩니다" 안내
- 캐시 디렉터리: `${HOME}/.cache/finclaw/models/rerank/`

```sh
pnpm tsx scripts/download-rerank-model.mjs
```

### D7. local rerank test (mock fallback 강제)

`packages/storage/src/rerank/local.test.ts` 신규:

- 모델 미존재 시 MockReranker fallback 검증 — 외부 모델 다운로드 없이 통과 가능
- MockReranker 로 점수 순서 검증 (입력 그대로)

```sh
pnpm test:storage -- rerank
```

### D8. hybrid rerank toggle test

`packages/storage/src/search/hybrid.test.ts` 확장:

- reranker 미주입 vs MockReranker 주입 결과 동일성 (Mock 은 순서 보존)
- 가짜 reranker (점수 역순) 주입 시 topKFinal 이 역순으로 반환

### D9. e2e

`packages/server/test/auto-reply/rerank.e2e.test.ts` 신규:

- MockReranker 로 — 1차 top-10 vs 최종 top-3 swap 시나리오 강제 → agent_runs.rerank_meta.swaps > 0 검증
- citation ID 가 최종 top-3 기준으로 부착되는지 검증

```sh
pnpm test:e2e -- rerank
```

**완료 조건**: 트랙 D 검증 명령 모두 통과 + plan.md 의 D 완료 조건 4개 충족.

---

## 통합 검증 (Week 5)

### 1. 전체 테스트

```sh
pnpm format:fix
pnpm lint
pnpm typecheck
pnpm test:all
```

모두 통과.

### 2. Phase 30 e2e 시나리오 일괄

```sh
pnpm test:e2e -- trace               # A: span tree 7+ 노드
pnpm test:e2e -- structured-output   # B: outputSchema 검증 + retry
# C: 50 RPC + audit.list (수동 검증 또는 e2e 스크립트)
pnpm test:e2e -- rerank              # D: rerank.swaps > 0
```

### 3. 마이그레이션 시뮬레이션

```sh
pnpm test:storage -- database.migration
```

v7 → v8 → v9 → v10 순차 통과.

### 4. 재감사

```sh
# 사전 준비 단계에서 _workspace/audit_phase30_start 백업 완료
# 본 하네스 재실행 — 메인 채팅에서:
# > Phase 30 종료 — finclaw-maturity-audit 다시 실행
```

검증:

- 종합 평균 ≥ **4.0**
- Runtime 2.5 (관찰성) = 5/5
- Runtime 2.6 (프롬프트) ≥ 4.5/5
- Memory 3.3 (RAG) ≥ 4.5/5
- Interface 4.2 (게이트웨이) ≥ 4.5/5
- 회귀 0 — Phase 29 후 점수 유지

### 5. review.md 작성

`plans/phase30/review.md` 신규:

- 정책 결정 5건 + 이탈 + 잔여
- 마이그레이션 v7→v10 실제 배포 후 dev DB 검증 결과
- 재감사 점수 비교 표 (Phase 29 후 vs Phase 30 후)
- Phase 31 후보 (M3) 로 이관할 항목 명시

### 6. CLAUDE.md 변경 이력 갱신

`/mnt/c/Users/박/Desktop/hi/FinClaw/CLAUDE.md` 의 "현대 AI 비서 성숙도 감사" 하네스 변경 이력 표에:

```markdown
| 2026-XX-XX | Phase 30 종료 — 종합 점수 X.X/5 (4.0+ 목표) | 전체 | 관찰성/structured/access-log/rerank 4 트랙 완료 |
```

### 7. 커밋·PR

각 트랙마다 별 커밋:

```sh
git commit -m "feat(server): wire OTel tracer + spans table + trace.* RPC + web/trace-view (Phase 30 A)"
git commit -m "feat(storage): access_log table + audit.* RPC + web/audit-view + retention cron (Phase 30 C)"
git commit -m "feat(agent): structured output forceToolChoice + outputSchema validation (Phase 30 B)"
git commit -m "feat(storage): RAG re-ranker (local ONNX + mock) + agent_runs.rerank_meta (Phase 30 D)"
git commit -m "docs(phase30): review with policy decisions, migration verification, audit re-run scores"
```

---

## 종료 체크리스트

- [ ] 사용자 결정 사항 5건 확정
- [ ] 트랙 A 완료 (A1-A15) — 스키마 v8
- [ ] 트랙 C 완료 (C1-C10) — 스키마 v9
- [ ] 트랙 B 완료 (B1-B10) — 스키마 변경 없음
- [ ] 트랙 D 완료 (D1-D9) — 스키마 v10
- [ ] 마이그레이션 시뮬레이션 v7→v10 통과
- [ ] 통합 검증 1-3 통과
- [ ] 재감사 종합 평균 ≥ 4.0 ✅
- [ ] review.md 작성
- [ ] CLAUDE.md 변경 이력에 Phase 30 행 추가
