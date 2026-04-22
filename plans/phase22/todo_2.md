# Phase 22 Plan 2 — Todo (미사용 코드 활성화)

## 개요

`plan_2.md`의 Category 1~4 중 plan.md와 중복되지 않는 순수 기여분을 실행 단위로 분해했다. 목표는 **"버리는 코드 없이 인프라 활성화"**. plan.md(Todo 1~10)는 이미 완료됐으므로 여기서는 다루지 않는다.

**신규 2개 + 수정 ~10개 = 약 10~12개 파일, ~200 LOC**

### 실행 순서

```
Todo 1 (Category 4 예외: validateConfigStrict 부팅 전환)    — 독립, 최소
Todo 2 (Category 2.3: Port conflict 진단 UX)                — 독립
Todo 3 (Category 1.1: ChannelDock 자동 등록)                — 독립
Todo 4 (Category 3: auto-reply/index.ts 공개 범위 축소)      — 독립
Todo 5 (Category 2.1: runWithModelFallback 래핑)            — 독립, 가장 큰 변경
Todo 6 (Category 2.2a: ProfileHealthMonitor 단일 키 기록)    — Todo 5 완료 권장
Todo 7 (Category 4: @internal 문서화)                        — 독립, cleanup
Todo 8 (선택: !finclaw status 확장)                          — Todo 3·5·6 완료 후
```

권장: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8** 순. 각 Todo 끝에 `pnpm build && pnpm typecheck && pnpm test` 로 회귀 확인.

### 각 Todo 정지 조건

- **1 후**: `.env`의 `GATEWAY_PORT=abc` 같은 잘못된 타입 주입 시 부팅 실패 + `ConfigValidationError` 명확히 출력
- **2 후**: 다른 프로세스가 `GATEWAY_PORT` 점유 중일 때 stderr에 `port 3000 occupied by PID 12345 (node ...)` 표시
- **3 후**: 서버 기동 로그에 `channels: registered 2 docks (discord, http-webhook)` 라인, `getAllChannelDocks().length === 2`
- **4 후**: 테스트·외부 진입점에서 사용하지 않는 stage 내부 심볼이 auto-reply 패키지 공개 API에서 사라짐
- **5 후**: Anthropic 잘못된 키 주입 시 부팅은 되고, DM 요청 시 로그에 `model:fallback ... exhausted` 이벤트 기록
- **6 후**: 정상 호출 후 `profileHealth.getState(default)` 가 `'healthy'`, 강제 에러 후 `'unhealthy'` 또는 `'disabled'`
- **7 후**: 테스트 전용 심볼에 JSDoc `@internal` 추가, 이름 충돌 없음
- **8 후**: Discord DM `!finclaw status` 응답에 "지원 채널: discord, http-webhook / 현재 모델: claude-sonnet-4-6 / 최근 API 에러율: 0%" 추가

---

## Todo 1: `validateConfig` → `validateConfigStrict` 부팅 전환

### 파일 목록

| 작업 | 파일 경로                           | LOC |
| ---- | ----------------------------------- | --- |
| 수정 | `packages/server/src/main.ts`       | +5  |
| 확인 | `packages/config/src/validation.ts` | 0   |

### 주의사항

- 현재 `main.ts`는 `FinClawConfig`에 대해 **Zod 검증을 거의 하지 않고** 빈 객체로 시작한다(`const routerConfig: FinClawConfig = {};` main.ts:227). 이건 config 레이어가 아직 경유 안 됨. plan_2의 이 Todo는 "config 검증을 실제 부팅 경로에 붙이기" 성격도 포함.
- `validateConfigStrict`는 실패 시 `ConfigValidationError` throw → `main()` catch에서 `MissingEnvError`처럼 분기해서 사람 읽기 쉬운 메시지로 출력.
- 잘못된 env가 없다면 기존 동작과 동일하게 통과해야 한다 (회귀 금지).
- 현재는 `FinClawConfig`를 직접 경유하지 않으므로, **1단계**로 env 기반 숫자 파싱 지점만 strict 검증하는 최소 조치도 가능. 여기선 **full config 경로 도입 전** 단계로, env 값 중 strict하게 쓸 것만 뽑아서 `validateConfigStrict`의 부분 경로를 적용.

### 구현 코드

#### `packages/server/src/main.ts` (requireEnv 사용부 인근)

