# Phase 30 — 관찰성 · 감사 가능성 산업 표준화

## Context

Phase 29 가 종료된 시점에서 (예상 종합 점수 ~3.7/5, Production-grade 진입선) 아직 4.0+ 로 끌어올리려면 **사용자 제약과 가장 가중치가 높은 축** 에 투자해야 한다. 사용자 use case 는:

- 사용자 본인 1인 전용 (`memory/project_use_case.md`)
- **감사 가능성·환각 방지·읽기 전용 원칙 우선**
- 직접 학습 비대상

본 Phase 의 단일 목표는 **"내가 어떤 입력으로 어떤 모델/도구를 거쳐 어떤 회상을 활용해 어떤 답을 낸 것인지를 trace ID 하나로 끝까지 따라갈 수 있게 만드는 것"**. 부가적으로 **분석 도구의 응답 구조를 강제** 하여 환각 방지를 한 단계 끌어올리고, **회상 정확도** 를 re-ranking 으로 개선한다.

### 출발점 (감사 보고서 인용)

본 Phase 가 다룰 갭들 — `_workspace/audit/SUMMARY.md` 와 `runtime-tools.md` / `memory-knowledge.md` / `interface-channels.md` 출처:

| #    | 갭                                                                      | 영역      | 출처                         |
| ---- | ----------------------------------------------------------------------- | --------- | ---------------------------- |
| 30-1 | trace ID / span tree 표준 부재 — `agent_runs` 1행 + EventBus 분리       | runtime   | runtime-tools 2.5 (3.5/5)    |
| 30-2 | structured output 강제 부재 — 분석 도구가 prompt-only 로 JSON 형식 요청 | runtime   | runtime-tools 2.6 (3.5/5)    |
| 30-3 | access-log 가 stdout/stderr 에만 — 운영자 web 뷰 없음                   | interface | interface-channels 4.2 (3/5) |
| 30-4 | RAG re-ranking 부재 — 1차 hybrid 점수만 사용, citation 정확도 한계      | memory    | memory-knowledge 3.3 (3.5/5) |

이 4 트랙을 마치면 다음 점수 변화가 예상된다:

| 영역                     | Phase 29 후 (예상) | Phase 30 후 (목표)                          |
| ------------------------ | ------------------ | ------------------------------------------- |
| Runtime 2.5 관찰성       | 3.5                | **5.0** (OTel 표준, span tree, 재실행 메타) |
| Runtime 2.6 프롬프트     | 3.5                | **4.5** (structured output 강제)            |
| Interface 4.2 게이트웨이 | 4                  | **4.5** (access-log web 뷰)                 |
| Memory 3.3 RAG           | 3.5                | **4.5** (re-ranking + citation)             |
| **종합 평균**            | ~3.7               | **~4.0-4.1** (Production-grade 본격 진입)   |

### 사용자 결정 사항 (Phase 30 시작 전)

본 Phase 진입 전 다음 5 가지 정책 결정이 필요하다:

1. **(A) OTel backend** — self-hosted Jaeger / 자체 web 뷰 / Langfuse SaaS / 셋 모두? 본 plan 은 **자체 web 뷰만 1차 채택** (1인 사용자, 외부 의존 최소화). OTel SDK 표준 export 는 두지만 collector 는 미연결.
2. **(A) trace ID 형식** — W3C Trace Context (traceparent) 표준 채택. `agent_runs.trace_id` (32 hex) + `parent_span_id` (16 hex).
3. **(B) structured output 강제 도구 범위** — 1차는 **분석 도구 (analysis 역할 매핑된 도구)** 만. fetch/chat/summarize 는 자유 텍스트 유지. JSON schema 정의는 도구 정의에 추가.
4. **(C) access-log destination** — stdout (파일) + SQLite `access_log` 테이블 동시 저장. web 뷰는 SQLite 읽기 전용. retention = **30일** 기본 (사용자 설정 가능).
5. **(D) re-ranker** — **로컬 cross-encoder** (BGE-reranker-v2-m3 또는 jina-reranker-v2 ONNX) 1차. API (Cohere rerank) 는 옵션. Phase 29 의 임베딩 차원 가드와 동일하게 차원/모델 ID 메타로 추적. 외부 키 없이 mock fallback 강제.

