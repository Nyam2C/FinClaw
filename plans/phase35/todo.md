# Phase 35 Todo: 백로그 후속 P1 정리 (라우터 AbortSignal/중복 · RPC 레지스트리 격리)

> plan.md 의 2 밀스톤(A: 라우터 AbortSignal + 라우팅 헬퍼 통합 / B: RPC 레지스트리 인스턴스 격리)을 코드 단위로 분해.
>
> **모호함 → `_workspace/phase-execute/35-questions.md`**: 밀스톤 B 는 Q1(blast radius 진행 여부) + Q2(`system.info` 레지스트리 배선 방식) 회신 대기. 밀스톤 A 는 모호함 없음 → 독립 진행 가능. **밀스톤 B 는 Q2 의 추천안(2) 클로저 캡처 기준으로 작성됨** — 다른 안 선택 시 B5/B 검증의 테스트 ctx 단계가 달라짐.

---

## 사전 준비

없음. 신규 의존성·schema bump·패키지 신설 없음. 모든 변경이 기존 `@finclaw/agent`·`@finclaw/server` 내부.

---

## 밀스톤 A — 라우터 AbortSignal 전달 + `routeToChain` 공통 코어 추출

> plan 항목 1+2. 같은 함수(`applyRouting`/`applyTuiRouting`/`routeOrFallback`)를 건드려 이중 편집을 피하려 단일 밀스톤. signal 배선과 중복 제거를 한 번에.
>
> 배선 사슬: `execute`/`executeForTui` 의 `signal` → `routeToChain(msg, tools, logEvent, signal)` → `routeOrFallback(msg, tools, signal)` → `routerLlm({ message, availableToolNames, abortSignal })` → `createLlmRouter` 의 `chatCompletion({ …, abortSignal })`.

### A1. EDIT `packages/agent/src/router/llm-router.ts` — `RouterInput` 에 `abortSignal` 추가 + chatCompletion 배선

`RouterInput` 인터페이스에 옵셔널 필드 추가 (`:26-30`):

```ts
/** 라우터 호출 입력. */
export interface RouterInput {
  readonly message: string;
  /** 현재 세션에서 노출 가능한 전체 도구명 (라우터가 이 중에서 화이트리스트 선택). */
  readonly availableToolNames: ReadonlyArray<string>;
  /** Phase 35: 파이프라인 abort 시 라우터 in-flight HTTP 즉시 취소. provider 가 fetch 에 전달. */
  readonly abortSignal?: AbortSignal;
}
```

`createLlmRouter` 의 `chatCompletion` 호출(`:136-143`)에 `abortSignal` 추가:

```ts
const raw = await provider.chatCompletion({
  model: ROUTER_MODEL_ID,
  systemPrompt,
  messages: [{ role: 'user', content: input.message }],
  maxTokens: 200,
  temperature: 0,
  abortSignal: input.abortSignal, // Phase 35: 라우터 호출도 abort 전파
  // tools 미전달 — 도구 사용 안 함 (분류 전용).
});
```

> 비고: `ProviderRequestParams.abortSignal?: AbortSignal` 는 이미 존재(`adapter.ts:15`) → 순수 배선. 별도 라우터 timeout 도입 X (plan §비대상).

검증: `pnpm --filter @finclaw/agent build`

### A2. EDIT `packages/agent/src/router/__tests__/llm-router.test.ts` — abort 전파 단위 테스트 (mock provider)

mock provider 가 받은 `ProviderRequestParams` 를 `calls` 에 저장하므로(`:9-25`), `abortSignal` 이 chatCompletion 까지 닿는지 검증. 파일 끝 `describe('createLlmRouter', …)` 안에 추가:

```ts
it('Phase 35: input.abortSignal 을 chatCompletion 으로 전달', async () => {
  const { provider, calls } = mockProvider([{ json: { intent: 'greeting', reason: '인사' } }]);
  const router = createLlmRouter(provider);
  const controller = new AbortController();
  await router({ message: '안녕', availableToolNames: [], abortSignal: controller.signal });
  expect(calls[0]?.abortSignal).toBe(controller.signal);
});

it('Phase 35: abortSignal 미전달 시 chatCompletion.abortSignal 도 undefined', async () => {
  const { provider, calls } = mockProvider([{ json: { intent: 'greeting', reason: '인사' } }]);
  const router = createLlmRouter(provider);
  await router({ message: '안녕', availableToolNames: [] });
  expect(calls[0]?.abortSignal).toBeUndefined();
});
```

> mock-only: 실 네트워크 없음. `calls` 캡처로 배선만 검증 (plan 완료조건 "mock provider 가 signal.aborted 확인").

