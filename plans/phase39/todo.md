# Phase 39 Todo: gateway 패키지 추출 (옵션 C2 — Full gateway)

> plan.md §밀스톤 A~E 를 코드 단위로 분해한 작업 가이드. 목표: `packages/server/src/gateway/`(35 비테스트 + 22 테스트 = 57 .ts) → 신규 `@finclaw/gateway`. createGatewayServer 시그니처 유지. 동작·로그·API 불변. 순수 추출.
>
> 순서 핵심: **A→B→C 로 gateway 의 server sibling import 를 0 으로 만든 뒤** D 에서 물리 이동. A·B·C 는 gateway 가 아직 `server/src/gateway/` 안에 있는 상태에서 import 만 하위 패키지로 re-point (각 단계 green 유지).
>
> ⚠️ **이 draft 는 `39-questions.md` 의 기본값(default)을 채택해 작성됨.** 사용자 미확정 시 Q1(SchedulerPort 추가)·Q2(통합 테스트 server 재배치)·Q3(RouterHelper agent 직접 import)·Q4(AttachMemoryInput types 통일) 가 바뀌면 C·D 일부 단계가 변경됨.

검증 명령 (각 밀스톤 끝 공통):

```
pnpm typecheck && pnpm build && pnpm test --run && pnpm test:storage && pnpm lint
```

테스트 베이스라인: unit **1679** (재배치만 — 총합 불변). mock-only 스탠스 (실 키/네트워크 금지).

---

## 사전 준비

신규 패키지·의존성 추가는 **밀스톤 D 에서 일괄 수행**한다 (A~C 는 기존 패키지 표면만 확장하므로 배선 변경 0). 사전 준비 단계 없음.

> 참고 — 실측 결정 (재조사 불필요):
>
> - gateway 외부 런타임 의존 = `ws`, `zod/v4`, `chokidar` **뿐**. `@modelcontextprotocol/sdk`·`@opentelemetry/*` 는 gateway 에서 **미사용** (tracer 는 C 에서 port 화). → gateway package.json deps 최소.
> - `gateway/version.ts` 는 gateway 디렉토리 **내부** 파일 → `system.ts:3 '../../version.js'` 는 intra-gateway. 통째 이동.
> - server→gateway import 사이트 = `main.ts:46`, `main.test.ts:6` (둘 다 `./gateway/server.js`) + 배럴 `gateway/index.ts`. (`cli/gateway-client.ts` 는 무관한 별도 HTTP 클라이언트.)

---

## 밀스톤 A — 순수 value 헬퍼 3종을 하위 패키지로 이동 + 전 소비자 re-point

**목표(plan):** 결합 #1(buildDispatcher)·#2(collectToolCalls/extractAssistantText)·#4(cron) 해소. gateway 가 아직 server 안에 있는 상태에서, value 헬퍼를 `@finclaw/infra`/`@finclaw/agent` 로 내리고 모든 소비자(gateway 포함)를 하위 패키지 import 로 re-point.

커밋 제안: `refactor(phase39): move cron to infra, dispatcher and message-utils to agent`

### A1. CREATE `packages/infra/src/cron.ts` — `automation/cron.ts` 통째 이동

`packages/server/src/automation/cron.ts` (161 LOC, import 0 순수) 의 **전체 내용을 그대로** 복사. 첫 줄 주석 경로만 갱신:

```ts
// packages/infra/src/cron.ts
// Phase 28 B: 5필드 cron (분 시 일 월 요일).
// 지원: '*', '*/N', 'M-N', 'M,N,O' 단순 조합. 한 필드당 number[].
// 비지원: 'L'(last day), 'W'(weekday), '?'.

export interface CronExpression {
  /* … 기존 그대로 … */
}
export class CronParseError extends Error {
  /* … 기존 그대로 … */
}
// expandField / FIELD_RANGES / FieldRange (내부)
export function parseCron(expr: string): CronExpression {
  /* … */
}
export function matches(cron: CronExpression, dateMs: number): boolean {
  /* … */
}
export function nextRunAt(cron: CronExpression, fromMs: number): number | null {
  /* … */
}
```

(본문은 기존 161 LOC 1:1. 재발명 금지 — 원본 복사 후 헤더 주석만 수정.)

### A2. CREATE `packages/infra/src/cron.test.ts` — `automation/cron.test.ts` 동반 이동

`packages/server/src/automation/cron.test.ts` 전체를 복사. import 경로만 `'./cron.js'` (상대) 로 유지 (같은 디렉토리). 원본 파일은 A6 에서 삭제.

### A3. EDIT `packages/infra/src/index.ts` — cron barrel export 추가

`// 유틸` 블록 인접에 추가 (backoff/retry/circuit-breaker 인접 유틸로 수용 — plan §리스크 승인 전제):

```ts
// cron (Phase 39: server/automation/cron 에서 이동 — 순수 파서)
export { parseCron, matches, nextRunAt, CronParseError, type CronExpression } from './cron.js';
```

검증: `pnpm --filter @finclaw/infra build`

### A4. CREATE `packages/agent/src/execution/tool-dispatcher.ts` — `buildDispatcher` 이동

`packages/server/src/auto-reply/tool-dispatcher-adapter.ts` (62 LOC) 전체 이동. import 를 상대(`@finclaw/agent` 자기 패키지이므로 내부 상대경로)로 전환:

```ts
// packages/agent/src/execution/tool-dispatcher.ts
import type { ToolDefinition } from '@finclaw/types';
import { ExecutionToolDispatcher } from './tool-executor.js';
import { toApiToolDefinition } from '../models/...'; // ⚠ 아래 주의 참조

import type { ToolExecutionContext } from './tool-executor.js';
import type { ToolRegistry } from '../???'; // ⚠ 아래 주의 참조

export interface DispatcherContextBase {
  readonly sessionId: string;
  readonly userId: string;
  readonly channelId: string;
}

export interface BuiltDispatcher {
  readonly dispatcher: ExecutionToolDispatcher;
  readonly toolDefinitions: readonly ToolDefinition[];
}

export function buildDispatcher(
  registry: ToolRegistry,
  ctx: DispatcherContextBase,
): BuiltDispatcher {
  // … 기존 본문 31-62 그대로 …
}
```

