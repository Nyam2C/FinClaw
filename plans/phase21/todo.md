# Phase 21: 비서 활성화 — Todo

## 개요

Phase 1–20에서 구축된 부품들을 배선하여 FinClaw를 실제 비서로 동작시킨다.

**신규 10개 + 수정 8개 = 18개 파일, ~1180 LOC**

### 실행 순서

```
Todo 1 (기반: RunnerExecutionAdapter + Stub)     — 독립
Todo 2 (main.ts Milestone A 배선)                — Todo 1 필요
Todo 3 (skills-general 패키지 + 3 도구)           — 독립
Todo 4 (upsertConversation + dispatcher adapter) — 독립
Todo 5 (main.ts Milestone B 확장)                — Todo 2, 3, 4 필요
Todo 6 (RPC chat/session factory)                — Todo 1 필요
Todo 7 (Gateway + main.ts Milestone C)           — Todo 5, 6 필요
Todo 8 (Milestone D: 명령어 + 에러 가시성)        — Todo 7 이후
```

권장: Todo 1 → 2 → (Milestone A 검증) → 3 → 4 → 5 → (Milestone B 검증) → 6 → 7 → (Milestone C 검증) → 8

### 각 Milestone의 정지 조건

- **A 후**: Discord DM "안녕" → Claude 응답 수신. 이 지점에서 사용자 리뷰.
- **B 후**: Discord "AAPL 주가" → 도구 호출 + 재시작 후 맥락. 사용자 리뷰.
- **C 후**: TUI에서 스트리밍 대화. 사용자 리뷰.
- **D 후**: 최종 PR 마무리.

---

## Todo 1: RunnerExecutionAdapter + Stub Provider

### 파일 목록

| 작업 | 파일 경로                                             | LOC  |
| ---- | ----------------------------------------------------- | ---- |
| 수정 | `packages/server/src/auto-reply/execution-adapter.ts` | +100 |
| 수정 | `packages/server/src/auto-reply/pipeline-context.ts`  | +30  |

### 주의사항

- `RunnerExecutionAdapter`는 **Mock 옆에 추가**. Mock은 삭제하지 않음 (기존 테스트 유지).
- Milestone A 시점에는 storage 사용하지 않음. 이력 load/save는 Todo 5에서 확장.
- `AgentRunParams`의 정확한 shape는 `packages/agent/src/execution/runner.ts` 읽어서 확인. 특히 `system`/`systemPrompt` 필드명, `messages` 역할 분기, `tools` 타입.
- `ExecutionResult.content`는 final assistant message의 text만 추출. `messages.at(-1)?.content`가 string이 아닐 수 있으므로 텍스트 블록 추출 헬퍼 필요 (예: `extractAssistantText()`).
- `StubFinanceContextProvider`의 `getMarketSession()`은 `MarketSession` 반환 — optional 아님. 빈 값이라도 객체 반환해야 함.

### 구현 스케치

#### `packages/server/src/auto-reply/execution-adapter.ts` (Todo 1 기준)

```typescript
// 기존 import 유지
import type { Runner, ModelRef, AgentRunParams } from '@finclaw/agent';

export interface RunnerExecutionAdapterDeps {
  readonly runner: Runner;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
}

export class RunnerExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly deps: RunnerExecutionAdapterDeps) {}

  async execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult> {
    const params: AgentRunParams = {
      model: this.deps.defaultModel,
      system: this.deps.systemPrompt,
      messages: [{ role: 'user', content: ctx.normalizedBody }],
      tools: [], // Todo 5에서 dispatcher.toolDefinitions 주입
      maxTurns: 10,
    };

    const result = await this.deps.runner.execute(params, undefined, signal);

    return {
      content: extractAssistantText(result.messages.at(-1)),
      usage: result.usage,
    };
  }
}

function extractAssistantText(msg: AssistantMessage | undefined): string {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
```

#### `packages/server/src/auto-reply/pipeline-context.ts` (추가)

```typescript
export class StubFinanceContextProvider implements FinanceContextProvider {
  async getActiveAlerts(): Promise<readonly Alert[]> {
    return [];
  }
  async getPortfolio(): Promise<Portfolio | null> {
    return null;
  }
  async getRecentNews(): Promise<readonly NewsItem[]> {
    return [];
  }
  async getWatchlist(): Promise<readonly string[]> {
    return [];
  }
  getMarketSession(): MarketSession {
    return {
      isOpen: false,
      market: 'NONE',
      nextOpenAt: null,
      timezone: 'Asia/Seoul',
    };
  }
}
```

### 검증

```bash
# 타입체크
pnpm typecheck

# 유닛 테스트 (기존 Mock 테스트 + 신규 RunnerExecutionAdapter 테스트)
pnpm test packages/server
```

신규 유닛 테스트 (`execution-adapter.test.ts`):

- Mock Runner를 주입하여 `adapter.execute(ctx)` 호출 시 runner.execute가 올바른 AgentRunParams로 호출되는지 확인
- assistant text 추출 로직 검증 (string / content block 배열 양쪽)

---

## Todo 2: main.ts Milestone A 배선

### 파일 목록

| 작업 | 파일 경로                     | LOC (수정 후) |
| ---- | ----------------------------- | ------------- |
| 수정 | `packages/server/src/main.ts` | ~130          |

### 주의사항

