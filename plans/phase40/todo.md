# Phase 40 Todo: Claude 구독(CLI)-only + MCP 도구로 "먼저 작동"

> `plans/phase40/plan.md` (승인본) 의 밀스톤 A/B/C/D/E 를 코드 단위로 분해한 작업 가이드.
> base = main HEAD `d5db716` (phase39 #74). 아키텍처 = **C: in-process HTTP MCP** (plan §1 확정).
> 모드 B (자동 코드 적용). 밀스톤당 1커밋, 각 밀스톤 = typecheck+build+test+lint green.
> 테스트 = **mock-only** (실 키/네트워크/라이브 CLI 금지). baseline: unit **1679** / storage 154 — 신규 테스트로 증가 OK, 회귀 금지.

---

## ⚠️ 분해 전 확정 사실 (조사 완료 — implementer 는 재조사 불필요)

이 todo 의 코드는 다음 실측에 기반한다. 그대로 따르면 된다.

1. **gateway 패키지 = `packages/gateway/src/`** (phase39 추출). 파일 헤더 주석은 `packages/server/src/gateway/...` 로 stale 하지만 실제 경로는 `packages/gateway/src/...`. **헤더 주석은 건드리지 말 것** (CLAUDE.md §3, plan §6 외과적 변경; stale 헤더 정리는 phase39 P3 백로그이지 phase40 범위 아님).
2. **MCP SDK (`@modelcontextprotocol/sdk@1.29.0`) 는 현재 `packages/server` 의존성** (`packages/server/package.json:24`). gateway 에는 없음 → **밀스톤 A 에서 gateway 에 의존성 추가** (gateway 가 이미 `ws`/`zod`/`chokidar` 를 직접 의존하듯, `/mcp` 가 gateway HTTP 라우트이므로 gateway 가 소유).
3. **MCP SDK 서버 API (실측):**
   - `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'` → `registerTool(name, { description, inputSchema, ... }, cb)`. `inputSchema` 는 **Zod raw shape**(`ZodRawShapeCompat`) 또는 `AnySchema` 를 받음 (JSON Schema 객체 그대로 아님 → 변환 필요).
   - `import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'` → `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` = stateless. `await transport.handleRequest(req, res, parsedBody)` 가 `node:http` IncomingMessage/ServerResponse 를 직접 받음 (openai-compat 라우트와 동일 패턴).
   - 기존 _클라이언트_ import 스타일 참고: `packages/server/src/plugins/mcp-transport.ts`.
4. **`RegisteredToolDefinition.inputSchema` 타입 = JSON Schema 서브셋** (`ToolInputSchema { type:'object', properties: Record<string, ToolPropertySchema>, required? }`, `registry.ts:23-35`). registry 내부에 `jsonSchemaToZod(prop)` 헬퍼가 있으나 **private (export 안 됨)** → 브리지가 자체 변환 헬퍼를 가짐 (registry 의 것을 미러).
5. **`InMemoryToolRegistry.execute(name, input, ctx)` → `GuardedToolResult { content, isError, metadata? }`**. 9-stage 정책/loop-detect/result-guard/audit 파이프라인을 이미 통과함 (`registry.ts:229-410`). `ToolExecutionContext = { sessionId, userId, channelId, abortSignal }` (모두 required). `list()` → `readonly RegisteredTool[]`, 각 `.definition.group: ToolGroupId`, `.definition.name`.
6. **`signToken` 없음 → 신규** (`validateToken` 만 존재, `auth/token.ts:14`). HS256 대칭. `authenticate(req, config.auth)` 가 Bearer 처리 (`auth/index.ts:22-29`) → `/mcp` 재사용.
7. **`GatewayServerConfig`** (`rpc/types.ts:99-143`) 에 `openaiCompat?`, `rateLimit?` 등 optional 블록 패턴 존재 → `mcp?` 동일 패턴 추가.
8. **CLI runner argv 빌드** = `runner.ts:38-52` (baseArgs → modelArg → systemPromptArg → input). `DEFAULT_CLAUDE_BACKEND` (`backends.ts:27-54`) 에 `clearEnv: ['ANTHROPIC_API_KEY', ...]` 이미 있음 (env 비워 구독 OAuth 강제). `CliBackendConfig` (`types.ts:19-40`).
9. **`RunnerExecutionAdapter.routerLlm` 는 이미 optional** (`auto-reply/execution-adapter.ts:179` `readonly routerLlm?: LlmRouter`; 미주입 시 fallbackChain 동작, `:485,501,536-537`). → **D 의 "routerLlm 조사 항목" 결론: CLI 모드에서 `routerLlm: undefined` 전달 시 다중-chain 라우팅이 fallbackChain 으로 깔끔히 degrade, 어댑터 코드 변경 불필요.** (plan §3D 열린 항목 + 리스크 §5 해소.)
10. **`sdkAdapter` 의 남은 강결합 = summarizer** (`runtime.ts:192` `sdkAdapter.summarize(...)` in `buildPipeline`). → D 에서 pipeline 의 summarizer 를 optional 화.
11. **`go/no-go` 전제**: B~E 는 A 의 http "go" 를 전제로 작성. **A 의 수동 검증에서 http 인라인 JSON 수용이 실패하면 → (a) stdio phone-home 으로 폴백** (transport 만 교체, B~E 의 핸들러/브리지/인증/회계 설계는 불변). 폴백 시 C 의 runner 플래그가 `--mcp-config` http url 대신 stdio command 가 됨.

---

## 사전 준비

### P-1. EDIT `packages/gateway/package.json` — MCP SDK 의존성 추가

`/mcp` 라우트가 gateway HTTP 서버에 mount 되므로 gateway 가 MCP SDK 를 직접 의존한다 (server 와 동일 버전 `^1`).

```jsonc
// dependencies 에 추가 (oxfmt 가 키 순서 재정렬하므로 위치는 신경쓰지 말 것)
{
  "dependencies": {
    "@finclaw/agent": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "@finclaw/storage": "workspace:*",
    "@finclaw/types": "workspace:*",
    "@modelcontextprotocol/sdk": "^1",
    "chokidar": "^5.0.0",
    "ws": "^8.19.0",
    "zod": "^4.0.0",
  },
}
```

> ⚠️ gateway 는 이미 `@finclaw/agent` 를 의존하므로 (`InMemoryToolRegistry` 타입 import 가능) 의존 그래프 역전 없음. MCP SDK 는 외부 패키지라 그래프 무관.

검증: `pnpm install` (lockfile 갱신) → `pnpm format:fix` (package.json 키 재정렬) → `pnpm --filter @finclaw/gateway build`

---

## 밀스톤 A — MCP 호스트 스파이크 + 격리 실증 (go/no-go 게이트)

**목표 (plan §3A):** gateway 에 `/mcp` 라우트(StreamableHTTP stateless) 추가, **실 도구 1개**(`get_stock_price`)를 `toolRegistry.execute` 경유로 노출. 수동 spawn 1회로 (1) http+headers JSON 수용 [go/no-go], (2) 격리(Bash/Edit 차단), (3) tool_use → 실데이터 복귀 확인.

> ⚠️ **이 밀스톤은 최소 스파이크다.** 제너릭 브리지(전체 도구)·인증 헬퍼·group allowlist 는 **밀스톤 B**. A 는 단일 도구 하드코딩 + 인증은 기존 `authenticate()` 재사용으로 충분. 범위 확장 금지.

### A1. CREATE `packages/gateway/src/mcp/host.ts` — `/mcp` 라우트 핸들러 + 단일 도구 브리지

OpenClaw `POST /tools/invoke` (`openclaw/src/gateway/tools-invoke-http.ts`) 의 코어 패턴(Bearer → execute → 에러분류)을 MCP transport 위에 얹는다. A 에서는 `get_stock_price` 1개만 노출.

```ts
// packages/gateway/src/mcp/host.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolRegistry } from '@finclaw/agent';
import { z } from 'zod/v4';
import { authenticate } from '../auth/index.js';
import type { GatewayServerContext } from '../context.js';
import { readBody } from '../router.js';

/**
 * Phase 40 A: in-process HTTP MCP 호스트 (스파이크).
 *
 * StreamableHTTP stateless (sessionIdGenerator: undefined) — 1인 사용자 스코프,
 * OpenClaw /tools/invoke 도 stateless (plan §1-1). 매 요청 새 transport/server.
 * A 에서는 get_stock_price 1개만 노출 (제너릭 브리지는 B).
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
  toolRegistry: ToolRegistry,
): Promise<void> {
  // ① Bearer 인증 (기존 authenticate 재사용 — Bearer/X-API-Key/none).
  const authResult = await authenticate(req, ctx.config.auth);
  if (!authResult.ok || authResult.info.level === 'none') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // ② body 파싱 (handleRequest 에 parsedBody 로 전달 — node:http 는 본문 자동 파싱 안 함).
  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    parsedBody = raw ? JSON.parse(raw) : undefined;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  // ③ stateless McpServer + 단일 도구 등록.
  const server = new McpServer({ name: 'finclaw', version: '0.1.0' });
  const userId = authResult.info.userId ?? 'mcp-user';
  registerSingleTool(server, toolRegistry, 'get_stock_price', userId);

  // ④ stateless transport (세션 없음).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

/** 단일 도구를 toolRegistry.execute 경유로 MCP 에 노출 (A 스파이크용). */
function registerSingleTool(
  server: McpServer,
  toolRegistry: ToolRegistry,
  toolName: string,
  userId: string,
): void {
  const reg = toolRegistry.get(toolName);
  if (!reg) {
    return; // 도구 미등록 시 노출 스킵 (mock 테스트에서는 항상 등록).
  }
  const shape = jsonSchemaToZodShape(reg.definition.inputSchema);
  server.registerTool(
    toolName,
    { description: reg.definition.description, inputSchema: shape },
    async (input: Record<string, unknown>) => {
      const result = await toolRegistry.execute(toolName, input, {
        sessionId: 'mcp',
        userId,
        channelId: 'mcp',
        abortSignal: new AbortController().signal,
      });
      return {
        content: [{ type: 'text' as const, text: result.content }],
        isError: result.isError,
      };
    },
  );
}

/** RegisteredToolDefinition.inputSchema (JSON Schema 서브셋) → Zod raw shape. registry.jsonSchemaToZod 미러. */
function jsonSchemaToZodShape(inputSchema: unknown): Record<string, z.ZodType> {
  const schema = inputSchema as {
    properties?: Record<string, Record<string, unknown>>;
    required?: readonly string[];
  };
  if (!schema.properties) {
    return {};
  }
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties).map(([k, v]) => {
      const base = jsonSchemaToZodType(v);
      return [k, required.has(k) ? base : base.optional()];
    }),
  );
}

function jsonSchemaToZodType(prop: Record<string, unknown>): z.ZodType {
  switch (prop.type) {
    case 'string':
      return prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(
        prop.items ? jsonSchemaToZodType(prop.items as Record<string, unknown>) : z.unknown(),
      );
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
```

검증: `pnpm --filter @finclaw/gateway build`

### A2. EDIT `packages/gateway/src/server.ts` — `GatewayServerDeps` 에 `toolRegistry` 추가 + ctx 보관

`/mcp` 핸들러가 라이브 `toolRegistry` 를 호출하려면 server 가 주입받아 ctx 또는 클로저로 router 에 전달해야 한다. A 는 ctx 에 optional 로 보관 (B 에서 mcp config 와 함께 확장).

```ts
// GatewayServerDeps 인터페이스에 추가 (기존 필드 뒤)
export interface GatewayServerDeps {
  // ... 기존 필드 ...
  /** Phase 40 A: /mcp 라우트가 in-process 호출할 라이브 ToolRegistry (생략 시 /mcp 비활성). */
  readonly toolRegistry?: import('@finclaw/agent').ToolRegistry;
}
```

`ctx` 조립부 (`server.ts:112-124`) 에 `toolRegistry` 를 넘기려면 `GatewayServerContext` 에도 필드가 필요. context.ts 수정은 A3.

```ts
// server.ts ctx 객체에 추가:
const ctx: GatewayServerContext = {
  config,
  httpServer,
  wss,
  connections: new Map(),
  registry: new ChatRegistry(config.auth.sessionTtlMs),
  methods: new MethodRegistry(),
  broadcaster: new GatewayBroadcaster(),
  isDraining: false,
  rateLimiter,
  accessLogger,
  authRateLimiter,
  toolRegistry: deps.toolRegistry, // Phase 40 A
};
```

검증: A3 와 함께 `pnpm --filter @finclaw/gateway build`

### A3. EDIT `packages/gateway/src/context.ts` — `GatewayServerContext` 에 `toolRegistry?` 추가

```ts
// GatewayServerContext 인터페이스에 추가 (기존 필드 뒤)
  /** Phase 40 A: /mcp in-process 호출용 라이브 ToolRegistry (deps 에서 주입, 생략 가능). */
  readonly toolRegistry?: import('@finclaw/agent').ToolRegistry;
```

> ⚠️ context.ts 의 실제 필드 목록은 Read 로 확인 후 동일 스타일로 추가. (위 server.ts 의 ctx 객체 키와 1:1 대응.)

검증: `pnpm --filter @finclaw/gateway build`

### A4. EDIT `packages/gateway/src/router.ts` — `/mcp` 조건부 라우트 분기 추가

openai-compat 조건부 라우트(`router.ts:53-60`) 와 동일 패턴. `routes[]` 배열이 아닌 조건부 분기 (StreamableHTTP 는 GET/POST/DELETE 모두 처리하므로 method 고정 불가).

```ts
// router.ts 상단 import 추가
import { handleMcpRequest } from './mcp/host.js';

// handleHttpRequest 안, openai-compat 분기 (line 53-60) 바로 뒤에 추가:
// Phase 40 A: in-process HTTP MCP 라우트 (toolRegistry 주입 시에만 활성).
if (ctx.toolRegistry && req.url?.startsWith('/mcp')) {
  await handleMcpRequest(req, res, ctx, ctx.toolRegistry);
  return;
}
```

> ⚠️ 이 분기는 라우트 매칭(`routes.find`, line 63) **앞에** 둘 것 — `/mcp` 가 어떤 method 든 핸들러로 가야 함.

검증: `pnpm --filter @finclaw/gateway build`

### A5. CREATE `packages/gateway/src/mcp/host.test.ts` — mock toolRegistry 단위 테스트

실 CLI/네트워크 금지. mock `ToolRegistry` + `node:http` 요청 mock 으로 핸들러 검증. MCP 프로토콜 핸드셰이크 전체를 돌리지 않고 **핸들러의 인증 게이트 + execute 경유 + 에러 분류**에 집중 (transport 내부는 SDK 책임).

```ts
// packages/gateway/src/mcp/host.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { ToolRegistry } from '@finclaw/agent';
import { handleMcpRequest } from './mcp/host.js'; // 경로는 실제 위치에 맞게
// ... mock IncomingMessage/ServerResponse 헬퍼 (기존 router.test.ts 패턴 참고) ...

function mockReq(opts: { method?: string; url?: string; auth?: string; body?: string }) {
  // EventEmitter 기반 mock — readBody 가 'data'/'end' 이벤트를 소비.
  // 기존 gateway router.test.ts / openai-compat 테스트의 mock 헬퍼를 재사용/참고.
}

describe('handleMcpRequest', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const reg = makeMockRegistry();
    const req = mockReq({ method: 'POST', url: '/mcp' }); // Bearer 없음
    const res = mockRes();
    await handleMcpRequest(req, res, mockCtx(), reg);
    expect(res.statusCode).toBe(401);
  });

  it('executes get_stock_price via toolRegistry.execute on valid call', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'AAPL $150', isError: false });
    const reg = makeMockRegistry({ execute });
    // ... 유효 Bearer + MCP tools/call body 로 호출 → execute 가 get_stock_price 로 불렸는지 검증 ...
    expect(execute).toHaveBeenCalledWith(
      'get_stock_price',
      expect.any(Object),
      expect.objectContaining({
        sessionId: 'mcp',
        channelId: 'mcp',
      }),
    );
  });
});

function makeMockRegistry(over?: { execute?: ReturnType<typeof vi.fn> }): ToolRegistry {
  return {
    get: (name: string) =>
      name === 'get_stock_price'
        ? {
            definition: {
              name: 'get_stock_price',
              description: 'Get a stock quote',
              inputSchema: {
                type: 'object',
                properties: { symbol: { type: 'string', description: 'ticker' } },
                required: ['symbol'],
              },
              group: 'finance',
              requiresApproval: false,
              isTransactional: false,
              accessesSensitiveData: false,
            },
            executor: async () => ({ content: '', isError: false }),
            registeredAt: new Date(),
            source: 'built-in' as const,
          }
        : undefined,
    execute: over?.execute ?? vi.fn().mockResolvedValue({ content: 'AAPL $150', isError: false }),
    list: () => [],
    listByGroup: () => [],
    has: (n: string) => n === 'get_stock_price',
    register: vi.fn(),
    unregister: vi.fn(),
    addPolicyRule: vi.fn(),
  } as unknown as ToolRegistry;
}
```

> ⚠️ MCP SDK 의 `handleRequest` 가 완전한 JSON-RPC initialize 핸드셰이크를 기대할 수 있음. 테스트에서 full MCP 라운드트립이 까다로우면, **`registerSingleTool` 의 도구 등록 + execute 경유 + `jsonSchemaToZodShape` 변환을 직접 단위 테스트로 분리**하고(브리지 로직), 인증 게이트는 `handleMcpRequest` 의 401 경로만 검증. (transport 핸드셰이크는 SDK 책임 — 우리 코드 경계 밖.) implementer 가 SDK 동작 확인 후 테스트 전략 택1.

검증: `pnpm --filter @finclaw/gateway test --run`

### A6. EDIT `packages/server/src/main.ts` — gateway `createGatewayServer` 에 `toolRegistry` 주입

`createGatewayServer(gatewayConfig, {...})` deps 객체 (`main.ts:307~`) 에 `toolRegistry` 추가. (main 은 이미 `toolRegistry` 를 `buildProviders` 에서 받아 보유.)

```ts
const gateway = createGatewayServer(gatewayConfig, {
  storage,
  defaultModel: DEFAULT_MODEL,
  adapter,
  toolRegistry, // Phase 40 A: /mcp in-process 호출용
  financeDeps: {
    /* ... 기존 ... */
  },
  // ... 기존 deps ...
});
```

검증: `pnpm --filter @finclaw/server build`

### A7. EDIT `packages/gateway/src/index.ts` — `ToolRegistry` 타입 re-export 불필요 확인

`@finclaw/agent` 의 `ToolRegistry` 는 host.ts 가 직접 import 하므로 gateway index 변경 불필요. **단 `GatewayServerDeps` 가 export 되는지 확인** (이미 `export { ..., type GatewayServerDeps } from './server.js'`, index.ts:4) — `toolRegistry` 필드 추가만으로 main 이 사용 가능.

검증: 없음 (확인만)

### A8. 수동 검증 (go/no-go 게이트 — 자동 테스트 아님, 분리 명시)

> 🔴 **이 단계는 라이브 CLI 를 쓰므로 자동 테스트에서 제외. 수동 1회 실행.** 구독 차감 발생 (~$0.34, plan §5).

1. 실 키 없이 server 부팅 (또는 A 시점엔 키 있어도 무방): gateway listening 확인.
2. per-spawn JWT 발급 (A 시점엔 임시로 기존 `FINCLAW_API_KEY` 또는 수동 토큰 사용 가능 — 정식 `signToken` 은 B).
3. 수동 spawn:
   ```bash
   env -u ANTHROPIC_API_KEY claude -p \
     --mcp-config '{"mcpServers":{"finclaw":{"type":"http","url":"http://127.0.0.1:3000/mcp","headers":{"Authorization":"Bearer <token>"}}}}' \
     --strict-mcp-config --tools "" --allowedTools "mcp__finclaw__get_stock_price" \
     --permission-mode bypassPermissions --output-format json \
     "AAPL 현재가 알려줘"
   ```
4. **확인 항목:**
   - ✅ **[go/no-go] http+headers 인라인 JSON 수용** — claude 가 에러 없이 `/mcp` 접속.
   - ✅ 격리: Bash/Edit/Read 미사용 (`--tools ""`), ToolSearch 미발동.
   - ✅ tool_use → `/mcp` → `toolRegistry.execute('get_stock_price')` → 실데이터 복귀.
5. **🔴 게이트 분기:** http 수용 **실패** 시 → 즉시 (a) **stdio phone-home 폴백** 으로 pivot. `plan §1` 갱신 + 본 todo 의 C 마일스톤 runner 플래그를 stdio command 로 변경. (B/D/E 의 핸들러·인증·회계 설계는 transport 무관하게 불변.)

### A9. 밀스톤 A 검증

다음을 모두 통과해야 B 로:

- `pnpm typecheck`
- `pnpm --filter @finclaw/gateway build && pnpm --filter @finclaw/server build`
- `pnpm test --run` (unit ≥ 1679, A5 신규 테스트 추가분 포함)
- `pnpm lint`
- **수동 spawn 1회 성공 로그** (A8) — go 확정. (no-go 면 stdio 폴백 후 재실행.)

커밋: `feat(phase40): in-process HTTP MCP host spike + get_stock_price bridge (A go/no-go)`

---

## 밀스톤 B — ToolRegistry → MCP 브리지 (전체) + 인증

> **전제: A 가 http "go".** (no-go 였으면 stdio transport 로 동일 브리지 구성.)

**목표 (plan §3B):** 제너릭 브리지 — `toolRegistry.list()` → **group allowlist + 강제 deny 필터** → `registerTool` 일괄. `/mcp` 실행 핸들러를 OpenClaw `tools-invoke-http.ts` 1:1 참고로 정식화 (Bearer → 필터 → execute → 에러분류 input=400/authz=403/기타=500). `signToken` HS256 헬퍼 신규. gateway config 에 `mcp?: { enabled, allowedGroups, denyTools }` 추가.

### B1. CREATE `packages/gateway/src/auth/sign.ts` — `signToken` HS256 발급 헬퍼

`validateToken` (`auth/token.ts:14`) 의 대칭. per-spawn JWT mint 용 (C 가 sessionId 운반). ~15줄.

```ts
// packages/gateway/src/auth/sign.ts
import { createHmac } from 'node:crypto';

export interface SignTokenClaims {
  /** subject = userId */
  readonly sub: string;
  /** CLI spawn 별 sessionId (ctx 조립용) */
  readonly sessionId?: string;
  /** 만료 (epoch seconds). 미지정 시 발급 + 15분. */
  readonly exp?: number;
  readonly permissions?: readonly string[];
}

/**
 * Phase 40 B: 간이 JWT 발급 (HS256). validateToken 과 대칭.
 * per-spawn 으로 CLI 에 주입할 단명 토큰 mint 에 사용.
 */
export function signToken(claims: SignTokenClaims, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = claims.exp ?? Math.floor(Date.now() / 1000) + 15 * 60;
  const payload = base64url(
    JSON.stringify({
      sub: claims.sub,
      ...(claims.sessionId ? { sessionId: claims.sessionId } : {}),
      ...(claims.permissions ? { permissions: claims.permissions } : {}),
      exp,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}
```

> ⚠️ `validateToken` 의 payload 파싱 (`token.ts:49`) 은 `sessionId` 를 읽지 않음 — `sub`/`clientId`/`permissions`/`exp` 만. **`sessionId` claim 을 ctx 에 운반하려면 `validateToken` 도 `sessionId` 를 `AuthInfo.sessionId` 로 채워야 함.** `AuthInfo` 에 `sessionId?` 이미 있음 (`rpc/types.ts:39`). → B2 에서 `validateToken` payload 타입에 `sessionId?` 추가 + `info.sessionId` 매핑.

검증: `pnpm --filter @finclaw/gateway build`

### B2. EDIT `packages/gateway/src/auth/token.ts` — payload 에 `sessionId` 파싱 추가

```ts
// validateToken 안, payload 타입 (line 49) 에 sessionId 추가:
let payload: {
  sub?: string;
  clientId?: string;
  sessionId?: string;
  permissions?: string[];
  exp?: number;
};

// 반환 info 에 sessionId 매핑 (line 61-70):
return {
  ok: true,
  info: {
    level: 'token',
    userId: payload.sub,
    clientId: payload.clientId,
    sessionId: payload.sessionId, // Phase 40 B: per-spawn JWT 의 sessionId claim 운반
    permissions: (payload.permissions ?? []) as Permission[],
  },
};
```

검증: `pnpm --filter @finclaw/gateway build`

### B3. CREATE `packages/gateway/src/mcp/bridge.ts` — 제너릭 브리지 (group allowlist + 강제 deny)

`toolRegistry.list()` → 필터 → `registerTool` 일괄. OpenClaw `DEFAULT_GATEWAY_HTTP_TOOL_DENY` (`openclaw/src/security/dangerous-tools.ts:9-22`) 패턴: allowlist 와 **무관하게** 적용되는 최후 방어선.

```ts
// packages/gateway/src/mcp/bridge.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolRegistry, ToolGroupId } from '@finclaw/agent';
import { z } from 'zod/v4';

export interface McpBridgeConfig {
  /** 노출 허용 도구 그룹 (예: ['finance']). 미지정 시 전체 그룹. */
  readonly allowedGroups?: readonly ToolGroupId[];
  /** allowlist 와 무관하게 강제 차단할 도구명 (OpenClaw DEFAULT_GATEWAY_HTTP_TOOL_DENY 패턴). */
  readonly denyTools?: readonly string[];
}

/**
 * Phase 40 B: 라이브 ToolRegistry 의 도구를 group allowlist + 강제 deny 로 필터해 MCP 에 일괄 등록.
 * 각 도구 executor 는 toolRegistry.execute (9-stage 정책/가드/감사 통과) 를 호출.
 */
export function registerBridgedTools(
  server: McpServer,
  toolRegistry: ToolRegistry,
  config: McpBridgeConfig,
  userId: string,
  sessionId: string,
): void {
  const allowedGroups = config.allowedGroups ? new Set(config.allowedGroups) : undefined;
  const denied = new Set(config.denyTools ?? []);

  for (const tool of toolRegistry.list()) {
    const def = tool.definition;
    if (denied.has(def.name)) {
      continue; // 강제 deny — allowlist 무관.
    }
    if (allowedGroups && !allowedGroups.has(def.group)) {
      continue; // group allowlist 미통과.
    }
    const shape = jsonSchemaToZodShape(def.inputSchema);
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: shape },
      async (input: Record<string, unknown>) => {
        const result = await toolRegistry.execute(def.name, input, {
          sessionId,
          userId,
          channelId: 'mcp',
          abortSignal: new AbortController().signal,
        });
        return {
          content: [{ type: 'text' as const, text: result.content }],
          isError: result.isError,
        };
      },
    );
  }
}

// A1 의 jsonSchemaToZodShape / jsonSchemaToZodType 를 여기로 이동 (host.ts 와 공유)
// → bridge.ts 가 export, host.ts 가 import. (중복 방지.)
export function jsonSchemaToZodShape(inputSchema: unknown): Record<string, z.ZodType> {
  /* A1 본문과 동일 */
}
function jsonSchemaToZodType(prop: Record<string, unknown>): z.ZodType {
  /* A1 본문과 동일 */
}
```

> ⚠️ **abortSignal**: plan §3 은 "abortSignal 은 요청에서". StreamableHTTP 핸들러 컨텍스트에서 요청 abort 를 도구로 전파하려면 `res.on('close')` 와 묶인 AbortController 를 executor 에 넘겨야 함. A 의 스파이크는 새 signal 로 단순화했으나 B 에서는 **host.ts 가 요청 수명 AbortController 를 만들어 bridge 에 전달**하도록 시그니처 확장 권장 (`registerBridgedTools(..., abortSignal)`). plan §3 의 "abortSignal 은 요청에서" 충족.

검증: `pnpm --filter @finclaw/gateway build`

### B4. EDIT `packages/gateway/src/mcp/host.ts` — 제너릭 브리지 사용 + 에러 분류 정식화

A1 의 단일 도구 하드코딩 (`registerSingleTool`) 을 제거하고 B3 의 `registerBridgedTools` 사용. ctx 의 mcp config + per-spawn JWT claim (userId/sessionId) 사용. OpenClaw 에러 분류 (input=400/authz=403/기타=500) 는 MCP transport 가 JSON-RPC 에러로 감싸므로, **execute 결과의 `isError` 를 MCP `isError` 로 전파**하는 것으로 충족 (toolRegistry 가 이미 input/policy 에러를 `isError:true` content 로 반환 — `registry.ts:264,318`). HTTP 레벨 400/403 은 인증/파싱 단계에만 적용.

```ts
// host.ts — registerSingleTool 호출을 교체:
import { registerBridgedTools } from './bridge.js';

// ③ stateless McpServer + 제너릭 브리지 등록 (group allowlist + 강제 deny).
const server = new McpServer({ name: 'finclaw', version: '0.1.0' });
const userId = authResult.info.userId ?? 'mcp-user';
const sessionId = authResult.info.sessionId ?? 'mcp';
const abort = new AbortController();
req.on('close', () => abort.abort());
registerBridgedTools(
  server,
  toolRegistry,
  {
    allowedGroups: ctx.config.mcp?.allowedGroups,
    denyTools: ctx.config.mcp?.denyTools,
  },
  userId,
  sessionId,
  // abort.signal — B3 시그니처 확장 시
);
```

> A1 의 `jsonSchemaToZodShape`/`jsonSchemaToZodType` 는 B3 로 이동했으므로 host.ts 에서 제거하고 import.

검증: `pnpm --filter @finclaw/gateway build`

### B5. EDIT `packages/gateway/src/rpc/types.ts` — `GatewayServerConfig` 에 `mcp?` 블록 추가

`openaiCompat?`/`rateLimit?` (line 128-142) 와 동일 패턴.

```ts
// GatewayServerConfig 인터페이스, rateLimit? 블록 뒤에 추가:
  /** Phase 40 B: in-process HTTP MCP 호스트 설정 (생략 시 toolRegistry 주입돼도 기본 노출). */
  readonly mcp?: {
    readonly enabled: boolean;
    /** 노출 허용 도구 그룹 (예: ['finance']). 미지정 시 전체. */
    readonly allowedGroups?: readonly import('@finclaw/agent').ToolGroupId[];
    /** allowlist 무관 강제 차단 도구명 (control-plane/mutating). */
    readonly denyTools?: readonly string[];
  };
```

> ⚠️ router.ts 의 `/mcp` 분기 조건을 `ctx.toolRegistry && ctx.config.mcp?.enabled !== false && req.url?.startsWith('/mcp')` 로 갱신 (enabled 플래그 존중). A4 의 조건 보강.

검증: `pnpm --filter @finclaw/gateway build`

### B6. EDIT `packages/gateway/src/index.ts` — `signToken` + 브리지 타입 export

main(C) 이 `signToken` 을, server 가 `McpBridgeConfig` 를 쓸 수 있게 export.

```ts
// 인증 섹션 (index.ts:42 근처) 에 추가:
export { signToken, type SignTokenClaims } from './auth/sign.js';
// MCP 섹션 신규:
export type { McpBridgeConfig } from './mcp/bridge.js';
```

검증: `pnpm --filter @finclaw/gateway build`

### B7. CREATE `packages/gateway/src/mcp/bridge.test.ts` — 브리지 필터/매핑 단위 테스트 (mock registry)

```ts
// packages/gateway/src/mcp/bridge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { registerBridgedTools, jsonSchemaToZodShape } from './mcp/bridge.js';

describe('registerBridgedTools', () => {
  it('registers only tools in allowedGroups', () => {
    const server = mockMcpServer();
    const reg = makeMockRegistryWith([
      { name: 'get_stock_price', group: 'finance' },
      { name: 'read_file', group: 'system' },
    ]);
    registerBridgedTools(server, reg, { allowedGroups: ['finance'] }, 'u', 's');
    expect(server.registerTool).toHaveBeenCalledWith(
      'get_stock_price',
      expect.any(Object),
      expect.any(Function),
    );
    expect(server.registerTool).not.toHaveBeenCalledWith(
      'read_file',
      expect.anything(),
      expect.anything(),
    );
  });

  it('force-denies tools regardless of allowlist (DEFAULT_GATEWAY_HTTP_TOOL_DENY 패턴)', () => {
    const server = mockMcpServer();
    const reg = makeMockRegistryWith([{ name: 'alert_create', group: 'finance' }]);
    registerBridgedTools(
      server,
      reg,
      { allowedGroups: ['finance'], denyTools: ['alert_create'] },
      'u',
      's',
    );
    expect(server.registerTool).not.toHaveBeenCalled();
  });

  it('bridged executor calls toolRegistry.execute with mcp ctx', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'ok', isError: false });
    const reg = makeMockRegistryWith([{ name: 'get_stock_price', group: 'finance' }], execute);
    const server = mockMcpServer();
    registerBridgedTools(server, reg, {}, 'user1', 'sess1');
    const cb = server.registerTool.mock.calls[0][2]; // 등록된 executor
    await cb({ symbol: 'AAPL' });
    expect(execute).toHaveBeenCalledWith(
      'get_stock_price',
      { symbol: 'AAPL' },
      expect.objectContaining({ userId: 'user1', sessionId: 'sess1', channelId: 'mcp' }),
    );
  });
});

describe('jsonSchemaToZodShape', () => {
  it('maps required vs optional + enum/array/object', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { symbol: { type: 'string' }, range: { type: 'string', enum: ['1d', '1w'] } },
      required: ['symbol'],
    });
    expect(shape.symbol).toBeDefined();
    expect(shape.range).toBeDefined();
    // safeParse 로 required 검증: symbol 누락 시 실패
  });
});
```

검증: `pnpm --filter @finclaw/gateway test --run`

### B8. CREATE `packages/gateway/src/auth/sign.test.ts` — JWT round-trip 단위 테스트

```ts
// packages/gateway/src/auth/sign.test.ts
import { describe, it, expect } from 'vitest';
import { signToken } from './auth/sign.js';
import { validateToken } from './auth/token.js';

describe('signToken ↔ validateToken round-trip', () => {
  const secret = 'test-secret';

  it('signs a token that validateToken accepts', () => {
    const token = signToken({ sub: 'user1', sessionId: 'sess1' }, secret);
    const result = validateToken(token, secret);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.info.userId).toBe('user1');
      expect(result.info.sessionId).toBe('sess1');
    }
  });

  it('produces HS256 header (alg confusion 방어 통과)', () => {
    const token = signToken({ sub: 'u' }, secret);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
  });

  it('rejects token signed with different secret', () => {
    const token = signToken({ sub: 'u' }, secret);
    expect(validateToken(token, 'other-secret').ok).toBe(false);
  });

  it('rejects expired token', () => {
    const token = signToken({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 10 }, secret);
    expect(validateToken(token, secret).ok).toBe(false);
  });
});
```

검증: `pnpm --filter @finclaw/gateway test --run`

### B9. 밀스톤 B 검증

- `pnpm typecheck`
- `pnpm --filter @finclaw/gateway build`
- `pnpm test --run` (B7/B8 신규)
- `pnpm lint`

커밋: `feat(phase40): generic ToolRegistry→MCP bridge + group allowlist/deny + signToken (B)`

---

## 밀스톤 C — CLI runner MCP 배선 + provider 경로

> **전제: A 가 http "go".** (no-go 면 `--mcp-config` 가 stdio command JSON, B/C 핸들러 불변.)

**목표 (plan §3C):** `runCliAgent`/backend config 확장 — `--mcp-config`(http url+Bearer)·`--tools ""`·`--strict-mcp-config`·`--allowedTools` 주입. adapter/runner 에 MCP url + spawn별 JWT mint 전달. providers.ts 에서 gateway MCP url + token minter 배선.

### C1. EDIT `packages/agent/src/providers/claude-cli/types.ts` — `CliBackendConfig` 에 MCP 필드 추가

```ts
// CliBackendConfig 인터페이스에 추가 (기존 필드 뒤):
  /**
   * Phase 40 C: in-process HTTP MCP 엔드포인트 (FinClaw gateway /mcp).
   * 설정 시 runner 가 --mcp-config(http) + 격리 플래그를 argv 에 주입.
   */
  mcp?: {
    /** /mcp URL (예: http://127.0.0.1:3000/mcp). */
    readonly url: string;
    /** spawn 별 Bearer 토큰을 mint 하는 함수 (sessionId 운반). */
    readonly mintToken: () => string;
    /** 자동 승인 도구 패턴 (기본 'mcp__finclaw__*'). */
    readonly allowedTools?: string;
  };
```

검증: `pnpm --filter @finclaw/agent build`

### C2. EDIT `packages/agent/src/providers/claude-cli/runner.ts` — MCP 플래그 주입

`runner.ts:38-52` 의 args 빌드부 (input push 직전, line 50) 에 MCP 플래그 주입. http "go" 전제로 인라인 JSON.

```ts
// runner.ts — backend.input === 'arg' push (line 50-52) 직전에 추가:

// Phase 40 C: in-process HTTP MCP 배선 (http "go" 전제, A8 게이트).
if (backend.mcp) {
  const mcpConfig = {
    mcpServers: {
      finclaw: {
        type: 'http' as const,
        url: backend.mcp.url,
        headers: { Authorization: `Bearer ${backend.mcp.mintToken()}` },
      },
    },
  };
  args.push('--mcp-config', JSON.stringify(mcpConfig));
  args.push('--strict-mcp-config');
  args.push('--tools', ''); // 내장 도구(Bash/Edit/Read) 전체 차단
  args.push('--allowedTools', backend.mcp.allowedTools ?? 'mcp__finclaw__*');
  args.push('--permission-mode', 'bypassPermissions');
}

if (backend.input === 'arg') {
  args.push(req.prompt);
}
```

> 🔴 **stdio 폴백 (A8 no-go) 시:** 위 블록을 `args.push('--mcp-config', JSON.stringify({ mcpServers: { finclaw: { command: <node>, args: [<stdio-host>] } } }))` 로 교체. http url/Bearer 대신 stdio command. (나머지 격리 플래그 동일.)

> ⚠️ `mintToken()` 은 **매 spawn 마다 호출** (단명 토큰). args 빌드 시점에 1회 호출되므로 useResume 여부와 무관하게 fresh.

검증: `pnpm --filter @finclaw/agent build`

### C3. EDIT `packages/agent/src/providers/claude-cli/adapter.ts` — `CliProviderAdapterOptions` 에 mcp 전달

adapter 가 backend 를 runner 에 그대로 넘기므로 (`adapter.ts:70`), backend.mcp 가 설정돼 있으면 자동 전파. **추가 코드 불필요** — `CliProviderAdapterOptions.backend` 에 mcp 가 포함된 backend 를 넘기면 됨. (providers.ts 가 backend 조립 시 mcp 주입 — C5.)

> 확인만: `#run` (adapter.ts:62-76) 이 `backend: this.opts.backend` 를 runner 에 넘김 → backend.mcp 자동 전파. 변경 없음.

검증: 없음 (확인)

### C4. EDIT `packages/agent/src/providers/factory.ts` — `ProviderFactoryConfig` 에 mcp 전달 경로

`createProviderAdapter` 가 `cliBackend` 를 그대로 `CliProviderAdapter` 에 넘김 (`factory.ts:26-30`). backend.mcp 가 cliBackend 에 포함되면 자동 전파 → **변경 불필요**. (providers.ts 가 `cliBackend.mcp` 를 채움 — C5.)

> 확인만: factory 는 backend 를 투명하게 전달. 변경 없음.

검증: 없음 (확인)

### C5. EDIT `packages/server/src/composition/providers.ts` — MCP url + token minter 배선

`buildProviders` 가 `createProviderAdapter` 의 `cliBackend` 에 `mcp` 필드를 주입. gateway MCP url + `signToken` minter 필요. → `BuildProvidersDeps` 에 `mcpEndpoint?` 추가.

```ts
// providers.ts — BuildProvidersDeps 에 추가:
import { signToken } from '@finclaw/gateway';

export interface BuildProvidersDeps {
  readonly finclawConfig: FinClawConfig;
  readonly anthropicKey?: string; // Phase 40 D: optional (키 없는 CLI 부팅)
  readonly logger: FinClawLogger;
  /** Phase 40 C: in-process MCP 배선용. */
  readonly mcpEndpoint?: { readonly url: string; readonly jwtSecret: string };
}

// buildProviders 안, createProviderAdapter 의 cliBackend 조립부 (line 41-49) 에 mcp 주입:
    cliBackend:
      finclawConfig.cliBackend || mcpEndpoint
        ? {
            ...DEFAULT_CLAUDE_BACKEND,
            command: finclawConfig.cliBackend?.command ?? 'claude',
            reliability: finclawConfig.cliBackend?.watchdog
              ? { watchdog: finclawConfig.cliBackend.watchdog }
              : undefined,
            ...(mcpEndpoint
              ? {
                  mcp: {
                    url: mcpEndpoint.url,
                    // per-spawn JWT: 단일 사용자 전역 세션 (sessionId 'mcp').
                    mintToken: () =>
                      signToken({ sub: 'finclaw', sessionId: 'mcp' }, mcpEndpoint.jwtSecret),
                    allowedTools: 'mcp__finclaw__*',
                  },
                }
              : {}),
          }
        : undefined,
```

> ⚠️ **순환 의존 주의:** `providers.ts` 가 `@finclaw/gateway` 의 `signToken` 을 import 한다. server → gateway 는 **단방향 정상** (MEMORY: "server aggregates incl. gateway"). gateway → server 역방향 아님. OK.

> ⚠️ `mcpEndpoint.url` 은 gateway port 기반 (`http://127.0.0.1:${gatewayPort}/mcp`). main 이 gatewayPort 를 알고 있으므로 buildProviders 호출 시 주입.

검증: `pnpm --filter @finclaw/server build`

### C6. EDIT `packages/server/src/main.ts` — buildProviders 에 mcpEndpoint 주입

```ts
// main.ts:184 buildProviders 호출 — mcpEndpoint 추가:
const { sdkAdapter, routerLlm, providerAdapter, lanes, toolRegistry } = buildProviders({
  finclawConfig,
  anthropicKey, // D 에서 optional 화
  logger,
  mcpEndpoint: {
    url: `http://127.0.0.1:${gatewayPort}/mcp`,
    jwtSecret: gatewayConfig?.auth.jwtSecret ?? defaultConfig.auth.jwtSecret,
  },
});
```

> ⚠️ `gatewayConfig` 는 main.ts:296 에서 정의됨 (buildProviders 호출 line 184 보다 **뒤**). → `jwtSecret` 은 `defaultConfig.auth.jwtSecret` (= `process.env.GATEWAY_JWT_SECRET ?? 'dev-secret'`, constants.ts:17) 를 직접 사용하거나, gatewayConfig 정의를 buildProviders 앞으로 이동. **간단히: `process.env.GATEWAY_JWT_SECRET ?? 'dev-secret'` 를 buildProviders 와 gatewayConfig 양쪽이 공유**하도록 상수 1개로 추출 (constants.ts 의 defaultConfig 가 이미 같은 값). implementer 는 `defaultConfig.auth.jwtSecret` 참조로 통일.

검증: `pnpm --filter @finclaw/server build`

### C7. EDIT `packages/agent/test/providers/claude-cli/runner.test.ts` — MCP argv 빌드 테스트 추가

기존 spawn mock 패턴 (`runner.test.ts:6-23`) 으로 argv 캡처. mock spawn 만, 실 CLI 금지.

```ts
// runner.test.ts 에 추가:
it('injects --mcp-config(http) + isolation flags when backend.mcp set', async () => {
  let capturedArgv: string[] = [];
  vi.spyOn(spawnMod, 'spawnWithWatchdog').mockImplementation(async (r) => {
    capturedArgv = r.argv;
    return {
      exitCode: 0,
      reason: 'exit',
      stdout: JSON.stringify({ type: 'result', result: 'ok' }),
      stderr: '',
      noOutputTimedOut: false,
      durationMs: 1,
    };
  });
  await runCliAgent({
    prompt: 'hi',
    backend: {
      ...DEFAULT_CLAUDE_BACKEND,
      mcp: {
        url: 'http://127.0.0.1:3000/mcp',
        mintToken: () => 'TOKEN123',
        allowedTools: 'mcp__finclaw__*',
      },
    },
  });
  const joined = capturedArgv.join(' ');
  expect(joined).toContain('--mcp-config');
  expect(joined).toContain('--strict-mcp-config');
  expect(joined).toContain('--allowedTools');
  // mcp-config JSON 에 http + Bearer TOKEN123 포함
  const cfgIdx = capturedArgv.indexOf('--mcp-config');
  const cfg = JSON.parse(capturedArgv[cfgIdx + 1]);
  expect(cfg.mcpServers.finclaw.type).toBe('http');
  expect(cfg.mcpServers.finclaw.url).toBe('http://127.0.0.1:3000/mcp');
  expect(cfg.mcpServers.finclaw.headers.Authorization).toBe('Bearer TOKEN123');
});