미정 시 기본값 채택.

읽기 전용 원칙은 **유지** — trace 도 구조화 응답도 데이터 변경 능력을 추가하지 않는다.

---

## 트랙 A — OpenTelemetry trace + span tree + web 뷰 (30-1)

### 목표

W3C Trace Context 표준의 trace ID / span ID 를 모든 agent.run 흐름에 부여하고, span tree 를 SQLite 에 영속화하여 web 에서 시각화한다. Langfuse / Jaeger 등 외부 backend 호환은 OTel SDK export 인터페이스로 열어두되, 1차 backend 는 자체 web 뷰.

### 전제

- `packages/storage/src/agent-runs.ts` 가 1행짜리 실행 이력 저장 (Phase 26 D 산출).
- `packages/server/src/auto-reply/observer.ts` + EventBus 가 stage 간 이벤트를 발행 (Phase 26 산출).
- 이 둘은 **연결되어 있지 않음** — 본 트랙이 OTel span tree 로 통합.

### 작업

| 단계 | 파일                                                       | 설명                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `packages/server/package.json`                             | `@opentelemetry/api`, `@opentelemetry/sdk-node` (또는 sdk-trace-base 만) 의존 추가. SDK 표준만 — collector exporter 는 nope.                                                                                                                                                                      |
| A2   | `packages/types/src/trace.ts` (신규)                       | `TraceContext { traceId: string; spanId: string; parentSpanId?: string }`, `SpanRecord { traceId, spanId, parentSpanId?, name, kind, startNs, endNs?, attributes, events[], status }`.                                                                                                            |
| A3   | `packages/storage/src/database.ts`                         | SCHEMA_VERSION v7 → v8. 마이그레이션: `agent_runs` 에 `trace_id TEXT`, `parent_span_id TEXT` 컬럼. 신규 `spans` 테이블 (`trace_id`, `span_id`, `parent_span_id`, `name`, `kind`, `start_ns`, `end_ns`, `attributes` TEXT JSON, `events` TEXT JSON, `status` TEXT). 인덱스 `(trace_id, start_ns)`. |
| A4   | `packages/storage/src/spans.ts` (신규)                     | `addSpan`, `listSpansByTrace(traceId)`, `getSpanTree(traceId)` (parent → children 트리 구성).                                                                                                                                                                                                     |
| A5   | `packages/server/src/observability/tracer.ts` (신규)       | `createTracer()` — OTel API 의 `Tracer` 를 SQLite span exporter 로 wrap. `withSpan(name, attrs, fn)` helper — 비동기 함수에 span 부여.                                                                                                                                                            |
| A6   | `packages/server/src/auto-reply/pipeline.ts`               | 각 stage 진입 시 `tracer.withSpan('stage.<name>', ...)`. ctx 에 traceContext 전파.                                                                                                                                                                                                                |
| A7   | `packages/agent/src/execution/runner.ts`                   | turn 마다 span — `agent.turn`, child: `provider.stream`, `tool.execute.<name>`. tool span 의 attributes 에 input/output (PII redact 적용).                                                                                                                                                        |
| A8   | `packages/storage/src/agent-runs.ts`                       | `addAgentRun` 시 `traceId`, `parentSpanId` 받음. `getAgentRun` 이 span tree 동시 반환 (옵션).                                                                                                                                                                                                     |
| A9   | `packages/server/src/gateway/rpc/methods/trace.ts` (신규)  | `trace.get(traceId)` → spans + agent_runs join. `trace.list({ limit, since })` → 최근 trace 목록. authLevel=token.                                                                                                                                                                                |
| A10  | `packages/types/src/gateway.ts`                            | RPC 응답 Zod schema 추가.                                                                                                                                                                                                                                                                         |
| A11  | `packages/web/src/views/trace-view.ts` (신규)              | trace 목록 + 선택 시 span tree (들여쓰기 또는 flame graph). agent_runs detail panel 과 연결.                                                                                                                                                                                                      |
| A12  | `packages/web/src/app-gateway.ts`                          | `trace.*` RPC 래퍼.                                                                                                                                                                                                                                                                               |
| A13  | `packages/storage/src/spans.test.ts` (신규)                | tree 구성, 시간 정렬, redact 검증.                                                                                                                                                                                                                                                                |
| A14  | `packages/server/test/observability/tracer.test.ts` (신규) | withSpan 중첩, error 시 span.status='error', PII redact.                                                                                                                                                                                                                                          |
| A15  | `packages/server/test/auto-reply/trace.e2e.test.ts` (신규) | Discord 메시지 1개 → 전체 stage 의 span 이 SQLite 에 기록되고 `trace.get` 으로 트리 반환 검증.                                                                                                                                                                                                    |

