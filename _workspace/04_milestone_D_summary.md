# 밀스톤 D 종합 산출물 — agent.run 결과 저장 & RAG 통합

## 결과: PASS (밀스톤 E 진입 가능)

전체 1464 unit + 108 storage tests 통과. 회귀 0. mock-only 원칙 준수.

## 변경 파일

**스키마 (schema-architect):**

- `packages/storage/src/database.ts` — SCHEMA_VERSION 4→5, agent_runs DDL + 인덱스 2개, MIGRATIONS[5]
- `packages/storage/src/agent-runs.ts` (신설) — addAgentRun/getAgentRun/listAgentRuns/linkMemoryToAgentRun
- `packages/storage/src/agent-runs.storage.test.ts` (신설) — 12 케이스 (CRUD + v4→v5 마이그레이션 + FK SET NULL)
- `packages/storage/src/index.ts` — re-export
- `packages/types/src/agent.ts` — AgentRun 인터페이스 (13개 필드)
- `packages/storage/src/database.test.ts`, `transactions.storage.test.ts` — schema_version 5 회귀 보정

**RAG 훅 (rag-engineer):**

- `packages/server/src/auto-reply/agent-memory-hook.ts` (신설) — DefaultAttachMemoryService, MIN_MEMORY_OUTPUT_LENGTH=100
- `packages/server/src/auto-reply/__tests__/agent-memory-hook.storage.test.ts` (신설) — 7 케이스
- `packages/server/src/main.ts` — DefaultAttachMemoryService 인스턴스 + agentDeps.attachMemoryService 주입
- `packages/server/src/gateway/rpc/methods/agent.ts` — AgentRpcDeps.attachMemoryService 옵셔널 필드만

**RPC (rpc-engineer):**

- `packages/server/src/gateway/rpc/methods/agent.ts` — agent.run 핸들러: 성공/실패 양쪽 addAgentRun + attach 훅 + 응답에 runId 추가
- `packages/server/src/gateway/rpc/methods/agent.test.ts` — persistence 5 케이스
- `packages/server/src/gateway/rpc/methods/agent-runs.ts` (신설) — agent.runs.list (truncate 200/500) + agent.runs.get
- `packages/server/src/gateway/rpc/methods/agent-runs.test.ts` (신설) — 10 케이스
- `packages/server/src/gateway/server.ts` — registerAgentRunsMethods 호출
- `packages/server/src/main.ts` — agentDeps.db 주입
- `packages/types/src/gateway.ts` — RpcMethod union 확장

**QA (qa-engineer):**

- `packages/server/src/gateway/rpc/methods/agent-runs.test.ts` — 경계면 통합 2 케이스 (round-trip toolCalls + 4계층 통합)

## 핵심 결정

- **SCHEMA_VERSION 4→5 BUMP** (옵션 A 채택) — 마이그레이션 단방향 추적 명시성. 옵션 B 의 IF NOT EXISTS 만 의존하지 않음.
- **memory_id FK ON DELETE SET NULL** — 사용자가 memory 삭제해도 agent_runs 는 보존 (감사용 raw 데이터).
- **best-effort 영속화** — addAgentRun/attach 실패 시 swallow + warn. RPC 응답엔 영향 없음.
- **실패 경로도 agent_runs 기록** — output='', error=msg. attach 는 호출 X.
- **agent.run 응답에 runId 옵셔널 추가** — 기존 필드 보존, db 미주입 시 undefined.
- **agent.runs.list truncate** — prompt 200자 / output 500자. 전체는 get 으로.

## 다음 밀스톤 (E) 가 알아야 할 사실

- `agent.runs.list` / `agent.runs.get` RPC 가용. Web UI Settings 의 "에이전트 실행 이력" 섹션에서 호출.
- agent.run 응답에 runId 가 있으면 UI 가 runId 로 detail 조회 가능.
- `memory.list` / `memory.delete` / `memory.search` RPC 가용 (밀스톤 B 산출). Settings 의 "내 기억" 섹션에서 호출.
- portfolio.changed broadcast 채널은 동작 중 (밀스톤 A). UI 가 구독하면 외부 RPC 거래 추가 시 자동 갱신.

## 후속 보강 후보 (결함 아님)

- e2e 시나리오: agent.run AAPL 분석 → 다음 대화 "AAPL 요약" → RAG 매칭 (통합 검증 단계).