it('omits MCP flags when backend.mcp absent (회귀: 기존 동작 불변)', async () => {
  let capturedArgv: string[] = [];
  vi.spyOn(spawnMod, 'spawnWithWatchdog').mockImplementation(async (r) => {
    capturedArgv = r.argv;
    return {
      exitCode: 0,
      reason: 'exit',
      stdout: JSON.stringify({ type: 'result', result: 'ok' }),
      stderr: '',
      noOutputTimedOut: false,
      durationMs: 1,
    };
  });
  await runCliAgent({ prompt: 'hi' }); // DEFAULT_CLAUDE_BACKEND (mcp 없음)
  expect(capturedArgv.join(' ')).not.toContain('--mcp-config');
});
```

> import 추가: `import { DEFAULT_CLAUDE_BACKEND } from '../../../src/providers/claude-cli/backends.js';`

검증: `pnpm --filter @finclaw/agent test --run`

### C8. 밀스톤 C 검증

- `pnpm typecheck`
- `pnpm --filter @finclaw/agent build && pnpm --filter @finclaw/server build`
- `pnpm test --run` (C7 신규, 기존 runner 테스트 회귀 없음)
- `pnpm lint`

커밋: `feat(phase40): CLI runner MCP wiring (--mcp-config http + isolation) + provider endpoint (C)`

---

## 밀스톤 D — 키 없이 부팅 (옵셔널화) + 기본 provider 전환

**목표 (plan §3D):** `requireEnv('ANTHROPIC_API_KEY')` → optional. 키 없음+`claude-cli` → 정상 부팅. 키 없음+`anthropic-sdk` → 명확한 fatal. providers.ts: 키 있을 때만 sdkAdapter/routerLlm/sdkFallback 생성. skills.ts news 분석 degrade. provider 기본값 `claude-cli`. stale 경고 정정.

> ✅ **D 의 "routerLlm 조사 항목" 결론 (사전조사 완료, 사실 9):** `RunnerExecutionAdapter.routerLlm` 은 **이미 optional** (`execution-adapter.ts:179`). 미주입 시 fallbackChain 으로 깔끔히 degrade — **어댑터 코드 변경 불필요.** CLI 모드에서 `routerLlm: undefined` 전달만 하면 됨. (리스크 §5 "multi-chain 라우팅 degrade 수용" 그대로 적용.) 남은 강결합은 summarizer (사실 10) 뿐.

### D1. EDIT `packages/config/src/defaults.ts` — provider 기본값 `claude-cli`

```ts
// defaults.ts:61 — provider 기본값 전환:
  // Phase 40 D: 키 없는 구독(CLI) 부팅이 기본 경험. (phase32 W6 의 SDK 기본 → CLI 기본 전환.)
  provider: 'claude-cli',