### 검증

```sh
pnpm typecheck
pnpm test:storage -- spans
pnpm test --filter @finclaw/server -- observability tracer
pnpm test:e2e -- trace
# 운영 검증
pnpm dev &
# Discord 또는 web 에서 메시지 1개 → web/trace-view 에 traceId 보임
```

**완료 조건:**

- `agent_runs` 의 모든 새 row 에 `trace_id` non-null
- `spans` 테이블에 stage 7개 + turn N개 + tool M개 모두 기록 (depth ≥ 3)
- web/trace-view 에서 trace 1개 클릭 → span tree 시각화
- attributes JSON 에서 PII 패턴 (이메일/전화/SSN) redact 검증 unit test 통과

### 추정

**2.5 주** (A1-A4: 3일 / A5-A8: 4일 / A9-A12: 4일 / A13-A15: 3일 / 통합: 2일)

---

## 트랙 B — Structured output 강제 (30-2)

### 목표

분석 도구의 응답 구조를 prompt 의 자연어 지시가 아닌 **모델의 tool_use 강제 호출** 로 강제. 결과는 도구 정의의 Zod schema 로 즉시 검증. 환각 방지 가중치 ↑.

### 전제

- Phase 29 트랙 A 로 OpenAI provider 통합 — Anthropic `tool_choice='tool'`, OpenAI `tools[] + tool_choice={type:'function', function:{name}}` 양쪽 지원.
- `packages/agent/src/agents/tools/` 에 `analysis` 역할 매핑된 도구 N개 존재.

### 작업

| 단계 | 파일                                                                      | 설명                                                                                                                         |
| ---- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| B1   | `packages/types/src/tool.ts` (또는 상응)                                  | `ToolDefinition` 에 `outputSchema?: z.ZodType` (기존 `inputSchema` 와 대칭). `enforceStructuredOutput?: boolean` 플래그.     |
| B2   | `packages/agent/src/providers/adapter.ts`                                 | `streamCompletion` 옵션에 `forceToolChoice?: { name: string }` 추가.                                                         |
| B3   | `packages/agent/src/providers/anthropic.ts`                               | Anthropic API 의 `tool_choice: { type: 'tool', name }` 전달.                                                                 |
| B4   | `packages/agent/src/providers/openai.ts`                                  | OpenAI 의 `tool_choice: { type: 'function', function: { name } }` 전달.                                                      |
| B5   | `packages/skills-finance/src/{news,market,alerts}/`                       | 분석 역할 도구들 (예: `analyze_news`, `analyze_portfolio_risk`) 의 `outputSchema` 정의 + `enforceStructuredOutput: true`.    |
| B6   | `packages/agent/src/execution/runner.ts`                                  | 분석 역할 호출 시 `forceToolChoice` 전달. tool_result 수신 시 `outputSchema.parse()` 검증, 실패 시 1회 재시도 + 명확한 에러. |
| B7   | `packages/agent/src/agents/tools/policy.ts`                               | structured output 도구의 정책 우선순위 (require-approval 면 강제 결합 X — 정책 우선).                                        |
| B8   | `packages/agent/test/providers/structured-output.test.ts` (신규)          | mock provider 로 forceToolChoice 동작 검증 (Anthropic/OpenAI 각각).                                                          |
| B9   | `packages/skills-finance/test/analyze-portfolio-risk.test.ts` (신규/확장) | outputSchema 검증 — 잘못된 출력 시 재시도 → 두 번째 실패 시 명확한 에러.                                                     |
| B10  | `packages/server/test/auto-reply/structured-output.e2e.test.ts`           | analysis 역할 메시지 → 도구 강제 호출 → schema 검증 통과 → 응답 마크다운 렌더링 검증.                                        |