```typescript
import { validateConfigStrict, ConfigValidationError } from '@finclaw/config';

// main() 상단, env 검증 직후
const gatewayPortRaw = process.env.GATEWAY_PORT;
const gatewayPort = gatewayPortRaw ? Number(gatewayPortRaw) : defaultConfig.port;

// 최소 구성으로 strict 검증 (config 전면 도입 전 과도기)
try {
  validateConfigStrict({
    gateway: { host: defaultConfig.host, port: gatewayPort },
  });
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error('[fatal] Invalid configuration:');
    for (const issue of err.issues) {
      console.error(`  - ${issue.path}: ${issue.message}`);
    }
    process.exit(1);
  }
  throw err;
}

// 이후 gatewayConfig 조립 시 gatewayPort 사용
const gatewayConfig: GatewayServerConfig = {
  ...defaultConfig,
  port: gatewayPort,
  auth: {
    ...defaultConfig.auth,
    apiKeys: process.env.FINCLAW_API_KEY ? [process.env.FINCLAW_API_KEY] : [],
  },
};
```

### 검증

- `.env`에 `GATEWAY_PORT=abc` 설정 후 `pnpm dev` → stderr에 `[fatal] Invalid configuration: gateway.port: Expected number` 후 exit code 1
- `GATEWAY_PORT=3001` 설정 → 정상 기동 + `Gateway listening on 0.0.0.0:3001`
- 기존 테스트 전부 통과 (`packages/server/src/__tests__/main.test.ts` 포함)

---

## Todo 2: Port Conflict 진단 메시지 보강

### 파일 목록

| 작업 | 파일 경로                             | LOC |
| ---- | ------------------------------------- | --- |
| 수정 | `packages/server/src/main.ts`         | +15 |
| 확인 | `packages/infra/src/ports-inspect.ts` | 0   |
| 확인 | `packages/infra/src/ports.ts`         | 0   |

### 주의사항

- 현재 `assertPortAvailable(gatewayConfig.port)` 실패 시 단순 `PortInUseError` throw → 상위 catch에서 `Failed to start gateway server:` 로 출력 (main.ts:268). 어떤 프로세스가 점유 중인지 정보 없음.
- `inspectPortOccupant`는 Linux/macOS는 `lsof`, Windows는 `netstat`를 execFile로 호출 → 권한/바이너리 부재 시 `undefined` 반환. 따라서 **실패해도 파이프라인 끊김 없음**.
- 개발 모드(`NODE_ENV !== 'production'`)에서 `findAvailablePort`로 자동 대체는 plan_2.md에 "선택"으로 남았다. **기본 범위 외**로 제외 — 경고 메시지 보강만 시행.

### 구현 코드

#### `packages/server/src/main.ts` (assertPortAvailable 호출부)

```typescript
import {
  assertPortAvailable,
  PortInUseError,
  inspectPortOccupant,
  formatPortOccupant,
  ConcurrencyLaneManager,
  createLogger,
  getEventBus,
} from '@finclaw/infra';

// 기존 `await assertPortAvailable(gatewayConfig.port);` 교체
try {
  await assertPortAvailable(gatewayConfig.port);
} catch (err) {
  if (err instanceof PortInUseError) {
    const occupant = await inspectPortOccupant(gatewayConfig.port);
    console.error(formatPortOccupant(gatewayConfig.port, occupant));
    process.exit(1);
  }
  throw err;
}
```

### 검증

- `python3 -m http.server 3000 &` 로 3000 점유 → `pnpm dev` → stderr에 `port 3000 occupied by PID <num> (python3 ...)` 출력 후 exit 1
- 점유 없으면 정상 기동 (회귀 없음)
- 권한 부족으로 lsof 실패 시 `unable to determine occupant` 메시지 (soft fail)

---

## Todo 3: ChannelDock 자동 등록

### 파일 목록

| 작업 | 파일 경로                                  | LOC                |
| ---- | ------------------------------------------ | ------------------ |
| 신규 | `packages/server/src/channels/init.ts`     | +20                |
| 수정 | `packages/server/src/channels/index.ts`    | +3                 |
| 수정 | `packages/server/src/channels/registry.ts` | 0 (TODO 주석 제거) |
| 수정 | `packages/server/src/main.ts`              | +4                 |

### 주의사항

- `registry.ts` 주석 TODO: "CORE_DOCKS(dock.ts)를 부팅 시 자동 등록하는 코드 필요. initChannels() 등에서 호출." ← 이 Todo로 해소.
- `dock.ts`에 이미 `DISCORD_DOCK`, `HTTP_WEBHOOK_DOCK` 같은 사전 정의 도크가 있는지 먼저 확인. 없다면 `createChannelDock`으로 만드는 로직도 init.ts에 포함.
- 중복 등록 방지: `registerChannelDock`이 `docks.has(id)` 확인 후 throw하는지 체크. 이미 `registry.ts`에 구현돼 있으므로 `initChannels()`를 두 번 호출하면 실패 → 부팅에 한 번만 호출되는 위치(main.ts:134 Agent 레이어 직전) 선택.
- `registerChannelDock`, `getChannelDock`, `hasChannelDock`, `getAllChannelDocks`는 **레지스트리 모듈 수준 전역 상태**를 쓴다. 테스트 격리 필요 시 `resetChannelRegistry` 같은 이미 있는 리셋 유틸 활용 (없으면 본 Todo 범위 밖).

