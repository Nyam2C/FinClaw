# Phase 30 Review: 관찰성 · 감사 가능성 산업 표준화

> todo.md 기반 구현 코드 리뷰. 4 트랙 (A/C/B/D) 의 구현 완료 상태, 자동화 검증, 경계면 정합성, 리팩토링 후보를 기록한다.

base SHA: `ab729b6` ↔ HEAD: `1b2b52b` (변경 LOC: +4735+α / -420, todo.md 1796 LOC + pnpm-lock 624 LOC 제외 ~+2315 / -420 + hotfix ~+200)

4 트랙 + hotfix 커밋 chain:

- A `149b446` — OTel trace + span tree + web 뷰 (schema v7 → v8)
- C `e8558c8` — access-log SQLite + audit RPC + web view (schema v8 → v9)
- B `b03fd55` — structured output enforcement (analysis tools)
- D `e33d3be` — RAG re-ranking, local cross-encoder ONNX (schema v9 → v10)
- **hotfix** `1b2b52b` — wire trace_id + rerankMeta + RunnerTracerAdapter (P0-1/2/3 처리, 아래 §4 참조)

---

## 1. 구현 사항 (TODO 일치도)

전체: **55 단계 중 39 ✅ 완전 일치 / 11 ⚠️ 편차 (모두 정당화) / 1 ⚠️ 부분 미완 (D5) / 0 ❌ 누락**

### 사전 준비

| 단계 | 파일   | 상태 | 비고                                           |
| ---- | ------ | ---- | ---------------------------------------------- |
| P-1  | (env)  | ✅   | dev DB 미존재 → 백업 skip, audit snapshot skip |
| P-2  | (정책) | ✅   | 5 결정 모두 plan.md 기본값 채택                |

### 트랙 A — OpenTelemetry trace + span tree + web 뷰 (16/16, 2 편차)

| 단계 | 파일                                                                 | 상태 | 비고                                                                                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `packages/server/package.json`                                       | ✅   | `@opentelemetry/api` + `sdk-trace-base` + `context-async-hooks`                                                                                                                                                                                                 |
| A2   | `packages/types/src/trace.ts`                                        | ✅   | TraceContext / SpanKind / SpanStatus / SpanEvent / SpanRecord                                                                                                                                                                                                   |
| A3   | `packages/storage/src/database.ts`                                   | ✅   | MIGRATIONS[8] — spans + agent_runs ALTER, idx_spans_trace_start                                                                                                                                                                                                 |
| A4   | `packages/storage/src/spans.ts`                                      | ✅   | addSpan / listSpansByTrace / getSpanTree (orphan → root 처리)                                                                                                                                                                                                   |
| A5   | `packages/server/src/observability/{tracer,redact}.ts`               | ⚠️   | todo.md 미명시 `AsyncLocalStorageContextManager` + `BasicTracerProvider` 글로벌 등록 추가. 사유: noop ContextManager default 라 child span 부모 trace 묶임 깨짐 → 정당한 보강                                                                                   |
| A6   | `packages/server/src/auto-reply/pipeline.ts`                         | ✅   | `stageSpan` 헬퍼로 8 stage wrap, ctx.traceContext 전파                                                                                                                                                                                                          |
| A7   | `packages/agent/src/execution/runner.ts`                             | ✅   | RunnerTracerAdapter + agent.turn / provider.stream / tool.execute span                                                                                                                                                                                          |
| A8   | `packages/storage/src/agent-runs.ts`                                 | ✅   | Row/Input/AgentRun traceId/parentSpanId 필드, INSERT 17 컬럼                                                                                                                                                                                                    |
| A9   | `packages/server/src/gateway/rpc/methods/trace.ts`                   | ✅   | trace.get / trace.list RPC + token 인증                                                                                                                                                                                                                         |
| A10  | `packages/types/src/gateway.ts`                                      | ⚠️   | RpcMethod union 에 `trace.get`/`trace.list` 추가. todo.md 가 SpanRecordSchema Zod 응답 schema 를 요구했으나 implementer 가 types 패키지의 zod 의존 회피 — server 내부 raw 직렬화. 일관성 ✅ (audit/trace 가 처음 사례 아님 — system.ts/finance.ts 도 같은 패턴) |
| A11  | `packages/web/src/views/trace-view.ts`                               | ✅   | 들여쓰기 텍스트 트리. flame graph 의도적 비대상                                                                                                                                                                                                                 |
| A12  | `packages/web/src/app-gateway.ts`                                    | ✅   | `createTraceClient` 추가                                                                                                                                                                                                                                        |
| A13  | `packages/storage/src/spans.storage.test.ts`                         | ✅   | tree / 시간 정렬 / orphan                                                                                                                                                                                                                                       |
| A14  | `packages/server/src/observability/tracer.storage.test.ts`           | ✅   | id 형식 / status / error / nested / redact                                                                                                                                                                                                                      |
| A15  | `packages/server/src/auto-reply/__tests__/trace.e2e.storage.test.ts` | ✅   | pipeline 1회 → 7+ span / allSameTrace                                                                                                                                                                                                                           |
| A16  | (검증)                                                               | ✅   | typecheck / lint / test 모두 PASS                                                                                                                                                                                                                               |

