# 05 — RPC 엔지니어: agent_runs RPC + agent.run 영속화 (밀스톤 D)

작업자: rpc-engineer
브랜치: `feature/memory-and-transactions`
선행:

- schema-architect — `_workspace/05_schema-architect_agent-runs.md` (storage CRUD: `addAgentRun`, `getAgentRun`, `listAgentRuns`, `linkMemoryToAgentRun`, `AgentRun` 타입).
- rag-engineer — `_workspace/05_rag-engineer_attach-memory.md` (`DefaultAttachMemoryService.attach({...}) → {memoryId} | {skipped}`, `AgentRpcDeps.attachMemoryService?` 옵셔널 필드 이미 추가됨).

## 1. 결정 요약

### 1.1 `agent.run` 응답 확장 — `runId` 필드 1개 추가 (옵셔널)

- 기존 응답 형태(`agentId, output, toolCalls, tokenUsage, durationMs, stopReason, turns`) 그대로 보존.
- 추가: `runId?: string` — DB 미주입(`deps.db === undefined`) 시 `undefined`. 옛 클라이언트는 본 필드를 무시할 수 있음 → 호환성 유지.
- UI 가 detail 화면을 띄울 때 `agent.runs.get({runId})` 로 조회.

### 1.2 best-effort 영속화

- agent_runs 저장 실패는 RPC 응답에 영향 X → `try/catch`로 감싸 swallow + `warn` 로그(`agent.run.store_failed`).
- attach 실패도 swallow → `warn`(`agent.run.memory.attach_failed`). RPC 는 정상 성공 응답.
- DB 미주입 환경(예: 단위 테스트의 `makeDeps` 기본형) → 저장·attach 모두 skip, `runId === undefined`.

### 1.3 실패 경로도 agent_runs 에 기록 (감사용)

- runner throw → catch 분기에서 `addAgentRun({..., output: '', error: msg, role: params.role ?? 'analysis'})`.
- attach 는 호출 안 함(output 없음). 핵심: 실행 실패의 흔적도 남겨야 사용자가 "왜 응답을 못 받았는지" 추적 가능.
- 저장 자체 실패도 swallow — RPC 가 이미 throw 중이므로 응답에 영향 X.

### 1.4 `agent.runs.list` 응답 truncate

- 목록 응답에 prompt 200자 / output 500자 truncate. 전체는 `agent.runs.get` 으로.
- 사유: 운영 누적 수백 row × 수 KB output 직렬화 부담 차단. UI 는 "최근 50개 카드 → 클릭 시 상세".

### 1.5 `agent.runs.get` 응답 — `toolCalls` 파싱

- storage 는 raw JSON 문자열 그대로 반환 (`toolCalls: string`). 본 RPC 는 `JSON.parse` 후 배열로 노출.
- 파싱 실패 시 빈 배열 (`[]`) — 잘못된 데이터를 응답에 노출하지 않음. UI 단순화.

## 2. 변경 파일

### 신설

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/gateway/rpc/methods/agent-runs.ts` (~135 LOC) — `AgentRunsRpcDeps`, `registerAgentRunsMethods`, 2 RPC 핸들러.
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/gateway/rpc/methods/agent-runs.test.ts` (~210 LOC) — 10 단위 테스트.

