# 04 — Pipeline 엔지니어: MemoryRetrieval 배선 (밀스톤 C 2차)

## 1. 목적

rag-engineer 가 산출한 `DefaultMemoryRetrievalService` 를 6단계 파이프라인에 외과적으로 끼워
넣어, **Context 직후 → Execute 직전** 사이에 자동 회상이 일어나고, `RunnerExecutionAdapter` 가
검색 결과를 system prompt 의 "사용자 배경지식" 섹션으로 합성해 LLM 에 전달하도록 한다.

## 2. 배선 흐름

```
MsgContext + BindingMatch
   │
   ▼
[Stage 1] Normalize        — body trim/공백/멘션·URL 추출
   │
   ▼
[Stage 2] Command          — `!finclaw …` 명령 분기 (continue 시만 진행)
   │
   ▼
[Stage 2.5] MemoryCapture  — (밀스톤 B) 정규식 5종 매칭 시 명시적 저장
   │
   ▼
[Stage 3] ACK              — 타이핑 인디케이터/리액션
   │
   ▼
[Stage 4] Context          — 금융 데이터 + 채널 capabilities → enrichedCtx
   │
   ├── enrichedCtx = { ...ctxResult.data, capturedMemory? }
   │
   ▼
[Stage 4.5] MemoryRetrieval (NEW)
   │  await memoryRetrievalService.searchRelevant({
   │    userQuery: enrichedCtx.normalizedBody,
   │    sessionKey: enrichedCtx.sessionKey,
   │  })
   │  → enrichedCtx = { ...enrichedCtx, retrievalResult }
   │  실패 시 warn + retrievalResult 미주입 (best-effort, 파이프라인은 계속)
   │
   ▼
[Stage 5] Execute → RunnerExecutionAdapter.execute(enrichedCtx)
   │  baseSystemPrompt = deps.systemPrompt
   │  backgroundSection = ctx.retrievalResult ? formatBackgroundSection(...) : ''
   │  composedSystemPrompt = backgroundSection
   │    ? `${baseSystemPrompt}\n\n${backgroundSection}`
   │    : baseSystemPrompt
   │  → AgentRunParams.systemPrompt = composedSystemPrompt
   │
   ▼
[Stage 6] Deliver
```

## 3. retrievalResult lifecycle

| 시점                          | 값                                                      | 비고                                                        |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Context 단계 직전             | `undefined`                                             | enrichedCtx 미생성                                          |
| Stage 4.5 진입 시점           | `undefined`                                             | 아직 검색 안 함                                             |
| 검색 성공                     | `RetrievalResult` (snippets/transactions/mode/auditLog) | spread 로 enrichedCtx 확장                                  |
| 검색 실패 (throw)             | `undefined`                                             | warn 로그 emit, stagesExecuted 에는 'memory-retrieval' 기록 |
| memoryRetrievalService 미주입 | `undefined`                                             | 단계 자체 생략, stagesExecuted 에 기록 X                    |
| Execute → buildParams         | `composedSystemPrompt`                                  | 빈 섹션이면 base 그대로                                     |
| Deliver                       | (소비 X)                                                | 본 밀스톤 범위 외 — 응답 본문에 반영 X                      |

## 4. 변경 파일 (외과적)