> ⚠️ **import 출처 확인 필수 (구현자):** 원본은 `@finclaw/agent` 배럴에서 `ExecutionToolDispatcher`, `toApiToolDefinition`, `ToolExecutionContext`, `ToolRegistry` 를 가져온다. agent **내부** 파일이므로 배럴(`@finclaw/agent`) self-import 대신 각 정의 파일의 상대경로로 import 해야 한다 (self-import 도 동작은 하나 컨벤션상 내부 상대 권장). 정의 위치:
>
> - `ExecutionToolDispatcher`, `ToolExecutionContext`(=tool-executor 의 `ToolHandler`?), `ToolRegistry` → `grep -rn "export.*ExecutionToolDispatcher\|export.*ToolRegistry\|export.*toApiToolDefinition\|export.*ToolExecutionContext" packages/agent/src` 로 정확한 파일 확정 후 상대경로 작성. (`tool-executor.ts` 에 dispatcher, 별도 tools 정의 파일에 ToolRegistry/toApiToolDefinition 가능성.)
> - 만약 상대경로가 번잡하면 `from '@finclaw/agent'` self-barrel import 도 허용(빌드 통과 확인). **단 placeholder 금지 — 실제 경로로 채울 것.**

### A5. CREATE `packages/agent/src/execution/message-utils.ts` — `collectToolCalls`/`extractAssistantText` + `ToolCallRecord` 이동

`execution-adapter.ts` 의 `ToolCallRecord`(L90-98), `extractAssistantText`(L648-665), `collectToolCalls`(L800-829) **순수 함수만** 이동. 이들은 `ConversationMessage`/`ContentBlock`(@finclaw/types) 만 사용:

```ts
// packages/agent/src/execution/message-utils.ts
import type { ContentBlock, ConversationMessage } from '@finclaw/types';

/** Phase 22: 도구 호출 감사용 메타데이터 — DeliverStage 출처 footer·DB 병렬 저장에서 소비 */
export interface ToolCallRecord {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  readonly source?: string;
  readonly timestamp: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
}

export function extractAssistantText(messages: readonly ConversationMessage[]): string {
  // … execution-adapter.ts L649-664 본문 그대로 …
}

/** assistant tool_use 블록과 뒤따르는 tool tool_result 블록을 페어링해 감사 레코드 생성 */
export function collectToolCalls(
  messages: readonly ConversationMessage[],
  fallbackTimestamp: number,
): ToolCallRecord[] {
  // … execution-adapter.ts L804-828 본문 그대로 …
}
```

> ⚠️ `flattenContent`/`toTranscriptEntry`/`isOrphanedToolResult`/`sliceHistoryRespectingToolPairs`/`maybeCompactMessages`/`extractCitedMemoryIds` 는 **이동하지 않음** — execution-adapter 잔류부(RunnerExecutionAdapter 등)가 쓰는 server-domain 헬퍼. `collectToolCalls`/`extractAssistantText` 는 이들과 무관(독립). 이동 대상 3심볼만.

### A6. EDIT `packages/agent/src/execution/index.ts` — message-utils + tool-dispatcher barrel export

```ts
// 기존 export 들 아래에 추가
export { buildDispatcher } from './tool-dispatcher.js';
export type { BuiltDispatcher, DispatcherContextBase } from './tool-dispatcher.js';

export { collectToolCalls, extractAssistantText } from './message-utils.js';
export type { ToolCallRecord } from './message-utils.js';
```

그리고 `packages/agent/src/index.ts` 의 execution re-export 블록(L182-198)에 동일 심볼 추가:

```ts
// L182-188 value export 블록에 추가
export {
  ToolInputBuffer,
  StreamStateMachine,
  ExecutionToolDispatcher,
  TokenCounter,
  Runner,
  buildDispatcher, // ← 추가
  collectToolCalls, // ← 추가
  extractAssistantText, // ← 추가
} from './execution/index.js';
// L189-198 type export 블록에 추가
export type {
  StreamState,
  StreamEvent,
  StreamEventListener,
  ExecutionResult,
  ToolHandler,
  ExecutionToolResult,
  RunnerOptions,
  RunnerTracerAdapter,
  BuiltDispatcher, // ← 추가
  DispatcherContextBase, // ← 추가
  ToolCallRecord, // ← 추가
} from './execution/index.js';
```

> ⚠️ agent 배럴에 이미 type `ExecutionResult`(streaming.ts)가 있음 — 신규 심볼과 충돌 없음(`ToolCallRecord`/`BuiltDispatcher`/`DispatcherContextBase` 신규명). 확인만.

### A7. CREATE `packages/agent/src/execution/tool-dispatcher.test.ts` — dispatcher 테스트 이동

`packages/server/src/auto-reply/__tests__/tool-dispatcher-adapter.test.ts` 전체를 복사. import 만 교체:

```ts
import {
  InMemoryToolRegistry,
  type RegisteredToolDefinition,
  type ToolExecutor,
} from '@finclaw/agent';
import { describe, expect, it, vi } from 'vitest';
import { buildDispatcher } from './tool-dispatcher.js'; // ← '../tool-dispatcher-adapter.js' 에서 변경
```

원본 `__tests__/tool-dispatcher-adapter.test.ts` 는 A11 에서 삭제.

검증: `pnpm --filter @finclaw/agent build && pnpm --filter @finclaw/agent test --run`

### A8. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — 이동 심볼 re-import + re-export, 잔류부 보존

상단 import 정리 (L40-43 영역). `buildDispatcher`(현재 `./tool-dispatcher-adapter.js` L43)와 이동된 message 헬퍼를 `@finclaw/agent` 에서 가져온다. **execution-adapter 는 L305/L349/L482 에서 `collectToolCalls`/`extractAssistantText` 를 내부 사용**하므로 re-import 필수. 또한 `ToolCallRecord` 는 `ExecutionResult` 인터페이스(L103)·`ToolCallRecord[]` 반환에 쓰이므로 type 으로 re-import:

```ts
// 변경 전 (L40-43):
import { createAgentId } from '@finclaw/types';
import type { PipelineMsgContext } from './pipeline-context.js';
import { formatBackgroundSection } from './stages/memory-retrieval.js';
import { buildDispatcher } from './tool-dispatcher-adapter.js';

// 변경 후:
import { createAgentId } from '@finclaw/types';
import { buildDispatcher, collectToolCalls, extractAssistantText } from '@finclaw/agent';
import type { ToolCallRecord } from '@finclaw/agent';
import type { PipelineMsgContext } from './pipeline-context.js';
import { formatBackgroundSection } from './stages/memory-retrieval.js';
```

그리고 **agent 헬퍼를 그대로 re-export** (기존 소비자 `execution-adapter.test.ts:13` 가 `../execution-adapter.js` 에서 `extractAssistantText` 를 import 하므로 — 테스트 무변경 유지):