### 검증

```sh
pnpm typecheck
pnpm test --filter @finclaw/agent -- providers/structured-output
pnpm test --filter @finclaw/skills-finance
pnpm test:e2e -- structured-output
```

**완료 조건:**

- 분석 도구 (`analysis` 역할) N개 모두 `outputSchema` 정의 + `enforceStructuredOutput: true`
- mock test — 잘못된 schema 출력 시 1회 재시도 → 명확한 에러 분류
- e2e — 실제 API 호출 시 도구가 강제 발생, JSON schema 통과
- 회귀 0 — fetch/chat/summarize 도구 자유 텍스트 유지

### 추정

**1 주** (B1-B4: 3일 / B5-B7: 2일 / B8-B10: 2일)

---

## 트랙 C — Access-log SQLite + web 뷰 (30-3)

### 목표

`createAccessLogger` 가 stdout 외에 SQLite `access_log` 테이블에도 동시 저장하여 운영자(=사용자 본인) 가 web 에서 모든 RPC 호출 이력을 audit 한다. 30일 retention.

### 전제

- Phase 29 트랙 E 에서 `createAccessLogger` 가 main.ts 에 배선됨.
- SQLite 가 이미 다른 영속 데이터의 single source of truth.

### 작업

| 단계 | 파일                                                      | 설명                                                                                                                                                                                                                                                      |
| ---- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | `packages/storage/src/database.ts`                        | SCHEMA_VERSION v8 → v9. 신규 `access_log` 테이블 (`id INTEGER PK AUTOINCREMENT`, `ts INTEGER`, `method TEXT`, `params_hash TEXT`, `actor TEXT`, `ip TEXT`, `duration_ms INTEGER`, `status TEXT`, `error TEXT`, `trace_id TEXT NULL`). 인덱스 `(ts DESC)`. |
| C2   | `packages/storage/src/access-log.ts` (신규)               | `addAccessLog`, `listAccessLog({ since, limit, method?, actor?, status? })`, `purgeAccessLog(olderThanDays)`.                                                                                                                                             |
| C3   | `packages/server/src/gateway/access-log.ts`               | 기존 logger 가 stdout 출력 외에 `addAccessLog` 호출. params 는 **redact 후 hash 만** (PII 보호). trace_id 가 ctx 에 있으면 함께.                                                                                                                          |
| C4   | `packages/server/src/automation/scheduler.ts` (또는 cron) | 신규 internal cron — 일 1회 `purgeAccessLog(30)` 실행. config 키 `accessLog.retentionDays` 기본 30.                                                                                                                                                       |
| C5   | `packages/server/src/gateway/rpc/methods/audit.ts` (신규) | `audit.list({ since, limit, method?, actor?, status? })` RPC. authLevel=token, 운영자 권한만 (해당 권한 enum 추가).                                                                                                                                       |
| C6   | `packages/types/src/gateway.ts`                           | RPC schema.                                                                                                                                                                                                                                               |
| C7   | `packages/web/src/views/audit-view.ts` (신규)             | 테이블 — 시간/메서드/actor/duration/status/trace 컬럼. 행 클릭 시 trace-view (트랙 A) 점프. 필터 (method, actor, 시간 범위).                                                                                                                              |
| C8   | `packages/web/src/app-gateway.ts`                         | `audit.*` 래퍼.                                                                                                                                                                                                                                           |
| C9   | `packages/storage/src/access-log.test.ts` (신규)          | insert / list / purge 검증.                                                                                                                                                                                                                               |
| C10  | `packages/server/test/gateway/access-log.test.ts` (확장)  | RPC 호출 → SQLite 기록 검증. params_hash 가 redact 적용된 입력 기준.                                                                                                                                                                                      |

### 검증

```sh
pnpm typecheck
pnpm test:storage -- access-log
pnpm test --filter @finclaw/server -- gateway/access-log
pnpm dev &
# 50회 RPC 호출
for i in {1..50}; do curl -s http://localhost:8787/jsonrpc -d '{"jsonrpc":"2.0","method":"system.ping","id":'"$i"'}' >/dev/null; done
# audit.list 로 50개 확인
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/jsonrpc \
  -d '{"jsonrpc":"2.0","method":"audit.list","params":{"limit":100},"id":1}' | jq '.result | length'
```