검증: `pnpm --filter @finclaw/agent test --run`

### A3. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — `routeToChain` 공통 헬퍼 추출

`applyRouting`(`:488-524`) 과 `applyTuiRouting`(`:573-613`) 의 중복 코어를 `routeToChain` 으로 단일화. 두 헬퍼는 (a) 메시지 출처, (b) 로그 이벤트명, (c) signal 만 넘겨 위임. 기존 `applyRouting`/`applyTuiRouting`/`routeOrFallback` 블록(`:483-547`) 을 아래로 **대체**:

```ts
  /**
   * Phase 35: applyRouting/applyTuiRouting 의 공통 코어.
   * 라우터 호출(또는 폴백) → chain + floor + allowedToolNames + routerUsage 구성 + 로깅.
   * 메시지·로그 이벤트명·signal 만 호출자가 주입 (이전 두 헬퍼의 유일한 차이).
   * routerLlm 미주입 시 undefined (라우터 비활성, 기존 fallbackChain 동작).
   */
  private async routeToChain(
    message: string,
    toolDefinitions: readonly { readonly name: string }[],
    logEvent: 'pipeline.routed' | 'tui.routed',
    signal: AbortSignal,
  ): Promise<
    | {
        readonly chain: readonly string[];
        readonly floor: ModelTier;
        readonly allowedToolNames: ReadonlyArray<string>;
        readonly routerUsage: { readonly inputTokens: number; readonly outputTokens: number };
      }
    | undefined
  > {
    if (!this.deps.routerLlm) {
      return undefined;
    }
    const toolNames = toolDefinitions.map((t) => t.name);
    const decision = await this.routeOrFallback(message, toolNames, signal);
    this.deps.logger?.info(logEvent, {
      event: logEvent,
      intent: decision.intent,
      tier: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      reason: decision.reason,
      fallback: decision.fallback,
      filteredCount: toolNames.length - decision.allowedToolNames.length,
      routerInputTokens: decision.routerUsage.inputTokens,
      routerOutputTokens: decision.routerUsage.outputTokens,
    });
    const modelId = tierToModelId(decision.modelTier);
    const others = (this.deps.fallbackChain ?? []).filter((m) => m !== modelId);
    return {
      chain: [modelId, ...others],
      floor: decision.modelTier,
      allowedToolNames: decision.allowedToolNames,
      routerUsage: decision.routerUsage,
    };
  }

  /**
   * Phase 34 B-2: LLM 라우터 호출, 실패 시 inferRole 키워드 폴백.
   * Phase 35: signal 을 라우터 호출로 전달 (abort 시 in-flight HTTP 취소).
   */
  private async routeOrFallback(
    message: string,
    availableToolNames: readonly string[],
    signal: AbortSignal,
  ): Promise<RouterDecision> {
    const routerLlm = this.deps.routerLlm;
    if (!routerLlm) {
      return this.keywordFallbackDecision(message, availableToolNames);
    }
    try {
      return await routerLlm({
        message,
        availableToolNames: [...availableToolNames],
        abortSignal: signal,
      });
    } catch (err) {
      this.deps.logger?.warn('router.fallback', {
        event: 'router.fallback',
        reason: toMessage(err),
      });
      return this.keywordFallbackDecision(message, availableToolNames);
    }
  }
```

> `keywordFallbackDecision`(`:550-566`) 은 변경 없음 — 그대로 유지.
> 기존 `applyRouting`(`:488-524`) / `applyTuiRouting`(`:573-613`) 의 두 메서드는 삭제(이 단계에서 `routeToChain` 으로 대체). 호출부는 A4 에서 갱신.

검증: 호출부 갱신(A4) 전까지는 typecheck 미통과 가능 — A4 와 한 묶음으로 본다.

### A4. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — `execute`/`executeForTui` 호출부를 `routeToChain` 으로 + signal 주입

`execute()` 의 라우팅 호출(`:220-223`):

```ts
// Phase 34/35: LLM 라우터 1회 호출 → intent 기반 모델/도구. signal 전달로 abort 시 취소.
const routed = await this.routeToChain(
  ctx.normalizedBody,
  toolDefinitions,
  'pipeline.routed',
  signal,
);
```

`executeForTui()` 의 라우팅 호출(`:400`):

```ts
// Phase 34/35: TUI 도 LLM 라우터 사용 (B-3). signal 전달로 abort 시 취소.
const routed = await this.routeToChain(input.userMessage, toolDefinitions, 'tui.routed', signal);
```