```ts
// execution-adapter.ts 적당한 위치 (기존 export 인접)에 추가:
export { collectToolCalls, extractAssistantText } from '@finclaw/agent';
export type { ToolCallRecord } from '@finclaw/agent';
```

**삭제할 잔류 정의** (이제 agent 가 소유):

- `ToolCallRecord` interface (L90-98) → 삭제 (agent type re-import 로 대체).
- `extractAssistantText` 함수 정의 (L648-665) → 삭제.
- `collectToolCalls` 함수 정의 (L800-829) → 삭제.

**보존** (잔류부 — 손대지 말 것): `extractCitedMemoryIds`, `MockExecutionAdapter`, `RunnerExecutionAdapter`, `RunnerFactory`, `maybeCompactMessages`, `sliceHistoryRespectingToolPairs`, `flattenContent`, `toTranscriptEntry`, `isOrphanedToolResult`, `inferRole`, `ExecutionResult`, `ExecutionAdapter`, `RunnerExecutionAdapterDeps`, `TuiExecutionResult`.

> ⚠️ `ExecutionResult`(L100-106, server 로컬)는 `toolCalls?: readonly ToolCallRecord[]` 를 쓴다 → `ToolCallRecord` 가 agent type re-import 로 살아있으니 OK. `buildDispatcher` 사용처(L613 `buildRequestDispatcher`)는 import 출처만 바뀌고 호출부 무변경.

### A9. EDIT `packages/server/src/automation/scheduler.ts` — cron/dispatcher/message 헬퍼 re-point

```ts
// 변경 전 (L24-32):
import {
  collectToolCalls,
  extractAssistantText,
  type RunnerFactory,
} from '../auto-reply/execution-adapter.js';
import type { RouterHelper } from '../auto-reply/router-helper.js';
import { buildDispatcher } from '../auto-reply/tool-dispatcher-adapter.js';
import type { FinclawTracer } from '../observability/tracer.js';
import { nextRunAt as computeNextRunAt, parseCron } from './cron.js';

// 변경 후:
import { buildDispatcher, collectToolCalls, extractAssistantText } from '@finclaw/agent';
import type { RouterHelper } from '@finclaw/agent'; // ← router-helper 재export 였음 (Q3)
import { nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';
import type { RunnerFactory } from '../auto-reply/execution-adapter.js'; // 잔류 (RunnerFactory 는 A 에서 미이동 — C 에서 agent 로)
import type { FinclawTracer } from '../observability/tracer.js'; // 잔류 (C 에서 port)
```

> ⚠️ `RunnerFactory`·`FinclawTracer` 는 A 범위 아님 (각각 C 에서 처리). A 에서는 cron/buildDispatcher/collect/extract 4개만 re-point. 호출부(L176-177, L231, L299-300, L352-353) 무변경.
> ⚠️ `RouterHelper` 를 `@finclaw/agent` 직접 import 로 (Q3 기본값). 만약 Q3 미승인이면 `'../auto-reply/router-helper.js'` 유지.

### A10. EDIT `packages/server/src/composition/schedule-rpc.ts` + `composition/skills.ts` — cron re-point

`schedule-rpc.ts:7`:

```ts
// 변경 전:
import { CronParseError, nextRunAt as computeNextRunAt, parseCron } from '../automation/cron.js';
// 변경 후:
import { CronParseError, nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';
```

`skills.ts:33`:

```ts
// 변경 전:
import { nextRunAt as computeNextRunAt, parseCron } from '../automation/cron.js';
// 변경 후:
import { nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';
```

(`skills.ts:32` 의 `makeRouterHelper` import 및 `RouterHelper` 로컬 type alias 는 A 범위 아님 — 무변경.)

### A11. EDIT `packages/server/src/gateway/rpc/methods/agent.ts` + `schedule.ts` — gateway 측 value re-point

`agent.ts` (L18-24):

```ts
// 변경 전:
import {
  collectToolCalls,
  extractAssistantText,
  type RunnerFactory,
} from '../../../auto-reply/execution-adapter.js';
import type { RouterHelper } from '../../../auto-reply/router-helper.js';
import { buildDispatcher } from '../../../auto-reply/tool-dispatcher-adapter.js';

// 변경 후:
import { buildDispatcher, collectToolCalls, extractAssistantText } from '@finclaw/agent';
// RunnerFactory(#6)·RouterHelper(#7)·AttachMemoryService(#5)·FinclawTracer(#8) 는 C 에서 처리 — A 단계에선 기존 type import 유지 (아직 server sibling).
import { type RunnerFactory } from '../../../auto-reply/execution-adapter.js';
import type { RouterHelper } from '../../../auto-reply/router-helper.js';
```