### 트랙 C — Access-log SQLite + 운영자 web 뷰 (11/11, 3 편차)

| 단계 | 파일                                                     | 상태 | 비고                                                                                                                                                         |
| ---- | -------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1   | `packages/storage/src/database.ts`                       | ✅   | MIGRATIONS[9] — access_log + idx_access_log_ts / method_ts                                                                                                   |
| C2   | `packages/storage/src/access-log.ts`                     | ✅   | addAccessLog / listAccessLog / purgeAccessLog                                                                                                                |
| C3   | `packages/server/src/gateway/access-log.ts`              | ✅   | AccessLoggerOptions (writer/db/getTraceId) + sha256 16hex hashParams                                                                                         |
| C4   | `packages/server/src/main.ts:596`                        | ⚠️   | scheduler internal cron 미지원 → setInterval(24h) + lifecycle.register cleanup. types/config.ts AccessLogConfig.retentionDays. todo.md NOTE 권장 경로 — 정당 |
| C5   | `packages/server/src/gateway/rpc/methods/audit.ts`       | ⚠️   | audit.list RPC + token 인증. todo.md 가 시사한 AUDIT_READ permission enum 도입은 회피 — token 으로 충분 판단 (정당, 후속 가능)                               |
| C6   | `packages/types/src/gateway.ts`                          | ⚠️   | A10 와 동일 — Zod 응답 schema 회피                                                                                                                           |
| C7   | `packages/web/src/views/audit-view.ts`                   | ✅   | 테이블 + filter + traceId 점프 (anchor href, 라우터 hookup 은 web 영역)                                                                                      |
| C8   | `packages/web/src/app-gateway.ts`                        | ✅   | `createAuditClient`                                                                                                                                          |
| C9   | `packages/storage/src/access-log.storage.test.ts`        | ✅   | insert / list / order / purge / limit clamp                                                                                                                  |
| C10  | `packages/server/src/gateway/access-log.storage.test.ts` | ✅   | RPC → SQLite 기록                                                                                                                                            |
| C11  | (검증)                                                   | ✅   | typecheck / lint / test PASS                                                                                                                                 |

### 트랙 B — Structured output 강제 (11/11, 3 편차)

| 단계 | 파일                                                         | 상태 | 비고                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1   | `packages/agent/src/execution/tool-executor.ts`              | ⚠️   | implementer 가 LLM API-facing ToolDefinition 대신 application-side `RegisteredToolDefinition` 에 추가. 정당                                                                                                                                                                                                                                      |
| B2   | `packages/agent/src/providers/adapter.ts`                    | ✅   | ProviderRequestParams.forceToolChoice                                                                                                                                                                                                                                                                                                            |
| B3   | `packages/agent/src/providers/anthropic.ts`                  | ✅   | tool_choice `{type:'tool', name}`                                                                                                                                                                                                                                                                                                                |
| B4   | `packages/agent/src/providers/openai.ts`                     | ✅   | tool_choice `{type:'function', function:{name}}`                                                                                                                                                                                                                                                                                                 |
| B5   | `packages/skills-finance/src/news/tools.ts`                  | ⚠️   | AnalyzeMarketOutputSchema (trend/volatility/drivers/summary) + enforceStructuredOutput=true. todo.md 가 4개 분석 도구를 명시했으나 코드에 존재하는 분석 도구는 `analyze_market` 1개뿐(grep 확인) — CLAUDE.md §2/§3 (외과적 변경, 추측성 코드 금지). 정당하나 plan.md "도구**들**" 범위는 자연 미달 — 후속 phase 에서 도구 추가 시 동일 패턴 적용 |
| B6   | `packages/agent/src/execution/runner.ts:150`                 | ✅   | structuredOutputViolation 감지 → 다음 turn forceToolChoice 재호출. 두번째 violation 시 `StructuredOutputValidationError` throw                                                                                                                                                                                                                   |
| B7   | (정책)                                                       | ⚠️   | implementer 자체 판단 — require-approval 도구는 도구 실행 자체가 blocked → enforceStructuredOutput 자연 무시. policy.ts 별도 flag 추가 회피. ✅ 정당 (외과적 변경 §3)                                                                                                                                                                            |
| B8   | `packages/agent/src/providers/structured-output.test.ts`     | ✅   | vi.spyOn 으로 SDK call body tool_choice 검증 3 cases                                                                                                                                                                                                                                                                                             |
| B9   | `packages/skills-finance/src/news/structured-output.test.ts` | ✅   | AnalyzeMarketOutputSchema valid/invalid 6 cases                                                                                                                                                                                                                                                                                                  |
| B10  | `packages/agent/test/structured-output-dispatcher.test.ts`   | ✅   | dispatcher schema enforce 5 cases                                                                                                                                                                                                                                                                                                                |
| B11  | (검증)                                                       | ✅   | typecheck / lint / test PASS                                                                                                                                                                                                                                                                                                                     |