> `execute(ctx, signal)`(`:206`)·`executeForTui(…, signal)`(`:388`) 의 `signal` 인자는 이미 존재 → 그대로 주입. 메인 러너 경로(`abortSignal: signal`, `:256`/`:414`)는 변경 없음.
> 결과 shape(`chain`/`floor`/`allowedToolNames`/`routerUsage`)은 이전 두 헬퍼와 동일 → `exposedTools`·`effectiveChain`·`routed.floor`·`routerUsage` 소비부 전부 무변경.

검증: `pnpm --filter @finclaw/server build` (A3+A4 합쳐 typecheck 통과해야 함)

### A5. EDIT `packages/server/src/auto-reply/__tests__/execution-adapter.test.ts` — abort 전파 회귀 테스트 추가

기존 `mockRouter`(`:496`) 는 호출 인자를 캡처하지 않으므로, 인자 캡처용 라우터를 새로 만들어 `execute`/`executeForTui` 가 자신의 signal 을 라우터로 전달하는지 검증. `describe('RunnerExecutionAdapter + LLM 라우터 (Phase 34)', …)`(`:507`) 블록 끝에 추가:

```ts
it('Phase 35: execute 의 signal 을 라우터로 전달', async () => {
  const { runnerFactory } = makeFakeRunnerFactory([{ role: 'assistant', content: 'ok' }]);
  let seenSignal: AbortSignal | undefined;
  const capturingRouter: LlmRouter = async (input) => {
    seenSignal = input.abortSignal;
    return {
      intent: 'greeting',
      modelTier: 'haiku',
      allowedToolNames: [],
      reason: 'r',
      routerUsage: { inputTokens: 0, outputTokens: 0 },
      fallback: false,
    };
  };
  const adapter = new RunnerExecutionAdapter({
    runnerFactory,
    defaultModel: DEFAULT_MODEL,
    systemPrompt: 'sp',
    routerLlm: capturingRouter,
  });
  const controller = new AbortController();
  await adapter.execute(makePipelineCtx(), controller.signal);
  expect(seenSignal).toBe(controller.signal);
});
```

> 기존 라우팅·로깅 테스트(`:507-567`)는 `routeToChain` 위임 후에도 동작/로그 shape 가 동일하므로 **무변경으로 green** 이어야 함 (plan 완료조건 "기존 라우팅 동작 회귀 없음"). green 이 아니면 A3 의 결과 shape·로그 키를 재확인.

검증: `pnpm --filter @finclaw/server test --run packages/server/src/auto-reply/__tests__/execution-adapter.test.ts`

### A6. EDIT — 형식 정리

```
pnpm format:fix
```

> oxfmt 정렬. lefthook pre-commit(typecheck + format) 통과 준비.

### A7. 밀스톤 A 검증

다음을 모두 통과해야 밀스톤 B 진입:

- `pnpm typecheck`
- `pnpm --filter @finclaw/agent test --run`
- `pnpm --filter @finclaw/server test --run`
- `pnpm --filter @finclaw/agent build`
- `pnpm --filter @finclaw/server build`

> 통과 시 밀스톤 A 단독 커밋 (B 가 과하다 판명되면 A 는 이미 머지 가능 — plan §리스크).
> 커밋 subject ASCII only (feedback): 예 `feat(phase35): router AbortSignal wiring + routeToChain extraction`.

---

## 밀스톤 B — RPC 메서드 레지스트리 인스턴스 격리

> plan 항목 3 (review-3 TODO). 모듈 전역 `const methods = new Map()`(`rpc/index.ts:15`) → `GatewayServerContext` 소속 `MethodRegistry` 인스턴스로 격리.
>
> **blast radius 최대** (method 파일 12개 + 테스트 ~13개). plan §리스크에 따라 진행 여부는 **Q1 회신 확인 후**.
> **`system.info` 의 요청 시점 `getRegisteredMethods()` 배선은 Q2 추천안(2) 클로저 캡처 기준으로 작성.** 다른 안 선택 시 B5/B 검증 테스트 ctx 가 달라짐.
>
> 핵심 전환: `registerMethod` 모듈 전역 호출 → 각 `registerXxxMethods(deps, registry)` 가 인스턴스 레지스트리에 등록. `dispatchRpc`/`handleSingleRequest` 는 이미 인자로 받는 `_serverCtx` 에서 레지스트리 읽음. 두 호출부(router.ts:132, ws/connection.ts:62) 는 이미 ctx 를 넘기므로 무변경.

### B1. EDIT `packages/server/src/gateway/rpc/index.ts` — `MethodRegistry` 클래스 신설 + dispatch 가 serverCtx 레지스트리 사용