> ⚠️ A 에서 gateway/agent.ts 는 **value 3종(buildDispatcher/collect/extract)만** agent 로 re-point. type 결합(#5~#8, #10)은 아직 server sibling 으로 남김 → **C 에서 일괄 port 화**. (A 후 grep 가드는 아직 0 아님 — C 후 0.)

`schedule.ts` (L15-19):

```ts
// 변경 전:
import {
  CronParseError,
  nextRunAt as computeNextRunAt,
  parseCron,
} from '../../../automation/cron.js';
// 변경 후:
import { CronParseError, nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';
```

(`schedule.ts:20` 의 `SchedulerService` 는 C 에서 port — A 무변경.)

### A12. DELETE 원본 이동 파일 4개

A1~A11 통과 확인 후 삭제:

- `packages/server/src/automation/cron.ts`
- `packages/server/src/automation/cron.test.ts`
- `packages/server/src/auto-reply/tool-dispatcher-adapter.ts` (buildDispatcher + 2 interface 만 보유 → 통째 삭제)
- `packages/server/src/auto-reply/__tests__/tool-dispatcher-adapter.test.ts`

> ⚠️ 삭제 후 잔존 참조 grep: `grep -rn "automation/cron\|tool-dispatcher-adapter" packages/server/src --include=*.ts` → 0 이어야 함.

### A13. 밀스톤 A 검증

```
pnpm typecheck && pnpm build && pnpm test --run && pnpm test:storage && pnpm lint
```

기대: unit 1679 유지 (cron.test + tool-dispatcher.test 가 infra/agent 로 재배치됐을 뿐). `oxfmt` 가 package.json 재정렬 가능성 없음(이 단계 package.json 무변경). 이상 시 `pnpm format:fix`.

---

## 밀스톤 B — loadPrompt-loadAgents → 메타데이터 주입 대체 (결합 #3 해소)

**목표(plan):** gateway/agent.ts 의 `loadAgents()`(loadPrompt 사용) 제거. `AgentRpcDeps.agents` 주입. main.ts 가 `loadPrompt('finclaw.identity.md')` 로 메타 로드 후 주입. agent.list/status/run 메타 동일.

커밋 제안: `refactor(phase39): inject agent metadata instead of loadPrompt in gateway`

### B1. EDIT `packages/server/src/gateway/rpc/methods/agent.ts` — loadPrompt 제거, agents 주입

**삭제:**

- import `loadPrompt`, `requireFrontmatterKeys` (L26).
- `let cachedAgents` (L73), `async function loadAgents()` (L75-94), `export function resetAgentsCache()` (L96-99). (resetAgentsCache 는 importer 0 — 확인 완료, 안전.)

**`AgentInfo` interface (L67-71)는 보존** — `AgentRpcDeps` 의 주입 타입으로 승격:

```ts
// L67-71 그대로 유지 (export 추가):
export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
```

**`AgentRpcDeps` 에 필드 추가** (L31 인터페이스):

```ts
export interface AgentRpcDeps {
  readonly toolRegistry: ToolRegistry;
  /** Phase 39: main.ts 가 finclaw.identity.md frontmatter 로부터 로드해 주입 (이전 loadAgents() 대체). */
  readonly agents: readonly AgentInfo[];
  readonly runnerFactory: RunnerFactory;
  // … 나머지 기존 필드 …
}
```

**3개 핸들러의 `await loadAgents()` 를 `deps.agents` 로 치환:**

```ts
// listHandler.execute (L172-183):
async execute() {
  const toolCount = deps.toolRegistry.list().length;
  return {
    agents: deps.agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      toolCount,
    })),
  };
},

// statusHandler.execute (L192):  const info = deps.agents.find((a) => a.id === params.agentId);
// runHandler.execute (L235):     if (!deps.agents.find((a) => a.id === params.agentId)) {
```

(나머지 status/run 본문 무변경 — `agents` 지역변수만 `deps.agents` 로.)

### B2. EDIT `packages/server/src/main.ts` — identity 메타 로드 후 agentDeps.agents 주입

`main.ts:49` 는 이미 `loadPrompt` import 함. `requireFrontmatterKeys` 도 추가:

```ts
// L49 변경:
import { loadPrompt, requireFrontmatterKeys } from './prompts/loader.js';
```

`DEFAULT_SYSTEM_PROMPT` 로드(L72) 인근에 identity 메타 로드 추가:

```ts
// L72-73 인근:
const systemPromptDoc = await loadPrompt('finclaw.system.ko.md', 'main:DEFAULT_SYSTEM_PROMPT');
const DEFAULT_SYSTEM_PROMPT = systemPromptDoc.body;

// Phase 39: agent 메타데이터 (이전 gateway/agent.ts loadAgents() 가 하던 일 — gateway→server fs 결합 제거).
const identityDoc = await loadPrompt('finclaw.identity.md', 'main:agentMeta');
requireFrontmatterKeys(
  identityDoc,
  'finclaw.identity.md',
  ['id', 'name', 'description'],
  'main:agentMeta',
);
const AGENT_METADATA = [
  {
    id: identityDoc.frontmatter.id,
    name: identityDoc.frontmatter.name,
    description: identityDoc.frontmatter.description,
  },
];
```

`agentDeps` 블록(L312)에 `agents` 주입:

```ts
agentDeps: {
  toolRegistry,
  agents: AGENT_METADATA,   // ← 추가
  runnerFactory,
  // … 기존 필드 …
},
```

### B3. EDIT gateway agent 테스트 — `makeDeps` 에 agents 추가

`gateway/rpc/methods/agent.test.ts:73 makeDeps` + `agent-runs.test.ts:315 makeAgentDeps` 의 기본 deps 에 `agents` 필드 추가 (이전엔 loadAgents 가 finclaw.identity.md 를 실제 로드 → 테스트 환경에서 prompts dir 의존했음. 이제 주입식이라 고정 메타로 대체):

```ts
function makeDeps(overrides: Partial<AgentRpcDeps> = {}): AgentRpcDeps {
  return {
    toolRegistry: /* 기존 */,
    agents: [{ id: 'finclaw', name: 'FinClaw', description: 'test agent' }],  // ← 추가
    // … 기존 …
    ...overrides,
  };
}
```

> ⚠️ `agent.test.ts:135` 가 `agents: Array<{id, toolCount}>` 응답을 검증. 주입 메타의 `id` 가 **기존 finclaw.identity.md frontmatter 의 id 와 동일**해야 기존 assertion 통과. `grep -n "expect.*agents\|toEqual\|id:" packages/server/src/gateway/rpc/methods/agent.test.ts` 로 기대 id 확인 후 동일 값 사용 (의미 동등 — plan 완료조건 #3).

### B4. 밀스톤 B 검증

```
pnpm typecheck && pnpm build && pnpm test --run && pnpm test:storage && pnpm lint
```

기대: `grep -rn "loadAgents\|resetAgentsCache" packages/server/src` → 0. agent.list/status/run 응답 불변. unit 1679 유지.

---

## 밀스톤 C — type 결합을 port 인터페이스로 역전 (DIP) (결합 #5~#11 해소)

**목표(plan + Q1):** gateway 의 server-sibling **type** import 를 narrow port 로 교체 → 이 시점 **gateway/ 의 server sibling import 0** (grep 가드). server 구현 클래스는 구조적 만족(typecheck 강제).

> port 7종 (Q1·Q3·Q4 기본값 반영):
> | port | 위치 | 메서드 (실측 시그니처 1:1) | server 구현 클래스 | 결합# |
> |---|---|---|---|---|
> | `AttachMemoryPort` | @finclaw/types | `attach(input: AttachMemoryInput): Promise<unknown>` | DefaultAttachMemoryService | #5 |
> | `TracerPort` | @finclaw/types | `withSpan<T>(name, attrs, fn): Promise<T>` | createTracer 반환 FinclawTracer | #8 |
> | `BrokerageSyncPort` | @finclaw/types | `run(): Promise<BrokerageSyncResult>` | BrokerageSyncService | #9 |
> | `ChatExecutionPort` | @finclaw/types | `executeForTui(input, listener, signal): Promise<TuiExecutionResult>` | RunnerExecutionAdapter | #10 |
> | `SchedulerPort` | @finclaw/types | `triggerNow(id: string): Promise<{ runId: string \| null }>` | SchedulerService | #11(Q1) |
> | `RunnerFactory` | @finclaw/agent | `(d: ExecutionToolDispatcher) => Runner` (agent-native) | — | #6 |
> | `RouterHelper` | @finclaw/agent (기존) | 함수형 (이미 존재 — 직접 import) | makeRouterHelper 반환 | #7(Q3) |

커밋 제안: `refactor(phase39): invert gateway type couplings to narrow ports (DIP)`

### C1. CREATE `packages/types/src/gateway-ports.ts` — narrow port 5종 + 보조 타입

gateway 가 호출하는 메서드만 노출하는 최소 port. **실측 시그니처 1:1** (과/저 추상화 금지):

```ts
// packages/types/src/gateway-ports.ts
// Phase 39: gateway → server 결합 역전용 narrow port (DIP). server 구현 클래스가 구조적 만족.
import type { SessionKey } from './common.js';
import type { StreamEventListener } from './???'; // ⚠ 아래 주의
import type { AgentId, ModelRef, ModelTier } from './common.js'; // 위치는 grep 확인

/** agent.run 종료 후 memory attach 입력 (이전 server agent-memory-hook.AgentRunMemoryInput). */
export interface AttachMemoryInput {
  readonly agentRunId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly output: string;
  readonly error?: string;
  readonly sessionKey: SessionKey;
  readonly createdAt: number;
}

/** gateway agent.ts:120 사용면 — 반환값 무시(await 만). */
export interface AttachMemoryPort {
  attach(input: AttachMemoryInput): Promise<unknown>;
}

/** gateway agent.ts:259 사용면 — withSpan 만. TraceContext 는 trace.ts 기존 타입. */
export interface TracerPort {
  withSpan<T>(
    name: string,
    attrs: Readonly<Record<string, unknown>>,
    fn: (ctx: import('./trace.js').TraceContext) => Promise<T>,
  ): Promise<T>;
}

/** brokerage.ts:33 사용면 — run() 결과 3필드 소비. */
export interface BrokerageSyncResultLike {
  readonly syncedAt: number;
  readonly holdingsCount: number;
  readonly marketsScanned: ReadonlyArray<'KR' | 'US'>;
  readonly errors: ReadonlyArray<{ market: string; message: string }>;
}
export interface BrokerageSyncPort {
  run(): Promise<BrokerageSyncResultLike>;
}

/** schedule.ts:44 사용면 — triggerNow 만 (Q1). */
export interface SchedulerPort {
  triggerNow(scheduleId: string): Promise<{ runId: string | null }>;
}

/** chat.ts:107 사용면 — executeForTui 만 (#10). */
export interface TuiExecutionResultLike {
  readonly messageId: string;
  readonly content: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}
export interface ChatExecutionPort {
  executeForTui(
    input: {
      readonly sessionKey: SessionKey;
      readonly agentId: AgentId;
      readonly userMessage: string;
      readonly model: ModelRef;
      readonly userHint?: ModelTier;
    },
    listener: StreamEventListener | undefined,
    signal: AbortSignal,
  ): Promise<TuiExecutionResultLike>;
}
```

> ⚠️ **import 출처 확인 (구현자):**
>
> - `StreamEventListener` 는 현재 `@finclaw/agent`(execution/streaming) 소유 — types 가 agent 를 의존하면 **역방향 위반**(types ← agent). 해결책 택1:
>   - (권장) `ChatExecutionPort.executeForTui` 의 `listener` 파라미터를 `listener: ((event: unknown) => void) | undefined` 로 일반화 (gateway chat.ts 가 `StreamEvent` 콜백을 넘기지만 port 는 구조적으로 수용). RunnerExecutionAdapter.executeForTui 의 실제 시그니처(`StreamEventListener | undefined`)가 이 일반형을 구조적 만족하는지 typecheck 확인. **불만족 시** ChatExecutionPort 를 `@finclaw/types` 대신 별도 처리 → Q 재논의.
>   - 또는 `StreamEventListener` 타입을 `@finclaw/types/message.ts` 로 이동(streaming 이벤트 타입 동반 — blast radius 큼, 비권장).
> - `AgentId`/`ModelRef`/`ModelTier`/`SessionKey` 정확한 파일: `grep -rn "export type AgentId\|export type ModelRef\|export type ModelTier\|export type SessionKey" packages/types/src` 로 확정.

### C2. EDIT `packages/types/src/index.ts` — gateway-ports barrel export

```ts
// 기존 type re-export 블록에 추가:
export type * from './gateway-ports.js';
```

검증: `pnpm --filter @finclaw/types build`

### C3. EDIT `packages/server/src/auto-reply/agent-memory-hook.ts` — AttachMemoryInput 통일 (Q4)

`AgentRunMemoryInput` (L20-28) 을 types 의 `AttachMemoryInput` 와 통일. 구조 동일하므로 alias 로 단순화:

```ts
// L7-8 인근 import 에 추가:
import type { AttachMemoryInput } from '@finclaw/types';

// L20-28 AgentRunMemoryInput interface 를 alias 로 교체 (또는 export type 유지하되 = AttachMemoryInput):
export type AgentRunMemoryInput = AttachMemoryInput;

// AttachMemoryService interface (L37-39) 는 server 잔류 — DefaultAttachMemoryService 가 implements.
// (gateway 는 더이상 이 타입을 import 하지 않음 — port 사용.)
```

> ⚠️ `DefaultAttachMemoryService implements AttachMemoryService` 의 `attach(input: AgentRunMemoryInput): Promise<AttachMemoryResult>` 는 `AttachMemoryPort.attach(input: AttachMemoryInput): Promise<unknown>` 를 구조적 만족 (AgentRunMemoryInput=AttachMemoryInput, AttachMemoryResult ⊂ unknown). gateway 가 port 로 받아도 OK.
> Q4 미승인 시: AgentRunMemoryInput server 잔류 + types AttachMemoryInput 별도 정의 (중복) — 구조 동일하면 typecheck 통과하나 드리프트 위험.

### C4. EDIT `packages/server/src/observability/tracer.ts` — TracerPort 구조 만족 (선택적 implements)

`FinclawTracer` interface (L32-40)는 `withSpan` + `getCurrentContext` 보유. `TracerPort` 는 `withSpan` 만 요구 → `FinclawTracer` 가 `TracerPort` 를 자동 구조 만족. **server 코드 변경 불필요** (gateway 측만 port 로 import). 명시성 위해 주석만 추가 가능 (선택):

```ts
// (선택) FinclawTracer 가 @finclaw/types TracerPort 의 상위집합임을 문서화.
// 강제 implements 는 함수 반환 객체라 부적용 — gateway 가 TracerPort 로 받음으로 충분.
```

→ **이 단계는 no-op (확인만).** createTracer 반환 객체가 TracerPort 만족하는지 C7 typecheck 로 검증.

### C5. EDIT server 구현 클래스 — 선택적 `implements` 명시 (typecheck 강제용)

구조적 만족이 기본이나, plan §C "필요 시 implements" 에 따라 회귀 방지로 명시 권장:

- `brokerage-sync-service.ts:22` — `export class BrokerageSyncService implements BrokerageSyncPort {` (import 추가). `BrokerageSyncResult` 가 `BrokerageSyncResultLike` 구조 만족 확인.
- `automation/scheduler.ts:94` — `export class SchedulerService implements SchedulerPort {` (triggerNow 시그니처 일치 확인 — L144 `Promise<{ runId: string | null }>` ✓).
- `RunnerExecutionAdapter`(execution-adapter.ts:197) — `implements ExecutionAdapter, ChatExecutionPort` (executeForTui 시그니처가 ChatExecutionPort 와 일치 확인. `TuiExecutionResult` ⊃ `TuiExecutionResultLike`).
- `DefaultAttachMemoryService`(agent-memory-hook.ts:59) — 이미 `implements AttachMemoryService`. AttachMemoryPort 추가는 선택 (gateway port 수용은 구조적).

> ⚠️ `implements` 가 기존 시그니처와 1px라도 안 맞으면 typecheck 실패 → **그게 가드**. 안 맞으면 port 정의를 server 실측에 맞춰 조정(반대 X). RunnerExecutionAdapter 의 listener 타입 이슈(C1 주의) 가 여기서 드러날 수 있음.

### C6. EDIT gateway 파일 5개 — type import 를 port 로 교체

`gateway/rpc/methods/agent.ts`:

```ts
// 삭제: import type { AttachMemoryService } from '../../../auto-reply/agent-memory-hook.js';  (L17)
// 삭제: type RunnerFactory from execution-adapter (L18-22 잔재)
// 삭제: import type { RouterHelper } from '../../../auto-reply/router-helper.js';  (L23)
// 삭제: import type { FinclawTracer } from '../../../observability/tracer.js';  (L25)
// 추가:
import type { RunnerFactory } from '@finclaw/agent'; // #6
import type { RouterHelper } from '@finclaw/agent'; // #7 (Q3 — 이미 agent-native)
import type { AttachMemoryPort, TracerPort } from '@finclaw/types'; // #5, #8

// AgentRpcDeps 필드 타입 교체:
//   attachMemoryService?: AttachMemoryService  →  attachMemoryService?: AttachMemoryPort
//   tracer?: FinclawTracer                     →  tracer?: TracerPort
//   router?: RouterHelper / runnerFactory: RunnerFactory  → 그대로 (이제 @finclaw/agent 출처)
```

`gateway/rpc/methods/chat.ts:7`:

```ts
// 변경 전: import type { RunnerExecutionAdapter } from '../../../auto-reply/execution-adapter.js';
// 변경 후: import type { ChatExecutionPort } from '@finclaw/types';
// ChatMethodsDeps.adapter: RunnerExecutionAdapter  →  adapter: ChatExecutionPort
```

`gateway/rpc/methods/brokerage.ts:4`:

```ts
// 변경 전: import type { BrokerageSyncService } from '../../../services/brokerage-sync-service.js';
// 변경 후: import type { BrokerageSyncPort } from '@finclaw/types';
// BrokerageRpcDeps.syncService?: BrokerageSyncService  →  syncService?: BrokerageSyncPort
```

`gateway/rpc/methods/schedule.ts:20`:

```ts
// 변경 전: import type { SchedulerService } from '../../../automation/scheduler.js';
// 변경 후: import type { SchedulerPort } from '@finclaw/types';
// ScheduleRpcDeps.scheduler?: SchedulerService  →  scheduler?: SchedulerPort
// requireScheduler 반환 타입도 SchedulerPort 로.
```

`gateway/server.ts:13`:

```ts
// 변경 전: import type { RunnerExecutionAdapter } from '../auto-reply/execution-adapter.js';
// 변경 후: import type { ChatExecutionPort } from '@finclaw/types';
// GatewayServerDeps.adapter: RunnerExecutionAdapter  →  adapter: ChatExecutionPort
```

> ⚠️ `server.ts:47 adapter` + chat.ts 가 같은 port 사용. main.ts 가 주입하는 실 `adapter`(RunnerExecutionAdapter)가 ChatExecutionPort 만족 → C5 implements 로 보장.

### C7. EDIT gateway 타입 전용 테스트 import re-point

`gateway/rpc/methods/agent.test.ts:6` (type-only `AttachMemoryService` → `AttachMemoryPort`):

```ts
// 변경 전: import type { AttachMemoryService } from '../../../auto-reply/agent-memory-hook.js';
// 변경 후: import type { AttachMemoryPort } from '@finclaw/types';
// L297/330/367/407: const attachMemoryService: AttachMemoryPort = { attach };
```

`gateway/rpc/methods/chat.test.ts:5` (type-only `RunnerExecutionAdapter`):

```ts
// 변경 전: import type { RunnerExecutionAdapter } from '../../../auto-reply/execution-adapter.js';
// 변경 후: import type { ChatExecutionPort } from '@finclaw/types';
// 해당 mock adapter 변수 타입을 ChatExecutionPort 로. (executeForTui mock 시그니처 확인.)
```

> ⚠️ **value 클래스 import 테스트 2건(`agent-runs.test.ts:6`, `memory.test.ts:15`)은 여기서 처리 X** — Q2 에 따라 **D 에서 server 로 재배치**한다 (port stub 로 강등하지 않음 = 기본값 A). C 단계에선 이 2 파일을 그대로 둔다 (아직 gateway 디렉토리, 아직 server 안이라 import 유효).

### C8. 밀스톤 C 검증 + **grep 가드**

```
pnpm typecheck && pnpm build && pnpm test --run && pnpm test:storage && pnpm lint
```

**핵심 가드 (plan 완료조건 #1 의 핵심):**

```
# production 코드에서 gateway → server sibling import 0 확인:
grep -rn "from '\.\./\.\./\.\./" packages/server/src/gateway --include='*.ts' | grep -v '\.test\.ts'
#   → 결과 0 줄이어야 함 (production)
# 테스트에 남은 2건(agent-runs.test/memory.test)은 D 에서 재배치 — C 시점엔 잔존 OK.
```

기대: production gateway→server 결합 0. unit 1679 유지.

---

## 밀스톤 D — gateway/ → packages/gateway/ 물리 추출 + 배선

**목표(plan):** `git mv` 로 gateway/ 전체 → `packages/gateway/src/`. 패키지 배선. server import re-point.

커밋 제안: `refactor(phase39): extract gateway to @finclaw/gateway package`

### D1. (Q2) 통합 테스트 2건 server 로 선이동

`git mv` 전, gateway→server 구체클래스 결합 테스트 2건을 server 테스트 트리로 이동 (Q2 기본값 A):

```
mkdir -p packages/server/src/__tests__/gateway-integration
git mv packages/server/src/gateway/rpc/methods/agent-runs.test.ts \
       packages/server/src/__tests__/gateway-integration/agent-runs.integration.test.ts
git mv packages/server/src/gateway/rpc/methods/memory.test.ts \
       packages/server/src/__tests__/gateway-integration/memory.integration.test.ts
```

import 재배선 (server 트리 기준 + D5 후 `@finclaw/gateway`):

```ts
// agent-runs.integration.test.ts:
//   '../../../auto-reply/agent-memory-hook.js'  →  '../../auto-reply/agent-memory-hook.js'  (DefaultAttachMemoryService, server 내부)
//   './agent.js' 등 gateway 메서드 import  →  '@finclaw/gateway'  (registerAgentMethods, AgentRpcDeps, resetAgentStats)
//   기타 '../...' gateway 상대 import  →  '@finclaw/gateway' export 로
// memory.integration.test.ts:
//   '../../../auto-reply/stages/memory-capture.js'  →  '../../auto-reply/stages/memory-capture.js'  (DefaultMemoryCaptureService)
//   gateway 메서드 import  →  '@finclaw/gateway'
```

> ⚠️ 이 두 테스트가 gateway 의 어떤 심볼을 쓰는지 `grep -n "^import\|from '" <file>` 로 전수 → 모두 `@finclaw/gateway` 배럴에 export 돼야 함 (D6 배럴 확장 시 반영). server 가 `@finclaw/gateway` 의존(D4)하므로 도달 가능. **순환 없음** (gateway 는 server 미의존).

### D2. `git mv` gateway 디렉토리 통째 이동

```
mkdir -p packages/gateway
git mv packages/server/src/gateway packages/gateway/src
```

결과: `packages/gateway/src/{auth,openai-compat,rpc,rpc/methods,ws,*.ts}` (남은 33 비테스트 + 20 테스트 — D1 에서 2 테스트 빠짐).

> ⚠️ gateway 내부 상대 import 는 **깊이 불변**(통째 이동)이라 무수정. server sibling 결합은 A~C 에서 0 으로 만들었으므로 깨지는 상대경로 없음. `gateway/version.ts` 등 intra-gateway 도 그대로.

### D3. CREATE `packages/gateway/package.json` (템플릿 = skills-finance)

```json
{
  "name": "@finclaw/gateway",
  "version": "0.1.0",
  "private": true,
  "files": ["dist"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@finclaw/agent": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "@finclaw/storage": "workspace:*",
    "@finclaw/types": "workspace:*",
    "chokidar": "^5.0.0",
    "ws": "^8.19.0",
    "zod": "^4.0.0"
  }
}
```

> ⚠️ deps 근거: gateway 외부 import 실측 = `ws`/`zod/v4`/`chokidar` + workspace(types/infra/agent/storage). `@modelcontextprotocol/sdk`·`@opentelemetry/*` **불포함**(미사용 확인). `config` 패키지 import 여부 `grep -rn "@finclaw/config" packages/gateway/src` 로 확인 후 있으면 추가. 작성 후 `pnpm format:fix` (oxfmt 가 키 재정렬).

### D4. CREATE `packages/gateway/tsconfig.json` (템플릿 = skills-finance)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [
    { "path": "../types" },
    { "path": "../infra" },
    { "path": "../storage" },
    { "path": "../agent" }
  ]
}
```

### D5. EDIT root `tsconfig.json` + server 배선

root `tsconfig.json` references 에 gateway 추가 (**server 앞**에 — server 가 gateway 의존하므로 빌드 순서):

```json
{ "path": "packages/agent" },
{ "path": "packages/gateway" },        // ← 추가 (agent~server 사이)
{ "path": "packages/channel-discord" },
```

`packages/server/package.json` dependencies 에 추가:

```json
"@finclaw/gateway": "workspace:*",
```

`packages/server/tsconfig.json` references 에 추가:

```json
{ "path": "../gateway" },
```

### D6. CREATE `packages/gateway/src/index.ts` — 공개 배럴

server(main.ts/main.test.ts) + 재배치된 통합 테스트(D1)가 쓰는 심볼을 export. 최소 = 기존 `gateway/index.ts`(`createGatewayServer`, `GatewayServer`) + 통합 테스트가 참조하는 심볼:

```ts
// packages/gateway/src/index.ts
export { createGatewayServer, type GatewayServer, type GatewayServerDeps } from './server.js';
export type { GatewayServerConfig } from './rpc/types.js';
// 통합 테스트(D1)·main 이 참조하는 메서드 등록자/타입 (grep 으로 전수):
export {
  registerAgentMethods,
  resetAgentStats,
  type AgentRpcDeps,
  type AgentInfo,
} from './rpc/methods/agent.js';
// … memory.integration 이 쓰는 registerMemoryMethods/MemoryRpcDeps 등 필요시 추가 …
```

> ⚠️ **export 목록은 D1 의 두 통합 테스트 + main.ts/main.test.ts 가 실제 import 하는 심볼 전수로 결정.** 기존 `gateway/index.ts`(이동 후 `packages/gateway/src/index.ts` 와 충돌)는 `git mv` 로 함께 이동됐을 것 → 그 파일을 이 내용으로 **덮어쓰기/확장**. (`packages/gateway/src/index.ts` 가 이미 존재하면 Write 대신 Edit.)

### D7. EDIT `packages/server/src/main.ts` + `main.test.ts` — gateway import re-point

`main.ts:46`:

```ts
// 변경 전: import { createGatewayServer } from './gateway/server.js';
// 변경 후: import { createGatewayServer } from '@finclaw/gateway';
```

`main.ts:45` (`GatewayServerConfig` from `./gateway/rpc/types.js`):

```ts
// 변경 전: import type { GatewayServerConfig } from './gateway/rpc/types.js';
// 변경 후: import type { GatewayServerConfig } from '@finclaw/gateway';
```

`main.test.ts:6`:

```ts
// 변경 전: import { createGatewayServer, type GatewayServer } from './gateway/server.js';
// 변경 후: import { createGatewayServer, type GatewayServer } from '@finclaw/gateway';
```

> ⚠️ server 내 잔존 gateway 상대 import 전수: `grep -rn "from '\./gateway\|from '\.\./gateway\|gateway/server\|gateway/rpc\|gateway/index" packages/server/src --include='*.ts'` → `@finclaw/gateway` 로 모두 치환 (단 `cli/gateway-client.ts` 는 무관 — 제외). createGatewayServer 호출부 `main.ts:292` 는 시그니처 불변이라 호출 코드 무변경.

### D8. 밀스톤 D 검증

```
pnpm install   # 신규 워크스페이스 패키지 링크
pnpm typecheck && pnpm build && pnpm test --run && pnpm test:storage && pnpm lint
```

기대: `@finclaw/gateway` 빌드 성공. vitest `packages/*/src/**/*.test.ts` 글롭이 gateway 테스트 자동 발견 (설정 변경 0). unit 1679 유지 (gateway 20 + server-재배치 2 = 기존 22 동일).

---

## 밀스톤 E — 검증 + smoke 게이트

**목표(plan):** 전체 스위트 green, lint clean, gateway→server sibling import 0 재확인. 실 키 부팅 smoke (사용자 액션).

커밋: 없음 (검증 전용 — D 가 마지막 코드 커밋). 필요 시 `docs(phase39): note boot smoke result` 만.

### E1. 전체 그린 + 카운트 확인

```
pnpm typecheck && pnpm build && pnpm test --run && pnpm test:storage && pnpm lint
```

- `pnpm test --run` → unit **1679** (재배치만, 증감 0).
- `pnpm lint` (oxlint) clean. stub/empty-file 규칙 위반 없음.

### E2. **grep 가드 — gateway → server import 0** (완료조건 #1)

`packages/gateway/` 에서 `@finclaw/server` 또는 server 상대경로 참조 0 확인:

```
grep -rn "@finclaw/server" packages/gateway/src
#   → 0 줄
grep -rn "from '\.\./\.\./\.\./" packages/gateway/src --include='*.ts'
#   → 0 줄 (이동 후엔 server src root 가 더이상 ../../../ 로 닿지 않음 — 패키지 분리됨)
```

> 통과 시: gateway 가 하위 패키지(types/infra/agent/storage) + 외부(ws/zod/chokidar)만 의존. 순환 없음.

### E3. createGatewayServer 시그니처 불변 확인 (완료조건 #3)

`packages/gateway/src/server.ts:76` 의 `createGatewayServer(config, deps)` 시그니처가 phase38 base 와 동일(파라미터·반환). `git show 6a408b7:packages/server/src/gateway/server.ts | grep -A3 "export function createGatewayServer"` 와 비교 — `GatewayServerDeps.adapter` 타입만 `RunnerExecutionAdapter`→`ChatExecutionPort`(구조 동등) 변경, 그 외 불변.

### E4. ⚠️ 실 키 부팅 smoke (사용자 수동 — 자동 커버 불가, 완료조건 #4)

**구현자/자동화 불가. 키 보유 사용자가 수동 실행:**

```
pnpm dev    # = tsx packages/server/src/main.ts
```

확인 항목:

- `Gateway listening` (또는 `gateway:start` 이벤트) 로그 출력.
- Discord 봇 온라인 전환.
- 스케줄러 기동 (news-brief cron seed 로그).

> plan §2·E: **추출 전 1회 + 후 1회** 권장 (base `6a408b7` 에서 1회, D 머지 후 1회 — 동작 동등 확인). review.md 에 결과(또는 미실시 리스크)를 #1 미검증 리스크로 명시.

---

## 최종 검증 (완료조건 전수)

1. ☐ gateway/ → `@finclaw/gateway` 분리, **gateway → server sibling import 0** (E2 grep 가드 통과).
2. ☐ `pnpm typecheck` + `pnpm build` + `pnpm test --run`(1679) + `pnpm test:storage` + `pnpm lint` 모두 green.
3. ☐ 동작·로그·API 불변 (createGatewayServer 시그니처 유지 — E3).
4. ☐ 실 키 부팅 smoke 게이트 결과 review.md 명시 (E4 — 사용자 수동).

---

## 롤백 절차

각 밀스톤 = 독립 커밋 (A/B/C/D). 역순 `git revert`:

- D revert → gateway 가 server/src/gateway 로 복귀 (패키지 배선 원복). C~A 는 하위 패키지에 심볼 잔존하나 동작 영향 없음.
- C revert → port 역전 원복 (gateway type import 가 server sibling 으로 복귀).
- B revert → loadAgents 복원.
- A revert → cron/dispatcher/message-utils 가 server 로 복귀 (단 infra/agent 의 신규 export 는 미사용 잔존 — 후속 정리).

> ⚠️ D 는 `git mv` + 패키지 신설이라 revert 시 `pnpm install` 재실행 필요. A~C 가 각각 green 커밋이므로 중간 지점 복귀 안전.

---

## 변경 LOC 추정 (순수 추출 — 신규 로직 0)

| 밀스톤 | 이동(mv)                                                    | 신규 CREATE                                                      | EDIT                                                                                                  | DELETE     | 순증감      |
| ------ | ----------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| A      | cron.ts/test(~270), dispatcher(62)+test, message 3심볼(~60) | infra/cron+test, agent/tool-dispatcher+test, agent/message-utils | execution-adapter(import+reexport), scheduler, schedule-rpc, skills, gateway/agent+schedule, 2 barrel | 원본 4파일 | ~0 (재배치) |
| B      | —                                                           | —                                                                | gateway/agent.ts(loadAgents 제거 ~30↓), main.ts(+15), 2 test                                          | —          | ~−15        |
| C      | —                                                           | types/gateway-ports.ts(~60 신규 port 정의)                       | agent-memory-hook, 4 server 클래스(implements), 5 gateway 파일, 2 test                                | —          | ~+60        |
| D      | gateway 전체(53 파일), 통합테스트 2                         | gateway package.json/tsconfig/index                              | root tsconfig, server package.json/tsconfig, main.ts/test                                             | —          | ~+40 (배선) |

**총 순수 신규 로직 ≈ port 정의(C, ~60 LOC) + 패키지 배선(D, ~40 LOC) ≈ 100 LOC.** 나머지는 전부 물리 이동·import re-point (동작 불변). 베이스라인 unit 1679 유지.