- **env 검증은 즉시 실패**: `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN` 없으면 `process.exit(1)` 후 명확한 에러 메시지.
- Discord 없이도 기동 가능하게 하려면 `DISCORD_BOT_TOKEN` 조건부로. 하지만 Milestone A의 검증은 Discord 경유. 본 Todo에서는 **둘 다 필수**로 시작 (간단함 우선).
- `DiscordAdapter`의 생성자/setup 시그니처는 `packages/channel-discord/src/adapter.ts` 읽어서 확인. 특히 intents 설정, guildIds 필수 여부.
- `MessageRouter`의 생성자는 `packages/server/src/process/message-router.ts`에서 확인. `onProcess` 시그니처 정확히 `(ctx, match, signal) => Promise<void>`.
- `AutoReplyPipeline` 생성자는 `PipelineConfig` + `PipelineDependencies` 2개 인자.
- `CommandRegistry`는 비어있는 상태로 `new CommandRegistry()` 가능한지 확인. 인스턴스가 요구하는 필수 명령어가 있다면 Todo 8로 미룸.
- **`config.example.json5` 정합성 확인**: `channels.discord.botToken`이 `"${env:DISCORD_TOKEN}"` 또는 유사 형태로 참조되는지 확인. env 변수명이 `DISCORD_BOT_TOKEN`과 일치하는지 대조 (불일치 시 어느 쪽을 정식명으로 할지 결정 후 통일). plan.md §10 참조.
- **`requireEnv`는 테스트 가능한 형태로**: `main.ts` 내부에 직접 두지 말고 별도 export 가능한 함수로 분리하여 unit test에서 process.exit를 spy 가능하게.

### 배선 순서 (코드 구조)

```typescript
// packages/server/src/main.ts
import { createLogger, getEventBus, assertPortAvailable } from '@finclaw/infra';
import { AnthropicAdapter, Runner, ConcurrencyLaneManager, InMemoryToolRegistry } from '@finclaw/agent';
import { DiscordAdapter } from '@finclaw/channel-discord';
import { ProcessLifecycle } from './process/lifecycle.js';
import { MessageRouter } from './process/message-router.js';
import { AutoReplyPipeline } from './auto-reply/pipeline.js';
import { RunnerExecutionAdapter } from './auto-reply/execution-adapter.js';
import { StubFinanceContextProvider } from './auto-reply/pipeline-context.js';
import { CommandRegistry } from './auto-reply/commands/registry.js';
import { createGatewayServer } from './gateway/server.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[fatal] Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  // 1. env
  const anthropicKey = requireEnv('ANTHROPIC_API_KEY');
  const discordToken = requireEnv('DISCORD_BOT_TOKEN');

  // 2. 기반
  const logger = createLogger({ name: 'finclaw', level: 'info' });
  const lifecycle = new ProcessLifecycle({ logger });

  // 3. Agent 레이어
  const anthropicAdapter = new AnthropicAdapter({ apiKey: anthropicKey });
  const emptyDispatcher = /* Milestone A: 빈 dispatcher. Todo 5에서 real dispatcher로 교체 */;
  const lanes = new ConcurrencyLaneManager(/* default */);
  const runner = new Runner({
    provider: anthropicAdapter,
    dispatcher: emptyDispatcher,
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
  const adapter = new RunnerExecutionAdapter({ runner, defaultModel, systemPrompt });

  // 5. 파이프라인
  const financeCtxProvider = new StubFinanceContextProvider();
  const commandRegistry = new CommandRegistry();
  const channelPluginRegistry = new Map<string, ChannelPlugin>();
  const pipeline = new AutoReplyPipeline(
    {
      enableAck: true,
      commandPrefix: '!finclaw ',
      maxResponseLength: 2000,
      timeoutMs: 60_000,
      respectMarketHours: false,
    },
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

  // 7. Discord
  const discordAdapter = new DiscordAdapter();
  const cleanup = await discordAdapter.setup({ botToken: discordToken });
  lifecycle.register(cleanup);
  channelPluginRegistry.set('discord', discordAdapter);
  discordAdapter.onMessage((msg) => router.route(msg));
  logger.info('Discord adapter connected');

  // 8. Gateway (기존 로직 유지 — deps 확장은 Todo 7)
  await assertPortAvailable(defaultConfig.port);
  const gateway = createGatewayServer(defaultConfig);
  lifecycle.register(() => gateway.stop());
  lifecycle.init();
  await gateway.start();
  logger.info(`Gateway listening on ${defaultConfig.host}:${defaultConfig.port}`);
  getEventBus().emit('system:ready');
}

main().catch((err) => {
  console.error('Failed to start gateway server:', err);
  process.exit(1);
});
```

### 검증 (Milestone A)

**Unit test (우선)**:

- `requireEnv('ANTHROPIC_API_KEY')` — 미설정 시 `process.exit(1)` 호출 확인 (vitest `vi.spyOn(process, 'exit')` + `console.error` spy).
- `requireEnv('DISCORD_BOT_TOKEN')` — 동일 패턴.

**수동 검증 (Discord)**:

1. `.env` 작성:
   ```
   ANTHROPIC_API_KEY=sk-...
   DISCORD_BOT_TOKEN=...
   DISCORD_CLIENT_ID=...
   ```
2. Discord Developer Portal에서:
   - Bot 생성 + Token 복사
   - **Privileged Gateway Intents → Message Content Intent 활성화**
   - OAuth2 URL Generator → `bot` scope + `Send Messages` 권한 → 개인 서버 초대 (또는 DM을 위해 봇을 친구 추가)
3. `pnpm dev` 실행
4. 로그 확인:
   ```
   finclaw - Discord adapter connected
   finclaw - Gateway listening on 0.0.0.0:3000
   ```
5. Discord 봇에게 DM "안녕"
6. 수 초 내 실제 Claude 응답 수신

**실패 시 체크 리스트**:

