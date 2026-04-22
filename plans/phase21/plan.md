# Phase 21: 비서 활성화 — 수평 배선 완성

## 1. 목표

Phase 1–20에서 구축된 부품들을 **실제로 연결하여** FinClaw를 OpenClaw 수준의 범용 AI 비서로 동작시킨다. 새 기능을 추가하지 않고, 이미 구현된 모듈 간의 **수평 배선**(Gateway RPC → Pipeline → Execution → Runner → Tool Registry → Storage)을 완성한다.

구체적으로:

1. **파이프라인 활성화**: `RunnerExecutionAdapter` 구현 + `main.ts`에서 `AutoReplyPipeline` 전체 인스턴스화. 현재 `MockExecutionAdapter`만 존재하여 Execute 단계가 하드코딩된 문자열을 반환하는 문제 해소.
2. **Discord 연결**: `packages/channel-discord`의 `DiscordAdapter`를 서버 시작 시 인스턴스화 + `MessageRouter` 경유 파이프라인 연결. 현재 어댑터는 구현되어 있으나 `main.ts`에서 배선되지 않아 메시지가 파이프라인에 도달하지 못한다.
3. **범용 도구 추가**: `@finclaw/skills-general` 신규 패키지에 `get_current_datetime`, `web_fetch`, `read_local_file` 3개 도구 구현. 범용 비서가 되려면 금융 도메인 밖 도구가 필요.
4. **도구 등록 배선**: `registerMarketTools`/`registerNewsTools`/`registerAlertTools`/`register<General>Tool` 함수들을 `main.ts`에서 호출하여 `InMemoryToolRegistry`에 실제로 등록 + `ExecutionToolDispatcher`로 변환.
5. **대화 영속화**: `@finclaw/storage`의 `conversations` 테이블을 활용해 매 턴 대화 이력을 저장/로드. `upsertConversation` 헬퍼 추가.
6. **Gateway RPC 배선**: `chat.start`/`chat.send`/`chat.stop`/`chat.history` + `session.get`/`session.reset`/`session.list` 7개 스텁 핸들러를 factory 패턴으로 실제 구현. TUI/Web이 Gateway와 실제 통신하게 됨.

> **이미 구현된 영역 (본 Phase에서 신규 구현하지 않음):**
>
> - **Runner (실행 엔진)**: `packages/agent/src/execution/runner.ts` (스트리밍, 도구 디스패치, 컨텍스트 컴팩션, 재시도)
> - **LLM 프로바이더**: `packages/agent/src/providers/anthropic.ts`, `openai.ts`
> - **ToolRegistry**: `packages/agent/src/agents/tools/registry.ts` (정책/가드/서킷브레이커)
> - **금융 스킬**: `packages/skills-finance/src/{market,news,alerts}/` (`register<X>Tools` 함수 정의됨)
> - **스토리지 스키마**: `packages/storage/src/tables/conversations.ts` (CRUD 존재)
> - **TUI/Web UI**: `packages/tui/`, `packages/web/` (WebSocket 스트리밍 UI 완성)
> - **Discord 어댑터**: `packages/channel-discord/src/adapter.ts` (`setup/onMessage/send` 구현)
> - **파이프라인 1-4 단계**: Normalize/Command/ACK/Context (`packages/server/src/auto-reply/stages/`)
> - **MessageRouter**: `packages/server/src/process/message-router.ts` (Dedupe + Concurrency Lane)

이 Phase는 Phase 20까지의 수직 완성 위에 **수평 배선만** 추가한다.

---

## 2. 본 Phase의 특수성 (OpenClaw 참조 없음)

Phase 1–20은 OpenClaw의 각 phase 문서(`docs/XX.md`, `deep-dive/XX-*.md`)를 참조하여 포팅했다. **Phase 21은 OpenClaw에 대응하는 Phase가 없다.** 이유는 OpenClaw는 각 phase 구현 시 배선을 함께 완성한 반면, FinClaw는 수직 완성을 먼저 하고 수평 배선을 미뤘기 때문이다.

참조 가능한 것은 OpenClaw의 **전체 애플리케이션 부팅 시퀀스** — 하지만 이것도 수동 대조하기보다 FinClaw 기존 코드(이미 존재하는 인터페이스와 의존성 그래프)에서 유도하는 것이 더 정확하다.