모듈 전역 Map + `registerMethod`/`getRegisteredMethods`/`clearMethods`(`:14-33`) 를 `MethodRegistry` 클래스로 대체. `dispatchRpc`/`handleSingleRequest` 는 `_serverCtx.methods` 에서 읽도록 변경:

```ts
import { getEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/index.ts
import type { RpcRequest, RpcResponse } from '@finclaw/types';
import type { GatewayServerContext } from '../context.js';
import { RpcErrors, createError } from './errors.js';
import type {
  JsonRpcBatchRequest,
  RpcMethodHandler,
  RpcContext,
  AuthInfo,
  AuthLevel,
} from './types.js';

/**
 * Phase 35: RPC 메서드 레지스트리. 모듈 전역 Map 을 대체하여 서버 인스턴스별 격리.
 * GatewayServerContext.methods 가 소유. 테스트는 인스턴스를 새로 만들어 격리(clearMethods 우회 불요).
 */
export class MethodRegistry {
  private readonly methods = new Map<string, RpcMethodHandler>();

  register(handler: RpcMethodHandler): void {
    if (this.methods.has(handler.method)) {
      throw new Error(`RPC method already registered: ${handler.method}`);
    }
    this.methods.set(handler.method, handler);
  }

  get(method: string): RpcMethodHandler | undefined {
    return this.methods.get(method);
  }

  /** 등록된 메서드 목록 (system.info 용) */
  list(): string[] {
    return [...this.methods.keys()];
  }
}

/** RPC 요청 디스패치 (단일 또는 배치) */
export async function dispatchRpc(
  request: RpcRequest | JsonRpcBatchRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  serverCtx: GatewayServerContext,
): Promise<RpcResponse | RpcResponse[]> {
  // 배치 요청
  if (Array.isArray(request)) {
    if (request.length === 0) {
      return createError(null, RpcErrors.INVALID_REQUEST, 'Empty batch');
    }
    if (request.length > serverCtx.config.rpc.maxBatchSize) {
      return createError(
        null,
        RpcErrors.INVALID_REQUEST,
        `Batch size ${request.length} exceeds limit ${serverCtx.config.rpc.maxBatchSize}`,
      );
    }
    return Promise.all(request.map((req) => handleSingleRequest(req, ctx, serverCtx)));
  }

  return handleSingleRequest(request as RpcRequest, ctx, serverCtx);
}

/** 단일 RPC 요청 처리 */
async function handleSingleRequest(
  request: RpcRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  serverCtx: GatewayServerContext,
): Promise<RpcResponse> {
  // 1. jsonrpc 버전 검증
  if (request.jsonrpc !== '2.0') {
    return createError(request.id, RpcErrors.INVALID_REQUEST, 'Invalid JSON-RPC version');
  }

  // 2. 메서드 조회 (Phase 35: 인스턴스 레지스트리)
  const handler = serverCtx.methods.get(request.method);
  if (!handler) {
    return createError(request.id, RpcErrors.METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
  }

  // 3. 이벤트 발행
  getEventBus().emit('gateway:rpc:request', request.method, ctx.connectionId ?? 'http');

  // 4. 인증 레벨 확인
  if (!hasRequiredAuth(ctx.auth, handler.authLevel)) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.UNAUTHORIZED);
    return createError(request.id, RpcErrors.UNAUTHORIZED, 'Insufficient permissions');
  }

  // 5. 파라미터 스키마 검증 (Zod v4)
  const parseResult = handler.schema.safeParse(request.params ?? {});
  if (!parseResult.success) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.INVALID_PARAMS);
    return createError(
      request.id,
      RpcErrors.INVALID_PARAMS,
      `Invalid params: ${parseResult.error?.message}`,
    );
  }

  // 6. 핸들러 실행
  try {
    const rpcCtx: RpcContext = { ...ctx, requestId: request.id };
    const result = await handler.execute(parseResult.data, rpcCtx);
    return { jsonrpc: '2.0', id: request.id, result };
  } catch (error) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.INTERNAL_ERROR);
    return createError(request.id, RpcErrors.INTERNAL_ERROR, (error as Error).message);
  }
}

/** 필요한 인증 레벨 충족 여부 */
export function hasRequiredAuth(auth: AuthInfo, required: AuthLevel): boolean {
  const levels: AuthLevel[] = ['none', 'api_key', 'token', 'session'];
  return levels.indexOf(auth.level) >= levels.indexOf(required);
}
```