- 봇 본문이 빈 문자열로 옴 → Message Content Intent 미활성화
- "Unknown API" 에러 → API 키 오타
- 봇이 메시지를 못 받음 → `messageCreate` 이벤트 리스너가 등록되었는지 adapter 로그 확인

---

## Todo 3: skills-general 패키지 + 3 도구

### 파일 목록

| 작업 | 파일 경로                                  | LOC                        |
| ---- | ------------------------------------------ | -------------------------- |
| 신규 | `packages/skills-general/package.json`     | ~20                        |
| 신규 | `packages/skills-general/tsconfig.json`    | ~15                        |
| 신규 | `packages/skills-general/src/index.ts`     | ~30                        |
| 신규 | `packages/skills-general/src/datetime.ts`  | ~50                        |
| 신규 | `packages/skills-general/src/web-fetch.ts` | ~90                        |
| 신규 | `packages/skills-general/src/file-read.ts` | ~70                        |
| 수정 | `tsconfig.json` (루트)                     | +1                         |
| 수정 | `pnpm-workspace.yaml`                      | (글롭 포함 시 수정 불필요) |

### 주의사항

- `skills-finance`의 구조 재사용: `packages/skills-finance/src/market/index.ts` 참조.
- 도구 시그니처는 `RegisteredToolDefinition` + `ToolExecutor`. `packages/agent/src/agents/tools/registry.ts` 읽어서 정확한 타입 확인.
- `web_fetch`의 SSRF 가드는 `@finclaw/infra`에 유틸 존재 여부 먼저 확인. 없으면 인라인 구현 (사설 대역 차단만: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, ::1).
- `read_local_file`은 `path.resolve(FILE_ROOT, userPath)` → `path.relative(FILE_ROOT, resolved)`가 `..`로 시작하면 거부.
- `get_current_datetime`은 `Intl.DateTimeFormat` 사용. Asia/Seoul 기본.
- **`pnpm-workspace.yaml` 선행 확인**: Read 툴로 `pnpm-workspace.yaml`을 먼저 읽어 `packages:` 항목이 `packages/*` 와일드카드 글롭인지, 명시적 화이트리스트인지 확인. 와일드카드면 수정 불필요. 명시적 리스트면 `packages/skills-general`을 추가해야 `pnpm install`이 신규 패키지를 인식.

### 구현 스케치

#### `packages/skills-general/package.json`

```json
{
  "name": "@finclaw/skills-general",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@finclaw/agent": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "@finclaw/types": "workspace:*",
    "zod": "^4.0.0"
  }
}
```

#### `packages/skills-general/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../agent" }, { "path": "../infra" }, { "path": "../types" }]
}
```

#### `packages/skills-general/src/index.ts`

```typescript
import type { ToolRegistry } from '@finclaw/agent';
import { registerDatetimeTool } from './datetime.js';
import { registerWebFetchTool } from './web-fetch.js';
import { registerFileReadTool } from './file-read.js';

export interface GeneralSkillConfig {
  readonly fileRoot?: string;
  readonly webFetchMaxBytes?: number;
  readonly webFetchTimeoutMs?: number;
}

export function registerGeneralTools(
  registry: ToolRegistry,
  config: GeneralSkillConfig = {},
): void {
  registerDatetimeTool(registry);
  registerWebFetchTool(registry, {
    maxBytes: config.webFetchMaxBytes ?? 100_000,
    timeoutMs: config.webFetchTimeoutMs ?? 10_000,
  });
  registerFileReadTool(registry, {
    fileRoot: config.fileRoot ?? resolveDefaultFileRoot(),
    maxBytes: 100_000,
  });
}

export const GENERAL_SKILL_METADATA = {
  name: '@finclaw/skills-general',
  version: '0.1.0',
  tools: ['get_current_datetime', 'web_fetch', 'read_local_file'],
} as const;

function resolveDefaultFileRoot(): string {
  return process.env.FINCLAW_FILE_ROOT ?? `${process.env.HOME}/.finclaw/workspace`;
}
```

#### `packages/skills-general/src/datetime.ts`

```typescript
import { z } from 'zod';
import type { ToolRegistry, RegisteredToolDefinition, ToolExecutor } from '@finclaw/agent';

const inputSchema = z.object({
  timezone: z.string().optional(),
});

export function registerDatetimeTool(registry: ToolRegistry): void {
  const definition: RegisteredToolDefinition = {
    name: 'get_current_datetime',
    description:
      '현재 날짜와 시간을 ISO 8601 형식으로 반환합니다. timezone 지정 가능 (기본: Asia/Seoul)',
    inputSchema,
    group: 'general',
    timeoutMs: 1_000,
    isExternal: false,
  };

  const executor: ToolExecutor = async (input) => {
    const parsed = inputSchema.parse(input);
    const tz = parsed.timezone ?? 'Asia/Seoul';
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    return {
      ok: true,
      data: { iso: now.toISOString(), localized: formatter.format(now), timezone: tz },
    };
  };

  registry.register(definition, executor, 'skill');
}
```

#### `packages/skills-general/src/web-fetch.ts`

```typescript
import { z } from 'zod';
import type { ToolRegistry, RegisteredToolDefinition, ToolExecutor } from '@finclaw/agent';

const inputSchema = z.object({
  url: z.string().url(),
  max_bytes: z.number().int().min(1).max(1_000_000).optional(),
});

const PRIVATE_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

function isPrivateHost(host: string): boolean {
  return PRIVATE_HOSTS.some((re) => re.test(host));
}