**본 Phase의 판단 기준:**

1. **현재 코드에서 명시적으로 비어 있는 곳만 채운다** — `TODO(Phase 10)` 주석, `throw new Error('... requires ... wiring')`, `MockExecutionAdapter`.
2. **기존 인터페이스를 변경하지 않는다** — `RpcContext`, `ToolRegistry.execute`, `Runner.execute` 시그니처 유지.
3. **신규 추상화를 만들지 않는다** — 기존 `PluginBuildApi`, `ChannelPlugin`, `ExecutionAdapter` 등을 그대로 사용.

---

## 3. 생성/수정할 파일

### 신규 파일 (10개)

#### 범용 스킬 패키지 (5개)

| #   | 파일 경로                                  | 설명                                             | 예상 LOC |
| --- | ------------------------------------------ | ------------------------------------------------ | -------- |
| 1   | `packages/skills-general/package.json`     | 패키지 정의 (workspace:\* 의존성)                | ~20      |
| 2   | `packages/skills-general/tsconfig.json`    | composite + project references                   | ~15      |
| 3   | `packages/skills-general/src/index.ts`     | barrel export + `registerGeneralTools(registry)` | ~30      |
| 4   | `packages/skills-general/src/datetime.ts`  | `get_current_datetime` 도구                      | ~50      |
| 5   | `packages/skills-general/src/web-fetch.ts` | `web_fetch` 도구 (SSRF 가드 재사용)              | ~90      |
| 6   | `packages/skills-general/src/file-read.ts` | `read_local_file` 도구 (path 가드)               | ~70      |

#### Execution Adapter 확장 (1개 수정이지만 사실상 클래스 신설)

| #   | 파일 경로                                             | 설명                                                                                                   | 예상 LOC |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| 7   | `packages/server/src/auto-reply/execution-adapter.ts` | `RunnerExecutionAdapter` 클래스 추가 (Mock 옆). Discord용 `execute()` + TUI용 `executeForTui()` 메서드 | ~130     |

#### 스토리지 헬퍼 (1개 수정)

| #   | 파일 경로                                      | 설명                                    | 예상 LOC |
| --- | ---------------------------------------------- | --------------------------------------- | -------- |
| 8   | `packages/storage/src/tables/conversations.ts` | `upsertConversation(key, payload)` 추가 | +40      |

#### 도구 디스패처 변환 헬퍼 (1개)

| #   | 파일 경로                                                   | 설명                                                        | 예상 LOC |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------- | -------- |
| 9   | `packages/server/src/auto-reply/tool-dispatcher-adapter.ts` | `ToolRegistry → ExecutionToolDispatcher` 변환 (per-request) | ~80      |

#### 파이프라인 Stub Provider (1개 수정)

| #   | 파일 경로                                            | 설명                                                       | 예상 LOC |
| --- | ---------------------------------------------------- | ---------------------------------------------------------- | -------- |
| 10  | `packages/server/src/auto-reply/pipeline-context.ts` | `StubFinanceContextProvider` 추가 (모든 메서드 빈 값 반환) | +30      |

### 기존 파일 수정 (8개)

| #   | 파일 경로                                            | 수정 내용                                                                                                      |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| M1  | `packages/server/src/main.ts`                        | 전역 배선: Runner/Registry/Tools/Storage/Pipeline/Router/Discord 인스턴스화 + Gateway deps 주입. 62줄 → ~180줄 |
| M2  | `packages/server/src/gateway/server.ts`              | `createGatewayServer(config, deps)` 시그니처 확장. factory 방식으로 chat/session 메서드 등록                   |
| M3  | `packages/server/src/gateway/rpc/methods/chat.ts`    | 4개 핸들러 전면 재작성. `registerChatMethods()` → `createChatMethods(deps)` factory                            |
| M4  | `packages/server/src/gateway/rpc/methods/session.ts` | 3개 핸들러 전면 재작성. factory 패턴                                                                           |
| M5  | `packages/server/src/gateway/rpc/types.ts`           | `ActiveSession`에 `model: ModelRef`, `sessionKey: SessionKey` 필드 추가                                        |
| M6  | `pnpm-workspace.yaml`                                | skills-general 포함 (이미 `packages/*` 글롭이면 변경 불필요 — 확인 필요)                                       |
| M7  | `tsconfig.json` (루트 solution)                      | skills-general project reference 추가                                                                          |
| M8  | `packages/server/package.json`                       | `@finclaw/skills-general`, `@finclaw/channel-discord`, `@finclaw/storage` dependency 추가 (누락 시)            |