**완료 조건:**

- 모든 RPC 호출이 SQLite `access_log` 에 1행씩 기록 (sampling X)
- `audit.list` 30일 이상 oldest row 미반환 (purge 동작)
- web/audit-view 에서 trace_id 클릭 → trace-view 점프 (트랙 A 와 통합)

### 추정

**5-7 일** (C1-C2: 2일 / C3-C5: 2일 / C6-C8: 2일 / C9-C10: 1일)

---

## 트랙 D — RAG re-ranking (30-4)

### 목표

Phase 29 의 RAG citation 위에 **로컬 cross-encoder re-ranker** 를 추가하여 회상 정확도를 개선. 1차 hybrid (벡터+FTS) 의 top-K (현재 3) 를 top-K' (예: 10) 로 늘려서 re-ranker 에 통과시킨 후 최종 top-3 만 system prompt 에 주입.

### 전제

- Phase 29 트랙 B 로 RAG citation 동작 — 회상된 메모리 ID 가 추적됨.
- Phase 29 트랙 C 로 임베딩 차원 가드 동작 — re-ranker 모델도 동일 메타 추적 패턴 적용 가능.

### 작업

| 단계 | 파일                                                        | 설명                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | `packages/storage/package.json`                             | `@huggingface/transformers` (ONNX runtime) 또는 `onnxruntime-node` 의존 추가.                                                                                                                                                                                                 |
| D2   | `packages/storage/src/rerank/index.ts` (신규)               | `Reranker` 인터페이스 — `rerank(query: string, candidates: string[]): Promise<number[]>` (점수 배열). `LocalReranker` 구현 — `Xenova/bge-reranker-v2-m3` 또는 `jinaai/jina-reranker-v2-base-multilingual` ONNX 로딩. mock 도 동시 제공 (외부 모델 다운로드 실패 시 fallback). |
| D3   | `packages/storage/src/search/hybrid.ts` (수정)              | `mergeHybridResults` 의 top-K 옵션 확장 (1차 K=10), 결과를 `Reranker.rerank` 에 통과 후 최종 top-3 반환. config 키 `rag.rerank.enabled` (기본 true), `rag.rerank.topKFirst` (10), `rag.rerank.topKFinal` (3).                                                                 |
| D4   | `packages/storage/src/database.ts`                          | SCHEMA_VERSION v9 → v10. `agent_runs.rerank_meta TEXT NULL` (JSON: `{ model, scoresBefore, scoresAfter, swaps }`) — 감사용.                                                                                                                                                   |
| D5   | `packages/server/src/auto-reply/stages/memory-retrieval.ts` | rerank 호출 + 결과를 trace 의 attributes 로 부착 (트랙 A 와 통합). citation 형식은 Phase 29 트랙 B 그대로 유지 (re-rank 후의 ID 만 인용).                                                                                                                                     |
| D6   | `scripts/download-rerank-model.mjs` (신규)                  | 사용자 1회 모델 다운로드 — Hugging Face Hub 에서 ONNX. 다운로드 실패 시 명확한 에러 + mock fallback 안내.                                                                                                                                                                     |
| D7   | `packages/storage/src/rerank/local.test.ts` (신규)          | 모델 미존재 시 mock fallback. mock 으로 점수 순서 검증.                                                                                                                                                                                                                       |
| D8   | `packages/storage/src/search/hybrid.test.ts` (확장)         | re-rank 활성/비활성 toggle 결과 비교.                                                                                                                                                                                                                                         |
| D9   | `packages/server/test/auto-reply/rerank.e2e.test.ts` (신규) | mock reranker 로 — 1차 top-10 vs 최종 top-3 의 swap 사례 검증, agent_runs.rerank_meta 기록 검증.                                                                                                                                                                              |

### 검증

```sh
pnpm typecheck
pnpm test:storage -- rerank search/hybrid
pnpm test:e2e -- rerank
# 운영 검증
pnpm tsx scripts/download-rerank-model.mjs
pnpm dev
# Discord 또는 web 에서 동일 주제 다른 표현 질문 → trace-view 에서 rerank.swaps > 0 관찰
```