export interface WebFetchConfig {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export function registerWebFetchTool(registry: ToolRegistry, config: WebFetchConfig): void {
  const definition: RegisteredToolDefinition = {
    name: 'web_fetch',
    description: '공개 URL의 텍스트 콘텐츠를 가져옵니다. HTML의 경우 텍스트만 추출합니다.',
    inputSchema,
    group: 'general',
    timeoutMs: config.timeoutMs + 1_000,
    isExternal: true,
    accessesSensitiveData: false,
  };

  const executor: ToolExecutor = async (input) => {
    const parsed = inputSchema.parse(input);
    const url = new URL(parsed.url);
    if (isPrivateHost(url.hostname)) {
      return {
        ok: false,
        error: 'PRIVATE_HOST_BLOCKED',
        message: `private/internal host: ${url.hostname}`,
      };
    }
    const maxBytes = parsed.max_bytes ?? config.maxBytes;
    const signal = AbortSignal.timeout(config.timeoutMs);
    const response = await fetch(url, { signal, redirect: 'follow' });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) break;
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const contentType = response.headers.get('content-type') ?? 'text/plain';
    let body = buf.toString('utf-8').slice(0, maxBytes);
    if (contentType.includes('html')) {
      body = stripHtml(body);
    }
    return {
      ok: true,
      data: { status: response.status, contentType, body, truncated: total > maxBytes },
    };
  };

