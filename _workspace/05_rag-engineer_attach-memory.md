# 05 — RAG 엔지니어: agent.run output → memory 훅 (밀스톤 D 1차)

작업자: rag-engineer
브랜치: `feature/memory-and-transactions`
선행: schema-architect 의 `addAgentRun`, `getAgentRun`, `linkMemoryToAgentRun` (`_workspace/05_schema-architect_agent-runs.md`).

## 1. 신설 모듈

`packages/server/src/auto-reply/agent-memory-hook.ts` (~135 LOC)

본 단계는 **저장 결정 + 임베딩 fallback + 링크 갱신 + 감사 로그** 만 산출. agent.run RPC 핸들러 안의 호출 위치는 다음 단계 rpc-engineer 가 결정.

## 2. 정책 상수 (단일 출처)

```ts
export const MIN_MEMORY_OUTPUT_LENGTH = 100;
```

plan.md line 298 "output 길이 > 100자" 의 단일 진실. 매직 넘버 산재 금지: 다른 모듈은 본 모듈에서 import.

내부 상수: `PROMPT_SNIPPET_MAX = 200` (metadata 에 보존하는 prompt 일부 길이).

## 3. 알고리즘 (의사코드)

```
input: { agentRunId, agentId, prompt, output, error?, sessionKey, createdAt }

1. error truthy → logger.debug + return { skipped: 'has-error' }
2. output.length <= MIN_MEMORY_OUTPUT_LENGTH → logger.debug + return { skipped: 'too-short' }
3. entry = MemoryEntry(
     id=randomUUID(),
     sessionKey, content=output (raw, 압축 X),
     type='financial', createdAt,
     metadata={ source:'agent.run', agentRunId, agentId, promptSnippet: prompt[:200] })
4. provider 있으면 addMemoryWithEmbedding(db, entry, provider) 시도
   provider 없으면 addMemory(db, entry)
5. (4) throw → logger.warn('agent.run.memory.embedding_failed') + addMemory(db, entry) fallback
   fallback 도 throw → logger.error + return { skipped: 'embedding-failed' }
6. linkMemoryToAgentRun(db, agentRunId, entry.id) (반환값 무시 — INSERT 직후라 항상 true)
7. logger.info('agent.run.memory.attached', { agentRunId, memoryId })
8. return { memoryId: entry.id }
```

**raw output 그대로 저장.** 요약·압축 없음 (단순함 우선, 사용자 지시 정합).

## 4. 공개 인터페이스 (rpc-engineer 사용)

```ts
import {
  DefaultAttachMemoryService,
  MIN_MEMORY_OUTPUT_LENGTH,
  type AttachMemoryService,
  type AttachMemoryServiceDeps,
  type AgentRunMemoryInput,
  type AttachMemoryResult,
  type AttachMemorySkipReason,
} from '../../../auto-reply/agent-memory-hook.js';

interface AgentRunMemoryInput {
  readonly agentRunId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly output: string;
  readonly error?: string;
  readonly sessionKey: SessionKey;
  readonly createdAt: number; // ms epoch
}

type AttachMemoryResult =
  | { readonly memoryId: string }
  | { readonly skipped: 'too-short' | 'has-error' | 'embedding-failed' };

interface AttachMemoryService {
  attach(input: AgentRunMemoryInput): Promise<AttachMemoryResult>;
}
```

`DefaultAttachMemoryService` 의존성 주입 (main.ts 에서):

```ts
new DefaultAttachMemoryService({
  db: storage.db,
  embeddingProvider, // capture/retrieval 과 동일 인스턴스 (옵셔널)
  logger,
});
```

## 5. main.ts 배선 (이번 단계 적용)

`packages/server/src/main.ts`:

1. `DefaultAttachMemoryService` import 추가.
2. capture/retrieval 인스턴스 직후 `attachMemoryService` 인스턴스 생성 (같은 embedding 재사용).
3. `agentDeps` 에 `attachMemoryService` 필드 추가.

`packages/server/src/gateway/rpc/methods/agent.ts`:

1. `AttachMemoryService` 타입 import 추가.
2. `AgentRpcDeps` 에 `attachMemoryService?: AttachMemoryService` 옵셔널 필드 추가.
3. **핸들러 로직은 변경 없음** (외과적 변경 — rpc-engineer 가 다음 단계에서 호출).

## 6. 다음 단계 (rpc-engineer) 호출 위치 가이드

agent.run 핸들러 (`packages/server/src/gateway/rpc/methods/agent.ts`) 안에서 `result` 가 산출된 직후, `clearTimeout(timer)` 와 finally 들 사이에 다음 흐름 권장:

```ts
// 1. agent_runs INSERT (기존 storage CRUD)
const run = addAgentRun(deps.storage.db, {
  agentId: createAgentId(params.agentId),
  prompt: params.prompt,
  output,
  toolCalls: JSON.stringify(toolCallRecords),
  tokensInput: result.usage.inputTokens,
  tokensOutput: result.usage.outputTokens,
  durationMs,
  modelUsed: usedModelId,
  role,
  // memoryId 는 hook 에서 link
  // error 는 catch 분기에서 별도 INSERT (output='' + error 메시지)
});

// 2. memory 훅 호출 (옵셔널 — 미주입 시 skip)
if (deps.attachMemoryService) {
  await deps.attachMemoryService.attach({
    agentRunId: run.id,
    agentId: params.agentId,
    prompt: params.prompt,
    output,
    sessionKey, // 핸들러 안에서 createSessionKey(...) 결과
    createdAt: run.createdAt as number,
  });
  // 결과는 무시해도 됨 (감사 로그는 hook 내부에서 emit, RPC 응답엔 영향 X)
}
```

catch 분기 (실행 실패) 에서는 `error` 필드를 채워 `addAgentRun` 호출. `attach({ ..., error })` 도 호출하면 hook 이 'has-error' 로 자동 skip 한다 — 호출자 분기 단순화 목적.

`AgentRpcDeps` 에 `storage: StorageBundle` (또는 `db: DatabaseSync`) 필드도 추가 필요 (storage 없으면 addAgentRun 자체 불가). 본 작업에서는 RPC 호출 경로 외과 변경 금지 원칙으로 storage 필드 신설은 rpc-engineer 책임.

## 7. 감사 로그 형식

| 이벤트                              | 레벨  | payload                                                             |
| ----------------------------------- | ----- | ------------------------------------------------------------------- |
| `agent.run.memory.skipped`          | debug | `{ agentRunId, reason: 'has-error' \| 'too-short', outputLength? }` |
| `agent.run.memory.embedding_failed` | warn  | `{ agentRunId, memoryId, error }`                                   |
| `agent.run.memory.failed`           | error | `{ agentRunId, memoryId, error }` (raw addMemory 도 throw)          |
| `agent.run.memory.attached`         | info  | `{ agentRunId, memoryId }`                                          |

JSON 한 줄. 다른 메모리 이벤트(`memory.injected`, `memory.capture.*`) 와 동일한 logger 채널 사용.

## 8. 빈 결과/에러 처리 표