### 수정

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/gateway/rpc/methods/agent.ts`
  - `import` 에 `DatabaseSync`, `addAgentRun` 추가.
  - `AgentRpcDeps` 에 `db?: DatabaseSync` 추가.
  - `sessionKey` 변수를 `try` 블록 밖으로 이동 (catch 까지 살아있을 필요는 없으나, 가독성·범위 일관성).
  - 성공 응답 직전: agent_runs INSERT + attachMemoryService 호출 (best-effort, 두 단계 모두 try/catch swallow).
  - 응답에 `runId` 필드 추가 (옵셔널).
  - catch 분기: agent_runs 에 `error` 채운 row INSERT (swallow).

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/gateway/server.ts`
  - `registerAgentRunsMethods` import 추가.
  - `registerAgentRunsMethods({ db: deps.agentDeps?.db ?? deps.financeDeps?.db })` 호출 추가 — agentDeps 또는 financeDeps 의 db 재사용.

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/main.ts`
  - `agentDeps.db = storage.db` 추가.

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/types/src/gateway.ts`
  - `RpcMethod` union 에 `agent.runs.list`, `agent.runs.get` 추가.

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/server/src/gateway/rpc/methods/agent.test.ts`
  - persistence describe 블록 추가 (5 신규 테스트 — 성공 row 저장, attach 호출 인자, 실패 row + no attach, attach swallow, db 미주입 skip).

## 3. RPC 시그니처 (UI/QA 참조용)

### 3.1 `agent.runs.list`

```ts
// params (Zod)
{
  agentId?: string;       // 1자 이상
  from?: number;          // ms epoch, ≥ 0
  to?: number;            // ms epoch, ≥ 0
  limit?: number;         // 1~200, default 50
}

// result
{
  runs: Array<{
    id: string;
    agentId: string;
    prompt: string;          // 200자 truncate
    output: string;          // 500자 truncate
    durationMs?: number;
    modelUsed?: string;
    role?: string;
    memoryId?: string;       // null → undefined
    error?: string;          // 실패 run 만 채워짐
    createdAt: number;       // ms epoch
  }>;
}
```

- 정렬: `created_at DESC` (storage 가 보장).
- 필터 미지정 시 전체 agentId × 전체 기간 × 최신 50.

### 3.2 `agent.runs.get`

```ts
// params (Zod)
{
  runId: string;           // 1자 이상
}

// result — 미존재면 run: null
{
  run: null | {
    id: string;
    agentId: string;
    prompt: string;          // 전체
    output: string;          // 전체
    toolCalls: unknown[];    // JSON.parse 결과 (실패 시 [])
    tokensInput?: number;
    tokensOutput?: number;
    durationMs?: number;
    modelUsed?: string;
    role?: string;
    memoryId?: string;
    error?: string;
    createdAt: number;
  };
}
```

### 3.3 `agent.run` (응답 확장만)

기존 응답 + `runId?: string` 필드 추가. 그 외 필드(output, toolCalls, tokenUsage, durationMs, stopReason, turns) 모두 그대로.

## 4. agent_runs 저장 흐름 (성공 경로)

```
1. runner.execute → output, toolCallRecords, durationMs 산출
2. profileHealth.recordResult + agent.run.completed 로그 (기존)
3. if (deps.db):
     try:
       run = addAgentRun(deps.db, {
         agentId: agentIdBrand,
         prompt: params.prompt,
         output,
         toolCalls: JSON.stringify(toolCallRecords),
         tokensInput, tokensOutput, durationMs,
         modelUsed: usedModelId ?? deps.defaultModel.model,
         role,
       })
       runId = run.id

       if (deps.attachMemoryService):
         try:
           await deps.attachMemoryService.attach({
             agentRunId: run.id,
             agentId: params.agentId,
             prompt: params.prompt,
             output,
             sessionKey,                     // try 밖에서 미리 만든 값
             createdAt: run.createdAt,
           })
           # attach 가 내부에서 link/skip 로깅 emit. 외부는 추가 로그 없음.
         catch (attachErr):
           logger.warn('agent.run.memory.attach_failed', {agentRunId, error})
     catch (storeErr):
       logger.warn('agent.run.store_failed', {agentId, error})

4. return { ... 기존 필드 ..., runId }
```

attach 가 hook 내부에서 `error truthy / output too short / embedding failed` 분기 자동 처리. 호출자는 결과를 읽지 않음 — hook 이 자체 로깅·linkMemoryToAgentRun 까지 처리하므로 RPC 가 분기를 이중 처리할 이유 없음.

## 5. 실패 경로 처리

```
catch (err):
  msg = err.message
  lastError.set(...) + profileHealth.recordResult(false) + agent.run.failed 로그 (기존)

  if (deps.db):
    try:
      addAgentRun(deps.db, {
        agentId: createAgentId(params.agentId),
        prompt: params.prompt,
        output: '',
        durationMs: now - startedAt,
        modelUsed: deps.defaultModel.model,
        role: params.role ?? 'analysis',
        error: msg,
      })
    catch (storeErr):
      logger.warn('agent.run.store_failed', {phase: 'on-failure', error})

  if (err instanceof ModelFloorExhaustedError):
    throw new Error(한국어 안내)
  throw err