> 변경 요약: `registerMethod`/`getRegisteredMethods`/`clearMethods` 전역 함수 + 전역 Map 제거. `MethodRegistry` 클래스로 캡슐화(`register`/`get`/`list`). `handleSingleRequest` 의 `methods.get` → `serverCtx.methods.get`. review-3 TODO 주석(`:14`, `:98`) 둘 다 제거 (격리 완료).
> `RpcContext` 타입은 **무변경** (Q2 추천안(2) — `system.info` 는 클로저로 레지스트리 닿음, serverCtx 를 rpcCtx 에 넣지 않음).

검증: 호출부 갱신(B2~B6) 전까지 typecheck 미통과 — 밀스톤 B 전체를 한 묶음으로 본다.

### B2. EDIT `packages/server/src/gateway/context.ts` — `GatewayServerContext` 에 `methods` 추가

```ts
// packages/server/src/gateway/context.ts
import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';
import type { AuthRateLimiter } from './auth/rate-limit.js';
import type { GatewayBroadcaster } from './broadcaster.js';
import type { ChatRegistry } from './registry.js';
import type { MethodRegistry } from './rpc/index.js';
import type { GatewayServerConfig, WsConnection } from './rpc/types.js';

/**
 * 게이트웨이 서버 전체의 공유 상태를 한 곳에 모은 DI 컨테이너.
 * 모듈 전역 Map/Registry를 제거하고 테스트 격리를 보장한다.
 */
export interface GatewayServerContext {
  readonly config: GatewayServerConfig;
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  readonly connections: Map<string, WsConnection>;
  readonly registry: ChatRegistry;
  /** Phase 35: RPC 메서드 레지스트리 (모듈 전역 Map 격리). */
  readonly methods: MethodRegistry;
  readonly broadcaster: GatewayBroadcaster;
  isDraining: boolean;
  /** Phase 29 E1: 요청 수준 IP rate limiter (없으면 비활성화) */
  readonly rateLimiter?: import('./rate-limit.js').RequestRateLimiter;
  /** Phase 29 E3: HTTP 액세스 로거 (없으면 비활성화) */
  readonly accessLogger?: ReturnType<typeof import('./access-log.js').createAccessLogger>;
  /** Phase 29 E4: auth 실패 IP rate limiter (없으면 비활성화) */
  readonly authRateLimiter?: AuthRateLimiter;
}
```

검증: `pnpm typecheck` (B 전체 묶음 후)

### B3. EDIT `packages/server/src/gateway/rpc/methods/*.ts` (system 제외) — `registerXxxMethods` 가 레지스트리 인자 수신

각 method 파일에서 (a) `import { registerMethod } from '../index.js'` 제거(또는 `MethodRegistry` 타입만 import), (b) `registerXxxMethods(deps)` 시그니처에 `registry: MethodRegistry` 추가, (c) 내부 `registerMethod(handler)` → `registry.register(handler)` 로 치환.

**대상 11개 파일** (system.ts 는 B5 에서 별도 — `getRegisteredMethods` 때문):

| 파일            | register 함수              | registerMethod 호출 수 |
| --------------- | -------------------------- | ---------------------- |
| `audit.ts`      | `registerAuditMethods`     | 1                      |
| `brokerage.ts`  | `registerBrokerageMethods` | 2                      |
| `agent-runs.ts` | `registerAgentRunsMethods` | 2                      |
| `agent.ts`      | `registerAgentMethods`     | 3                      |
| `chat.ts`       | `registerChatMethods`      | 1 (루프)               |
| `config.ts`     | `registerConfigMethods`    | 3                      |
| `finance.ts`    | `registerFinanceMethods`   | 9                      |
| `session.ts`    | `registerSessionMethods`   | 1 (루프)               |
| `schedule.ts`   | `registerScheduleMethods`  | 9                      |
| `trace.ts`      | `registerTraceMethods`     | 2                      |
| `memory.ts`     | `registerMemoryMethods`    | 4                      |

패턴 (예: `audit.ts`):

```ts
// import { registerMethod } from '../index.js';  ← 제거
import type { MethodRegistry } from '../index.js';

// ... 핸들러 정의 그대로 ...

export function registerAuditMethods(deps: AuditRpcDeps, registry: MethodRegistry): void {
  // ... 핸들러 빌드 그대로 ...
  registry.register(listHandler); // 이전: registerMethod(listHandler)
}
```

루프형(`chat.ts:174-176`, `session.ts:90-92`) 패턴:

```ts
export function registerChatMethods(deps: ChatMethodsDeps, registry: MethodRegistry): void {
  for (const handler of createChatMethods(deps)) {
    registry.register(handler); // 이전: registerMethod(handler)
  }
}
```

