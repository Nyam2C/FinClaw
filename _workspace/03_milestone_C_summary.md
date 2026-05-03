# 밀스톤 C 종합 산출물 — RAG 주입 파이프라인

## 결과: PASS (밀스톤 D 진입 가능)

전체 1447 테스트 + storage 89 테스트 통과. 회귀 0. mock-only 원칙 준수.

## 변경 파일

**RAG (rag-engineer):**

- `packages/server/src/auto-reply/stages/memory-retrieval.ts` (신설) — DefaultMemoryRetrievalService, formatBackgroundSection, extractSymbols, 상수 5종
- `packages/server/src/auto-reply/__tests__/memory-retrieval.storage.test.ts` (신설) — 22 케이스

**파이프라인 배선 (pipeline-engineer):**

- `packages/server/src/auto-reply/pipeline.ts` — Stage 4.5 retrieval 끼워넣기 (Context 직후, Execute 직전, best-effort)
- `packages/server/src/auto-reply/pipeline-context.ts` — retrievalResult 필드 추가
- `packages/server/src/auto-reply/execution-adapter.ts` — RunnerExecutionAdapter.execute 가 systemPrompt 합성
- `packages/server/src/main.ts` — DefaultMemoryRetrievalService 주입 (capture/RPC 와 embeddingProvider 동일 인스턴스 재사용)
- `packages/server/src/auto-reply/__tests__/pipeline.test.ts` — 신규 3 케이스
- `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts` — 신규 3 케이스

**QA (qa-engineer):**

- `packages/server/src/auto-reply/__tests__/memory-capture-retrieval.boundary.storage.test.ts` (신설) — 경계면 통합 2 케이스

## 핵심 결정

- **임계값/신선도/상한 상수는 retrieval 모듈에서 단일 출처 export.** 매직 넘버 산재 X.
- **mode='hybrid' / 'fts-only'** 두 모드. embeddingProvider 미주입/throw 시 자동 fallback.
- **best-effort retrieval** — searchRelevant throw 시 파이프라인 abort X. warn 로그 + retrievalResult 미주입.
- **빈 결과 시 systemPrompt 그대로** — 빈 헤더 노출 방지.
- **MockExecutionAdapter / executeForTui()** 는 본 밀스톤 미변경 — 향후 TUI 회상 별도 패턴 권장.

## 다음 밀스톤 (D) 가 알아야 할 사실

- `attachMemoryFromAgentRun` 훅은 RAG 측면이라 rag-engineer 가 책임.
- agent.run output → memory 변환 시 type='financial', 사용자가 명시적으로 저장한 'fact'/'preference' 와 구분.
- agent_runs 테이블은 schema-architect 가 v4 마이그레이션 안에 추가 또는 v4 보강. SCHEMA_VERSION=4 이미 사용 중 — v4 보강 형태 검토.
- `agent.runs.{list,get}` RPC 는 rpc-engineer.
- agent.run 핸들러는 `packages/server/src/gateway/rpc/methods/agent.ts` 에 있음.

## 후속 보강 후보 (결함 아님)

- `daysOld < 0` clamp 단위 테스트 (코드는 정확).
- FTS-only 모드의 한국어 trigram 회수율 — 운영 단계에서 hybrid 모드(벡터) 사실상 필수.