```

- 실패 row 의 `output = ''` 로 명시 (NULL 금지 — schema 가 NOT NULL).
- attach 호출 안 함 (output 없음 → hook 의 'too-short' 분기로 어차피 skip 되지만, 호출 자체를 생략하여 의도 명시).
- 실패 row 도 `agent.runs.list` 응답에 포함됨 (UI 가 error 필드로 구분 가능).

## 6. 검증 결과

| 명령             | 결과                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm build`     | OK (tsc --build, 에러 없음)                                                                                |
| `pnpm typecheck` | OK                                                                                                         |
| `pnpm lint`      | 0 warnings, 0 errors                                                                                       |
| `pnpm test`      | 157 files / 1462 tests passed (직전 1447 → +15: agent.test.ts 5 신규 + agent-runs.test.ts 10 신규, 회귀 0) |

### 6.1 신규 테스트 커버리지

**`agent.test.ts > agent.run > persistence (Phase 26 D)`** (5 케이스):

1. 성공 시 agent_runs row 가 prompt/output/role/tokens/toolCalls 모두 채워 저장됨.
2. attach 가 `{agentRunId, agentId, prompt, output, sessionKey, createdAt}` 인자로 정확히 1회 호출.
3. runner 실패 시 agent_runs 에 `error` 채운 row 가 저장되고 attach 는 호출 안 됨.
4. attach 가 throw 해도 RPC 응답은 정상 (`runId` 반환) — `agent.run.memory.attach_failed` 로그 emit.
5. db 미주입 시 저장·attach 모두 skip, `runId === undefined`.

**`agent-runs.test.ts`** (10 케이스):

- `agent.runs.list`: provider_unavailable, created_at DESC, agentId 필터, from/to 범위, limit, prompt/output truncate (200/500자).
- `agent.runs.get`: provider_unavailable, 미존재 `null`, 정상 + `toolCalls` 파싱 배열, malformed JSON 시 빈 배열.

mock-only — DB 는 `:memory:`, runner/attach 모두 vitest mock. 외부 API 키 없이 통과.

## 7. CLAUDE.md 4원칙 준수

- **추측 금지**: storage `AddAgentRunInput` 시그니처(camelCase: `agentId`, `toolCalls`, `tokensInput`, …)를 schema-architect 문서 + 코드로 직접 확인 후 사용. `addAgentRun` 이 자동으로 `id`/`createdAt` 채우는 점도 코드에서 검증 → 외부 ID 생성 로직 제거.
- **단순함**: agent_runs 응답엔 raw 그대로, list 만 truncate. attach 결과는 무시 (hook 이 자체 처리). RpcError 도입은 본 작업 범위 밖이므로 기존 `throw new Error(...)` 패턴 유지 (memory.ts 와 동일).
- **외과적 변경**: agent.run 핸들러의 라우팅·fallback·logging 코드 무수정. 추가는 영속화·attach 두 블록과 응답 `runId` 한 필드만. server.ts 도 4 LOC 추가. main.ts 1 LOC 추가.
- **검증**: 15 신규 테스트 + 1447 회귀 0.

## 8. 후속 작업 (다른 팀원에게)

- **ui-engineer (밀스톤 E)**: `agent.runs.list({agentId?, limit?})` → 카드 리스트, 클릭 시 `agent.runs.get({runId})` → toolCalls 펼친 상세. memoryId 가 채워져 있으면 "기억으로 저장됨" 배지.
- **qa-engineer**: 본 단위 테스트로 단일 RPC 경로 커버. e2e 시나리오(agent.run → agent_runs 저장 → memory.list 에 노출 → memory.search hit) 는 storage 통합 테스트로 추가 권장 — embedding mock 만 있으면 외부 키 없이 가능.