```

검증: `pnpm --filter @finclaw/config build && pnpm --filter @finclaw/config test --run`

### D2. EDIT `packages/server/src/main.ts` — `ANTHROPIC_API_KEY` optional 화 + provider별 게이트

```ts
// main.ts:91 — requireEnv → optional:
// Phase 40 D: 키 없이 구독(CLI) 부팅 허용. requireEnv → optional.
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const providerKind = finclawConfig.provider ?? 'claude-cli';
if (providerKind === 'anthropic-sdk' && !anthropicKey) {
  console.error(
    '[fatal] provider=anthropic-sdk requires ANTHROPIC_API_KEY (set key or switch provider to claude-cli)',
  );
  process.exit(1);
}
```

> ⚠️ `requireEnv` import 가 다른 곳에서도 쓰이면 (discord 토큰 등 line 92-93) import 유지. anthropicKey 한 줄만 교체.

검증: `pnpm --filter @finclaw/server build`

### D3. EDIT `packages/server/src/composition/providers.ts` — 키 있을 때만 SDK 인스턴스화

`anthropicKey?` optional 화 (C5 에서 이미 시그니처 변경). 키 없으면 sdkAdapter/routerLlm/sdkFallback 미생성.

```ts
// providers.ts — buildProviders 본문 (line 33-52) 교체:
export function buildProviders({
  finclawConfig,
  anthropicKey,
  logger,
  mcpEndpoint,
}: BuildProvidersDeps): ProvidersBundle {
  const providerKind = finclawConfig.provider ?? 'claude-cli';

  // Phase 40 D: 키 있을 때만 SDK 휴면 dual-path 생성. 키 없으면 pure-CLI.
  const sdkAdapter = anthropicKey ? new AnthropicAdapter(anthropicKey) : undefined;
  const routerLlm = sdkAdapter ? createLlmRouter(sdkAdapter) : undefined;

  const providerAdapter = createProviderAdapter({
    kind: providerKind,
    apiKey: anthropicKey,
    cliBackend: /* C5 의 mcp 주입 블록 */,
    defaultTimeoutMs: finclawConfig.cliBackend?.timeoutMs ?? 60_000,
    sdkFallback: sdkAdapter, // 키 없으면 undefined → CLI auth 만료 시 폴백 없음 (수용).
  });
  logger.info('provider.initialized', {
    event: 'provider.initialized',
    providerKind,
    keyless: !anthropicKey,
  });
  const lanes = new ConcurrencyLaneManager();
  const toolRegistry = new InMemoryToolRegistry();
  return { sdkAdapter, routerLlm, providerAdapter, lanes, toolRegistry };
}
```

`ProvidersBundle` 타입도 optional 화:

```ts
export interface ProvidersBundle {
  readonly sdkAdapter: AnthropicAdapter | undefined; // Phase 40 D
  readonly routerLlm: ReturnType<typeof createLlmRouter> | undefined; // Phase 40 D
  readonly providerAdapter: ReturnType<typeof createProviderAdapter>;
  readonly lanes: ConcurrencyLaneManager;
  readonly toolRegistry: InMemoryToolRegistry;
}
```

> ⚠️ **stale 경고 정정 (plan §3D):** providers.ts:56-58 의 `note: 'CLI mode: streaming/caching/tool_use disabled'` 는 이제 거짓 (MCP 로 tool_use 활성). 위 교체에서 제거함 (`keyless` 만 로깅).

검증: `pnpm --filter @finclaw/server build` — **여기서 타입 에러가 sdkAdapter/routerLlm 소비처 (runtime.ts buildExecution/buildPipeline) 로 전파됨 → D4 가 해소.**

### D4. EDIT `packages/server/src/composition/runtime.ts` — routerLlm/summarizer optional 수용

`buildExecution` 의 `routerLlm` 과 `buildPipeline` 의 `sdkAdapter` 를 optional 로.

```ts
// runtime.ts — BuildExecutionDeps.routerLlm optional:
  readonly routerLlm: ReturnType<typeof createLlmRouter> | undefined; // Phase 40 D