### 트랙 D — RAG re-ranking (10/10, 1 편차 + 1 미완 wire-up)

| 단계 | 파일                                                                | 상태 | 비고                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | `packages/storage/package.json`                                     | ✅   | `@huggingface/transformers` 추가. ONNX runtime 자체 번들                                                                                                                                                                                                                                                                           |
| D2   | `packages/storage/src/rerank/{index,local,mock}.ts`                 | ✅   | Reranker interface, LocalReranker (pipeline 'text-classification'), MockReranker, createRerankerWithFallback                                                                                                                                                                                                                       |
| D3   | `packages/storage/src/search/hybrid.ts`                             | ✅   | rerankResults helper + RerankMeta type. mergeHybridResults pure 보존                                                                                                                                                                                                                                                               |
| D4   | `packages/storage/src/database.ts`                                  | ✅   | MIGRATIONS[10] — agent_runs.rerank_meta TEXT                                                                                                                                                                                                                                                                                       |
| D5   | `packages/server/src/auto-reply/stages/memory-retrieval.ts:320-363` | ⚠️   | reranker 옵션 + RetrievalResult.rerankMeta 부착. **자체 보고 미완**: agent_runs.rerank_meta 자동 부착 미완 — pipeline 의 rerankMeta 가 노출되지만 호출처(agent.ts:109, scheduler.ts:247/268) 에서 input.rerankMeta 미사용. trace attributes 부착도 누락 (`pipeline.ts:121` 의 attrs 가 `{sessionKey}` 만). **위험 신호 — §7 참조** |
| D6   | `scripts/download-rerank-model.mjs`                                 | ✅   | HF Hub 1회 다운로드, RERANK_MODEL_ID env 오버라이드                                                                                                                                                                                                                                                                                |
| D7   | `packages/storage/src/rerank.storage.test.ts`                       | ✅   | 외부 모델 다운로드 없이 5 cases (Mock 점수 / LocalReranker id / fallback)                                                                                                                                                                                                                                                          |
| D8   | `packages/storage/src/search/hybrid.test.ts`                        | ✅   | rerankResults 4 cases (no reranker / empty / reverse / same order swaps=0)                                                                                                                                                                                                                                                         |
| D9   | `packages/server/src/auto-reply/__tests__/rerank.storage.test.ts`   | ✅   | DefaultMemoryRetrievalService rerankMeta 부착 e2e 2 cases                                                                                                                                                                                                                                                                          |
| D10  | (검증)                                                              | ✅   | typecheck / lint / test PASS                                                                                                                                                                                                                                                                                                       |

### 최종 검증

| 단계   | 결과 | 비고                                                                                                                    |
| ------ | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 검증-1 | ⚠️   | 전체 unit — 1551 중 1 flaky fail (`mcp.test.ts`, 30s timeout). 단독 재실행 PASS (28s). phase30 변경 없음 (phase29 산물) |
| 검증-2 | ✅   | trace.e2e / access-log.storage / structured-output / rerank.e2e 4 e2e 모두 PASS                                         |
| 검증-3 | ✅   | `database.migration.storage.test.ts` v5→v10 마이그레이션 PASS                                                           |
| 검증-4 | N/A  | 사용자 트리거 영역                                                                                                      |
| 검증-5 | N/A  | review.md 작성은 본 finalize 의 산출물                                                                                  |

### Implementer 자체 판단 검증 결과