### 구현 코드

#### `packages/server/src/channels/init.ts` (신규)

```typescript
// packages/server/src/channels/init.ts
import { registerChannelDock, getAllChannelDocks } from './registry.js';
import { DISCORD_DOCK, HTTP_WEBHOOK_DOCK } from './dock.js';
import type { FinClawLogger } from '@finclaw/infra';

/**
 * 부팅 시 1회 호출해 내장 채널 도크를 레지스트리에 등록한다.
 * 순서: discord → http-webhook. 중복 호출은 registerChannelDock에서 throw.
 */
export function initChannels(logger: FinClawLogger): void {
  registerChannelDock(DISCORD_DOCK);
  registerChannelDock(HTTP_WEBHOOK_DOCK);
  const ids = getAllChannelDocks().map((d) => d.id);
  logger.info(`channels: registered ${ids.length} docks (${ids.join(', ')})`);
}
```

#### `packages/server/src/channels/index.ts`

```typescript
export { initChannels } from './init.js';
export { getChannelDock, getAllChannelDocks, hasChannelDock } from './registry.js';
```

#### `packages/server/src/main.ts` (storage.initialize() 직후)

```typescript
import { initChannels } from './channels/index.js';

// storage.initialize() 이후, discordAdapter.setup() 이전
initChannels(logger);
```

### 검증

- `docker logs finclaw-server | grep "channels:"` → `channels: registered 2 docks (discord, http-webhook)` 1줄
- 재기동 후에도 중복 없이 정상
- `deliverResponse`에서 `ctx.channelCapabilities?.maxMessageLength`가 여전히 정상 (본 Todo는 소비자 연결 안 함, 단지 등록만)

### 주의: 도크 정의 파일 사전 확인

`DISCORD_DOCK`·`HTTP_WEBHOOK_DOCK` 상수가 `dock.ts`에 **이미 선언**되어 있는지 먼저 확인:

```bash
grep -n "DISCORD_DOCK\|HTTP_WEBHOOK_DOCK\|CORE_DOCKS" packages/server/src/channels/dock.ts
```

없다면 이 Todo 앞에 **하위 Todo 3a** 삽입: `createChannelDock`으로 2개 도크 상수 신규 생성(~30 LOC).

---

## Todo 4: `auto-reply/index.ts` 공개 범위 축소

### 파일 목록

| 작업 | 파일 경로                                 | LOC |
| ---- | ----------------------------------------- | --- |
| 수정 | `packages/server/src/auto-reply/index.ts` | -30 |

### 주의사항

- **Category 3 — 실제 내부 사용 중. 코드 삭제가 아니라 `index.ts`에서 외부 노출만 축소.**
- 대상 심볼 (index.ts에서 빼야 할 것):
  - `enrichContext`, `CONTROL_TOKENS`, `extractControlTokens`, `formatFinancialNumber`, `splitMessage`
  - `createTypingController`, `normalizeMessage`
  - `commandStage`, `ackStage`, `contextStage`, `executeStage`, `deliverResponse`
  - `DefaultPipelineObserver`, `MockExecutionAdapter`
- **유지해야 할 공개 API**:
  - `AutoReplyPipeline` 클래스, 그 config/deps 타입
  - `CommandRegistry`, `InMemoryCommandRegistry`
  - `ExecutionAdapter` 인터페이스, `RunnerExecutionAdapter`, `RunnerFactory`
  - `ToolCallRecord` 타입 (DeliverStage·storage 양쪽에서 참조)
  - `PipelineMsgContext` 타입, `StubFinanceContextProvider`
  - `FinanceContextProvider` 인터페이스
  - `registerBuiltInCommands`
- 테스트 코드가 직접 stage 함수를 import하는 경우가 있다 → `packages/server/src/auto-reply/stages/xxx.js` 직접 경로로 전환해야 테스트 깨지지 않음.
- **순서**: 먼저 `index.ts` 수정 → `pnpm test` 실행 → 깨진 테스트의 import 경로만 수정 (로직 변경 금지).

### 구현 코드

#### `packages/server/src/auto-reply/index.ts` (공개 API만 남김)