  registry.register(definition, executor, 'skill');
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

#### `packages/skills-general/src/file-read.ts`

```typescript
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ToolRegistry, RegisteredToolDefinition, ToolExecutor } from '@finclaw/agent';

const inputSchema = z.object({
  path: z.string().min(1),
  max_bytes: z.number().int().min(1).max(1_000_000).optional(),
});

export interface FileReadConfig {
  readonly fileRoot: string;
  readonly maxBytes: number;
}

export function registerFileReadTool(registry: ToolRegistry, config: FileReadConfig): void {
  const definition: RegisteredToolDefinition = {
    name: 'read_local_file',
    description: `로컬 파일을 읽습니다. 안전 루트(${config.fileRoot}) 하위의 파일만 접근 가능합니다.`,
    inputSchema,
    group: 'general',
    timeoutMs: 2_000,
    isExternal: false,
    accessesSensitiveData: true,
  };

  const executor: ToolExecutor = async (input) => {
    const parsed = inputSchema.parse(input);
    const userPath = parsed.path;
    if (isAbsolute(userPath)) {
      return {
        ok: false,
        error: 'ABSOLUTE_PATH_NOT_ALLOWED',
        message: 'only relative paths under FILE_ROOT allowed',
      };
    }
    const resolved = resolve(config.fileRoot, userPath);
    const rel = relative(config.fileRoot, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { ok: false, error: 'PATH_TRAVERSAL_BLOCKED', message: 'path escapes FILE_ROOT' };
    }
    const real = await realpath(resolved).catch(() => resolved);
    const realRel = relative(config.fileRoot, real);
    if (realRel.startsWith('..')) {
      return { ok: false, error: 'SYMLINK_BLOCKED', message: 'symlink escapes FILE_ROOT' };
    }
    const maxBytes = parsed.max_bytes ?? config.maxBytes;
    const buf = await readFile(resolved);
    const content = buf.slice(0, maxBytes).toString('utf-8');
    return {
      ok: true,
      data: { path: userPath, bytes: buf.length, content, truncated: buf.length > maxBytes },
    };
  };

  registry.register(definition, executor, 'skill');
}
```

### 검증

```bash
pnpm build
pnpm typecheck
pnpm test packages/skills-general  # 단위 테스트 추가 권장
```

단위 테스트 케이스:

- `get_current_datetime` — timezone 파라미터 적용, 포맷 확인
- `web_fetch` — `http://10.0.0.1` 거부 확인, `https://example.com` 성공 (or mock fetch)
- `read_local_file` — `../../../etc/passwd` 거부, 정상 파일 읽기, 심볼릭 링크 거부

---

## Todo 4: upsertConversation + Tool Dispatcher Adapter

### 파일 목록

| 작업 | 파일 경로                                                   | LOC |
| ---- | ----------------------------------------------------------- | --- |
| 수정 | `packages/storage/src/tables/conversations.ts`              | +40 |
| 신규 | `packages/server/src/auto-reply/tool-dispatcher-adapter.ts` | ~80 |

### 주의사항

- `upsertConversation`은 기존 `getConversation` + (`createConversation` or `updateConversation`) 패턴의 래퍼. SQLite의 `INSERT ON CONFLICT`를 직접 사용할 수도 있으나, 기존 CRUD 패턴 재사용이 더 안전.
- `ToolRegistry.execute(name, input, ctx)`의 ctx 타입 확인 필수. `ToolExecutionContext`로 추정되나 실제 파일 읽어서 확인.
- Dispatcher는 **per-request**로 생성: `buildDispatcher(registry, contextFactory)`. contextFactory가 호출 시점에 `sessionId`/`signal`/`userId`를 캡처.
- `ExecutionToolDispatcher`의 정확한 인터페이스는 `packages/agent/src/execution/` 디렉토리에서 확인. `ToolHandler` 타입 포함.

### 구현 스케치

#### `packages/storage/src/tables/conversations.ts` (추가)

```typescript
export async function upsertConversation(
  db: DatabaseSync,
  payload: ConversationUpsertPayload,
): Promise<void> {
  const existing = getConversation(db, payload.sessionKey);
  if (existing) {
    updateConversation(db, payload.sessionKey, {
      messages: payload.messages,
      updatedAt: payload.updatedAt,
      agentId: payload.agentId,
    });
  } else {
    createConversation(db, {
      sessionKey: payload.sessionKey,
      agentId: payload.agentId,
      messages: payload.messages,
      createdAt: payload.updatedAt,
      updatedAt: payload.updatedAt,
    });
  }
}
```

#### `packages/server/src/auto-reply/tool-dispatcher-adapter.ts`

```typescript
import type {
  ToolRegistry,
  ExecutionToolDispatcher,
  ToolHandler,
  ToolExecutionContext,
} from '@finclaw/agent';
import type { FinClawLogger } from '@finclaw/infra';

export interface DispatcherContextBase {
  readonly sessionId: string;
  readonly userId?: string;
  readonly logger: FinClawLogger;
}

export function buildDispatcher(
  registry: ToolRegistry,
  contextBase: DispatcherContextBase,
): ExecutionToolDispatcher {
  const handlers: ToolHandler[] = [];
  for (const definition of registry.list()) {
    handlers.push({
      name: definition.name,
      async execute(input, signal) {
        const ctx: ToolExecutionContext = { ...contextBase, signal };
        const result = await registry.execute(definition.name, input, ctx);
        return JSON.stringify(result);
      },
    });
  }
  return {
    toolDefinitions: registry.list().map(toApiToolDefinition),
    handlers,
  };
}
```

(실제 `ExecutionToolDispatcher`/`ToolHandler` 타입에 맞춰 조정 필요 — 구현 시 Read로 시그니처 확인 후 정확히 맞출 것.)

### 검증

- `upsertConversation` 테스트: 동일 sessionKey 2회 호출 시 update 경로 탄다 + 한 번만 존재
- `buildDispatcher` 테스트: 등록된 도구 목록이 handlers에 포함, 각 handler 실행 시 registry.execute 호출

---

## Todo 5: main.ts Milestone B 확장 (도구 + Storage)

### 파일 목록

| 작업 | 파일 경로                                             | LOC (수정 후)   |
| ---- | ----------------------------------------------------- | --------------- |
| 수정 | `packages/server/src/main.ts`                         | ~170            |
| 수정 | `packages/server/src/auto-reply/execution-adapter.ts` | +50 (load/save) |
| 수정 | `packages/server/package.json`                        | deps 추가       |

### 주의사항

- `main.ts`는 Todo 2 base 위에 배선 확장. 기존 구조 유지하고 중간에 도구 등록 + storage 주입.
- `registerMarketTools`/`registerNewsTools`/`registerAlertTools`의 config 시그니처는 각 스킬의 index.ts에서 확인.
  - Market: Alpha Vantage/CoinGecko/Frankfurter provider 의존. API 키 없으면 provider 인스턴스화 skip.
  - News: NewsAPI/AlphaVantage/RSS. 조건부.
  - Alerts: DB 필요. storage 주입.
- `RunnerExecutionAdapter`에 `storage` + `buildToolDispatcher` 추가 주입. `execute()` 확장:
  - 이력 load (`storage.getConversation`)
  - dispatcher build per-request
  - runner.execute 후 upsert
- `Runner`의 dispatcher는 **생성자에서 고정**될 수 있으므로, 실제로는 `runner.execute` 호출 시점에 params로 dispatcher를 전달할지 확인. 만약 생성자 고정이면 Runner 인스턴스를 매 요청마다 만들거나, Runner의 dispatcher를 mutable로 교체하거나, Runner 자체를 수정해야 함. → **Runner 구현 읽고 결정**. 가장 간단한 경로: Runner가 `run(params)` 받을 때 params에 dispatcher 포함하도록 확장 (만약 이미 지원하면 그대로 사용).
- **dispatcher 주입 방식 차이 (plan.md §4.1과의 의도적 편차)**: plan.md §4.1은 `buildToolDispatcher: (sessionId, signal) => ExecutionToolDispatcher` 팩토리를 adapter deps로 주입하는 방식을 제시하지만, 본 Todo는 `toolRegistry`를 직접 주입하여 `adapter.execute()` 내부에서 per-request `buildDispatcher(registry, ctx)`를 호출한다. **이유**: (a) 클로저 캡처 시점을 adapter 내부로 모아 `signal`/`sessionId`/`userId` 전파 실수 방지, (b) 단위 테스트에서 `toolRegistry` mock 하나만으로 dispatcher 경로까지 한 번에 커버. 두 방식은 행위가 동일하므로 선택 편차이며, 이후 플러그인 기반 dispatcher 스왑이 필요할 때 plan.md 방식으로 리팩토링 가능.

### 배선 추가 부분 (Todo 2 코드 위에 추가)

```typescript
// 2.5. 도구 레지스트리 + 스킬 등록 (Todo 2의 (3) Agent 레이어 확장)
import { createStorage } from '@finclaw/storage';
import { registerMarketTools } from '@finclaw/skills-finance/market';
import { registerNewsTools } from '@finclaw/skills-finance/news';
import { registerAlertTools } from '@finclaw/skills-finance/alerts';
import { registerGeneralTools } from '@finclaw/skills-general';

const dbPath = process.env.FINCLAW_DB_PATH ?? `${process.env.HOME}/.finclaw/db.sqlite`;
const storage = await createStorage({ dbPath });
lifecycle.register(() => storage.close());

const toolRegistry = new InMemoryToolRegistry({ logger });

// 범용 도구 — 항상 등록
registerGeneralTools(toolRegistry);

// 금융 도구 — API 키 있을 때만
if (process.env.ALPHA_VANTAGE_KEY || process.env.COINGECKO_API_KEY) {
  registerMarketTools(toolRegistry, {
    alphaVantageKey: process.env.ALPHA_VANTAGE_KEY,
    coingeckoKey: process.env.COINGECKO_API_KEY,
    logger,
  });
}
if (process.env.NEWS_API_KEY || process.env.ALPHA_VANTAGE_KEY) {
  registerNewsTools(toolRegistry, {
    newsApiKey: process.env.NEWS_API_KEY,
    alphaVantageKey: process.env.ALPHA_VANTAGE_KEY,
    logger,
  });
}
registerAlertTools(toolRegistry, { storage, logger });

// 4. 어댑터 확장
const adapter = new RunnerExecutionAdapter({
  runner,
  defaultModel,
  systemPrompt,
  storage,
  toolRegistry, // execute() 안에서 per-request dispatcher 빌드
  logger,
});
```

#### `execution-adapter.ts` 확장

```typescript
async execute(ctx: PipelineMsgContext, signal: AbortSignal): Promise<ExecutionResult> {
  const sessionKey = ctx.sessionKey;
  const prior = await this.deps.storage.getConversation(sessionKey);
  const priorMessages = (prior?.messages ?? []).slice(-20);

  const dispatcher = buildDispatcher(this.deps.toolRegistry, {
    sessionId: sessionKey,
    userId: ctx.senderId,
    logger: this.deps.logger,
  });

  const params: AgentRunParams = {
    model: this.deps.defaultModel,
    system: this.deps.systemPrompt,
    messages: [...priorMessages, { role: 'user', content: ctx.normalizedBody }],
    tools: dispatcher.toolDefinitions,
    dispatcher,  // Runner가 params로 받는 경우
    maxTurns: 10,
  };

  const result = await this.deps.runner.execute(params, undefined, signal);

  await upsertConversation(this.deps.storage.db, {
    sessionKey,
    agentId: ctx.agentId ?? 'default',
    messages: [...params.messages, ...result.newMessages],
    updatedAt: Date.now(),
  });

  return {
    content: extractAssistantText(result.messages.at(-1)),
    usage: result.usage,
  };
}
```

### 검증 (Milestone B)

1. `.env`에 `ALPHA_VANTAGE_KEY` 추가 (무료 티어 키 발급)
2. `pnpm dev` 재시작
3. Discord DM "지금 몇 시야?" → `get_current_datetime` 호출 결과 응답
4. Discord DM "AAPL 주가 알려줘" → `get_stock_price` 호출 + 실제 수치
5. Discord DM 3턴 대화 → 서버 재시작 → "방금 뭐 물어봤지?" → 이전 맥락 기반 응답
6. `sqlite3 ~/.finclaw/db.sqlite "SELECT sessionKey, length(messages) FROM conversations"` 로 이력 저장 확인

---

## Todo 6: RPC chat/session factory

### 파일 목록

| 작업 | 파일 경로                                            | LOC  |
| ---- | ---------------------------------------------------- | ---- |
| 수정 | `packages/server/src/gateway/rpc/methods/chat.ts`    | ~180 |
| 수정 | `packages/server/src/gateway/rpc/methods/session.ts` | ~100 |
| 수정 | `packages/server/src/gateway/rpc/types.ts`           | +4   |

### 주의사항

- `registerChatMethods()` → `createChatMethods(deps): RpcMethodHandler[]`로 변경. `server.ts`에서 배열을 순회하며 `registerMethod()` 호출.
- 기존 테스트가 있다면 factory 기반으로 업데이트 필요. `packages/server/src/gateway/rpc/methods/` 아래 `.test.ts` 파일 존재 여부 확인.
- `session.get`의 반환 shape은 TUI `App.tsx:58`이 `{ model }`로 destructure하므로 `{ sessionId, agentId, model: string, status, startedAt }` 최소 필드 필요.
- `ActiveSession`에 `model: ModelRef`, `sessionKey: SessionKey` 추가. 기존 구조는 수정 최소화.
- `chat.send`는 TUI 전용 경로로 `adapter.executeForTui()` 호출 (Todo 7에서 `executeForTui` 구현).

### 구현 스케치 (chat.ts 대표)

```typescript
import type { RpcMethodHandler } from '../types.js';
import type { ChatRegistry } from '../chat-registry.js';
import type { GatewayBroadcaster } from '../broadcaster.js';
import type { WsConnection } from '../ws/connection.js';
import type { RunnerExecutionAdapter } from '../../auto-reply/execution-adapter.js';
import type { ModelRef } from '@finclaw/agent';

export interface ChatMethodsDeps {
  readonly registry: ChatRegistry;
  readonly connections: Map<string, WsConnection>;
  readonly broadcaster: GatewayBroadcaster;
  readonly adapter: RunnerExecutionAdapter;
  readonly defaultModel: ModelRef;
  readonly systemPrompt: string;
  readonly storage: StorageAdapter;
}

export interface SessionMethodsDeps {
  readonly registry: ChatRegistry;
  readonly storage: StorageAdapter;
}

export function createChatMethods(deps: ChatMethodsDeps): RpcMethodHandler<any, any>[] {
  return [
    {
      method: 'chat.start',
      description: '새 채팅 세션을 시작합니다',
      authLevel: 'token',
      schema: z.object({ agentId: z.string(), model: z.string().optional() }),
      async execute(params, ctx) {
        const sessionKey = deriveTuiSessionKey(ctx.userId ?? 'anon', params.agentId);
        const session = deps.registry.startSession({
          agentId: params.agentId,
          connectionId: ctx.connectionId!,
          model: deps.defaultModel,
          sessionKey,
        });
        return { sessionId: session.sessionId };
      },
    },
    {
      method: 'chat.send',
      description: '활성 세션에 메시지를 전송합니다',
      authLevel: 'session',
      schema: z.object({
        sessionId: z.string(),
        message: z.string(),
        idempotencyKey: z.string().optional(),
      }),
      async execute(params, _ctx) {
        const session = deps.registry.getSession(params.sessionId);
        if (!session) throw new Error('session not found');
        const conn = deps.connections.get(session.connectionId);
        if (!conn) throw new Error('connection lost');

        const signal = AbortSignal.timeout(60_000);
        const listener = (event: StreamEvent) =>
          deps.broadcaster.send(conn, session.sessionId, event);

        const result = await deps.adapter.executeForTui(
          {
            model: session.model,
            system: deps.systemPrompt,
            messages: [{ role: 'user', content: params.message }],
            tools: [], // adapter 내부에서 registry 기반 dispatcher 빌드
            maxTurns: 10,
          },
          listener,
          session.sessionKey,
          signal,
        );
        return { messageId: result.messageId };
      },
    },
    {
      method: 'chat.stop',
      description: '활성 세션을 중단합니다',
      authLevel: 'session',
      schema: z.object({ sessionId: z.string() }),
      async execute(params) {
        const stopped = deps.registry.stopSession(params.sessionId);
        return { stopped };
      },
    },
    {
      method: 'chat.history',
      description: '세션의 대화 이력을 조회합니다',
      authLevel: 'token',
      schema: z.object({
        sessionId: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      async execute(params) {
        const session = deps.registry.getSession(params.sessionId);
        if (!session) return { messages: [] };
        const conversation = await deps.storage.getConversation(session.sessionKey);
        const limit = params.limit ?? 100;
        return { messages: (conversation?.messages ?? []).slice(-limit) };
      },
    },
  ];
}
```

#### 구현 스케치 (session.ts)

```typescript
import type { RpcMethodHandler } from '../types.js';
import type { SessionMethodsDeps } from './types.js';
import { z } from 'zod';

export function createSessionMethods(deps: SessionMethodsDeps): RpcMethodHandler<any, any>[] {
  return [
    {
      method: 'session.get',
      description: '세션 메타데이터를 조회합니다',
      authLevel: 'token',
      schema: z.object({ sessionId: z.string() }),
      async execute(params) {
        const session = deps.registry.getSession(params.sessionId);
        if (!session) throw new RpcError('session not found', -32004);
        // TUI App.tsx:58은 `{ model }`을 destructure — string 필드로 평탄화
        return {
          sessionId: session.sessionId,
          agentId: session.agentId,
          model: session.model.model,
          status: session.status,
          startedAt: session.startedAt,
        };
      },
    },
    {
      method: 'session.reset',
      description: '세션 상태와 대화 이력을 초기화합니다',
      authLevel: 'session',
      schema: z.object({ sessionId: z.string() }),
      async execute(params) {
        const session = deps.registry.getSession(params.sessionId);
        if (!session) throw new RpcError('session not found', -32004);
        await deps.storage.deleteConversation(session.sessionKey);
        deps.registry.resetSession(params.sessionId);
        return { reset: true };
      },
    },
    {
      method: 'session.list',
      description: '현재 연결의 활성 세션 목록을 반환합니다',
      authLevel: 'token',
      schema: z.object({}).optional(),
      async execute(_params, ctx) {
        const sessions = deps.registry.listSessionsByConnection(ctx.connectionId!);
        return {
          sessions: sessions.map((s) => ({
            sessionId: s.sessionId,
            agentId: s.agentId,
            model: s.model.model,
            status: s.status,
            startedAt: s.startedAt,
          })),
        };
      },
    },
  ];
}
```

**주의**:

- `registry.resetSession` / `registry.listSessionsByConnection`이 ChatRegistry에 존재하는지 확인. 없으면 Todo 6 범위 내에서 추가 (Phase 11에서 이미 구현되어 있을 가능성 있음 — Read로 먼저 확인).
- `session.reset`은 `storage.deleteConversation`을 호출하므로 `StorageAdapter`에 해당 메서드 존재 여부 확인. 없으면 Todo 4에서 함께 추가 고려.
- 반환 shape의 `model: string`은 TUI destructure 계약. `ModelRef` 객체 전체를 노출하지 말 것 (내부 구조 누설 방지).

### 검증

```bash
pnpm test packages/server
```

- 기존 chat/session 테스트가 있다면 factory 기반으로 업데이트
- 신규 테스트: mock deps로 4개 핸들러 각각 실행 검증

---

## Todo 7: Gateway + main.ts Milestone C (TUI 활성화)

### 파일 목록

| 작업 | 파일 경로                                             | LOC                 |
| ---- | ----------------------------------------------------- | ------------------- |
| 수정 | `packages/server/src/gateway/server.ts`               | +30                 |
| 수정 | `packages/server/src/main.ts`                         | ~180 최종           |
| 수정 | `packages/server/src/auto-reply/execution-adapter.ts` | +70 (executeForTui) |

### 주의사항

- `createGatewayServer(config, deps)` 시그니처 확장. `deps`는 `ChatMethodsDeps` + `SessionMethodsDeps` 의 union (또는 공통 subset).
- `createChatMethods(deps)` 호출 후 반환된 배열을 `ctx` 생성 시점에 `registerMethod()` 루프로 등록. 기존 `registerChatMethods()` 호출 제거.
- `RunnerExecutionAdapter.executeForTui` 구현:
  - storage 이력 load
  - `runner.execute(params, listener, signal)` 호출 (Runner가 `StreamEventListener` 받는지 확인 — 이미 받음)
  - 완료 후 upsert
  - `messageId` 생성 (crypto.randomUUID)

### `executeForTui` 구현 스케치

```typescript
async executeForTui(
  params: AgentRunParams,
  listener: StreamEventListener,
  sessionKey: SessionKey,
  signal: AbortSignal,
): Promise<{ messageId: string }> {
  const prior = await this.deps.storage.getConversation(sessionKey);
  const priorMessages = (prior?.messages ?? []).slice(-20);

  const dispatcher = buildDispatcher(this.deps.toolRegistry, {
    sessionId: sessionKey,
    logger: this.deps.logger,
  });

  const finalParams: AgentRunParams = {
    ...params,
    messages: [...priorMessages, ...params.messages],
    tools: dispatcher.toolDefinitions,
    dispatcher,
  };

  const result = await this.deps.runner.execute(finalParams, listener, signal);

  await upsertConversation(this.deps.storage.db, {
    sessionKey,
    agentId: params.agentId ?? 'default',
    messages: [...finalParams.messages, ...result.newMessages],
    updatedAt: Date.now(),
  });

  return { messageId: crypto.randomUUID() };
}
```

### main.ts 최종 (Gateway deps 전달)

```typescript
// 8. Gateway
const gatewayConfig = {
  ...defaultConfig,
  auth: {
    ...defaultConfig.auth,
    apiKeys: process.env.FINCLAW_API_KEY ? [process.env.FINCLAW_API_KEY] : [],
  },
};
await assertPortAvailable(gatewayConfig.port);
const gateway = createGatewayServer(gatewayConfig, {
  adapter,
  defaultModel,
  systemPrompt,
  storage,
});
lifecycle.register(() => gateway.stop());
lifecycle.init();
await gateway.start();
```

### 검증 (Milestone C)

1. `.env`에 `FINCLAW_API_KEY=dev-key-1` 추가, 재시작
2. 별도 터미널에서 TUI 실행:
   ```bash
   pnpm --filter @finclaw/tui start -- --url ws://localhost:3000 --token dev-key-1 --agent default
   ```
3. TUI 상단 상태바에 "connected, model: claude-sonnet-4-5"
4. "안녕" 입력 → 스트리밍 응답 실시간 표시
5. "/market" → 시장 뷰 전환 (기존 UI 동작)
6. `/quit` → 정상 종료
7. 재접속 후 `chat.history` 검증 — 이전 대화 반환

---

## Todo 8: Milestone D — 명령어 + 에러 가시성

### 파일 목록

| 작업 | 파일 경로                                                                | LOC |
| ---- | ------------------------------------------------------------------------ | --- |
| 수정 | `packages/server/src/auto-reply/commands/registry.ts` (또는 신규 명령어) | +50 |
| 수정 | `packages/server/src/auto-reply/execution-adapter.ts`                    | +20 |

### 주의사항

- `CommandRegistry`의 명령어 추가 API 확인. `!finclaw reset/status` 2개만.
- 에러 가시성: `RunnerExecutionAdapter.execute` 내부 try/catch로 감싸고, 에러 발생 시 `content`에 "⚠️ 에러: [message]" 형식으로 반환. 이게 Discord로 전달됨.

### 명령어 구현 스케치

```typescript
// reset: 현재 sessionKey의 대화 삭제
commandRegistry.register({
  name: 'reset',
  description: '현재 대화 이력을 초기화합니다',
  async execute(ctx) {
    await storage.deleteConversation(ctx.sessionKey);
    return { reply: '대화 이력을 초기화했습니다.' };
  },
});

// status: 서버 상태
commandRegistry.register({
  name: 'status',
  description: '서버 상태를 조회합니다',
  async execute(_ctx) {
    const activeSessions = chatRegistry.listSessions().length;
    const uptime = Math.floor(process.uptime());
    return { reply: `✅ 가동 중 · 세션 ${activeSessions}개 · uptime ${uptime}s` };
  },
});
```

### 에러 가시성 (adapter.execute 개선)

```typescript
async execute(ctx, signal): Promise<ExecutionResult> {
  try {
    // ... 기존 로직
  } catch (err) {
    this.deps.logger.error('Runner execution failed', err);
    const message = err instanceof Error ? err.message : 'unknown error';
    return {
      content: `⚠️ AI 응답 생성 중 오류가 발생했습니다: ${message}`,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
```

### 검증

- Discord "!finclaw reset" → 이력 삭제 확인 + 다음 질문 시 맥락 없음
- Discord "!finclaw status" → 상태 메시지 응답
- Anthropic API 키 제거하고 재시작 → 질문 시 경고 메시지 응답 (기동은 실패해야 하므로 이 경우는 맥락을 바꿔서 테스트: 예 — 일시적으로 잘못된 모델 지정)

---

## 최종 체크리스트

```bash
pnpm build         # tsc --build
pnpm typecheck     # tsgo --noEmit
pnpm lint          # oxlint
pnpm format        # oxfmt --check
pnpm test          # 1282 + 신규 = ~1312
pnpm test:storage  # storage 테스트 (upsertConversation 포함)
```

모두 통과하고 4개 수동 검증 (Milestone A/B/C/D) 완료 시 Phase 21 종료.

### 커밋 단위

- Milestone A 후: `feat(server): activate auto-reply pipeline with discord wiring (phase 21, milestone A)`
- Milestone B 후: `feat(skills-general): add general-purpose tools + conversation persistence (phase 21, milestone B)`
- Milestone C 후: `feat(gateway): wire chat/session RPC factories for TUI streaming (phase 21, milestone C)`
- Milestone D 후: `feat(server): add reset/status commands and user-visible error messages (phase 21, milestone D)`