다중형(`finance.ts:586-594`, `schedule.ts:386-394`, `config.ts:53-55`, `agent.ts:478-480`, `memory.ts:245-248`, `trace.ts:83-84`, `agent-runs.ts:135-136`, `brokerage.ts:66-67`): 동일하게 `registry.register(...)` 로 일괄 치환 + 시그니처에 `registry` 추가.

> 인자 순서는 기존 `deps` **뒤에** `registry` 추가 (호출부 B6 에서 일관 적용).
> `agent.ts` 의 `resetAgentStats`/`resetAgentsCache`(`:97`/`:153`) 는 plan §비대상(통계 Map 격리는 별건) → **무변경**.

검증: `pnpm typecheck` (B 전체 묶음 후)

### B4. EDIT `packages/server/src/gateway/index.ts` — 배럴 export 갱신

기존 `export { dispatchRpc, registerMethod, hasRequiredAuth } from './rpc/index.js';`(`:38`) 에서 제거된 `registerMethod` 빼고, 신규 `MethodRegistry` 추가:

```ts
// ... 기존 export ...
export { dispatchRpc, hasRequiredAuth, MethodRegistry } from './rpc/index.js';
```

> `registerMethod` 는 더 이상 export 안 함 (클래스 메서드로 캡슐화). 외부 소비자 없음(grep 상 gateway 내부 + 테스트만 사용).

검증: `pnpm typecheck`

### B5. EDIT `packages/server/src/gateway/rpc/methods/system.ts` — 레지스트리 클로저 캡처 (Q2 추천안 2)

`system.info` 의 `getRegisteredMethods()` 가 요청 시점 호출이므로, `infoHandler` 를 `registerSystemMethods` 안에서 생성해 `registry.list()` 를 클로저로 캡처:

```ts
// packages/server/src/gateway/rpc/methods/system.ts
import { z } from 'zod/v4';
import { loadVersion } from '../../version.js';
import type { MethodRegistry } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

// -- system.health -- (모듈 레벨 유지: registry 불요)
const healthHandler: RpcMethodHandler<
  Record<string, never>,
  { status: 'ok' | 'degraded' | 'error'; uptime: number; memoryMB: number }
> = {
  method: 'system.health',
  description: '서버 상태를 확인합니다',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  },
};

// -- system.ping -- (모듈 레벨 유지)
const pingHandler: RpcMethodHandler<Record<string, never>, { pong: true; timestamp: number }> = {
  method: 'system.ping',
  description: 'Ping-pong 연결 확인',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return { pong: true, timestamp: Date.now() };
  },
};

/** system.* 메서드 일괄 등록. Phase 35: system.info 가 registry.list() 를 클로저로 캡처. */
export function registerSystemMethods(registry: MethodRegistry): void {
  const infoHandler: RpcMethodHandler<
    Record<string, never>,
    { name: string; version: string; methods: string[]; capabilities: string[] }
  > = {
    method: 'system.info',
    description: '서버 버전 및 기능 정보를 반환합니다',
    authLevel: 'none',
    schema: z.object({}),
    async execute() {
      return {
        name: 'finclaw-gateway',
        version: loadVersion(),
        methods: registry.list(), // Phase 35: 인스턴스 레지스트리 (이전: getRegisteredMethods())
        capabilities: ['streaming', 'batch', 'subscriptions'],
      };
    },
  };
  registry.register(healthHandler);
  registry.register(infoHandler);
  registry.register(pingHandler);
}
```

> health/ping 은 registry 의존이 없어 모듈 레벨 유지(외과적). info 만 클로저 안으로 이동.
> `getRegisteredMethods` import 제거됨 — 더 이상 존재하지 않는 export.

검증: `pnpm typecheck`

### B6. EDIT `packages/server/src/gateway/server.ts` — ctx 에 `methods` 생성 + 등록부에 registry 주입

import 에 `MethodRegistry` 추가, ctx 빌드에 `methods` 인스턴스, 등록부 12줄에 registry 인자 추가.

import 추가 (`:24` 부근):

```ts
import { ChatRegistry } from './registry.js';
import { handleHttpRequest } from './router.js';
import { MethodRegistry } from './rpc/index.js'; // Phase 35
```

ctx 빌드(`:110-122`):

```ts
// DI 컨테이너
const ctx: GatewayServerContext = {
  config,
  httpServer,
  wss,
  connections: new Map(),
  registry: new ChatRegistry(config.auth.sessionTtlMs),
  methods: new MethodRegistry(), // Phase 35: 인스턴스별 RPC 메서드 레지스트리
  broadcaster: new GatewayBroadcaster(),
  isDraining: false,
  rateLimiter,
  accessLogger,
  authRateLimiter,
};
```