| 파일                                                                 | 변경                                                                                                                                                                                        | LOC  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/server/src/auto-reply/pipeline-context.ts`                 | `RetrievalResult` import + `PipelineMsgContext.retrievalResult?` 필드 추가                                                                                                                  | +3   |
| `packages/server/src/auto-reply/pipeline.ts`                         | `MemoryRetrievalService` import + `PipelineDependencies.memoryRetrievalService?` 추가 + Stage 4.5 블록 (try/catch + observer 통합 + stagesExecuted 기록) + `enrichedCtx` 를 `let` 으로 변환 | +33  |
| `packages/server/src/auto-reply/execution-adapter.ts`                | `formatBackgroundSection` import + `RunnerExecutionAdapter.execute()` 의 `buildParams` 직전에 `composedSystemPrompt` 합성 (`executeForTui` 는 PipelineMsgContext 미수신이므로 변경 없음)    | +9   |
| `packages/server/src/main.ts`                                        | `DefaultMemoryRetrievalService` import + 인스턴스 생성 (`db: storage.db`, `embeddingProvider`, `logger` 재사용) + `pipelineDeps.memoryRetrievalService` 주입                                | +10  |
| `packages/server/src/auto-reply/__tests__/pipeline.test.ts`          | 신규 describe `AutoReplyPipeline + MemoryRetrieval (Phase 26 C)` — 3 케이스                                                                                                                 | +130 |
| `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts` | 신규 describe `RunnerExecutionAdapter + retrievalResult` — 3 케이스                                                                                                                         | +95  |

다른 스테이지 시그니처/동작 변경 없음. `MockExecutionAdapter` 변경 없음 (단순 정보 출력 어댑터).

## 5. CLAUDE.md 4원칙 준수 검증

| 원칙         | 확인                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 코딩 전 생각 | rag-engineer 의 `_workspace/04_rag-engineer_retrieval.md` 명세 + 실제 `memory-retrieval.ts` export 확인 후 배선           |
| 단순함       | 캐시·TTL·동시 실행 제어·dedup 없음. 매 발화마다 1회 호출                                                                  |
| 외과적 변경  | Stage 4.5 만 신설. 기존 스테이지 시그니처 0 변경. retrievalResult 는 `enrichedCtx` 를 `let` 으로 바꾸고 spread 한 줄 추가 |
| 목표 기반    | 각 변경마다 검증 케이스 매핑 — 아래 §7                                                                                    |

## 6. 에러/엣지 처리

| 상황                                               | 동작                                                                | 검증                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| memoryRetrievalService 미주입                      | Stage 4.5 자체 생략, retrievalResult `undefined`                    | pipeline.test.ts: `memoryRetrievalService 미주입 시 retrieval 단계 자체가 생략된다`                              |
| retrieval throw                                    | warn + stagesExecuted 에 기록 + 파이프라인 계속 (deliver 까지 도달) | pipeline.test.ts: `retrieval 실패해도 파이프라인이 계속 진행한다 (best-effort)`                                  |
| retrievalResult 있고 snippets/transactions 둘 다 0 | `formatBackgroundSection` → '' → composedSystemPrompt = base        | execution-adapter.test.ts: `retrievalResult 의 섹션이 빈 문자열이면 base 그대로 사용한다`                        |
| retrievalResult 있고 snippet 1+                    | `BASE\n\n## 사용자 배경지식 (자동 주입)\n- ...`                     | execution-adapter.test.ts: `retrievalResult 가 있고 섹션이 비어있지 않으면 base system prompt + 섹션을 합성한다` |
| retrievalResult 없음 (정상 경로)                   | base 그대로                                                         | execution-adapter.test.ts: `retrievalResult 가 없으면 base system prompt 그대로 사용한다`                        |

## 7. 검증 결과

| 명령                               | 결과                                        |
| ---------------------------------- | ------------------------------------------- |
| `pnpm build` (`tsc --build`)       | OK                                          |
| `pnpm typecheck` (`tsgo --noEmit`) | OK                                          |
| `pnpm lint` (`oxlint`)             | 0 warnings, 0 errors                        |
| `pnpm format` (`oxfmt --check`)    | OK                                          |
| `pnpm test:storage`                | 87/87 passed (변동 없음)                    |
| `pnpm test` (전체)                 | **1447/1447 passed** (1441 → 1447, +6 신규) |
| pipeline.test.ts                   | 10/10 passed (기존 7 + 신규 3)              |
| execution-adapter.test.ts          | 22/22 passed (기존 19 + 신규 3)             |

## 8. 후속 인터페이스 (밀스톤 D / agent.run 작업자에게)

- `agent.run` RPC 가 retrieval 결과를 활용하려면 동일 `MemoryRetrievalService` 인스턴스를 주입 받으면 된다 — `agentDeps` 에 추가 가능 (본 밀스톤 범위 외).
- `executeForTui()` 는 `PipelineMsgContext` 가 아닌 `sessionKey/agentId/model/userMessage` 만 받는다. 자동 회상이 필요하다면 `RunnerExecutionAdapterDeps.memoryRetrievalService?` 를 별도 추가하거나, `executeForTui` 호출 직전에 RPC 레벨에서 retrieval 후 `composedSystemPrompt` 를 어댑터에 주입하는 패턴을 권장.
- 본 단계는 retrievalResult 를 enrichedCtx 에 실어 보낼 뿐, deliver 에서 사용자 응답 본문에 별도 표기하지 않는다 (footer 등은 본 밀스톤 범위 외).

## 9. 신설/수정 파일 절대 경로 (참조용)

신설:

- `/mnt/c/Users/박/Desktop/hi/FinClaw/_workspace/04_pipeline-engineer_retrieval-wiring.md`

수정:

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/auto-reply/pipeline-context.ts`
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/auto-reply/pipeline.ts`
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/auto-reply/execution-adapter.ts`
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/main.ts`
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/auto-reply/__tests__/pipeline.test.ts`
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/auto-reply/__tests__/execution-adapter.test.ts`