// RunnerExecutionAdapter 는 routerLlm? 이미 optional (execution-adapter.ts:179) → 그대로 전달 OK.

// BuildPipelineDeps.sdkAdapter optional:
  readonly sdkAdapter: AnthropicAdapter | undefined; // Phase 40 D

// buildPipeline 안 summarizer (line 192) — sdkAdapter 없으면 summarizer undefined:
  const summarizer = sdkAdapter
    ? (text: string) => sdkAdapter.summarize(text, defaultModel.model)
    : undefined;
```

> ⚠️ **`AutoReplyPipeline` 이 summarizer 를 required 로 받는지 확인 필요** (runtime.ts:194~ `new AutoReplyPipeline({...})`). summarizer 가 pipeline 옵션에서 required 면 → pipeline 옵션도 optional 화 (컨텍스트 압축 skip = RAG→FTS 와 동형 degrade). implementer 는 `AutoReplyPipeline` 생성자/옵션 타입을 Read 로 확인 후 optional 전파. **이것이 D 의 유일한 비자명 연쇄** — summarizer 소비처가 압축 단계 1곳이면 `undefined` 시 압축 skip 으로 degrade.

검증: `pnpm --filter @finclaw/server build`

### D5. EDIT `packages/server/src/composition/skills.ts` — news 분석 degrade + stale 경고 정정

```ts
// skills.ts — RegisterSkillsDeps.anthropicKey optional:
  readonly anthropicKey: string | undefined; // Phase 40 D