등록부(`:134-171`) — 각 호출 끝에 `ctx.methods` 추가:

```ts
// RPC 메서드 등록 (ctx가 생성된 후 deps + registry 주입)
registerSystemMethods(ctx.methods);
registerConfigMethods(ctx.methods);
registerChatMethods(
  {
    registry: ctx.registry,
    connections: ctx.connections,
    broadcaster: ctx.broadcaster,
    storage: deps.storage,
    defaultModel: deps.defaultModel,
    adapter: deps.adapter,
    logger: deps.agentDeps?.logger,
  },
  ctx.methods,
);
registerFinanceMethods(
  { ...deps.financeDeps, broadcaster: ctx.broadcaster, connections: ctx.connections },
  ctx.methods,
);
registerSessionMethods({ registry: ctx.registry, storage: deps.storage }, ctx.methods);
registerMemoryMethods(deps.memoryDeps ?? {}, ctx.methods);
registerAgentRunsMethods({ db: deps.agentDeps?.db ?? deps.financeDeps?.db }, ctx.methods);
registerTraceMethods({ db: deps.agentDeps?.db ?? deps.financeDeps?.db }, ctx.methods);
registerAuditMethods({ db: deps.agentDeps?.db ?? deps.financeDeps?.db }, ctx.methods);
if (deps.agentDeps) {
  registerAgentMethods(deps.agentDeps, ctx.methods);
}
registerScheduleMethods(deps.scheduleDeps ?? {}, ctx.methods);
registerBrokerageMethods(deps.brokerageDeps ?? {}, ctx.methods);
```

> 등록은 이미 ctx 생성 **후** 이므로 `ctx.methods` 선존재 보장. 순서·주석 의도는 보존(외과적). `registerConfigMethods`/`registerSystemMethods` 는 deps 없음 → registry 만 인자.

검증: `pnpm typecheck`

### B7. EDIT 테스트들 — `clearMethods()` 전역 우회 제거 + 인스턴스 레지스트리 배선

전역 `clearMethods`/`registerMethod` 가 사라지므로, 테스트는 매 케이스 `new MethodRegistry()` 를 만들어 (a) `register*Methods(deps, registry)` 로 등록, (b) `makeServerCtx()` 가 그 registry 를 `ctx.methods` 에 담아 `dispatchRpc` 로 전달.

**대상 테스트 파일** (grep 기준):

- `gateway/rpc/index.test.ts` — `registerMethod`/`getRegisteredMethods`/`clearMethods` 직접 사용. → `MethodRegistry` 인스턴스 메서드(`register`/`list`)로 재작성, `dispatchRpc` 에 넘기는 serverCtx 의 `methods` 에 동일 인스턴스 주입.
- `gateway/router.test.ts` — `clearMethods` + `registerMethod` 사용.
- `gateway/server.test.ts` — `clearMethods` 사용 (격리 후 제거).
- `gateway/ws/connection.test.ts` — `clearMethods` + `registerMethod` 사용.
- `main.test.ts` — `clearMethods` 사용 (제거).
- `gateway/rpc/methods/*.test.ts` 8개 (`agent-runs`/`agent`/`finance`/`chat`/`memory`/`system`/`session` + `index`) — 각 `makeServerCtx()` 가 `methods` 누락 → 추가, `beforeEach` 의 `clearMethods()` → `registry = new MethodRegistry()` 로, `register*Methods(deps)` → `register*Methods(deps, registry)`.

대표 패턴 (`makeServerCtx` 에 registry 매개 + register 배선). 예 `system.test.ts`:

```ts
import { dispatchRpc, MethodRegistry } from '../index.js';
// import { clearMethods } 제거

function makeServerCtx(methods: MethodRegistry): GatewayServerContext {
  const config: GatewayServerConfig = {
    /* ...기존... */
  };
  return {
    config,
    httpServer: {} as GatewayServerContext['httpServer'],
    wss: {} as GatewayServerContext['wss'],
    connections: new Map(),
    registry: { activeCount: () => 0 } as GatewayServerContext['registry'],
    methods, // Phase 35
    broadcaster: {} as GatewayServerContext['broadcaster'],
    isDraining: false,
  };
}

describe('system.* RPC methods', () => {
  let methods: MethodRegistry;
  beforeEach(() => {
    methods = new MethodRegistry();
    resetEventBus();
    registerSystemMethods(methods);
  });

  it('returns ok status ...', async () => {
    const result = await dispatchRpc(
      { jsonrpc: '2.0', id: 1, method: 'system.health', params: {} },
      baseCtx,
      makeServerCtx(methods),
    );
    // ...기존 assertions 그대로...
  });
});
```