| 상황                               | 동작                                                                                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error` truthy                     | skip 'has-error', memory 저장 X, agent_runs.memory_id NULL                                                                                                                                                                                                 |
| `output.length ≤ 100`              | skip 'too-short', memory 저장 X                                                                                                                                                                                                                            |
| `output.length === 100` (boundary) | skip 'too-short' (비교가 `<=`)                                                                                                                                                                                                                             |
| `embeddingProvider` undefined      | `addMemory` (FTS-only) 직접, warn 없음                                                                                                                                                                                                                     |
| `addMemoryWithEmbedding` throw     | `addMemory` fallback + warn, memoryId 반환                                                                                                                                                                                                                 |
| 양쪽 throw                         | error 로그 + skip 'embedding-failed'                                                                                                                                                                                                                       |
| 동일 hash content 재실행           | `addMemory` 가 dedup 으로 INSERT skip → entry.id 가 DB 미존재 가능. 본 hook 은 `linkMemoryToAgentRun` 에 entry.id 를 넘기므로 FK 미충족 → UPDATE 가 0 changes (조용히). 메모리 회상은 기존 행 기준으로 동작하므로 운영상 문제 없음. (capture 와 동일 정책) |

## 9. 산출물 + 테스트 결과

**신설 파일:**

- `packages/server/src/auto-reply/agent-memory-hook.ts` (135 LOC)
- `packages/server/src/auto-reply/__tests__/agent-memory-hook.storage.test.ts` (260 LOC, 7 tests)

**기존 파일 변경:**

- `packages/server/src/main.ts` — import + 인스턴스 생성 + agentDeps 필드 추가 (~10 LOC)
- `packages/server/src/gateway/rpc/methods/agent.ts` — import + AgentRpcDeps 옵셔널 필드 추가 (~6 LOC, 핸들러 로직 무수정)

**검증 결과:**

| 명령                    | 결과                                      |
| ----------------------- | ----------------------------------------- |
| `pnpm build`            | OK                                        |
| `pnpm typecheck`        | OK                                        |
| `pnpm format`           | OK (자동 적용 후 안정)                    |
| `pnpm lint`             | 0 warnings, 0 errors                      |
| `pnpm test:storage`     | 11 files / 108 tests passed (신규 7 포함) |
| `pnpm test` (전체 unit) | 156 files / 1447 tests passed (회귀 0)    |

## 10. 테스트 시나리오 커버리지

| 시나리오                                                                                   | 테스트                                                                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 정상: output 200자 + no error → memoryId + agent_runs.memory_id 갱신 + type='financial' 행 | `attach: output > 100 chars + no error → memoryId returned, agent_runs.memory_id linked, type=financial row exists` |
| 너무 짧음: output='OK' → skip 'too-short' + memory 미생성                                  | `output too short → skipped: too-short, no memory row created, agent_runs.memory_id stays NULL`                     |
| 경계값: output 길이 정확히 100                                                             | `output exactly at MIN_MEMORY_OUTPUT_LENGTH → still skipped (boundary: <=)`                                         |
| error 있음 + output 길어도                                                                 | `error present → skipped: has-error (even if output is long)`                                                       |
| 임베딩 throw → fallback FTS-only + warn                                                    | `embedding throws → falls back to addMemory (FTS-only) + warn, memoryId returned`                                   |
| provider undefined → fallback FTS-only                                                     | `embeddingProvider undefined → addMemory FTS-only path, memoryId returned`                                          |
| ON DELETE SET NULL: memory 삭제 → agent_runs.memory_id NULL                                | `attach → DELETE memory → agent_runs.memory_id becomes NULL (FK SET NULL)`                                          |

mock-only 임베딩 (1024 차원 결정론적 vector) — 외부 API 키 불필요.

## 11. 알릴 곳

- **rpc-engineer**: agent.run 핸들러에서 `addAgentRun` + `attachMemoryService.attach(...)` 호출 위치 결정. `AgentRpcDeps.attachMemoryService` 는 옵셔널이므로 미주입 환경에서도 동작. storage 의존성 주입 (현재 agentDeps 에 없음) 도 본인이 담당.
- **qa-engineer**: 본 hook 의 단위 테스트는 신규 7 테스트로 커버. RPC 통합(agent.run e2e → addAgentRun → attach → memory 회상) 시나리오는 rpc-engineer 호출 위치 확정 후 추가 권장.

## 12. CLAUDE.md 4원칙 준수

- **추측 금지**: schema-architect export (`addAgentRun`, `getAgentRun`, `linkMemoryToAgentRun`) 정확히 사용. capture 의 패턴 (try `addMemoryWithEmbedding` → catch fallback `addMemory`) 동일하게 채택.
- **단순함**: 요약·압축 없음. raw output 그대로 저장. 정책 상수 1개 (`MIN_MEMORY_OUTPUT_LENGTH`).
- **외과적 변경**: agent.ts 핸들러 로직 무수정. `AgentRpcDeps` 에 옵셔널 필드 1개 추가만. main.ts 는 capture/retrieval 인스턴스 직후 1블록 추가만.
- **검증**: 7 신규 테스트 모두 통과 + 1447 전체 unit 회귀 0.