// registerNewsTools 호출 (line 119-132): 키 없으면 sentiment LLM degrade.
// anthropicApiKey 가 undefined 면 news 스킬이 분석 skip (부팅 정상) — RAG→FTS 동형.
// → registerNewsTools 의 anthropicApiKey 파라미터가 optional 인지 확인 후 그대로 전달.
      anthropicApiKey: anthropicKey, // undefined 허용 (스킬 내부 degrade)
```

```ts
// skills.ts:214-219 — isCliMode seed-skip 경고 정정:
// MCP 로 tool_use 활성 → brokerage_sync_holdings 가 CLI 모드에서도 동작.
// 기존 "CLI mode disables tool_use" 가정이 거짓이 됨. seed-skip 분기 제거하고 항상 seed 시도.
if (getSchedule(storage.db, NEWS_BRIEF_SCHEDULE_ID) === null) {
  // ... 기존 seed 로직 (isCliMode 분기 삭제) ...
}
```

```ts
// skills.ts:267-278 — provider.cli_tools_disabled 경고 제거:
// Phase 40 D: MCP 로 도구 활성 → "tools are inactive" 경고는 거짓. 블록 전체 삭제.
```

> ⚠️ **`registerNewsTools` 의 `anthropicApiKey` optional 여부 확인** (skills-finance). required 면 news 스킬 시그니처도 optional 화 또는 키 없을 때 `registerNewsTools` 자체를 skip (news 도구 미등록 = market-only). plan §3D "sentiment LLM degrade (분석 skip, 부팅 정상)" 충족하는 쪽 택1. implementer 는 skills-finance `registerNewsTools` 시그니처 Read 후 결정 — **가장 외과적인 쪽: 키 없으면 news 도구 등록 skip (market 도구는 유지), 로그로 명시.**

> ⚠️ **seed-skip 분기 제거 시** `news_brief.seed_skipped_cli` 경고 로그 + `isCliMode` 지역변수가 고아가 됨 → 함께 제거 (CLAUDE.md §3 자기 변경 고아 정리).

검증: `pnpm --filter @finclaw/server build && pnpm --filter @finclaw/skills-finance build`

### D6. CREATE/EDIT `packages/server/test/.../providers.test.ts` (또는 기존 composition 테스트) — 키 없는 부팅 단위 테스트

기존 composition 테스트 위치 확인 후 추가 (없으면 신규). mock-only.

```ts
// buildProviders 키 없는 부팅:
import { describe, it, expect } from 'vitest';
import { buildProviders } from '../src/composition/providers.js'; // 경로 실측