```typescript
// packages/server/src/auto-reply/index.ts
export { AutoReplyPipeline } from './pipeline.js';
export type { AutoReplyConfig, AutoReplyDeps, StageResult } from './pipeline.js';

export type { ExecutionAdapter } from './execution-adapter.js';
export {
  RunnerExecutionAdapter,
  type RunnerFactory,
  type ToolCallRecord,
  type ExecutionResult,
} from './execution-adapter.js';

export { InMemoryCommandRegistry, type CommandRegistry } from './commands/registry.js';
export { registerBuiltInCommands } from './commands/built-in.js';

export { StubFinanceContextProvider } from './pipeline-context.js';
export type { FinanceContextProvider, PipelineMsgContext } from './pipeline-context.js';
```

### 검증

- `pnpm --filter @finclaw/server test` 통과
- 깨진 테스트가 있으면 해당 테스트 파일에서 import 경로만 stage 직접 경로로 변경 (예: `import { normalizeMessage } from '../auto-reply/stages/normalize.js';`)
- 서버 부팅에 영향 없음 (런타임 동작은 동일)

---

## Todo 5: `runWithModelFallback`로 Anthropic 호출 래핑

### 파일 목록

| 작업 | 파일 경로                                             | LOC |
| ---- | ----------------------------------------------------- | --- |
| 수정 | `packages/agent/src/models/catalog-data.ts`           | +3  |
| 수정 | `packages/server/src/auto-reply/execution-adapter.ts` | +50 |
| 수정 | `packages/server/src/main.ts`                         | +10 |

### 주의사항

- **가장 큰 변경**. 현재 구조:
  ```
  RunnerExecutionAdapter.execute
    → runner.execute(params) ← params.model = DEFAULT_MODEL
  ```
  이 부분을 폴백 체인으로 감싼다:
  ```
  runWithModelFallback(config, async (model) => runner.execute({...params, model}), resolve)
  ```
- `runWithModelFallback` 정확한 시그니처는 구현 전에 `packages/agent/src/models/fallback.ts` 직접 확인. 대략 `<T>(config, fn, resolve) => Promise<FallbackResult<T>>`.
- **모델 ID 갱신 (중요)**: `DEFAULT_FALLBACK_CHAIN`의 `'claude-opus-4-6'`은 outdated. 2026-04 기준 최신:
  - Opus: `'claude-opus-4-7'`
  - Sonnet: `'claude-sonnet-4-6'`
  - Haiku: `'claude-haiku-4-5-20251001'`
  - 또한 `main.ts:60`의 `DEFAULT_MODEL.model = 'claude-sonnet-4-5'`도 검토 대상 (plan_2 범위 밖이지만 명시).
- **AbortError는 즉시 전파** (사용자 중단). `rate-limit`·`overloaded`·`server-error`·`timeout`만 폴백 트리거.
- 소비자는 `RunnerExecutionAdapter`의 `execute`와 `executeForTui` 양쪽. `executeForTui`는 TUI 전용이고 세션별 모델을 사용하므로 **이번 Todo는 `execute`에만 적용** (최소 침습).
- 폴백 이벤트(`model:fallback`, `model:exhausted`)는 `getEventBus()`에 발행되므로 별도 로그 코드 없이 관측 가능.

### 구현 코드

#### `packages/agent/src/models/catalog-data.ts`

```typescript
// 기존 DEFAULT_FALLBACK_CHAIN 갱신
export const DEFAULT_FALLBACK_CHAIN = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
] as const;
```

(GPT는 provider 세팅이 없으므로 Anthropic 전용 체인으로 축소. 추가는 phase23+에서.)

#### `packages/server/src/auto-reply/execution-adapter.ts` (execute 내부)