### 환경 변수 추가 (.env.example)

| 변수                                                       | 용도                                                      | 필수                   |
| ---------------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| `ANTHROPIC_API_KEY`                                        | Claude API 키                                             | 필수                   |
| `DISCORD_BOT_TOKEN`                                        | Discord Bot Token                                         | 필수 (Discord 사용 시) |
| `DISCORD_CLIENT_ID`                                        | Discord Application ID                                    | 필수 (Discord 사용 시) |
| `FINCLAW_API_KEY`                                          | TUI/Web 인증 토큰                                         | 필수 (TUI 사용 시)     |
| `FINCLAW_DB_PATH`                                          | SQLite 경로 (기본 `~/.finclaw/db.sqlite`)                 | 선택                   |
| `FINCLAW_FILE_ROOT`                                        | `read_local_file` 안전 루트 (기본 `~/.finclaw/workspace`) | 선택                   |
| `ALPHA_VANTAGE_KEY` / `COINGECKO_API_KEY` / `NEWS_API_KEY` | 금융 도구 활성화                                          | 선택                   |

**합계: 신규 10개 + 수정 8개 = 18개 파일, 예상 ~1100 LOC**

---

## 4. 핵심 인터페이스/타입

### 4.1 RunnerExecutionAdapter (신규)

```typescript
// packages/server/src/auto-reply/execution-adapter.ts
import type { Runner, ModelRef, AgentRunParams, StreamEvent } from '@finclaw/agent';
import type { StorageAdapter } from '@finclaw/storage';

export interface RunnerExecutionAdapterDeps {
  readonly runner: Runner;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly storage: StorageAdapter;
  readonly buildToolDispatcher: (sessionId: string, signal: AbortSignal) => ExecutionToolDispatcher;
}

export class RunnerExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly deps: RunnerExecutionAdapterDeps) {}

  /** 파이프라인 Stage 5 (Discord/채널 경로) */
  async execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult> {
    // 1. sessionKey로 storage.getConversation() 호출, 이전 messages 로드
    // 2. AgentRunParams 빌드 (system + prior messages + new user message)
    // 3. runner.execute(params) (스트리밍 리스너 없음 — 최종 텍스트만)
    // 4. storage.upsertConversation(...) 저장
    // 5. 최종 assistant 텍스트 반환
  }

  /** TUI/Web 경로 — 스트리밍 리스너 포함 */
  async executeForTui(
    params: AgentRunParams,
    listener: (event: StreamEvent) => void,
    sessionKey: SessionKey,
    signal: AbortSignal,
  ): Promise<{ messageId: string }> {
    // 1. storage.getConversation(sessionKey) 로드
    // 2. params.messages 앞에 prior 이력 prepend
    // 3. runner.execute(params, listener) — broadcaster로 스트리밍
    // 4. storage.upsertConversation(...) 저장
    // 5. messageId 반환
  }
}
```

### 4.2 StubFinanceContextProvider (신규)

```typescript
// packages/server/src/auto-reply/pipeline-context.ts
export class StubFinanceContextProvider implements FinanceContextProvider {
  async getActiveAlerts() {
    return [];
  }
  async getPortfolio() {
    return null;
  }
  async getRecentNews() {
    return [];
  }
  async getWatchlist() {
    return [];
  }
  getMarketSession(): MarketSession {
    return { isOpen: false, market: 'NONE', nextOpenAt: null, timezone: 'Asia/Seoul' };
  }
}
```

Milestone D에서 실제 `FinanceContextProvider` 구현(DB 기반 포트폴리오 등) 추가 가능.

### 4.3 범용 도구 시그니처