describe('buildProviders keyless CLI boot', () => {
  const logger = makeMockLogger();

  it('omits sdkAdapter/routerLlm when no anthropicKey (CLI mode)', () => {
    const b = buildProviders({
      finclawConfig: { provider: 'claude-cli' },
      anthropicKey: undefined,
      logger,
    });
    expect(b.sdkAdapter).toBeUndefined();
    expect(b.routerLlm).toBeUndefined();
    expect(b.providerAdapter).toBeDefined(); // CLI adapter 정상 생성
  });

  it('creates sdkAdapter when anthropicKey present (dual-path)', () => {
    const b = buildProviders({
      finclawConfig: { provider: 'claude-cli' },
      anthropicKey: 'sk-test',
      logger,
    });
    expect(b.sdkAdapter).toBeDefined();
    expect(b.routerLlm).toBeDefined();
  });
});
```

> provider 기본값 테스트: `getDefaults().provider === 'claude-cli'` 를 config 테스트에 추가 (D1 검증).

검증: `pnpm --filter @finclaw/server test --run` (+ `pnpm --filter @finclaw/config test --run`)

### D7. 밀스톤 D 검증

- `pnpm typecheck`
- `pnpm build` (전체 — D3/D4/D5 의 optional 전파가 모든 소비처에서 깨끗한지)
- `pnpm test --run` (D6 신규)
- `pnpm test:storage` (storage 154 회귀 없음 — D 는 storage 미변경이나 확인)
- `pnpm lint`

커밋: `feat(phase40): keyless CLI boot + default provider=claude-cli + correct stale tool_use warnings (D)`

---

## 밀스톤 E — 관찰성·비용 회계·정리 (필수분만)

**목표 (plan §3E):** `/mcp` 핸들러가 호출별 audit/observer/tracer 이벤트 emit (in-process, 무료). CLI json result 의 `total_cost_usd` → agent_runs/observability 회계. 문서 갱신.

> ⚠️ **필수분만. 나머지 스트레치** (plan §3E). session_id 영속화는 비대상 (§0).

### E1. EDIT `packages/gateway/src/mcp/host.ts` (또는 bridge.ts) — 호출별 audit/observer 이벤트 emit

`toolRegistry.execute` 는 이미 내부에서 `tool:execute:start/end`, `tool:policy:verdict` 등을 emit 함 (`registry.ts:243,313,390` — getEventBus). **즉 in-process 호출이 기존 audit 파이프라인을 자동 통과** (plan §1 "관찰성 무료"). E1 은 **추가 emit 이 필요한지 확인**: `/mcp` 진입/완료를 별도 이벤트로 표시하려면 host 에서 `getEventBus().emit('mcp:request', ...)` 1줄. 기존 tool 이벤트로 충분하면 추가 없음.

```ts
// host.ts — 선택적 (기존 tool:* 이벤트로 audit 충족 시 생략 가능):
import { getEventBus } from '@finclaw/infra';
// handleMcpRequest 진입 후 인증 통과 직후:
getEventBus().emit('mcp:request', { userId, ts: Date.now() });
```

> ⚠️ **이벤트 추가 시 `@finclaw/infra` 의 EventBus 타입에 `mcp:request` 시그니처 등록 필요** (infra event-bus 타입). 기존 tool 이벤트로 audit 가 충분하면 **추가하지 말 것** (CLAUDE.md §2 최소 코드). implementer 는 audit.\* RPC 가 tool 이벤트를 이미 캡처하는지 확인 후 결정.

검증: `pnpm --filter @finclaw/gateway build`

### E2. EDIT `packages/agent/src/providers/claude-cli/parsers.ts` + adapter.ts — `total_cost_usd` 캡처

CLI json result 의 `total_cost_usd` 를 파싱해 usage 에 포함. `CliOutput` 타입 + `parseCliJson` 확인 필요.

```ts
// parsers.ts — CliOutput.usage 또는 별도 필드에 costUsd 추가:
export interface CliOutput {
  text: string;
  sessionId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    costUsd?: number;
  };
}
// parseCliJson 안 — result.total_cost_usd 를 usage.costUsd 로 매핑.
```

```ts
// adapter.ts:48-57 — streamCompletion 의 usage chunk 에 costUsd 전파 (StreamChunk usage 타입에 필드 있으면):
// 또는 별도 관찰성 hook. agent_runs 회계 경로 확인 후 최소 배선.
```

> ⚠️ **agent_runs/observability 회계 경로 확인 필요:** `total_cost_usd` 가 어디로 흘러 agent_runs 에 기록되는지 (`agent-runs` RPC / observability). plan §3E "agent_runs/observability 회계" 의 정확한 싱크는 implementer 가 `agent_runs` 스키마 + observability 기록부를 Read 후 배선. **StreamChunk.usage 타입에 cost 필드가 없으면 추가는 types 패키지 변경 → 범위 확인.** 최소: parsers 가 costUsd 를 파싱하고 로그로 emit (DB 기록은 회계 경로가 이미 usage 를 쓰면 자동, 아니면 스트레치로 분리).

검증: `pnpm --filter @finclaw/agent build`

### E3. CREATE `packages/agent/test/providers/claude-cli/parsers.test.ts` 보강 — cost 캡처 단위 테스트

```ts
// parsers.test.ts 에 추가 (기존 파일 있으면 보강):
it('captures total_cost_usd from claude json result', () => {
  const out = parseCliJson(
    JSON.stringify({
      type: 'result',
      result: 'ok',
      total_cost_usd: 0.34,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    DEFAULT_CLAUDE_BACKEND,
  );
  expect(out?.usage?.costUsd).toBe(0.34);
});
```

검증: `pnpm --filter @finclaw/agent test --run`

### E4. CREATE `packages/gateway/src/mcp/host.audit.test.ts` (선택) — audit 이벤트 emit 단위 테스트

E1 에서 `mcp:request` 이벤트를 추가한 경우만. 기존 tool 이벤트로 충분하면 **이 단계 생략**.

```ts
// E1 에서 이벤트 추가 시:
it('emits mcp:request on authenticated call', async () => {
  const events: unknown[] = [];
  getEventBus().on('mcp:request', (e) => events.push(e));
  // ... 유효 Bearer 로 handleMcpRequest 호출 ...
  expect(events.length).toBe(1);
});
```

검증: `pnpm --filter @finclaw/gateway test --run`

### E5. EDIT 문서 — README / CLAUDE.md / phase 노트 갱신

```
- README: "Claude 구독(CLI)-only 부팅" 섹션 — ANTHROPIC_API_KEY 불요, claude OAuth + MCP 금융도구.
- CLAUDE.md: phase40 변경 이력 추가 (하네스 표가 아니라 프로젝트 노트면 해당 위치).
- plans/phase40/ 노트: A8 go/no-go 결과 (http go 확정 또는 stdio 폴백) 기록.
```

> ⚠️ **session_id 영속화는 문서에서 "비대상(phase41+)" 으로 명시** (plan §0). 실시간 스트리밍·SDK 제거도 OUT 으로 명시.

검증: 없음 (문서)

### E6. 밀스톤 E 검증

- `pnpm typecheck`
- `pnpm build` (전체)
- `pnpm test --run` (E3/E4 신규)
- `pnpm test:storage`
- `pnpm lint`

커밋: `feat(phase40): per-call MCP observability + CLI cost accounting + docs (E)`

---

## 최종 검증

A~E 전부 완료 후 한 번에:

- `pnpm typecheck` ✅
- `pnpm test --run` ✅ (unit ≥ 1679 + 신규 — 회귀 0)
- `pnpm test:storage` ✅ (154 불변)
- `pnpm lint` ✅
- `pnpm build` ✅
- **수동 (1회):** A8 의 라이브 spawn 재실행으로 전체 경로 (키 없는 부팅 → CLI spawn → /mcp → toolRegistry.execute → 실데이터) end-to-end 1회 확인.

---

## 롤백 절차

각 밀스톤이 독립 커밋이므로 `git revert <밀스톤 커밋>` 으로 단계적 롤백:

- E revert → 관찰성/비용/문서만 제거 (코어 동작 유지).
- D revert → 키 없는 부팅 비활성 (provider 기본 SDK 복귀, `requireEnv` 복원). **C 의 MCP 배선은 유지되나 SDK 모드라 미사용.**
- C revert → CLI runner MCP 플래그 제거 (spawn 이 도구 없이 동작).
- B revert → 제너릭 브리지 제거 (A 의 단일 도구 스파이크만).
- A revert → `/mcp` 라우트 + 의존성 전체 제거 (phase39 상태 복귀).

**안전판:** SDK 휴면 경로 유지 (plan §5) — phase40 은 SDK 를 제거하지 않으므로 키만 다시 넣으면 dual-path 복귀.

---

## ⚠️ 위험 / 불확실 지점 (implementer 주의 — 재추론 금지, 아래 지침대로)

1. **🔴 A8 go/no-go (리스크 #1):** `-p --mcp-config` 의 http 인라인 JSON 수용은 **수동 검증 전까지 미확정**. B~E 코드는 http "go" 전제. no-go 면 C2 의 runner 블록을 stdio command 로 교체 (transport 만, 나머지 불변). **A8 를 통과하지 않고 B 로 진행 금지.**
2. **MCP SDK `handleRequest` 핸드셰이크:** stateless transport 가 full JSON-RPC initialize 를 기대할 수 있음 → A5 테스트에서 full 라운드트립이 어려우면 브리지 로직(필터/매핑/execute 경유)만 단위 테스트로 분리하고 transport 는 SDK 책임으로 둘 것 (A5 ⚠️).
3. **`registerTool` inputSchema = Zod raw shape:** JSON Schema 객체 그대로 넘기면 안 됨 → `jsonSchemaToZodShape` (registry 의 private `jsonSchemaToZod` 미러) 사용. registry 내부 헬퍼는 export 안 됨 → bridge.ts 가 자체 보유 (사실 4).
4. **abortSignal 전파 (B3 ⚠️):** plan §3 "abortSignal 은 요청에서". host 가 `req.on('close')` 와 묶인 AbortController 를 bridge executor 에 전달하도록 시그니처 확장. A 스파이크는 새 signal 로 단순화 가능하나 B 에서 정식화.
5. **summarizer 연쇄 (D4 ⚠️ — D 의 유일한 비자명 연쇄):** `routerLlm` 은 이미 optional 이라 무변경(사실 9)이지만 `sdkAdapter.summarize` 는 `AutoReplyPipeline` 옵션으로 흐름. pipeline 이 summarizer 를 required 로 받으면 옵션 optional 화 필요 (압축 skip = degrade). implementer 는 `AutoReplyPipeline` 생성자 타입 Read 후 전파.
6. **`registerNewsTools` anthropicApiKey optional 여부 (D5 ⚠️):** required 면 키 없을 때 news 도구 등록 skip (market-only) 이 가장 외과적. skills-finance 시그니처 Read 후 결정.
7. **`total_cost_usd` 회계 싱크 (E2 ⚠️):** `StreamChunk.usage` 에 cost 필드 부재 시 types 변경 = 범위 경계. 최소 = parsers 캡처 + 로그; DB 기록이 usage 경로 재사용이면 자동, 아니면 스트레치 분리.
8. **`mcp:request` 이벤트 (E1 ⚠️):** 기존 `tool:execute:*` 이벤트로 audit 가 이미 충족되면 신규 이벤트 추가 금지 (CLAUDE.md §2). audit.\* RPC 캡처 범위 확인 후 결정.
9. **jwtSecret 일관성 (C6 ⚠️):** buildProviders(line 184) 가 gatewayConfig(line 296) 보다 먼저 호출됨 → 양쪽이 `defaultConfig.auth.jwtSecret` (= `GATEWAY_JWT_SECRET ?? 'dev-secret'`) 를 공유. mint 토큰의 secret 과 /mcp 검증 secret 이 같아야 round-trip 성립.
10. **stale 헤더 주석 (사실 1):** gateway 파일들의 `// packages/server/src/gateway/...` 헤더는 phase39 백로그 — phase40 에서 건드리지 말 것 (외과적 변경).

## 범위 경계 재확인 (plan §4 OUT — 절대 금지)

- ❌ SDK 런타임 제거 (phase41). SDK 휴면 경로 유지.
- ❌ 실시간 토큰 스트리밍 (stream-json NDJSON). 기존 합성 단일 text_delta 유지.
- ❌ CLI session_id 영속화. adapter 메모리(`#cliSessionId`) 그대로.
- ❌ RAG 임베딩 변경. 키 없으면 기존대로 FTS-only.
- ❌ KR 종목.
- ❌ plan 이 요구 안 한 인접 코드 리팩토링 (stale 헤더, 죽은 re-export 등 phase39 P3 백로그).