```typescript
import { runWithModelFallback, DEFAULT_FALLBACK_CHAIN } from '@finclaw/agent';
import type { ModelCatalog } from '@finclaw/agent';

// RunnerExecutionAdapterDeps에 추가
export interface RunnerExecutionAdapterDeps {
  readonly runnerFactory: RunnerFactory;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly modelCatalog?: ModelCatalog; // 신규 (없으면 폴백 비활성)
  readonly fallbackChain?: readonly string[]; // 신규 (기본: DEFAULT_FALLBACK_CHAIN)
  // ... 기존 필드 ...
}

// execute 내부, 기존 `const result = await runner.execute(params);` 블록 교체
async execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult> {
  // ... priorMessages, userMessage, dispatcher 준비 (기존과 동일) ...
  const runner = this.deps.runnerFactory(dispatcher);

  const startedAt = Date.now();

  let result;
  if (this.deps.modelCatalog && this.deps.fallbackChain) {
    const fallbackResult = await runWithModelFallback(
      {
        primary: this.deps.defaultModel.model,
        fallbackChain: this.deps.fallbackChain,
      },
      async (model) => {
        const params: AgentRunParams = {
          agentId: this.defaultAgentId,
          sessionKey: ctx.sessionKey,
          model: { ...this.deps.defaultModel, model: model.model },
          systemPrompt: this.deps.systemPrompt,
          messages: [...priorMessages, userMessage],
          tools: toolDefinitions.length > 0 ? [...toolDefinitions] : undefined,
          abortSignal: signal,
        };
        return runner.execute(params);
      },
      (modelId) => this.deps.modelCatalog!.getModel(modelId),
    );
    result = fallbackResult.value;
  } else {
    const params: AgentRunParams = {
      agentId: this.defaultAgentId,
      sessionKey: ctx.sessionKey,
      model: this.deps.defaultModel,
      systemPrompt: this.deps.systemPrompt,
      messages: [...priorMessages, userMessage],
      tools: toolDefinitions.length > 0 ? [...toolDefinitions] : undefined,
      abortSignal: signal,
    };
    result = await runner.execute(params);
  }

  const toolCalls = collectToolCalls(result.messages, startedAt);
  await this.persistHistory(ctx.sessionKey, this.defaultAgentId, result.messages);

  return {
    content: extractAssistantText(result.messages),
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}
```

**위 코드의 정확한 `runWithModelFallback` 인자 구조**는 `packages/agent/src/models/fallback.ts`를 열어 실제 시그니처 확인 후 매핑. `FallbackResult<T>.value` 필드명도 구현 코드 기준으로 맞출 것.

#### `packages/server/src/main.ts`

```typescript
import {
  AnthropicAdapter,
  InMemoryToolRegistry,
  Runner,
  InMemoryModelCatalog,
  BUILT_IN_MODELS,
  DEFAULT_FALLBACK_CHAIN,
} from '@finclaw/agent';

// 4. Agent 레이어 내부, toolRegistry 생성 다음
const modelCatalog = new InMemoryModelCatalog(BUILT_IN_MODELS);

// RunnerExecutionAdapter deps에 추가
const adapter = new RunnerExecutionAdapter({
  runnerFactory,
  defaultModel: DEFAULT_MODEL,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  modelCatalog,
  fallbackChain: DEFAULT_FALLBACK_CHAIN,
  storage,
  toolRegistry,
  logger,
});
```

### 검증

- 정상 키: `pnpm dev` → Discord DM 응답 정상 (회귀 없음)
- 잘못된 `ANTHROPIC_API_KEY`: `.env`의 키를 임의 문자열로 교체 → DM 요청 시 로그에 `model:fallback` 이벤트 기록, 최종 `model:exhausted` + 에러 응답
- `pnpm test` — `runWithModelFallback` 미주입 시 기존 로직(단일 모델)로 동작하는 경로 회귀 확인

### 리스크

- `InMemoryModelCatalog`가 중복 등록 시 throw → `BUILT_IN_MODELS`가 이미 catalog-data에서 포함되어 있는지 확인 필요. 이중 등록 발생하면 `new InMemoryModelCatalog()` 빈 생성 후 `registerModel()` 개별 호출로 교체.
- Runner 내부 `retry()` 로직과 `runWithModelFallback`의 `maxRetriesPerModel`가 **중첩 재시도**를 만들 수 있다. `runWithModelFallback` config에 `maxRetriesPerModel: 1`로 설정해 중복 회피.

---

## Todo 6: ProfileHealthMonitor 단일 키 기록

### 파일 목록

| 작업 | 파일 경로                                             | LOC |
| ---- | ----------------------------------------------------- | --- |
| 수정 | `packages/server/src/auto-reply/execution-adapter.ts` | +15 |
| 수정 | `packages/server/src/main.ts`                         | +5  |

### 주의사항

- **Todo 5 먼저 완료 권장** — execute() 내부의 try/catch 경계가 이미 생겨 있을 것이기 때문.
- 단일 프로필 시나리오: profileId = `'default'` 고정. `ProfileHealthMonitor`가 단일 프로필이라도 윈도우 기반 에러율 기록 가능.
- 실패 판정: `AbortError`, `MissingEnvError`는 기록 제외. Anthropic 호출에서 발생한 `APIError`/`RateLimitError`/`OverloadedError`만 기록.
- `ProfileHealthMonitor.recordResult`가 어떤 에러 분류를 받는지는 `packages/agent/src/auth/health.ts` 시그니처 직접 확인. 대략 `recordResult(profileId, { success: boolean, errorReason?: string })`.
- `Todo 8`에서 `!finclaw status`가 이 데이터를 소비한다.

### 구현 코드

#### `packages/server/src/auto-reply/execution-adapter.ts`