```typescript
// packages/skills-general/src/index.ts
import type { ToolRegistry } from '@finclaw/agent';

export function registerGeneralTools(registry: ToolRegistry): void {
  registerDatetimeTool(registry);
  registerWebFetchTool(registry);
  registerFileReadTool(registry);
}

// 각 도구는 기존 skills-finance 패턴 재사용:
// const definition: RegisteredToolDefinition = { name, description, schema, group, timeoutMs, ... }
// const executor: ToolExecutor = async (input, ctx) => ({ ok: true, data: ... })
// registry.register(definition, executor, 'skill')
```

### 4.4 Tool Dispatcher Adapter (신규)

```typescript
// packages/server/src/auto-reply/tool-dispatcher-adapter.ts
import type { ToolRegistry, ToolHandler, ExecutionToolDispatcher } from '@finclaw/agent';

export function buildDispatcher(
  registry: ToolRegistry,
  contextFactory: () => ToolExecutionContext,
): ExecutionToolDispatcher {
  // ToolRegistry의 모든 도구를 ToolHandler로 변환
  // 각 handler는 registry.execute(name, input, contextFactory())를 호출
  // per-request로 호출되어 signal/sessionId/userId 클로저 캡처
}
```

### 4.5 RPC Factory 패턴

```typescript
// packages/server/src/gateway/rpc/methods/chat.ts
export interface ChatMethodsDeps {
  readonly registry: ChatRegistry;
  readonly connections: Map<string, WsConnection>;
  readonly broadcaster: GatewayBroadcaster;
  readonly adapter: RunnerExecutionAdapter;
  readonly defaultModel: ModelRef;
}

export function createChatMethods(deps: ChatMethodsDeps): RpcMethodHandler<any, any>[] {
  return [
    {
      method: 'chat.start',
      execute: async (params, ctx) => {
        /* 실제 구현 */
      },
    },
    {
      method: 'chat.send',
      execute: async (params, ctx) => {
        /* 실제 구현 */
      },
    },
    {
      method: 'chat.stop',
      execute: async (params, ctx) => {
        /* 실제 구현 */
      },
    },
    {
      method: 'chat.history',
      execute: async (params, ctx) => {
        /* 실제 구현 */
      },
    },
  ];
}
```

`createGatewayServer`가 `ctx` 생성 후 이 factory를 호출하여 핸들러를 `registerMethod`로 등록한다.

### 4.6 main.ts 배선 순서

```typescript
async function main(): Promise<void> {
  // 1. env 검증
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  const finclawApiKey = process.env.FINCLAW_API_KEY;

  // 2. 기반 레이어
  const logger = createLogger({ name: 'finclaw', level: 'info' });
  const lifecycle = new ProcessLifecycle({ logger });
  const storage = await createStorage({ dbPath: resolveDbPath() });

  // 3. Agent 레이어
  const anthropicAdapter = new AnthropicAdapter({ apiKey: anthropicKey });
  const toolRegistry = new InMemoryToolRegistry({ logger });
  registerMarketTools(toolRegistry, { /* conditional on env */ });
  registerNewsTools(toolRegistry, { /* conditional */ });
  registerAlertTools(toolRegistry, { /* conditional */ });
  registerGeneralTools(toolRegistry);

  const lanes = new ConcurrencyLaneManager({ /* default config */ });
  const runner = new Runner({
    provider: anthropicAdapter,
    dispatcher: /* placeholder — built per-request in adapter */,
    lanes,
    logger,
  });

  // 4. 실행 어댑터
  const defaultModel: ModelRef = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  };
  const systemPrompt = 'You are FinClaw, a helpful personal assistant. 한국어로 자연스럽게 대답해.';

  const buildToolDispatcher = (sessionId: string, signal: AbortSignal) =>
    buildDispatcher(toolRegistry, () => ({
      sessionId,
      signal,
      logger,
      userId: /* from session */,
    }));

  const adapter = new RunnerExecutionAdapter({
    runner, defaultModel, systemPrompt, storage, buildToolDispatcher,
  });

  // 5. 파이프라인
  const financeCtxProvider = new StubFinanceContextProvider();
  const commandRegistry = new CommandRegistry();
  const channelPluginRegistry = new Map<string, ChannelPlugin>();
  const pipeline = new AutoReplyPipeline(
    { enableAck: true, commandPrefix: '!finclaw ', maxResponseLength: 2000, timeoutMs: 60_000, respectMarketHours: false },
    {
      executionAdapter: adapter,
      financeContextProvider: financeCtxProvider,
      commandRegistry,
      logger,
      getChannel: (id) => channelPluginRegistry.get(id),
    },
  );

  // 6. MessageRouter
  const router = new MessageRouter({
    logger,
    lanes,
    onProcess: (ctx, match, signal) => pipeline.process(ctx, match, signal),
  });

  // 7. Discord 어댑터 (조건부)
  if (discordToken) {
    const discordAdapter = new DiscordAdapter(/* config */);
    const cleanup = await discordAdapter.setup({ botToken: discordToken });
    lifecycle.register(cleanup);
    channelPluginRegistry.set('discord', discordAdapter);
    discordAdapter.onMessage((msg) => router.route(msg));
    logger.info('Discord adapter connected');
  }

  // 8. Gateway
  const gatewayConfig = { ...defaultConfig, auth: { ...defaultConfig.auth, apiKeys: finclawApiKey ? [finclawApiKey] : [] } };
  await assertPortAvailable(gatewayConfig.port);
  const gateway = createGatewayServer(gatewayConfig, { runner, defaultModel, systemPrompt, adapter, storage });
  lifecycle.register(() => gateway.stop());
  lifecycle.init();
  await gateway.start();
  logger.info(`Gateway listening on ${gatewayConfig.host}:${gatewayConfig.port}`);
  getEventBus().emit('system:ready');
}
```