`index.test.ts` (전역 함수 직접 테스트) 패턴:

```ts
import { dispatchRpc, MethodRegistry } from './index.js';

let methods: MethodRegistry;
beforeEach(() => {
  methods = new MethodRegistry();
  resetEventBus();
});

it('register + list', () => {
  methods.register(handler);
  expect(methods.list()).toContain('test.echo');
});

it('중복 등록 throw', () => {
  methods.register(handler);
  expect(() => methods.register(handler)).toThrow('already registered');
});
// dispatchRpc 호출하는 케이스: makeServerCtx(methods) 로 동일 인스턴스 주입
```

> 각 method 테스트의 `call(...)`/`dispatchRpc(...)` 헬퍼가 `makeServerCtx()` 를 인자 없이 호출하던 곳 → `makeServerCtx(methods)` 로. `clearMethods` import/호출 전부 제거. `getRegisteredMethods` 직접 호출(index.test.ts) → `methods.list()`.
> plan 완료조건: "테스트가 clearMethods() 전역 우회 없이 격리됨" — 이 단계가 그 조건 충족.

검증: `pnpm --filter @finclaw/server test --run`

### B8. EDIT — 형식 정리

```
pnpm format:fix
```

### B9. 밀스톤 B 검증

다음을 모두 통과:

- `pnpm typecheck`
- `pnpm --filter @finclaw/server test --run` (전체 server 테스트 — clearMethods 우회 제거 후 전부 green)
- `pnpm --filter @finclaw/server build`
- grep 검증: `grep -rn "clearMethods\|registerMethod\b\|getRegisteredMethods" packages/server/src/` 결과 0건 (전역 잔재 없음)

> 통과 시 밀스톤 B 단독 커밋. subject 예: `feat(phase35): isolate RPC method registry per server instance`.

---

## 최종 검증

phase 전체 완료 후 다음 모두 통과 (plan 완료 조건):

- [ ] `pnpm typecheck`
- [ ] `pnpm test --run`
- [ ] `pnpm test:storage`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] mock-only 격리: API 키 unset 상태에서 `pnpm test --run` 통과 (밀스톤 A 의 abort 테스트 포함 — 실 네트워크 없음)
- [ ] 완료조건 매핑:
  - 라우터 경로 AbortSignal 전달 — A2(llm-router) + A5(execution-adapter) abort 테스트 green
  - `routeToChain` 위임, 라우팅 회귀 없음 — A5 기존 테스트 green
  - RPC 레지스트리 인스턴스 격리 — B9 grep 0건 + server 테스트 green (clearMethods 우회 제거)

---

## 롤백 절차

각 밀스톤이 독립 커밋 → 단계적 롤백:

- 밀스톤 B 롤백: `git revert {sha-B}` — RPC 레지스트리 격리만 되돌림. A(라우터/리팩)는 유지.
- 밀스톤 A 롤백: `git revert {sha-A}` (B 가 A 에 의존하지 않으므로 단독 가능. 단 B 가 머지됐으면 `git revert {sha-B} {sha-A}` 순서).
- 전체 phase 롤백: `git revert {sha-B} {sha-A}`.

> storage/마이그레이션 변경 없음 → SCHEMA_VERSION 처리 불요.
> plan §리스크: B 가 과하면 **A 만 커밋·머지, B 는 미착수**로 phase 종료 가능 (A 는 B 에 비의존).

---

## 분해 self-check

- [x] 모든 밀스톤 독립 커밋 가능 (A↔B 비의존; B 롤백해도 A 무영향)
- [x] 각 밀스톤 끝 검증 단계 (A7, B9)
- [x] CREATE 단계 없음 (전부 EDIT) — 신규 파일 불요
- [x] EDIT 단계가 변경 위치(라인) 명시
- [x] plan 비요구 변경 없음: KR RAG / server 분할 / truncate 동적화 / 라우터 timeout / agent.ts 통계 Map — 전부 미포함 (CLAUDE.md §3)
- [x] 외부 API 의존 테스트 mock (A2/A5 — calls 캡처, 실 네트워크 X)
- [x] 마이그레이션 없음 → 시뮬레이션 단계 불요
- [x] 롤백 절차 명시
- [x] 모호함 questions.md 분리: Q1(B blast radius 진행), Q2(system.info 레지스트리 배선) — 추측 없이 분리. **밀스톤 B 는 Q2 추천안(2) 기준 작성** → 다른 안 회신 시 B5/B7 ctx 조정 필요