```typescript
import { ProfileHealthMonitor } from '@finclaw/agent';

// RunnerExecutionAdapterDeps에 추가
export interface RunnerExecutionAdapterDeps {
  // ... 기존 ...
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string; // 기본 'default'
}

// execute() 내부, Todo 5의 runWithModelFallback 블록을 try/catch로 감쌈
async execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult> {
  // ... 기존 준비 로직 ...
  const profileId = this.deps.profileId ?? 'default';

  try {
    // Todo 5에서 작성한 result = await runWithModelFallback(...) 블록
    this.deps.profileHealth?.recordResult(profileId, { success: true });
    return {
      content: extractAssistantText(result.messages),
      usage: { ... },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  } catch (err) {
    if (!(err instanceof Error) || err.name === 'AbortError') throw err;
    this.deps.profileHealth?.recordResult(profileId, {
      success: false,
      errorReason: classifyErrorReason(err),
    });
    throw err;
  }
}

// 파일 하단 헬퍼
function classifyErrorReason(err: Error): string {
  const msg = err.message.toLowerCase();
  if (msg.includes('rate') || msg.includes('429')) return 'rate-limit';
  if (msg.includes('overload') || msg.includes('503')) return 'overloaded';
  if (msg.includes('timeout')) return 'timeout';
  if (msg.includes('401') || msg.includes('auth')) return 'auth';
  return 'unknown';
}
```

#### `packages/server/src/main.ts`

```typescript
import { ProfileHealthMonitor } from '@finclaw/agent';

// adapter 생성 직전
const profileHealth = new ProfileHealthMonitor();

const adapter = new RunnerExecutionAdapter({
  // ... 기존 ...
  profileHealth,
  profileId: 'default',
});

// registerBuiltInCommands deps에도 전달 (Todo 8에서 사용)
registerBuiltInCommands(commandRegistry, { toolRegistry, storage, profileHealth });
```

### 검증

- 정상 호출 5회 후 (런타임에서) `profileHealth.getState('default')` → `'healthy'`
- Anthropic 키를 잘못된 값으로 교체 후 3회 호출 → `'unhealthy'` 또는 `'disabled'` 전이
- `auth:health:change` 이벤트가 EventBus에 발행 (로그에서 확인 가능하다면 grep)

---

## Todo 7: 테스트 격리 유틸 `@internal` 문서화

### 파일 목록

| 작업 | 파일 경로                                  | LOC |
| ---- | ------------------------------------------ | --- |
| 수정 | `packages/infra/src/warnings.ts`           | +2  |
| 수정 | `packages/server/src/gateway/health.ts`    | +2  |
| 수정 | `packages/config/src/runtime-overrides.ts` | +4  |
| 수정 | `packages/config/src/defaults.ts`          | +2  |
| 수정 | `packages/channel-discord/src/buttons.ts`  | +2  |

### 주의사항

- **이 Todo는 코드 동작 변경이 없다.** JSDoc 추가만.
- 대상 심볼 각각에 `/** @internal */` 주석 추가 → TypeDoc·IDE 자동완성이 "내부 전용"으로 인식.
- 이름 변경 (예: `_resetWarnings`로 언더스코어 접두) 은 **이번 Todo 범위 밖** — 기존 테스트 import 깨짐 방지.
- `getDefaults`는 "테스트 전용"이라기보단 실용 헬퍼. `@internal` 대신 그대로 두거나, 만약 테스트 외 사용이 있으면 `@internal` 제외.

### 구현 코드

#### `packages/infra/src/warnings.ts` (resetWarnings 선언부)

```typescript
/**
 * 테스트 전용: 중복 경고 억제 상태(emitted Set)를 초기화한다.
 * 프로덕션 코드에서 호출하지 말 것.
 * @internal
 */
export function resetWarnings(): void {
  emitted.clear();
}
```

#### `packages/server/src/gateway/health.ts` (resetHealthCheckers)

```typescript
/**
 * 테스트 전용: health checkers 배열을 초기화한다.
 * @internal
 */
export function resetHealthCheckers(): void {
  checkers.length = 0;
}
```

#### `packages/config/src/runtime-overrides.ts` (unsetOverride, getOverrideCount)

```typescript
/** @internal 테스트에서 오버라이드 해제 검증용 */
export function unsetOverride(path: string): void { ... }

/** @internal 테스트에서 오버라이드 누적 확인용 */
export function getOverrideCount(): number { ... }
```

#### `packages/config/src/defaults.ts` (getDefaults)

```typescript
/** @internal 테스트에서 불변성 검증용. 실제 설정 읽기는 applyDefaults 경유. */
export function getDefaults(): Readonly<FinClawConfig> { ... }
```