---

## 5. 구현 상세 (Milestone 별)

### 5.1 Milestone A — Discord MVP

**성공 기준**: Discord DM "안녕" → 실제 Claude 스트리밍 응답

**작업 파일**:

- 파일 #7 `execution-adapter.ts` — `RunnerExecutionAdapter.execute()` 구현 (TUI 메서드는 Milestone C에서)
- 파일 #10 `pipeline-context.ts` — `StubFinanceContextProvider` 추가
- M1 `main.ts` — 위 배선 순서 중 1~7번 (Gateway deps는 Milestone C에서 확장)

**Milestone A 시점의 adapter.execute() 구현**:

1. `ctx.senderId`로 sessionKey 파생 (Discord는 `deriveRoutingSessionKey`가 이미 처리)
2. 이력 로드 없이 현재 메시지만 사용 (영속성은 Milestone B)
3. `AgentRunParams = { model: defaultModel, system: systemPrompt, messages: [{ role: 'user', content: ctx.normalizedBody }], tools: [] }`
4. `runner.execute(params)` 호출
5. 최종 assistant 텍스트 추출 → `{ content, usage }` 반환

### 5.2 Milestone B — 도구 + 영속성

**성공 기준**: "AAPL 주가" → `get_stock_price` 호출 결과 응답 / 재시작 후 맥락 유지

**작업 파일**:

- 파일 #1~6 `packages/skills-general/**` 신규 패키지 + 3 도구
- 파일 #8 `upsertConversation` 헬퍼
- 파일 #9 `tool-dispatcher-adapter.ts` 신규
- 파일 #7 `execution-adapter.ts` — 이력 load/save 로직 추가
- M1 `main.ts` — 도구 등록 + storage 주입 확장
- M6 `pnpm-workspace.yaml` (glob에 포함되면 수정 불필요)
- M7 루트 `tsconfig.json` — skills-general references 추가

**도구 상세**:

| 도구                   | 입력                                   | 출력                            | 구현 노트                                                                                                   |
| ---------------------- | -------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `get_current_datetime` | `{ timezone?: string }`                | ISO 8601 문자열                 | `Intl.DateTimeFormat` 사용, 기본 `Asia/Seoul`                                                               |
| `web_fetch`            | `{ url: string, max_bytes?: number }`  | `{ status, contentType, body }` | 10s 타임아웃, `@finclaw/infra`의 SSRF 가드 재사용. HTML은 script/style 제거 후 텍스트. 기본 max_bytes 100KB |
| `read_local_file`      | `{ path: string, max_bytes?: number }` | `{ path, bytes, content }`      | `path.resolve(FILE_ROOT, path)`가 `FILE_ROOT` prefix인지 확인. 심볼릭 링크 거부. 기본 max_bytes 100KB       |

**영속성 흐름 (adapter.execute 확장)**:

```
1. sessionKey = ctx.sessionKey (router가 이미 파생)
2. prior = await storage.getConversation(sessionKey)
3. messages = [...(prior?.messages ?? []).slice(-20), { role: 'user', content: ctx.normalizedBody }]
4. dispatcher = buildToolDispatcher(sessionKey, signal)
5. runner.execute({ ...params, messages, tools: dispatcher.toolDefinitions })
6. assistantMsg = runResult.finalAssistantMessage
7. await storage.upsertConversation({ sessionKey, messages: [...messages, assistantMsg], agentId: ctx.agentId, updatedAt: now })
8. return { content: extractText(assistantMsg), usage }
```

**최근 N턴 제한**: 이력을 전부 프리펜드하면 context window가 터진다. 기본 20턴으로 제한. Runner 내부의 `compaction` 로직이 여전히 작동하지만, DB에서 로드 시 예비 cutoff 적용.

### 5.3 Milestone C — TUI 채팅 활성화

**성공 기준**: `finclaw tui` → Claude와 실시간 스트리밍 대화

**작업 파일**:

- M3 `rpc/methods/chat.ts` — 전면 재작성 (factory 패턴)
- M4 `rpc/methods/session.ts` — 전면 재작성
- M5 `rpc/types.ts` — `ActiveSession` 필드 추가
- M2 `gateway/server.ts` — deps 시그니처 확장
- M1 `main.ts` — Gateway deps 전달
- 파일 #7 `execution-adapter.ts` — `executeForTui` 메서드 추가

**chat.start 구현**:

```typescript
async execute(params, ctx) {
  const sessionKey = deriveSessionKey({ tokenUserId: ctx.userId, agentId: params.agentId });
  const session = registry.startSession({
    agentId: params.agentId,
    connectionId: ctx.connectionId!,
    model: defaultModel,
    sessionKey,
  });
  return { sessionId: session.sessionId };
}
```

**chat.send 구현**:

```typescript
async execute(params, ctx) {
  const session = registry.getSession(params.sessionId);
  if (!session) throw new RpcError('session not found', -32004);
  const conn = connections.get(session.connectionId);
  if (!conn) throw new RpcError('connection lost', -32005);
  const signal = AbortSignal.timeout(60_000);
  const agentParams: AgentRunParams = {
    model: session.model,
    system: systemPrompt,
    messages: [{ role: 'user', content: params.message }],
    tools: [],
  };
  const listener = (event: StreamEvent) => broadcaster.send(conn, session.sessionId, event);
  const result = await adapter.executeForTui(agentParams, listener, session.sessionKey, signal);
  return { messageId: result.messageId };
}
```

**session.get 구현**: registry에서 session 조회 → `{ sessionId, agentId, model: session.model.model, status, startedAt }` 반환 (TUI의 App.tsx:58 destructure와 맞춤).

**chat.history 구현**: `storage.getConversation(session.sessionKey)` 호출 → `{ messages }` 반환.

### 5.4 Milestone D — 다듬기 (실사용 기반)

Phase 21 본체에서는 다음만 포함:

- `!finclaw reset` — 현재 세션의 대화 이력 초기화 (storage 삭제)
- `!finclaw status` — 서버 상태 + 활성 세션 수
- Claude 호출 실패 시 Discord로 에러 메시지 전달 (지금은 조용히 먹힘)

나머지 (system prompt 확장, 첨부파일, vision, config 파일 로드)는 별도 Phase 또는 post-phase로.

---

## 6. 선행 조건