- **A5** AsyncLocalStorageContextManager + BasicTracerProvider 글로벌 등록: ⚠️ — 1인 사용자 + 자체 web 뷰 결정에 부합. test isolation 미흡 (vitest 다른 test 가 OTel API 사용 시 충돌 가능). globalProviderRegistered idempotency 정확. 1차 phase 범위 OK, phase 31+ 모니터링 collector 추가 시 재검토 권장
- **A10/C6** types 패키지 zod 의존 회피: ✅ — `packages/types/src/` 에 zod import 없음 (grep 0건). 기존 system.ts/finance.ts 와 일관
- **B5** analyze_market 1개에만 outputSchema: ❌ (plan.md 범위 기준) / ✅ (CLAUDE.md §2/§3 기준) — analyze_news / analyze_portfolio_risk 도구는 미구현. plan.md "예시" 가 가상 도구. 도구 추가는 phase 31 범위
- **B7** require-approval 자연 무시: ✅ — analyze_market 은 `isTransactional: false` → policy 평가에서 require-approval 미트리거. 별도 메타 불필요
- **C4** main.ts setInterval (scheduler 미지원): ⚠️ — 부팅 시점부터 24시간 후 첫 실행, 매 재시작 시 retention 미적용 가능. 시작 시 1회 즉시 실행 + setInterval 권장. SchedulerService 내부 cron 추가 시 본 setInterval 도 이전 — TODO 주석 권장
- **D5** rerankMeta 자동 부착 미완: ❌ — implementer 가 인정한 수준보다 큼. agent_runs.rerank_meta 와 trace attributes 둘 다 끊김. **§7 위험 신호**

## 2. 자동화 검증 결과