#### `packages/channel-discord/src/buttons.ts` (이미 `_` 접두 있음)

```typescript
/** @internal 테스트 유틸: pending 승인 맵 + 모든 타임아웃 초기화 */
export function _resetPendingApprovals(): void { ... }
```

### 검증

- `pnpm typecheck` 통과 (JSDoc은 컴파일에 영향 없음)
- IDE에서 해당 심볼 hover 시 `@internal` 태그 표시
- 회귀 테스트 통과 (동작 변경 없음)

---

## Todo 8: `!finclaw status` 확장

### 파일 목록

| 작업 | 파일 경로                                             | LOC |
| ---- | ----------------------------------------------------- | --- |
| 수정 | `packages/server/src/auto-reply/commands/status.ts`   | +20 |
| 수정 | `packages/server/src/auto-reply/commands/built-in.ts` | +3  |

### 주의사항

- `!finclaw status`는 plan.md Todo 9(`7781873`)에서 이미 구현됨. 이번엔 **출력에 3가지 항목 추가**:
  1. 지원 채널 목록 (Todo 3의 `getAllChannelDocks()` 소비)
  2. 현재 사용 중인 모델 ID (DEFAULT_MODEL 또는 최근 성공 모델)
  3. 최근 API 에러율 (Todo 6의 `profileHealth.getState(profileId)` 소비)
- 기존 출력(도구 수·메시지 수·알림 수·업타임)은 **그대로 유지**. 섹션 추가만.
- Todo 3/5/6이 완료되지 않은 상태에서 Todo 8만 진행하려 하면 옵셔널 체이닝으로 방어 (`?.` fallback "N/A").

### 구현 코드

#### `packages/server/src/auto-reply/commands/status.ts` (기존 status 확장)

```typescript
import { getAllChannelDocks } from '../../channels/index.js';
import type { ProfileHealthMonitor } from '@finclaw/agent';
import type { ModelRef } from '@finclaw/types';

export interface StatusCommandDeps {
  readonly toolRegistry: ToolRegistry;
  readonly storage: Storage;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly defaultModel?: ModelRef;
}

export function createStatusCommand(deps: StatusCommandDeps): CommandHandler {
  return async (ctx: CommandContext) => {
    // 기존 수집
    const toolCount = deps.toolRegistry.list().length;
    const messageCount = deps.storage.getMessageCount?.(ctx.sessionKey) ?? '?';
    const alertCount = deps.storage.getActiveAlertCount?.() ?? '?';
    const uptime = Math.round(process.uptime() / 60);

    // 신규 수집
    const channelIds =
      getAllChannelDocks()
        .map((d) => d.id)
        .join(', ') || 'none';
    const modelId = deps.defaultModel?.model ?? 'unknown';
    const health = deps.profileHealth?.getState(deps.profileId ?? 'default');
    const errorRate =
      health && typeof health === 'object' && 'failureRate' in health
        ? `${Math.round((health.failureRate as number) * 100)}%`
        : 'N/A';
    const healthLabel =
      health && typeof health === 'object' && 'status' in health
        ? (health.status as string)
        : 'unknown';

    return {
      ok: true,
      reply: [
        '**FinClaw 상태**',
        `- 등록 도구: ${toolCount}개`,
        `- 현재 세션 메시지: ${messageCount}건`,
        `- 활성 알림: ${alertCount}개`,
        `- 서버 업타임: ${uptime}분`,
        `- 지원 채널: ${channelIds}`,
        `- 현재 모델: ${modelId}`,
        `- API 상태: ${healthLabel} (최근 에러율 ${errorRate})`,
      ].join('\n'),
    };
  };
}
```

#### `packages/server/src/auto-reply/commands/built-in.ts`

```typescript
export function registerBuiltInCommands(
  registry: CommandRegistry,
  deps: {
    toolRegistry: ToolRegistry;
    storage: Storage;
    profileHealth?: ProfileHealthMonitor;
    defaultModel?: ModelRef;
  },
): void {
  // ... 기존 ...
  registry.register(
    'status',
    createStatusCommand({
      ...deps,
      profileId: 'default',
    }),
  );
  registry.register('reset', createResetCommand(deps));
}
```

### 검증

- Discord DM `!finclaw status` 응답에 8줄 포함:
  - 기존 4줄 + 신규 3줄 (지원 채널, 현재 모델, API 상태)
- Todo 3 미완이면 지원 채널이 "none", Todo 6 미완이면 API 상태가 "N/A"로 표시 (defensive)
- 기존 status 테스트 통과 (출력 형식이 확장됐으므로 테스트 assertion도 업데이트 필요)

---

## End-to-end 검증 (Todo 1~8 완료 후)

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