| 선행 Phase                    | 산출물                                               | 사용 목적                              |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------- |
| **Phase 2** (인프라)          | 로거, 에러, SSRF 가드, 포트 관리                     | 모든 레이어에서 재사용                 |
| **Phase 3** (설정)            | env 파싱, 경로 정규화                                | `main.ts` env 검증                     |
| **Phase 4** (프로세스/라우팅) | `MessageRouter`, `ConcurrencyLaneManager`            | 파이프라인 진입점                      |
| **Phase 5** (채널/플러그인)   | `ChannelPlugin` 인터페이스                           | `channelPluginRegistry`의 value 타입   |
| **Phase 6** (모델/인증)       | `AnthropicAdapter`, `ModelRef`, `BUILT_IN_MODELS`    | `main.ts`에서 프로바이더 인스턴스화    |
| **Phase 7** (도구/세션)       | `InMemoryToolRegistry`, `ToolDefinition`             | 도구 등록 허브                         |
| **Phase 8** (자동 응답)       | `AutoReplyPipeline`, `pipeline-context.ts`           | Stage 5에 `ExecutionAdapter` 주입      |
| **Phase 9** (실행 엔진)       | `Runner`, `ExecutionToolDispatcher`, `StreamEvent`   | `RunnerExecutionAdapter`의 핵심 의존성 |
| **Phase 10-11** (게이트웨이)  | `ChatRegistry`, `GatewayBroadcaster`, `WsConnection` | RPC 핸들러 factory의 deps              |
| **Phase 12** (Discord)        | `DiscordAdapter`                                     | `main.ts`에서 인스턴스화               |
| **Phase 14** (스토리지)       | `StorageAdapter`, `conversations` 테이블             | 대화 영속화                            |
| **Phase 16-18** (금융 스킬)   | `registerMarketTools` 등                             | `main.ts`에서 호출                     |
| **Phase 19** (TUI/Web)        | TUI `App.tsx`의 `chat.start/send` 호출               | Gateway RPC factory가 채워야 할 계약   |

### 직접 의존 관계

```
Phase 7 (ToolRegistry) ────┐
Phase 8 (Pipeline)    ─────┤
Phase 9 (Runner)      ─────┼──→ Phase 21 (배선)
Phase 10-11 (Gateway) ─────┤
Phase 12 (Discord)    ─────┤
Phase 14 (Storage)    ─────┤
Phase 16-18 (Skills)  ─────┘
```

---

## 7. 산출물 및 검증

### 기능 검증 체크리스트

| #   | 검증 항목                                                      | 테스트 방법                              | 테스트 tier |
| --- | -------------------------------------------------------------- | ---------------------------------------- | ----------- |
| 1   | `RunnerExecutionAdapter.execute()`가 실제 Runner 호출          | unit test: mock runner + 파이프라인 1턴  | unit        |
| 2   | `StubFinanceContextProvider`의 4 메서드 빈 값 반환             | unit test                                | unit        |
| 3   | `upsertConversation` — 신규/업데이트 양쪽 경로                 | storage test                             | storage     |
| 4   | `buildDispatcher` — ToolRegistry의 도구를 dispatcher로 변환    | unit test: 등록된 도구 2개 실행 확인     | unit        |
| 5   | `get_current_datetime` 도구 — timezone 파라미터 처리           | unit test: Asia/Seoul vs UTC             | unit        |
| 6   | `web_fetch` — SSRF 가드 (localhost/private IP 차단)            | unit test: 10.0.0.1 거부                 | unit        |
| 7   | `read_local_file` — path traversal 거부                        | unit test: `../../../etc/passwd` 거부    | unit        |
| 8   | `createChatMethods` factory — 4 핸들러 반환 + Runner 호출      | unit test                                | unit        |
| 9   | `createSessionMethods` factory — session.get이 model 포함 반환 | unit test                                | unit        |
| 10  | main.ts 부팅 — ANTHROPIC_API_KEY 없으면 즉시 실패              | unit test or manual                      | unit        |
| 11  | Discord DM "안녕" → 실제 Claude 응답 (Milestone A)             | 수동: Developer Portal 봇 생성 후 DM     | manual      |
| 12  | Discord "AAPL 주가" → 도구 호출 + 실제 수치 (Milestone B)      | 수동 (ALPHA_VANTAGE_KEY 필요)            | manual      |
| 13  | 재시작 후 Discord 대화 맥락 유지 (Milestone B)                 | 수동                                     | manual      |
| 14  | TUI 실시간 스트리밍 대화 (Milestone C)                         | 수동: `pnpm --filter @finclaw/tui start` | manual      |
| 15  | 기존 1282 unit test 여전히 통과                                | `pnpm test`                              | regression  |

### vitest 실행 기대 결과

```bash
# skills-general + execution-adapter + dispatcher-adapter 신규 테스트
pnpm vitest run
# 예상: 1282 + ~30 new tests = ~1312 tests passed
```

---

## 8. 의도적 제외 목록

> 본 Phase에서 구현하지 않음. 필요 시 별도 Phase 또는 post-phase로.