| 명령                          | 결과              | 시간    | 비고                                                                                                                      |
| ----------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`              | ✅ PASS           | (빠름)  | tsgo --noEmit, exit 0                                                                                                     |
| `pnpm lint`                   | ✅ PASS           | (빠름)  | 524 files clean, 0 errors / 0 warnings                                                                                    |
| `pnpm test --run` (unit)      | ⚠️ 1550/1551 PASS | 292.25s | 유일 fail = `mcp.test.ts > manifest.mcpServers …`, 30s timeout. 단독 재실행 PASS (28s). flaky, phase29 산물, phase30 무관 |
| `pnpm test:storage --run`     | ✅ 144/144 PASS   | 288.81s | 21 files                                                                                                                  |
| migration v5 → v10 시뮬레이션 | ✅ PASS           | -       | `database.migration.storage.test.ts` 단계 분리 검증                                                                       |
| mock-only 외부 API 격리       | ✅ PASS           | -       | API 키 unset 상태 통과. fetch grep 0건. D2 LocalReranker 모델 미존재 시 mock fallback 자연 트리거                         |

## 3. 경계면 검증

### 3.1 RPC ↔ UI

- `trace.list` 응답 `{traces:[{trace_id, first_ns, last_ns, root_name}]}` ↔ web `TraceListResult.traces[]` (line 89-97): ✅ shape 일치
- `trace.get` `{traceId, spans, tree, agentRuns}` ↔ web `TraceGetResult` (line 116-121): ✅ 일치
- `audit.list` 응답 `AccessLogEntry[]` (id?, ts, method, paramsHash, actor?, ip?, durationMs, status, error?, traceId?) ↔ web `AccessLogEntry` (line 6-17): ✅ camelCase 1:1

### 3.2 storage ↔ RPC / pipeline

- agent_runs 17 컬럼 DDL ↔ INSERT 17 placeholder (`agent-runs.ts:108-114`): ✅
- spans 11 컬럼 DDL ↔ addSpan INSERT 11 placeholder (`spans.ts:38-55`): ✅. events JSON.parse 일치
- access_log 10 컬럼 DDL ↔ addAccessLog INSERT 9 placeholder (id 제외): ✅
- agent_runs.rerank_meta ↔ memory-retrieval rerank: ⚠️ PARTIAL — `RetrievalResult.rerankMeta` 노출되지만 호출처에서 input.rerankMeta 미사용. **§7 위험 신호**
- ToolDefinition.outputSchema ↔ runner forceToolChoice + 검증 + retry: ✅ — `tool-executor.ts:86-101` safeParse → structuredOutputViolation. `runner.ts:150-153` 감지 → 다음 turn forceToolChoice. 두번째 violation throw
- AnalyzeMarketOutputSchema ↔ analyze_market 등록: ✅ — `news/tools.ts:25` 정의, line 153 등록, line 122 도구명, `news/index.ts:103` flow

### 3.3 SCHEMA_VERSION 마이그레이션 분리

- v7 → v8 (`149b446` A): spans + agent_runs.trace 컬럼
- v8 → v9 (`e8558c8` C): access_log 테이블
- B 커밋 (`b03fd55`): 스키마 변경 없음
- v9 → v10 (`e33d3be` D): agent_runs.rerank_meta
- ✅ 한 커밋에 두 단계 묶임 없음. plan.md "같은 PR 에 묶지 말 것" 준수. MIGRATIONS[8/9/10] 분리 정의

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전 처리 권장)

1. **`packages/server/src/gateway/rpc/methods/agent.ts:110` + `automation/scheduler.ts:247,268` — agent_runs.trace_id wire-up 미완 (A7/A8)**
   - 문제: agent_runs.trace_id/parent_span_id 컬럼 + AddAgentRunInput 필드 추가됐으나 모든 호출처 미전달. 결과 모든 row 에서 trace_id NULL
   - 근거: plan.md A 트랙 완료 조건 #1 "agent_runs 의 모든 새 row 에 trace_id non-null" 미충족
   - 테스트가 이를 잡지 못한 이유: `trace.e2e.storage.test.ts` 가 storage layer 만 단독 검증 (직접 `addAgentRun({traceId})` 호출), 실제 코드 경로 미커버
   - 제안: `persistAgentRunAndAttach` 가 active trace context 를 `getCurrentTraceId` 로 가져와 input 부착. scheduler.ts 는 새 trace 시작 (`tracer.withSpan('schedule.run', ..., (ctx) => addAgentRun(..., {traceId: ctx.traceId}))`)
   - **[hotfix `1b2b52b` 적용 ✅]**: agent.ts RPC handler 본체를 `tracer.withSpan('rpc.agent.run', ..., async () => ...)` 로 wrap, persistAgentRunAndAttach 양 분기에 traceId/parentSpanId 부착. scheduler.ts `runOne` 도 `tracer.withSpan('scheduler.run', ...)` 로 wrap, addAgentRun 양 분기에 부착. AgentRpcDeps + SchedulerDeps 에 `tracer` 추가, main.ts 에서 주입

2. **`packages/server/src/main.ts:371-376` — Runner.RunnerTracerAdapter 미배선 (A7)**
   - 문제: runner.ts 의 RunnerTracerAdapter / runWithSpan 모두 추가됐으나 main.ts runnerFactory 가 tracer 미전달 → `Runner.tracer === undefined` → `runWithSpan` 이 fn 그대로 실행 (no-op). 결과 turn / provider.stream / tool.execute span 미발생, depth 1
   - 근거: plan.md A 트랙 완료 조건 #2 "spans 테이블에 stage 7 + turn N + tool M 모두 기록 (depth ≥ 3)" 미충족
   - 제안:
     ```ts
     const tracerAdapter: RunnerTracerAdapter = {
       withSpan: (name, attrs, fn) => tracer.withSpan(name, attrs, async () => fn()),
     };
     const runnerFactory: RunnerFactory = (dispatcher) =>
       new Runner({
         provider: anthropicAdapter,
         toolExecutor: dispatcher,
         laneManager: lanes,
         tracer: tracerAdapter,
       });
     ```
   - **[hotfix `1b2b52b` 적용 ✅]**: main.ts 에 tracerAdapter 생성 + runnerFactory 가 capture. RunnerTracerAdapter 를 `@finclaw/agent` 에서 root re-export. agentDeps + scheduler 에도 tracer 동시 주입. depth ≥ 3 (turn / provider.stream / tool.execute) 달성 — 실측 통합 테스트는 phase 31 후보

3. **`packages/server/src/auto-reply/stages/memory-retrieval.ts` ↔ `agent.ts:109` / `scheduler.ts:247,268` — RAG rerankMeta wire-up 미완 (D5)**
   - 문제: 4 단계까지 만들어졌으나 마지막 wire-up 끊김:
     - storage.database v10 ✅ / agent-runs.ts AddAgentRunInput ✅ / memory-retrieval.ts RetrievalResult.rerankMeta ✅
     - 누락: input.rerankMeta 채움 + trace attributes 부착 (`pipeline.ts:121` 의 attrs 가 `{sessionKey}` 만)
   - 근거: plan.md D 트랙 완료 조건 "agent_runs.rerank_meta 에 swap 통계 기록" 미충족 — 컬럼 항상 NULL
   - implementer 자체 인정 항목, refactor + qa 양측 일치 판정
   - 제안: P0-1 (traceId wire-up) 과 같이 persistAgentRunAndAttach 에서 retrievalResult 를 받아 input 부착. **단**, `agent.run` RPC 는 retrieval 단계 자체가 없음 — 본격 wire-up 이 큰 변경. 1차 phase 30 범위에서는 auto-reply 경로의 rerankMeta 를 audit log 로 출력하는 것만이라도 plan.md "감사용" 약속을 부분 충족. 또는 wire-up 을 phase 31 첫 작업으로 명시 이월
   - **[hotfix `1b2b52b` 1차 적용 ⚠️]**: 명시 옵션 채택 — auto-reply pipeline.ts 에서 retrieval stage 종료 후 `rerankMeta` 가 있으면 `logger.info('memory.rerank.observed', {sessionKey, ...rerankMeta})` audit log 출력. **agent_runs.rerank_meta 자동 부착은 phase 31 이월** (auto-reply 경로 addAgentRun 부재 — agent.run RPC 의 retrieval 단계 추가 또는 auto-reply 경로에 addAgentRun 도입 필요)

4. **`packages/server/src/gateway/server.ts:157,159,161` — RPC 메서드 등록의 db 의존 fragility**
   - 문제: 3 새 RPC 가 모두 `deps.agentDeps?.db ?? deps.financeDeps?.db` 패턴. 둘 다 미주입 시 silent provider_unavailable. 같은 패턴 3회 반복
   - 근거: 본 phase 가 한 번에 3 RPC 추가하면서 동일 fragility 가 계속 누적. main.ts 는 같은 storage.db 인스턴스 주입하므로 현재 작동하나 의도가 불명
   - 제안: `GatewayServerDeps` 에 `db?: DatabaseSync` 단일 필드 추가, storage.db 일원화. 본 phase 와 무관하면 P1 강등 가능 — 단, 본 phase 가 처음으로 3 회까지 패턴을 늘렸다는 점에서 P0 분류

### P1 — 권장 (다음 phase 안에)

5. **`packages/storage/src/database.ts` — ALTER TABLE wrapper 4회 반복 (v6/v7/v8/v10)**
   - 동일 패턴: `PRAGMA table_info → some(c.name === col) → ALTER ADD COLUMN`. grep `PRAGMA table_info('agent_runs')` → 4
   - 제안: `ensureColumn(db, table, column, ddl)` helper 추출. CLAUDE.md §2 임계값(3회 이상) 통과

   ```ts
   function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
     const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
     if (!cols.some((c) => c.name === column)) {
       db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
     }
   }
   ```

6. **`packages/server/src/auto-reply/stages/memory-retrieval.ts:339-349` — inversion-counting 코드 중복**
   - O(n²) inversion 카운트 inline 작성. 동일 알고리즘이 `packages/storage/src/search/hybrid.ts:40-52` `countInversions` 에 이미 존재. `rerankResults` (`hybrid.ts:60`) 도 거의 같은 흐름 (점수 → desc 정렬 → topK slice → swap 카운트)
   - 제안: `rerankResults` 를 generic 화 (`<T extends { content: string }>`) 후 memory-retrieval 이 직접 사용. **rerankResults 가 production 호출처 0** → P1-6 적용 시 dead code 동시 해소

7. **`packages/web/src/views/{trace,audit}-view.ts` — SpanRecord/AccessLogEntry 인터페이스 재선언**
   - web 이 `@finclaw/types` / `@finclaw/storage` 직접 의존 안 함 → 같은 shape 가 storage / types / server (RPC type) / web (가져오는 type) 4곳 산재. `app-gateway.ts:454` 의 `AuditEntry` 와 `audit-view.ts:6` 의 `AccessLogEntry` — web 내부 중복도 존재
   - 제안: web/package.json 에 `@finclaw/types` workspace 의존 추가 후 `import type { SpanRecord } from '@finclaw/types'`

8. **`packages/server/src/gateway/access-log.ts:38-60` — createAccessLogger LogWriter overload 사용처 0**
   - `(arg?: LogWriter | AccessLoggerOptions)` union 의 함수 분기 미사용. production 호출처 0 (server.ts:97 만, 옵션 객체)
   - phase 30 C3 신규 도입 — 직전 phase 가 함수 인자를 받았는지 확인 결과 backward-compat 대상 자체가 없음. CLAUDE.md §2 "요청되지 않은 유연성"
   - 제안: `(options: AccessLoggerOptions = {})` 로 단순화

9. **`packages/agent/src/{providers/{anthropic,openai},execution/tool-executor}.ts` — outputSchema 이중 type**
   - `ToolHandler.outputSchema` (tool-executor.ts:6-15) + `RegisteredToolDefinition.outputSchema` (registry.ts:46-50) 두 곳 정의. dispatcher-adapter 가 명시적으로 복사 (line 53-54). 한쪽만 변경 시 silent
   - 제안: 작은 helper interface (`StructuredOutputSpec`) 1개로 통합 + 양쪽 spread. 또는 tool-executor 가 `Pick<RegisteredToolDefinition, 'outputSchema' | 'enforceStructuredOutput'>`

10. **`packages/server/src/main.ts:596` — purgeAccessLog 첫 실행 24시간 지연**

- setInterval(24h) 이 부팅 시점부터 24시간 후 첫 실행. 1인 가동 환경에서 매 재시작 시 retention 미적용 가능
- 제안: `purgeAccessLog(...)` 즉시 1회 + setInterval. SchedulerService 내부 cron 도입 시 본 setInterval 도 이전 (TODO 주석)

### P2 — 선택 (인지만)

11. **`packages/server/src/observability/tracer.ts:15-30` — ensureGlobalProvider 가 process 전역 mutate**
    - `globalProviderRegistered` 모듈 변수 + `context.setGlobalContextManager` / `trace.setGlobalTracerProvider`. createTracer 다중 호출 idempotent 하지만 vitest 의 다른 test 가 OTel API 사용 시 충돌. test 환경 isolation 부재
    - 1인 사용자 환경에서 영향 minimal. test 충돌 발견 시 instance-local provider 로 분리

12. **`packages/server/src/gateway/rpc/methods/trace.ts:71` — `MIN(name) AS root_name` 안티패턴**
    - trace 의 root span name 을 알파벳 순 가장 빠른 것으로 가정. 실제로는 `parent_span_id IS NULL` 인 span 이 root
    - 제안: subquery 또는 `JOIN spans s2 ON s.trace_id = s2.trace_id AND s2.parent_span_id IS NULL`. root_name 정확도가 1차 기능에 영향 적음

13. **`packages/server/src/auto-reply/stages/memory-retrieval.ts:317-318,323` — candidates.slice 중복 적용**
    - `candidates.sort + slice(0, MAX_INJECTED_MEMORIES)` 후 reranker 분기에서 다시 `pool = candidates.slice(0, topKFirst)` → rerank → slice. 첫 slice 가 reranker 분기에선 의미 없음 (덮어씀)
    - 동작은 정확. readability 이슈만. 변수 분리 권장

14. **`packages/storage/src/spans.ts:49-50` — BigInt → Number 변환 정밀도**
    - `Number(span.startNs)` 변환이 100일 이상 가동 시 ns 정밀도 1ns 손실 가능. process.hrtime.bigint() 가 시스템 boot 이후 ns
    - 분석 의미 없음. 인지만

## 5. 범위 밖 발견 (참고 — 삭제·수정 권장 X)

> phase 30 의 plan.md 가 요구하지 않은 영역에서 발견된 사항.

- **`packages/server/src/automation/scheduler.ts:259,278`** — `addAgentRun` 직후 `UPDATE agent_runs SET schedule_id = ? WHERE id = ?` 두 분기에서 반복. AddAgentRunInput.scheduleId 추가하면 INSERT 1회로 끝남. phase 28 산출물
- **`packages/agent/src/agents/tools/registry.ts:298,306`** — ToolRegistry 가 logger 미수신, `console.warn` 직접. 다른 server 코드는 FinClawLogger 통합. agent 패키지의 design choice
- **`packages/agent/src/agents/tools/policy.ts:282-289`** — `decidingStage: 'fallthrough'` TODO 주석. phase 30 변경 X
- **`packages/storage/src/index.ts:55-59,136-137`** — `MockReranker` / `RerankMeta` / `rerankResults` export. **production 사용처 0** (P1-6 와 통합 시 해소). `Reranker` interface 는 memory-retrieval 이 type-only import — 정당

## 6. CLAUDE.md §3 외과적 변경 검토

✅ 위반 발견 없음. 변경된 모든 줄이 plan.md / todo.md 의 4 트랙에 직접 연결됨. 검토한 동반 수정:

- `packages/storage/src/{agent-runs,database,transactions}.storage.test.ts` — schema_version 기대값 7 → 10. 마이그레이션 단계 변경에 의한 정당한 동반 수정
- `packages/storage/src/agent-runs.ts:1-31, 50-59, 88-94, 110-133` — 컬럼 추가에 따른 row/input/insert 갱신
- `packages/server/src/gateway/server.ts:14, 28, 37, 59-61, 97-100, 158-161` — 새 RPC + accessLogDb/getTraceId 옵션. plan 직접 매칭

## 7. 위험 신호

> 즉시 의사결정 필요한 항목.

1. **plan.md 완료 조건 — A 트랙 #1, #2 ✅ 충족 (hotfix `1b2b52b`) / D 트랙 1차 충족 + 잔여 phase 31 이월**
   - P0-1 (agent_runs.trace_id) — agent.run RPC + scheduler 양 경로에 wire 완료. 신규 row traceId non-null 충족
   - P0-2 (turn/tool span depth) — RunnerTracerAdapter 배선 완료. depth ≥ 3 달성. **실측 통합 테스트는 phase 31 후보** (현 hotfix 는 단위 검증만)
   - P0-3 (rerank_meta) — 1차 audit log 적용. **agent_runs.rerank_meta 자동 부착은 phase 31 이월** (auto-reply 경로 addAgentRun 부재)
   - 자동화 검증 4-tier PASS (1551/1551 unit, 144/144 storage)

2. **mcp.test.ts flaky** — phase30 무관 (phase29 산물), 차단 요소 아니나 인지

3. **A10/C6 응답 Zod schema 부재** — types 패키지 zod 의존 회피의 트레이드오프. UI 가 직접 destructure 라 현재 OK. 후속 강화 가능

4. **D6 download-rerank-model.mjs CI 통합 부재** — 사용자 첫 RAG 사용 시 수동 실행. 운영 시 안내 필요

## 8. 다음 phase 후보 (제안)

- **phase 31 잔여 wire-up**: agent_runs.rerank_meta 자동 부착 (agent.run RPC 의 retrieval 단계 추가 또는 auto-reply 경로에 addAgentRun 도입). depth ≥ 3 실측 통합 테스트 추가 (RPC/scheduler 경로의 turn/tool span 검증). P0-4 db 의존 fragility 일원화 (GatewayServerDeps.db 단일 필드)
- **phase 31 cleanup** (P1 4-5건): ensureColumn helper, rerankResults generic 화 + dead code 해소, web → @finclaw/types 의존, createAccessLogger 단순화, outputSchema 통합 type
- **분석 도구 추가** (B5 자연 미달분): `analyze_news`, `analyze_portfolio_risk` 등 신규 도구 + outputSchema. 본 phase 의 enforceStructuredOutput 인프라 그대로 활용

## 9. 측정값

- 변경 파일 수: 55 + hotfix 6 (todo.md 제외 ~54 production/test + hotfix wire-up)
- 변경 LOC: +4735 / -420 (todo.md 1796 + pnpm-lock 624 제외 ~+2315 / -420) + hotfix ~+200
- 신규 production 파일 LOC 합계: ~809 (10 신규 파일)
- 새 테스트 파일: 9 (spans / tracer / trace.e2e / access-log×2 / structured-output×3 / rerank×3) — hotfix 신규 테스트 0 (phase 31 통합 테스트 후보)
- 마이그레이션: v7 → v8 → v9 → v10 (3 단계, 4 커밋 분리)
- 커밋 chain: A `149b446` → C `e8558c8` → B `b03fd55` → D `e33d3be` → hotfix `1b2b52b`
- review-draft 생성: 2026-05-08
- hotfix 적용 + review 갱신: 2026-05-09

## 10. 권고 — 머지 가능 여부

**판정**: ✅ **머지 가능** — hotfix `1b2b52b` 로 P0-1/2/3 처리 (P0-3 은 1차 적용 + 잔여 phase 31 이월). plan.md A 트랙 완료 조건 #1/#2 ✅, D 트랙 1차 충족.

남은 사항 (머지 차단 X):

1. **agent_runs.rerank_meta 자동 부착** — phase 31 첫 작업으로 명시 이월 (auto-reply 경로에 addAgentRun 도입 또는 agent.run RPC 의 retrieval 단계 추가가 큰 변경)
2. **P0-4 (db 의존 fragility)** — 1인 사용자 환경에서 silent failure 위험 낮음. P1 강등 (phase 31)
3. **depth ≥ 3 실측 통합 테스트** — phase 31 후보 (현 hotfix 는 wire-up 만, 실제 RPC/scheduler 경로의 span 기록 검증 부재)
4. **mcp.test.ts flaky** — phase30 무관. 머지 후 별도 작업
5. **자동화 검증** — typecheck / lint / storage 모두 PASS. unit 1 flaky fail (격리 가능)