`.env` 정상 세팅 후:

```bash
pnpm run dev
```

| 단계 | 입력/조치                                   | 기대                                                                                                                  |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1    | `.env`에 `GATEWAY_PORT=abc` → `pnpm dev`    | `ConfigValidationError` + exit 1                                                                                      |
| 2    | 다른 프로세스가 3000 점유 → `pnpm dev`      | `port 3000 occupied by PID N ...` + exit 1                                                                            |
| 3    | 정상 기동                                   | `channels: registered 2 docks (discord, http-webhook)` 로그 1줄                                                       |
| 4    | `pnpm test`                                 | 기존 테스트 전부 통과 (index.ts 정리 영향 제외)                                                                       |
| 5    | Discord DM "비트코인 가격"                  | 정상 응답. 로그에 `model:fallback` **없음**                                                                           |
| 5'   | `ANTHROPIC_API_KEY`를 고의 오염 후 DM       | `model:fallback` 이벤트 후 최종 `model:exhausted` + 에러 응답                                                         |
| 6    | 5' 이후 `profileHealth.getState('default')` | `unhealthy` 또는 `disabled`                                                                                           |
| 7    | IDE hover                                   | `resetWarnings`, `resetHealthCheckers` 등에 `@internal` 태그                                                          |
| 8    | Discord DM `!finclaw status`                | 기존 4줄 + "지원 채널: discord, http-webhook" + "현재 모델: claude-sonnet-4-6" + "API 상태: healthy (최근 에러율 0%)" |

---

## 범위 밖 (plan_2에서 phase23+로 보존)

의도적으로 **이번 phase에서 처리하지 않는** 항목. 존재는 유지:

- `InMemoryAuthProfileStore.selectNext` 다중 키 로드밸런싱
- `CooldownTracker` 외부 노출 및 레이트 리밋 자동 우회
- Storage Search (`buildFtsQuery`, `cosineSimilarity` 등) → `!finclaw search` 명령어 미구현
- `formatFinancialNumber` 소비자 배선
- `DefaultPipelineObserver` 메트릭 대시보드 연결
- `InMemoryModelCatalog.updateModel` (현재는 중복 throw만)
- 개발 모드 `findAvailablePort` 자동 대체 포트 배정

---

## 복잡도 및 예상 파일 수

| 항목                 | 값                     |
| -------------------- | ---------------------- |
| 복잡도               | **S-M**                |
| 신규 파일            | 1 (`channels/init.ts`) |
| 수정 파일            | 10~12                  |
| 예상 LOC (신규+수정) | ~200                   |
| 새 외부 의존성       | 없음                   |
| DB 마이그레이션      | 없음                   |

### Todo별 규모

| Todo                    | 규모                     | 리스크                                   |
| ----------------------- | ------------------------ | ---------------------------------------- |
| 1. validateConfigStrict | ~5 LOC, 1 파일           | 저                                       |
| 2. Port 진단            | ~15 LOC, 1 파일          | 저                                       |
| 3. ChannelDock 등록     | ~30 LOC, 신규 1 + 수정 3 | 저~중 (DISCORD_DOCK 상수 부재 시 중)     |
| 4. index.ts 축소        | ~30 LOC (대부분 삭제)    | 중 (테스트 import 경로 수정 필요)        |
| 5. 모델 폴백            | ~60 LOC, 3 파일          | 중~고 (Runner-fallback 중첩 재시도 주의) |
| 6. ProfileHealthMonitor | ~20 LOC, 2 파일          | 저 (Todo 5 연계)                         |
| 7. @internal 문서화     | ~15 LOC, 5 파일          | 최저                                     |
| 8. status 확장          | ~25 LOC, 2 파일          | 저 (기존 테스트 업데이트 필요)           |

---

## 마이그레이션 / 호환성

- **DB**: 영향 없음
- **env**: 신규 필수 없음. 잘못된 값 검증만 추가
- **기존 동작**: Todo 5의 폴백 래핑은 `modelCatalog`/`fallbackChain`이 주입되지 않으면 단일 모델 경로로 fallthrough → 회귀 없음
- **Downgrade**: 각 Todo는 revert 가능. Todo 5만 `AnthropicAdapter` 호출 구조가 바뀌므로 revert 시 `params` 구조 원복 필요

---

## 원칙 재확인

- **삭제 0건**: Todo 4도 `index.ts` 공개 범위만 축소. 심볼·로직은 살아있음
- **plan.md 재진술 제외**: plan_2의 1.2(감사 메타)·1.3(Command 프레임워크)은 이미 완료되어 이 Todo에 없음
- **phase23 후보 보존**: 위 "범위 밖" 섹션에 명시