| 제외 항목                           | 사유                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| MCP 프로토콜 (서버/클라이언트)      | 별도 phase — 외부 생태계 붙이려면 큰 작업                                  |
| 플러그인 런타임 활성화              | `packages/server/src/plugins/loader.ts` 존재하지만 호출처 없음. 별도 phase |
| 알림 크론 데몬 자동 시작            | `skills-finance/alerts`는 등록되지만 monitor 루프는 별도 기동              |
| OpenAI-compat REST 엔드포인트       | `gateway/openai-compat/`는 어댑터만 존재, 사용 안 함                       |
| 웹 UI 채널 등록                     | TUI로 충분, Web은 post-phase                                               |
| config 파일 핫 리로드               | 재시작으로 충분                                                            |
| 새 LLM 프로바이더                   | Claude + 기존 OpenAI로 충분                                                |
| Agent 프로필 시스템 (model 선택 UI) | defaultModel 하드코딩으로 시작                                             |
| `buildSystemPrompt` 고급 활용       | 최소 문자열로 시작. 사용자 이름/관심사 주입은 Milestone D 또는 별도        |
| Discord 첨부파일/vision             | 텍스트만 지원                                                              |
| Agent 간 orchestration              | 단일 에이전트                                                              |
| Evals / observability               | 별도 phase (Langfuse 등)                                                   |
| computer use / browser use          | 범위 밖                                                                    |

---

## 9. 복잡도 및 예상 파일 수

| 항목                | 값                            |
| ------------------- | ----------------------------- |
| **복잡도**          | **L** (Large)                 |
| **신규 파일**       | 10개                          |
| **수정 파일**       | 8개                           |
| **총 파일 수**      | **18개**                      |
| **예상 LOC (신규)** | ~1100                         |
| **새 외부 의존성**  | 없음                          |
| **신규 패키지**     | 1 (`@finclaw/skills-general`) |

### 복잡도 근거 (L 판정)

- **다수 파일의 통합 변경**: main.ts 재작성 + Gateway deps 확장 + 7개 RPC 핸들러 + 신규 패키지
- **인터페이스 계약 확인 필요**: ToolRegistry/ToolHandler 시그니처 어댑터, Runner params shape, broadcaster StreamEvent 호환성
- **테스트 영향 범위**: chat.test.ts, session.test.ts 등 기존 테스트가 있다면 factory 변경으로 업데이트 필요
- **3단계 Milestone**: A/B/C 각각이 독립 PR로 커밋 가능하지만 Phase 단위로는 하나의 L 작업

### Milestone별 규모

| Milestone         | 수정/신규 파일       | 예상 LOC  | 리스크 |
| ----------------- | -------------------- | --------- | ------ |
| A (Discord MVP)   | 3 파일               | ~250      | 저     |
| B (도구 + 영속성) | 8 신규 / 3 수정      | ~550      | 중     |
| C (TUI 활성화)    | 6 수정               | ~300      | 중     |
| D (명령어 다듬기) | 2 수정               | ~80       | 저     |
| **합계**          | **10 신규 / 8 수정** | **~1180** | —      |

### OpenClaw 대비

본 Phase는 OpenClaw에 직접 대응하는 phase가 없다. OpenClaw는 각 phase 구현 시 배선을 병행하여 Phase 21 같은 "배선 전용" phase가 불필요했다. FinClaw는 phase 20까지 수직 완성을 먼저 해둔 덕에, Phase 21은 **이미 존재하는 인터페이스 간의 연결**만 책임진다.

---

## 10. 마이그레이션 / 호환성

- **기존 테스트**: `MockExecutionAdapter`를 사용하는 테스트는 유지 (stage 5 단위 테스트 목적). `RunnerExecutionAdapter`는 추가 클래스로 공존.
- **config.example.json5**: Discord/Claude 관련 env 변수 참조 추가 (이미 `channels.discord.botToken: "${env:DISCORD_TOKEN}"` 존재 확인 필요).
- **DB 마이그레이션**: `conversations` 테이블 스키마 변경 없음. `upsertConversation` 헬퍼만 추가.
- **downgrade 경로**: 문제 발생 시 `main.ts`만 phase 20 상태로 revert하면 Gateway는 여전히 기동 (기능만 비활성).