**완료 조건:**

- 외부 키 없이 (mock reranker) 모든 vitest 통과
- 실제 모델 1회 다운로드 후 e2e 통과
- agent_runs.rerank_meta 에 swap 통계 기록
- citation 형식 (Phase 29 B) 회귀 0

### 추정

**1-1.5 주** (D1-D2: 3일 / D3-D5: 3일 / D6-D7: 2일 / D8-D9: 2일)

---

## 의존 그래프 / 권장 일정

```
Week 1: A1-A4 │ B1-B4 │ C1-C3   (스키마 v7→v8→v9 순차, A→C 의존)
Week 2: A5-A8 │ B5-B7 │ C4-C6 │ D1-D2
Week 3: A9-A12 │ B8-B10 │ C7-C8 │ D3-D5
Week 4: A13-A15 │ C9-C10 │ D6-D9 + 통합 e2e
Week 5: 회귀 + 재감사 (`finclaw-maturity-audit`)
```

**의존:**

- C5 (audit.list) 의 trace_id 컬럼이 A 의 traceId 형식과 일치 — A 가 먼저 정의
- D5 (rerank trace 부착) 가 A 의 withSpan helper 사용 — A 가 먼저
- 스키마 마이그레이션 v7 → v8 (A) → v9 (C) → v10 (D) 순차 — 같은 PR 에 묶지 말 것

---

## 종료 기준 (Definition of Done)

1. **테스트** — `pnpm test:all` 통과 (4-tier). mock-only, 외부 모델/API 키 없이.
2. **타입체크 / 포맷 / 린트** — 0 위반.
3. **마이그레이션** — v7 → v10 (3 단계) 시뮬레이션 테스트 통과. 기존 dev DB 백업 → migrate → roll-forward 검증.
4. **트랙별 e2e** — 각 1개 이상 명시적 통과:
   - A: Discord 메시지 1개 → trace-view 에 span tree 7+ 노드 시각화
   - B: 분석 도구 호출 → outputSchema 통과 → 잘못된 schema 1회 재시도 분기 검증
   - C: 50 RPC → audit.list 50건 + 30일 retention purge 동작
   - D: 동일 주제 다른 표현 질문 → rerank.swaps > 0 + citation ID 변경
5. **재감사** — `_workspace/audit/SUMMARY.md` 백업 후 `finclaw-maturity-audit` 재실행. 종합 평균 **≥ 4.0**, Runtime 2.5 = 5/5, Memory 3.3 ≥ 4.5/5.
6. **review.md** — `plans/phase30/review.md` 작성 (정책 결정 5건 + 이탈 + 잔여 작업).
7. **사용자 검증** — Phase 30 종료 후 본인이 web/trace-view, web/audit-view 를 실사용하고 의견 기록.

---

## 의도적 비대상 (Phase 31 이후)

본 Phase 에서 **건드리지 않는** 것:

- **외부 OTel collector / Langfuse / Jaeger 통합** — 본 plan 은 자체 web 뷰만. Phase 31+ 에서 SDK exporter 만 추가하면 가능 (인프라는 트랙 A 에서 준비).
- **거래 회계 무결성** (Important I-2) — Phase 31 (M3) 우선 후보
- **Mock 임베딩 fallback** (Important I-3) — Phase 31 (M3)
- **메모리 편집 UI / 자동 추출** (Important I-4 + ChatGPT Memory 격차) — Phase 31 (M3)
- **vision / file 첨부** (Important I-5) — Phase 32 (M1)
- **OpenAI-호환 endpoint** stub 완성 (Important I-7) — Phase 32 (M1)
- **워커 프로세스 분리** (Important I-1) — Phase 33 (M4)
- **Letta 식 3계층 메모리, Canvas/Artifacts** — Nice-to-have, 사용자 가시 가치 측정 후

---

## 변경 이력

| 날짜       | 변경      | 사유                                                                                |
| ---------- | --------- | ----------------------------------------------------------------------------------- |
| 2026-05-03 | 초기 작성 | Phase 29 종료 후 종합 4.0+ 진입 — 사용자 제약(감사·환각 방지) 가중치 최대 영역 우선 |
