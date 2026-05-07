# Phase 29 Todo: Critical 5 해소 (Production-grade 진입)

> [plan.md](../../plans/phase29/plan.md) 의 5 트랙(A/B/C/D/E)을 현재 레포 상태(base SHA `60a95c2`, phase26+28 머지 후)에 맞춰 코드 단위로 분해. plan.md 권장 순서대로 E → A → B → C → D 진행. 각 단계 끝의 검증 명령 통과를 다음 단계 진입 조건으로 한다.

- 브랜치: `feature/critical-5` (이미 체크아웃됨)
- 작업 디렉토리: `/mnt/c/Users/박/Desktop/hi/FinClaw`
- 시작 SHA: `60a95c2` (`feat(phase27): US market data expansion ...`)

---

## 사전 준비

### P-1. clean tree 확인 + DB/감사 백업

```sh
git status                                                      # clean working tree
git rev-parse HEAD                                              # 시작 SHA (= 60a95c2)

# 본 Phase 는 SCHEMA_VERSION v6 → v7 마이그레이션 포함 (트랙 B). dev DB 백업.
DEV_DB="${HOME}/.finclaw/db.sqlite"
[ -f "$DEV_DB" ] && cp "$DEV_DB" "${DEV_DB}.pre-phase29.bak"

# audit/ 가 남아 있으면 비교용으로 백업 (Phase 29 종료 후 재감사).
[ -d _workspace/audit ] && mv _workspace/audit _workspace/audit_phase29_start
```

### P-2. 사용자 결정 사항 5건 (모두 기본값 채택, plan.md §사용자 결정 사항)

- (A) `runWithModelFallback` cross-provider 폴백: **동일 벤더 내만** (default)
- (A) 1차 추가 provider: **OpenAI** (gpt-4o, gpt-4o-mini)
- (C) 차원 정책: **provider 별 단일 차원 락 + truncation** (vec0 = 1024D 고정, OpenAI 는 `dimensions=1024` 옵션으로 truncate)
- (D) MCP transport: **stdio 만**
- (D) MCP 도구 정책: **9-단계 정책의 group=`mcp` 슬롯 + `require-approval` 기본**

---

## 트랙 E — Gateway 운영성 모듈 배선 (C-5)

> 가장 먼저 종료. main.ts 배선 패턴을 트랙 D 가 그대로 활용.
> 5 모듈은 모두 `packages/server/src/gateway/` 에 unit test 포함된 형태로 존재 — `main.ts` 호출만 0건. 본 트랙은 그 호출만 추가한다.

### E1. EDIT `packages/server/src/gateway/router.ts` — request rate-limit 미들웨어 통합

`handleRpcRequest` 진입 직후, `authenticate` 호출 전에 `RequestRateLimiter` 검사. Limiter 인스턴스는 `GatewayServerContext` 에 주입 (E2 와 동일 패턴 — server.ts 가 ctx 에 추가).

```ts
// packages/server/src/gateway/router.ts (handleRpcRequest 함수 상단에 추가)
async function handleRpcRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  // E1: IP 기반 슬라이딩 윈도우 rate-limit (60 rpm 기본).
  const ip = req.socket.remoteAddress ?? 'unknown';
  const rl = ctx.rateLimiter?.check(ip);
  if (rl && !rl.allowed) {
    const headers = RequestRateLimiter.toRateLimitHeaders(rl.info);
    res.writeHead(429, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(createError(null, RpcErrors.RATE_LIMITED, 'Too Many Requests')));
    return;
  }

  let body: string;
  // ... 기존 ...
}
```

`RpcErrors.RATE_LIMITED` 이 없으면 `packages/server/src/gateway/rpc/errors.ts` 의 enum/상수에 추가 (값: `-32029` 또는 기존 컨벤션 따름).

검증: `rg "RATE_LIMITED" packages/server/src/gateway/rpc/errors.ts` 매칭, `pnpm typecheck`.

### E2. EDIT `packages/server/src/gateway/context.ts` — ctx 에 rateLimiter / accessLogger / authRateLimiter 주입 슬롯 추가

```ts
// packages/server/src/gateway/context.ts (interface GatewayServerContext)
import type { RequestRateLimiter } from './rate-limit.js';
import type { AuthRateLimiter } from './auth/rate-limit.js';

export interface GatewayServerContext {
  // ... 기존 (config, httpServer, wss, connections, registry, broadcaster, isDraining)
  /** E1: 요청 수준 IP rate limiter (없으면 비활성화) */
  rateLimiter?: RequestRateLimiter;
  /** E2: HTTP 액세스 로거 (없으면 비활성화) */
  accessLogger?: ReturnType<typeof import('./access-log.js').createAccessLogger>;
  /** E4: auth 실패 IP rate limiter (없으면 비활성화) */
  authRateLimiter?: AuthRateLimiter;
}
```

검증: `pnpm typecheck`.

### E3. EDIT `packages/server/src/gateway/router.ts` — handleHttpRequest 에 access logger 후크

`handleHttpRequest` 진입 직후 (CORS 처리 전) `ctx.accessLogger?.(req, res)` 호출. 로거가 `res.on('finish')` 로 자동 기록.

```ts
// packages/server/src/gateway/router.ts
export async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  // E3: HTTP access log 등록 (응답 finish 시 자동 emit).
  ctx.accessLogger?.(req, res);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    handleCors(req, res, ctx.config.cors);
    return;
  }
  // ... 기존 ...
}
```

검증: `pnpm typecheck`.

### E4. EDIT `packages/server/src/gateway/router.ts` — auth rate-limit 통합

`handleRpcRequest` 의 `authenticate` 호출 직전, `ctx.authRateLimiter?.isBlocked(ip)` 가 true 면 즉시 401 + `Retry-After`. 인증 실패 시 `recordFailure(ip)` 호출.

```ts
// packages/server/src/gateway/router.ts (handleRpcRequest 의 authenticate 직전/직후)
const ip = req.socket.remoteAddress ?? 'unknown';
if (ctx.authRateLimiter?.isBlocked(ip)) {
  res.writeHead(401, { 'Content-Type': 'application/json', 'Retry-After': '900' });
  res.end(JSON.stringify(createError(null, RpcErrors.UNAUTHORIZED, 'Auth rate limited')));
  return;
}

const authResult = await authenticate(req, ctx.config.auth);
if (!authResult.ok) {
  ctx.authRateLimiter?.recordFailure(ip);
  res.writeHead(authResult.code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(createError(null, RpcErrors.UNAUTHORIZED, authResult.error)));
  return;
}
```

검증: `pnpm typecheck`.

### E5. EDIT `packages/server/src/gateway/server.ts` — RequestRateLimiter / AccessLogger / AuthRateLimiter 인스턴스화 + ctx 에 주입 + DB·embedding health checker 등록

```ts
// packages/server/src/gateway/server.ts (createGatewayServer 본체 시작부)
import { RequestRateLimiter } from './rate-limit.js';
import { createAccessLogger } from './access-log.js';
import { AuthRateLimiter } from './auth/rate-limit.js';
import {
  registerHealthChecker,
  createDbHealthChecker,
  createProviderHealthChecker,
} from './health.js';

export function createGatewayServer(
  config: GatewayServerConfig,
  deps: GatewayServerDeps,
): GatewayServer {
  // ... 기존 (httpServer, wss) ...

  // E5: 운영성 인스턴스 생성. config 에 키가 있으면 활성, 없으면 undefined → router 가 자동 noop.
  const rateLimiter = new RequestRateLimiter({
    windowMs: 60_000,
    maxRequests: config.rateLimit?.requestsPerMinute ?? 60,
  });
  const accessLogger = createAccessLogger(); // stdout JSON
  const authRateLimiter = new AuthRateLimiter({
    maxFailures: 5,
    windowMs: 5 * 60_000,
    blockDurationMs: 15 * 60_000,
  });

  const ctx: GatewayServerContext = {
    config,
    httpServer,
    wss,
    connections: new Map(),
    registry: new ChatRegistry(config.auth.sessionTtlMs),
    broadcaster: new GatewayBroadcaster(),
    isDraining: false,
    rateLimiter,
    accessLogger,
    authRateLimiter,
  };

  // E5: deep health checker 등록. db ping 은 storage.db.exec('SELECT 1'), embedding ping 은 매우 짧은 텍스트 1건.
  if (deps.dbHealthCheck) {
    registerHealthChecker(createDbHealthChecker(deps.dbHealthCheck));
  }
  if (deps.embeddingHealthCheck) {
    registerHealthChecker(createProviderHealthChecker('embedding', deps.embeddingHealthCheck));
  }

  // ... 기존 RPC 메서드 등록 ...

  // E5: stop() 직전 rateLimiter / authRateLimiter dispose.
  return {
    httpServer,
    wss,
    ctx,
    async start(): Promise<void> {
      /* 기존 */
    },
    async stop(): Promise<void> {
      ctx.isDraining = true;
      // ... 기존 ...
      rateLimiter.dispose();
      authRateLimiter.clear();
      // ... 기존 close ...
    },
  };
}
```

`GatewayServerDeps` 에 `dbHealthCheck?: () => Promise<void>`, `embeddingHealthCheck?: () => Promise<void>` 추가.
`GatewayServerConfig` (`packages/server/src/gateway/rpc/types.ts`) 에 `rateLimit?: { requestsPerMinute: number }` 추가.

검증: `pnpm typecheck`.

### E6. EDIT `packages/server/src/main.ts` — gateway 생성 시 health check 콜백 + (dev only) hot reloader 활성화

```ts
// packages/server/src/main.ts (createGatewayServer 호출 직전·직후)
const gateway = createGatewayServer(gatewayConfig, {
  // ... 기존 (storage, defaultModel, adapter, financeDeps, agentDeps, memoryDeps, scheduleDeps) ...
  dbHealthCheck: async () => {
    storage.db.prepare('SELECT 1').get();
  },
  embeddingHealthCheck: embeddingProvider
    ? async () => {
        // 짧은 query 1건 — 실패 시 throw → degraded
        await embeddingProvider.embedQuery('healthz');
      }
    : undefined,
});

// E6: dev 모드에서만 hot reload — prompts 디렉터리 watch.
if (process.env.NODE_ENV !== 'production') {
  const { createHotReloader } = await import('./gateway/hot-reload.js');
  const promptsPath = join(import.meta.dirname, '..', 'prompts', 'finclaw.system.ko.md');
  const hotReloader = createHotReloader(
    { configPath: promptsPath, debounceMs: 500, validateBeforeApply: false, mode: 'watch' },
    gateway.ctx,
    () => ({ success: true }),
  );
  hotReloader.on('change', (e) => {
    logger.info('Prompts hot-reloaded', { event: 'prompts.reloaded', path: e.path });
  });
  await hotReloader.start();
  lifecycle.register(() => hotReloader.stop());
}
```

검증: `pnpm typecheck`, `pnpm dev` 후 `packages/server/prompts/finclaw.system.ko.md` 수정 시 콘솔에 `prompts.reloaded` 로그.

### E7. EDIT `packages/server/src/gateway/rate-limit.test.ts` — router 통합 폭주 시나리오 추가

기존 unit test 보존, 끝에 `describe('integration with router', ...)` 추가:

- `RequestRateLimiter` + 가짜 `IncomingMessage`/`ServerResponse` 로 60+ 요청 → 일부가 429 + `Retry-After` 헤더.
- `AuthRateLimiter` 5회 실패 → 6회째 `isBlocked()` true.

```sh
pnpm test --filter @finclaw/server -- gateway/rate-limit
```

### E8. CREATE `packages/server/src/main.test.ts` (있으면 EDIT) — 부트 시퀀스 e2e

```ts
// 5 모듈 모두 활성 상태인지 ctx 에서 확인.
import { describe, it, expect } from 'vitest';
import { createGatewayServer } from './gateway/server.js';

describe('main boot wiring (Phase 29 E)', () => {
  it('gateway ctx 에 rateLimiter / accessLogger / authRateLimiter 가 주입된다', () => {
    const gw = createGatewayServer(/* minimal config + deps */);
    expect(gw.ctx.rateLimiter).toBeDefined();
    expect(gw.ctx.accessLogger).toBeDefined();
    expect(gw.ctx.authRateLimiter).toBeDefined();
    void gw.stop();
  });
});
```

검증: `pnpm test --filter @finclaw/server -- main.test`.

### E9. 트랙 E 검증

```sh
pnpm typecheck
pnpm test --filter @finclaw/server -- gateway/rate-limit gateway/access-log gateway/hot-reload main.test
pnpm format:fix
pnpm lint
git add -p && git commit -m "feat(server/gateway): wire rate-limit/access-log/hot-reload/health (Phase 29 E)"
```

완료 조건:

- 5 모듈 (`RequestRateLimiter`, `createAccessLogger`, `createHotReloader`, `AuthRateLimiter`, `registerHealthChecker`) 모두 ctx 에 주입됨
- `pnpm dev` 후 인위 폭주 200 요청 → 일부 429
- `/healthz` 가 `db` + `embedding` (있을 때) 컴포넌트 포함

---

## 트랙 A — Provider 다중화 (C-1)

> ProviderId 를 `'anthropic' | 'openai'` 로 확장하고 OpenAIAdapter 를 `ProviderAdapter` 인터페이스로 구현.
> cross-provider 폴백은 차단 (사용자 결정 1) — fallback chain 이 동일 provider 모델만 시도하도록 가드.

### A1. EDIT `packages/agent/package.json` — openai SDK dep 추가

```sh
pnpm add openai@^4 --filter @finclaw/agent
```

`packages/agent/package.json` 의 `dependencies` 에 `"openai": "^4.x"` 추가.

검증: `pnpm install` 통과, `pnpm format:fix` (oxfmt 가 키 순서 정렬).

### A2. EDIT `packages/agent/src/models/catalog.ts` — `ProviderId` union 확장

```ts
// packages/agent/src/models/catalog.ts:4
/** 모델 제공자 식별자 */
export type ProviderId = 'anthropic' | 'openai';
```

검증: `pnpm typecheck` — 다른 곳에서 `'anthropic'` 으로 narrowing 한 곳이 있으면 error 위치 확인. `ENV_KEY_MAP` (resolver.ts) 에서 type error 발생할 것 (A4 에서 처리).

### A3. EDIT `packages/agent/src/models/catalog-data.ts` — OpenAI 모델 2종 추가

`BUILT_IN_MODELS` 끝에 두 엔트리 추가. capabilities 는 OpenAI 공식 문서 기준 (gpt-4o vision/tools/streaming 모두 true; cache 는 prompt_cache_key 로 가능, 본 Phase 는 보수적으로 `cacheReadPerMillion` 미설정).

```ts
// packages/agent/src/models/catalog-data.ts
export const BUILT_IN_MODELS: readonly ModelEntry[] = [
  // ... 기존 3개 anthropic 엔트리 ...
  {
    id: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: false,
      numericalReasoningTier: 'high',
    },
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    aliases: ['gpt-4o', 'openai-4o'],
    deprecated: false,
    releaseDate: '2024-05-13',
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o mini',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: false,
      numericalReasoningTier: 'medium',
    },
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    aliases: ['gpt-4o-mini', 'openai-4o-mini'],
    deprecated: false,
    releaseDate: '2024-07-18',
  },
];
```

검증: `pnpm test --filter @finclaw/agent -- catalog` 통과 + `BUILT_IN_MODELS.filter(m => m.provider === 'openai').length === 2`.

### A4. EDIT `packages/agent/src/auth/resolver.ts` — `ENV_KEY_MAP` 에 openai 추가

```ts
// packages/agent/src/auth/resolver.ts:33
const ENV_KEY_MAP: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};
```

검증: `pnpm typecheck` — A2 에서 발생한 ProviderId narrowing error 가 해소돼야 함.

### A5. CREATE `packages/agent/src/providers/openai.ts` — OpenAIAdapter 구현

`ProviderAdapter` 인터페이스 100% 구현. `streamCompletion` 은 OpenAI 의 SSE chunk → `StreamChunk` (6-variant) 매핑.

```ts
// packages/agent/src/providers/openai.ts
import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions.js';
import type { ConversationMessage, ToolDefinition } from '@finclaw/types';
import { FailoverError } from '../errors.js';
import type { StreamChunk } from '../models/provider-normalize.js';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';

/**
 * 내부 ConversationMessage → OpenAI ChatCompletionMessageParam 변환.
 *
 * - role 'tool' → 'tool' (OpenAI 도 tool message 별도 role)
 * - assistant 의 tool_use 블록 → assistant.tool_calls[]
 * - tool_result 블록 → role='tool', tool_call_id=<toolUseId>
 */
function toOpenAIMessages(messages: ConversationMessage[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      result.push({ role: 'system', content: typeof m.content === 'string' ? m.content : '' });
      continue;
    }
    if (m.role === 'tool') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const toolMsg: ChatCompletionToolMessageParam = {
            role: 'tool',
            tool_call_id: b.toolUseId,
            content: b.content,
          };
          result.push(toolMsg);
        }
      }
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content
        .filter(
          (b): b is Extract<(typeof m.content)[number], { type: 'text' }> => b.type === 'text',
        )
        .map((b) => b.text)
        .join('');
      const toolCalls = m.content
        .filter(
          (b): b is Extract<(typeof m.content)[number], { type: 'tool_use' }> =>
            b.type === 'tool_use',
        )
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      result.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    result.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    });
  }
  return result;
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    try {
      const sys = params.systemPrompt
        ? [{ role: 'system' as const, content: params.systemPrompt }]
        : [];
      return await this.client.chat.completions.create(
        {
          model: params.model,
          max_completion_tokens: params.maxTokens ?? 4096,
          messages: [
            ...sys,
            ...toOpenAIMessages(params.messages.filter((m) => m.role !== 'system')),
          ],
          ...(params.tools?.length ? { tools: toOpenAITools(params.tools) } : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        },
        { signal: params.abortSignal },
      );
    } catch (error) {
      throw wrapOpenAIError(error);
    }
  }

  async *streamCompletion(params: ProviderRequestParams): AsyncIterable<StreamChunk> {
    const sys = params.systemPrompt
      ? [{ role: 'system' as const, content: params.systemPrompt }]
      : [];
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: params.model,
          max_completion_tokens: params.maxTokens ?? 4096,
          messages: [
            ...sys,
            ...toOpenAIMessages(params.messages.filter((m) => m.role !== 'system')),
          ],
          ...(params.tools?.length ? { tools: toOpenAITools(params.tools) } : {}),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: params.abortSignal },
      );

      // OpenAI 는 tool_use 가 chunk delta.tool_calls[index].function.{name,arguments} 로 분할 도착.
      // index 별로 첫 등장 시 tool_use_start, 이후 arguments delta 마다 tool_input_delta, finish_reason 시 tool_use_end.
      const startedToolIndices = new Set<number>();
      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          yield { type: 'text_delta', text: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!startedToolIndices.has(idx)) {
              startedToolIndices.add(idx);
              if (tc.id && tc.function?.name) {
                yield { type: 'tool_use_start', id: tc.id, name: tc.function.name };
              }
            }
            if (tc.function?.arguments) {
              yield { type: 'tool_input_delta', delta: tc.function.arguments };
            }
          }
        }
        if (choice?.finish_reason) {
          // tool_use_end 는 OpenAI 에 직접 대응 이벤트 없음 — finish_reason 시 모든 활성 도구 종료.
          for (const _ of startedToolIndices) {
            yield { type: 'tool_use_end' };
          }
          startedToolIndices.clear();
        }
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        }
      }
      yield { type: 'done' };
    } catch (error) {
      throw wrapOpenAIError(error);
    }
  }
}

/** OpenAI SDK 에러 → FailoverError 변환 */
function wrapOpenAIError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  if (error.name === 'AbortError') {
    return error;
  }
  const status = (error as { status?: number }).status;
  if (status === 429) {
    return new FailoverError(`OpenAI rate limit: ${error.message}`, 'rate-limit', {
      statusCode: 429,
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new FailoverError(`OpenAI server error: ${error.message}`, 'server-error', {
      statusCode: status,
      cause: error,
    });
  }
  return error;
}
```

검증: `pnpm typecheck`, `pnpm test --filter @finclaw/agent`.

### A6. EDIT `packages/agent/src/index.ts` — OpenAIAdapter export

```ts
// packages/agent/src/index.ts
export { OpenAIAdapter } from './providers/openai.js';
// ... 기존 AnthropicAdapter export ...
```

검증: `pnpm typecheck`.

### A7. EDIT `packages/agent/src/models/fallback.ts` — cross-provider 폴백 차단 가드

기본값: chain 첫 모델의 provider 와 다른 provider 모델은 자동 skip + warn 로그 (사용자 결정 1).

```ts
// packages/agent/src/models/fallback.ts (effectiveModels 필터 직후)
export interface FallbackConfig {
  // ... 기존 ...
  /** Phase 29 A: cross-provider 폴백 허용 (기본 false — 동일 벤더 내만 시도) */
  readonly allowCrossProvider?: boolean;
}

// runWithModelFallback 내부, floor 필터 직후:
if (config.allowCrossProvider !== true && effectiveModels.length > 0) {
  const firstProvider = resolve(effectiveModels[0]).provider;
  effectiveModels = effectiveModels.filter((m) => resolve(m).provider === firstProvider);
}
```

`resolve` 가 chain 마다 호출되므로 비용은 미미. resolve 결과를 한 번 캐시해도 됨 (간결성 우선 — implementer 재량).

검증: `pnpm test --filter @finclaw/agent -- fallback` 통과.

### A8. CREATE `packages/agent/test/providers/openai.test.ts` — OpenAIAdapter unit test

mock fetch / OpenAI SDK 호출. SDK 인스턴스를 직접 모킹하기 어려우면 `vi.mock('openai', ...)` 으로 client 메소드 stub.

```ts
// packages/agent/test/providers/openai.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import type { ConversationMessage } from '@finclaw/types';

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async (params, _opts) => {
            if (params.stream) {
              // async iterator returning 1 text chunk + finish + usage
              return (async function* () {
                yield {
                  choices: [{ delta: { content: 'hello' }, finish_reason: null }],
                };
                yield {
                  choices: [{ delta: {}, finish_reason: 'stop' }],
                };
                yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } };
              })();
            }
            return { id: 'cmpl-1', model: params.model, choices: [], usage: {} };
          }),
        },
      },
    })),
  };
});

describe('OpenAIAdapter', () => {
  const adapter = new OpenAIAdapter('test-key');
  const userMsg: ConversationMessage = { role: 'user', content: 'hi' };

  it('streamCompletion: text_delta + done + usage', async () => {
    const chunks = [];
    for await (const c of adapter.streamCompletion({ model: 'gpt-4o-mini', messages: [userMsg] })) {
      chunks.push(c);
    }
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
  });

  it('chatCompletion: returns model id', async () => {
    const result = (await adapter.chatCompletion({
      model: 'gpt-4o-mini',
      messages: [userMsg],
    })) as { model: string };
    expect(result.model).toBe('gpt-4o-mini');
  });
});
```

검증: `pnpm test --filter @finclaw/agent -- providers/openai`.

### A9. EDIT `packages/agent/test/models/fallback.test.ts` — cross-provider 차단 시나리오

(파일이 있으면 EDIT, 없으면 CREATE):

```ts
// packages/agent/test/models/fallback.test.ts (describe('cross-provider gate', ...) 추가)
it('allowCrossProvider=false (default) — skips models from different provider', async () => {
  const chain = [
    { raw: 'claude-sonnet-4-6' },
    { raw: 'gpt-4o' },
    { raw: 'claude-haiku-4-5-20251001' },
  ];
  // anthropic 첫 모델 → openai 모델은 skip → claude-haiku 만 남음
  let called: string[] = [];
  await expect(
    runWithModelFallback(
      { models: chain, maxRetriesPerModel: 0, retryBaseDelayMs: 1, fallbackOn: ['rate-limit'] },
      async (resolved) => {
        called.push(resolved.modelId);
        throw new FailoverError('rl', 'rate-limit');
      },
      // resolve stub
      (ref) => ({
        entry: {
          id: ref.raw,
          provider: ref.raw.startsWith('gpt') ? 'openai' : 'anthropic' /* ... */,
        } as any,
        provider: ref.raw.startsWith('gpt') ? 'openai' : 'anthropic',
        modelId: ref.raw,
        resolvedFrom: 'id' as const,
      }),
    ),
  ).rejects.toThrow();
  expect(called).not.toContain('gpt-4o');
});
```

검증: `pnpm test --filter @finclaw/agent -- fallback`.

### A10. 트랙 A 검증

```sh
pnpm typecheck
pnpm test --filter @finclaw/agent
pnpm format:fix
pnpm lint
git add -p && git commit -m "feat(agent/providers): add OpenAIAdapter + multi-provider routing (Phase 29 A)"
```

완료 조건:

- `BUILT_IN_MODELS.filter(m => m.provider === 'openai').length >= 2`
- `OpenAIAdapter` 가 `ProviderAdapter` 인터페이스 100% 구현
- 기존 anthropic 경로 회귀 0
- cross-provider 폴백 차단 (기본값) 검증 1건

---

## 트랙 B — RAG citation (C-2)

> 회상된 메모리에 인용 ID 부착, system prompt 가이드 라인 추가, 응답에서 정규식으로 추출하여 `agent_runs.usedMemoryIds` 에 영속화. SCHEMA_VERSION 6 → 7 마이그레이션.

### B1. EDIT `packages/server/src/auto-reply/stages/memory-retrieval.ts` — `formatBackgroundSection` 인용 마커 부착

```ts
// packages/server/src/auto-reply/stages/memory-retrieval.ts:171
export function formatBackgroundSection(result: RetrievalResult): string {
  const lines: string[] = [];

  if (result.snippets.length > 0) {
    lines.push('## 사용자 배경지식 (자동 주입)');
    for (const s of result.snippets) {
      // B1: 메모리 줄 끝에 [mem:<id 첫 6자>] 마커 부착.
      lines.push(
        `- [${s.type}] ${s.content} (${isoDate(s.createdAt)} 저장) [mem:${s.id.slice(0, 6)}]`,
      );
    }
  }

  if (result.transactions.length > 0) {
    const bySymbol = new Map<string, InjectedTransaction[]>();
    for (const tx of result.transactions) {
      const list = bySymbol.get(tx.symbol);
      if (list) list.push(tx);
      else bySymbol.set(tx.symbol, [tx]);
    }
    for (const [symbol, txs] of bySymbol) {
      if (lines.length > 0) lines.push('');
      lines.push(`## 최근 거래 (${symbol})`);
      for (const tx of txs) {
        const label = ACTION_LABEL[tx.action];
        const priceStr = tx.price !== null ? `@ ${tx.currency} ${tx.price}`.trim() : '';
        // B1: 거래에 [txn:<symbol+executedAt 해시>] 부착 — InjectedTransaction 에 id 가 없으므로 symbol+ts 로 stable prefix.
        const txMark = `${tx.symbol}:${tx.executedAt}`.slice(0, 12);
        lines.push(
          `- ${isoDate(tx.executedAt)}: ${label} ${tx.quantity}주 ${priceStr} [txn:${txMark}]`.replace(
            /\s+\[txn/,
            ' [txn',
          ),
        );
      }
    }
  }

  return lines.join('\n');
}
```

`InjectedTransaction` 에 별도 id 필드 없음 → symbol+executedAt 으로 stable hash. 충돌 빈도 낮음.

검증: `pnpm test --filter @finclaw/server -- memory-retrieval` 의 기존 4 시나리오에서 마커 체크 추가.

### B2. EDIT `packages/server/prompts/finclaw.system.ko.md` — 인용 규칙 추가

기존 5 원칙 (읽기 전용, 환각 금지, 출처 명시, 불확실성 수치화, 간결한 한국어) 끝에 6번째로 추가:

```md
6. **회상 인용.** "사용자 배경지식 (자동 주입)" 섹션에서 회상한 사실을 인용하면 해당 문장 끝에 `[mem:xxxxxx]` (회상된 마커 그대로 복사). 거래 인용은 `[txn:...]`. 추측이나 일반 지식은 인용하지 마라. 복수 인용은 `[mem:aaa,bbb]`.
```

검증: `grep -n "회상 인용" packages/server/prompts/finclaw.system.ko.md` 매칭.

### B3. EDIT `packages/storage/src/database.ts` — SCHEMA_VERSION v6 → v7 + agent_runs.used_memory_ids

```ts
// packages/storage/src/database.ts:21
const SCHEMA_VERSION = 7;
```

`SCHEMA_DDL` 의 `agent_runs` 테이블 정의에 `used_memory_ids TEXT,` 추가 (id 컬럼 다음).

`MIGRATIONS` 객체에 v7 단계 추가:

```ts
// packages/storage/src/database.ts (MIGRATIONS 객체)
7: (db: DatabaseSync) => {
  const cols = db.prepare(`PRAGMA table_info('agent_runs')`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'used_memory_ids')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN used_memory_ids TEXT;`);
  }
},
```

검증: `pnpm test:storage -- database.migration`.

### B4. EDIT `packages/storage/src/agent-runs.ts` — `usedMemoryIds: string[]` round-trip

`AgentRunRow` 에 `used_memory_ids: string | null` 추가. `rowToAgentRun` 에서 JSON.parse. `addAgentRun` input 에 `usedMemoryIds?: string[]` 추가하고 INSERT 컬럼 / VALUES / params 보강 (JSON.stringify).

```ts
// packages/storage/src/agent-runs.ts
export interface AgentRunRow {
  // ... 기존 ...
  used_memory_ids: string | null;
}

export interface AddAgentRunInput {
  // ... 기존 ...
  /** Phase 29 B: RAG 인용으로 응답이 의존한 memory.id 목록 (응답 후처리에서 채움) */
  usedMemoryIds?: string[];
}

function rowToAgentRun(row: AgentRunRow): AgentRun {
  return {
    // ... 기존 필드 ...
    usedMemoryIds:
      row.used_memory_ids === null ? undefined : (JSON.parse(row.used_memory_ids) as string[]),
  };
}

// addAgentRun: INSERT 에 used_memory_ids 컬럼 추가, params 에 JSON.stringify(input.usedMemoryIds ?? null) || null.
db.prepare(
  `INSERT INTO agent_runs
   (id, agent_id, prompt, output, tool_calls_json, tokens_input, tokens_output,
    duration_ms, model_used, role, memory_id, used_memory_ids, error, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  id,
  // ... 기존 13 ...
  input.usedMemoryIds ? JSON.stringify(input.usedMemoryIds) : null,
  input.error ?? null,
  createdAt as number,
);
```

검증: `pnpm test --filter @finclaw/storage -- agent-runs`.

### B5. EDIT `packages/types/src/agent.ts` — `AgentRun.usedMemoryIds?: string[]` 필드 추가

```ts
// packages/types/src/agent.ts (AgentRun interface)
export interface AgentRun {
  // ... 기존 ...
  /** Phase 29 B: RAG 인용 추출 결과 (응답이 의존한 memory.id 배열) */
  usedMemoryIds?: string[];
  createdAt: Timestamp;
}
```

검증: `pnpm typecheck`.

### B6. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — 응답 텍스트에서 인용 추출 + retrievalResult 의 후보 ID 와 매칭

`execute()` 의 `extractAssistantText(result.messages)` 결과를 받아서, `ctx.retrievalResult?.snippets` 의 ID prefix(첫 6자) 와 매칭하여 resolved IDs 배열을 만든다. Tool calls 와 같은 위치에서 `usedMemoryIds` 를 ExecutionResult 에 추가.

```ts
// packages/server/src/auto-reply/execution-adapter.ts
export interface ExecutionResult {
  readonly content: string;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly toolCalls?: readonly ToolCallRecord[];
  /** Phase 29 B: 응답 텍스트에서 추출한 [mem:xxxxxx] 인용을 retrievalResult 와 매칭한 결과 */
  readonly usedMemoryIds?: readonly string[];
}

// 함수: 응답 텍스트에서 인용 prefix 추출 → 후보 ID 와 매칭
export function extractCitedMemoryIds(
  text: string,
  candidates: ReadonlyArray<{ readonly id: string }>,
): string[] {
  const prefixes = new Set<string>();
  const re = /\[mem:([a-f0-9]{6,8}(?:,[a-f0-9]{6,8})*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    for (const p of m[1].split(',')) prefixes.add(p);
  }
  const matched: string[] = [];
  for (const c of candidates) {
    for (const p of prefixes) {
      if (c.id.startsWith(p)) {
        matched.push(c.id);
        break;
      }
    }
  }
  return matched;
}

// execute() 의 return 직전 (toolCalls 처리와 같은 위치):
const content = extractAssistantText(result.messages);
const usedMemoryIds = ctx.retrievalResult?.snippets
  ? extractCitedMemoryIds(content, ctx.retrievalResult.snippets)
  : [];

return {
  content,
  usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  usedMemoryIds: usedMemoryIds.length > 0 ? usedMemoryIds : undefined,
};
```

검증: `pnpm test --filter @finclaw/server -- execution-adapter`.

### B7. EDIT `packages/server/src/gateway/rpc/methods/agent.ts` — agent.run 의 `addAgentRun` 호출에 `usedMemoryIds` 전달

`agent.run` RPC 는 retrievalResult 를 받지 않으므로 이 트랙에서 본 RPC 의 usedMemoryIds 는 빈 배열 (auto-reply pipeline 만 회상 단계 보유). pipeline 측 영속화 위치에서 사용:

`packages/server/src/auto-reply/pipeline.ts` 또는 deliver/execute stage 에서 `addAgentRun` 을 호출하는 위치를 찾아 `usedMemoryIds: result.usedMemoryIds` 전달.

(현재 pipeline 은 agent_runs 직접 INSERT 안 함 — agent.run RPC 만 INSERT. auto-reply 파이프라인이 영속화 안 한다면 본 단계는 skip 하고 future work 표기. pipeline 에서 INSERT 가 있으면 추가.)

```sh
# 확인:
rg "addAgentRun" packages/server/src/auto-reply/
```

매칭이 없으면 본 단계는 no-op. agent.run RPC 의 경우 `agent.run` 은 단발이라 retrievalResult 가 없음 → `usedMemoryIds` 는 항상 미설정. (pipeline 측이 RAG 회상 컨텍스트 보유.)

검증: 매칭 0건이면 단계 생략 + review.md 에 기록.

### B8. EDIT `packages/server/src/gateway/rpc/methods/memory.ts` — `memory.getById` RPC 추가

settings-view 인용 점프용 단건 조회.

```ts
// packages/server/src/gateway/rpc/methods/memory.ts (registerMemoryMethods 본문)
const memoryGetByIdHandler: RpcMethodHandler<{ memoryId: string }, unknown> = {
  method: 'memory.getById',
  description: '메모리 1건을 ID 로 조회합니다 (settings-view 인용 점프용)',
  authLevel: 'token',
  schema: z.object({ memoryId: z.string().min(1) }),
  async execute(params) {
    if (!deps.db) throw new Error('provider_unavailable: storage db not initialized');
    const entry = getMemory(deps.db, params.memoryId);
    if (!entry) throw new Error(`not_found: ${params.memoryId}`);
    return { memory: entry };
  },
};
registerMethod(memoryGetByIdHandler);
```

검증: `pnpm test --filter @finclaw/server -- methods/memory`.

### B9. EDIT `packages/web/src/views/settings-view.ts` — agent_run 상세 패널에 `usedMemoryIds` 표시

기존 패널의 `memoryId` 옆 줄에 `usedMemoryIds` 배열을 chip 형태로 렌더. 클릭 시 `memory.getById` RPC → 화면 위 메모리 목록 강조 (구체 점프 동작은 implementer 재량, 최소 토스트).

```ts
// packages/web/src/views/settings-view.ts (renderRunDetail 의 metadata pre 안)
memoryId: ${run.memoryId ?? '-'}
usedMemoryIds: ${(run.usedMemoryIds ?? []).join(', ') || '-'}
```

검증: `pnpm typecheck`, `pnpm build --filter @finclaw/web`.

### B10. CREATE `packages/server/src/auto-reply/__tests__/memory-citation.storage.test.ts` — e2e 시나리오

```ts
// 1. memory 저장: "내 원칙은 매수 가격 -10% 손절"
// 2. 동일 주제 query: "내 손절 원칙 뭐였지?"
// 3. retrievalResult.snippets 에 회상됨 → formatBackgroundSection 결과에 [mem:xxxxxx]
// 4. mock LLM 응답 (인용 포함) → extractCitedMemoryIds → memoryId match
// 5. ExecutionResult.usedMemoryIds 비어있지 않음
import { describe, it, expect } from 'vitest';
import { extractCitedMemoryIds } from '../execution-adapter.js';

describe('memory citation extraction (Phase 29 B)', () => {
  it('extracts [mem:xxxxxx] markers and matches by id prefix', () => {
    const candidates = [{ id: 'aaaaaa-1111-2222-3333' }, { id: 'bbbbbb-4444-5555-6666' }];
    const text = '손절 원칙은 -10% [mem:aaaaaa]. 그리고 분산투자 원칙은 [mem:bbbbbb] 였습니다.';
    expect(extractCitedMemoryIds(text, candidates)).toEqual([
      'aaaaaa-1111-2222-3333',
      'bbbbbb-4444-5555-6666',
    ]);
  });

  it('multi-id syntax [mem:aaa,bbb]', () => {
    const candidates = [{ id: 'aaaaaa-x' }, { id: 'bbbbbb-y' }];
    const text = '두 원칙 모두 적용 [mem:aaaaaa,bbbbbb].';
    expect(extractCitedMemoryIds(text, candidates).sort()).toEqual(['aaaaaa-x', 'bbbbbb-y']);
  });

  it('no markers → empty array', () => {
    expect(extractCitedMemoryIds('plain text', [{ id: 'abcdef-z' }])).toEqual([]);
  });
});
```

검증: `pnpm test --filter @finclaw/server -- memory-citation`.

### B11. 트랙 B 검증

```sh
pnpm typecheck
pnpm test:storage -- database.migration agent-runs
pnpm test --filter @finclaw/server -- memory-retrieval execution-adapter memory-citation methods/memory
pnpm format:fix
pnpm lint
git add -p && git commit -m "feat(server/auto-reply): RAG citation [mem:xxxxxx] format + agent_runs.usedMemoryIds (Phase 29 B)"
```

완료 조건:

- 회상된 N 개 메모리 → system prompt 에 N 개 `[mem:xxxxxx]` 마커
- `extractCitedMemoryIds` 단위 테스트 3+ 시나리오 통과
- v6 → v7 migration 적용 확인 (PRAGMA table_info 에 `used_memory_ids` 존재)
- `memory.getById` RPC 동작 확인

---

## 트랙 C — 임베딩 차원 가드 (C-3)

> `vec0(float[1024])` 와 등록된 provider.dimensions 불일치 시 즉시 throw.
> OpenAI provider 에 `dimensions=1024` truncation 옵션 추가 → 활성 가능.

### C1. EDIT `packages/storage/src/database.ts` — `getVectorDimension()` export

```ts
// packages/storage/src/database.ts (Database 인터페이스 + openDatabase 구현)
export interface Database {
  // ... 기존 ...
  /** Phase 29 C: memory_chunks_vec 의 embedding 컬럼 차원. 부트 시 1회 읽고 캐시. */
  readonly vectorDimension: number;
}

// openDatabase 본문, ensurePostMigrationSchema 직후:
const vectorDimension = readVectorDimension(db);

return {
  db,
  path,
  schemaVersion: SCHEMA_VERSION,
  vectorDimension,
  close() {
    /* 기존 */
  },
};

// helper:
function readVectorDimension(db: DatabaseSync): number {
  // sqlite-vec 는 PRAGMA table_info 로 컬럼 type 노출 ('float[1024]' 같은 형식).
  const rows = db.prepare(`PRAGMA table_info('memory_chunks_vec')`).all() as Array<{
    name: string;
    type: string;
  }>;
  const embedding = rows.find((r) => r.name === 'embedding');
  if (!embedding) {
    throw new Error('memory_chunks_vec table missing embedding column');
  }
  const m = embedding.type.match(/float\[(\d+)\]/);
  if (!m) {
    throw new Error(`Cannot parse vector dimension from type: ${embedding.type}`);
  }
  return Number(m[1]);
}
```

검증: `pnpm test:storage -- database`.

### C2. CREATE `packages/storage/src/embeddings/registry.ts` — `EmbeddingDimensionMismatchError` + `assertEmbeddingDimension`

```ts
// packages/storage/src/embeddings/registry.ts
import type { EmbeddingProvider } from './provider.js';

export class EmbeddingDimensionMismatchError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly providerDim: number,
    public readonly expectedDim: number,
  ) {
    super(
      `Embedding provider "${providerId}" produces ${providerDim}-D vectors, ` +
        `but vec0 column expects ${expectedDim}-D. ` +
        `Either use OpenAIEmbeddingProvider({ dimensions: ${expectedDim} }) ` +
        `truncation, or recreate vec0 + reindex with the new dimension.`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/**
 * provider.dimensions 가 expectedDim 과 일치하는지 검증. 불일치 시 throw.
 *
 * main.ts 의 createEmbeddingProvider 직후 호출하여 silent corruption 차단.
 */
export function assertEmbeddingDimension(provider: EmbeddingProvider, expectedDim: number): void {
  if (provider.dimensions !== expectedDim) {
    throw new EmbeddingDimensionMismatchError(provider.id, provider.dimensions, expectedDim);
  }
}
```

검증: `pnpm typecheck`.

### C3. EDIT `packages/storage/src/index.ts` — registry export

```ts
// packages/storage/src/index.ts (export 블록)
export {
  EmbeddingDimensionMismatchError,
  assertEmbeddingDimension,
} from './embeddings/registry.js';
```

검증: `pnpm typecheck`.

### C4. EDIT `packages/storage/src/embeddings/openai.ts` — `dimensions` 옵션 추가 (truncation)

OpenAI text-embedding-3-small/large 는 API `dimensions` 파라미터로 출력 차원 truncation 지원.

```ts
// packages/storage/src/embeddings/openai.ts
export interface OpenAIEmbeddingOptions {
  apiKey?: string;
  /** Phase 29 C: 출력 차원 truncation (기본 1536, 1024 로 설정 시 vec0 1024D 와 매칭). */
  dimensions?: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly model = 'text-embedding-3-small';
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly truncationDim: number | undefined;

  constructor(opts?: OpenAIEmbeddingOptions | string) {
    // 기존 호출 호환성: 문자열 전달 시 apiKey 로 처리.
    const config = typeof opts === 'string' ? { apiKey: opts } : (opts ?? {});
    const key = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OPENAI_API_KEY is required');
    }
    this.apiKey = key;
    this.truncationDim = config.dimensions;
    this.dimensions = config.dimensions ?? 1536;
  }

  async embedQuery(text: string): Promise<number[]> {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        ...(this.truncationDim ? { dimensions: this.truncationDim } : {}),
      }),
    });
    // ... 기존 ...
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // body JSON.stringify 안에서 동일하게 dimensions 추가.
    // ... 기존 흐름 + dimensions 옵션 ...
  }
}
```

`createEmbeddingProvider('openai', config)` 의 `EmbeddingConfig` 에 `dimensions?: number` 추가하고 OpenAIEmbeddingProvider 생성자에 forward.

검증: `pnpm test --filter @finclaw/storage -- openai` (mock fetch 로 body 의 `dimensions` 키 검증).

### C5. EDIT `packages/storage/src/embeddings/provider.ts` — `EmbeddingConfig.dimensions` 추가

```ts
// packages/storage/src/embeddings/provider.ts
export interface EmbeddingConfig {
  readonly apiKey?: string;
  /** Phase 29 C: OpenAI provider 에서 truncation dimension (1024) 지정 */
  readonly dimensions?: number;
}

// createEmbeddingProvider 의 OpenAIEmbeddingProvider 생성 분기:
if (mode === 'openai' || mode === 'auto') {
  const { OpenAIEmbeddingProvider } = await import('./openai.js');
  return new OpenAIEmbeddingProvider({
    apiKey: config?.apiKey,
    dimensions: config?.dimensions,
  });
}
```

검증: `pnpm typecheck`.

### C6. EDIT `packages/server/src/main.ts` — embedding provider 생성 직후 dimension assert

```ts
// packages/server/src/main.ts (createEmbeddingProvider 호출 부근)
import { assertEmbeddingDimension } from '@finclaw/storage';

// ... 기존 createStorage / openDatabase ...
const expectedDim = (storage as unknown as { db: DatabaseSync; vectorDimension?: number })
  .vectorDimension;
// FinClawStorage 가 Database 의 vectorDimension 을 노출하도록 createStorage 갱신 필요 (아래 C7).

let embeddingProvider: EmbeddingProvider | undefined;
if (process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY) {
  try {
    // OpenAI 키만 있으면 1024D truncation 으로 생성 — vec0 차원과 매칭.
    const dimensions = expectedDim;
    embeddingProvider = await createEmbeddingProvider('auto', { dimensions });
    assertEmbeddingDimension(embeddingProvider, expectedDim);
    logger.info('Embedding provider created', {
      event: 'memory.embedding_ready',
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
    });
  } catch (err) {
    logger.warn('Failed to create embedding provider — memory.search will use FTS-only', {
      event: 'memory.embedding_unavailable',
      error: (err as Error).message,
    });
    embeddingProvider = undefined;
  }
}
```

검증: `pnpm typecheck`.

### C7. EDIT `packages/storage/src/index.ts` — `FinClawStorage` 에 `vectorDimension` 노출

```ts
// packages/storage/src/index.ts
export interface FinClawStorage extends StorageAdapter {
  readonly db: Database['db'];
  readonly vectorDimension: number;
}

// createStorage 반환 객체에 추가:
return {
  get db(): Database['db'] {
    return database.db;
  },
  get vectorDimension(): number {
    return database.vectorDimension;
  },
  // ... 기존 메서드 ...
};
```

검증: `pnpm typecheck`.

### C8. EDIT `packages/storage/src/reindex.ts` — provider 변경 감지 + meta 기록

```ts
// packages/storage/src/reindex.ts (atomicReindex 본문 시작 부근)
export async function atomicReindex(dbPath: string, provider: EmbeddingProvider): Promise<void> {
  const tmpPath = dbPath + '.reindex.tmp';

  try {
    const origDb = new DatabaseSync(dbPath);
    // C8: meta 테이블에 last_reindex_provider 기록. 다른 provider 면 강제 전체 reindex.
    const lastProviderRow = origDb
      .prepare(`SELECT value FROM meta WHERE key = 'last_reindex_provider'`)
      .get() as { value: string } | undefined;
    const previousProvider = lastProviderRow?.value;
    if (previousProvider && previousProvider !== provider.id) {
      // provider 변경 — 모든 memory_chunks_vec 무효화 (atomic swap 으로 자동 처리됨).
      // 호출자에게 안내할 수 있도록 console.warn 만, throw X.
      console.warn(
        `[reindex] provider changed: ${previousProvider} → ${provider.id} — full reindex.`,
      );
    }

    const rows = origDb
      .prepare('SELECT * FROM memories ORDER BY created_at ASC')
      .all() as unknown as MemoryRow[];
    origDb.close();

    const tmpDatabase = openDatabase({ path: tmpPath, enableWAL: false });
    for (const row of rows) {
      // ... 기존 ...
    }

    // C8: 새 DB 에 last_reindex_provider 기록.
    tmpDatabase.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run('last_reindex_provider', provider.id);

    tmpDatabase.close();
    // ... 기존 swap ...
  } catch (err) {
    /* 기존 */
  }
}
```

검증: `pnpm test --filter @finclaw/storage -- reindex`.

### C9. EDIT `packages/storage/src/embeddings/openai.ts` (test 옆) — 또는 CREATE `packages/storage/src/embeddings/openai.test.ts`

mock fetch 로 dimensions=1024 호출 시 body 에 `dimensions: 1024` 포함, 미지정 시 1536, `assertEmbeddingDimension` 가 throw 검증.

```ts
// packages/storage/src/embeddings/openai.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIEmbeddingProvider } from './openai.js';
import { assertEmbeddingDimension, EmbeddingDimensionMismatchError } from './registry.js';

describe('OpenAIEmbeddingProvider dimensions option', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1024).fill(0.01) }] }),
      text: async () => '',
    } as Response);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('default dimensions is 1536 (no truncation in API body)', async () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: 'k' });
    expect(p.dimensions).toBe(1536);
    await p.embedQuery('hi');
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body).not.toHaveProperty('dimensions');
  });

  it('dimensions=1024 → API body includes dimensions:1024', async () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: 'k', dimensions: 1024 });
    expect(p.dimensions).toBe(1024);
    await p.embedQuery('hi');
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.dimensions).toBe(1024);
  });

  it('assertEmbeddingDimension throws on mismatch', () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: 'k' }); // 1536
    expect(() => assertEmbeddingDimension(p, 1024)).toThrow(EmbeddingDimensionMismatchError);
  });
});
```

검증: `pnpm test --filter @finclaw/storage -- openai`.

### C10. EDIT `scripts/reindex.mjs` (없으면 CREATE) — 운영자 reindex CLI

```js
#!/usr/bin/env node
// scripts/reindex.mjs
import { atomicReindex, createEmbeddingProvider } from '@finclaw/storage';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'auto' }, // 'voyage' | 'openai' | 'auto'
    dimension: { type: 'string', default: '1024' },
    'dry-run': { type: 'boolean', default: false },
    db: { type: 'string', default: join(homedir(), '.finclaw', 'db.sqlite') },
  },
});

const dimension = Number(values.dimension);
console.log(
  `[reindex] provider=${values.provider} dim=${dimension} db=${values.db} dry-run=${values['dry-run']}`,
);

if (values['dry-run']) {
  console.log('[reindex] dry-run — exiting');
  process.exit(0);
}

const provider = await createEmbeddingProvider(values.provider, { dimensions: dimension });
await atomicReindex(values.db, provider);
console.log('[reindex] done.');
```

검증: `pnpm tsx scripts/reindex.mjs --dry-run` 동작.

### C11. 트랙 C 검증

```sh
pnpm typecheck
pnpm test --filter @finclaw/storage -- embeddings reindex database
pnpm format:fix
pnpm lint
git add -p && git commit -m "feat(storage/embeddings): dimension guard + provider-aware reindex (Phase 29 C)"
```

완료 조건:

- 잘못된 차원 provider 등록 시 `EmbeddingDimensionMismatchError` throw + 권장 동작 메시지
- `OpenAIEmbeddingProvider({ dimensions: 1024 })` body 에 `dimensions:1024` 포함
- provider 변경 시 reindex 가 strict 모드로 전체 재계산
- `pnpm tsx scripts/reindex.mjs --dry-run` 정상 종료

---

## 트랙 D — MCP 클라이언트 + plugin 배선 (C-4)

> `@modelcontextprotocol/sdk` 추가, stdio 서버 spawn → 도구 디스커버리 → ToolRegistry 등록.
> 5-stage plugin loader 의 Register 단계 확장 + main.ts 부트 시퀀스에 호출 배선.

### D1. EDIT `packages/server/package.json` — MCP SDK + json-schema-to-zod dep

```sh
pnpm add @modelcontextprotocol/sdk@^1 --filter @finclaw/server
```

`json-schema-to-zod` 가 의존성에 없으면 추가 (`pnpm add json-schema-to-zod --filter @finclaw/server`). 또는 간단한 자체 변환 (D5 의 jsonSchemaToZod 가 이미 registry.ts 에 있음 → 재사용).

검증: `pnpm install` 통과, `pnpm format:fix`.

### D2. EDIT `packages/types/src/plugin.ts` — `MCPServerSpec` + manifest 확장

```ts
// packages/types/src/plugin.ts (PluginManifest 추가 필드)
/** Phase 29 D: MCP stdio 서버 spec */
export interface MCPServerSpec {
  /** plugin 내 식별자 (고유) */
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** 도구 호출 timeout (ms). 미지정 시 30_000 */
  readonly timeoutMs?: number;
}

export interface PluginManifest {
  // ... 기존 ...
  /** Phase 29 D: stdio MCP 서버 등록. 도구는 ToolRegistry 에 group='mcp' 로 자동 등록. */
  mcpServers?: readonly MCPServerSpec[];
}
```

검증: `pnpm typecheck`.

### D3. EDIT `packages/server/src/plugins/manifest.ts` — Zod schema 에 `mcpServers` 추가

```ts
// packages/server/src/plugins/manifest.ts
const MCPServerSpecSchema = z.strictObject({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
});

export const PluginManifestSchema = z.strictObject({
  // ... 기존 ...
  mcpServers: z.array(MCPServerSpecSchema).optional(),
});
```

검증: `pnpm test --filter @finclaw/server -- manifest`.

### D4. CREATE `packages/server/src/plugins/mcp-transport.ts`

```ts
// packages/server/src/plugins/mcp-transport.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerSpec } from '@finclaw/types';

export interface MCPClientHandle {
  readonly client: Client;
  readonly spec: MCPServerSpec;
  shutdown(): Promise<void>;
}

/**
 * stdio MCP 서버를 spawn → 연결 → Client 핸들 반환.
 * shutdown 은 transport.close + client.close.
 */
export async function createMCPClient(spec: MCPServerSpec): Promise<MCPClientHandle> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: [...spec.args],
    env: spec.env ? { ...process.env, ...spec.env } : (process.env as Record<string, string>),
  });
  const client = new Client({ name: 'finclaw', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  return {
    client,
    spec,
    async shutdown() {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    },
  };
}
```

검증: `pnpm typecheck`.

### D5. CREATE `packages/server/src/plugins/mcp-tool-bridge.ts`

```ts
// packages/server/src/plugins/mcp-tool-bridge.ts
import type { ToolDefinition } from '@finclaw/types';
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { MCPClientHandle } from './mcp-transport.js';

export interface MCPToolRegistration {
  readonly definition: RegisteredToolDefinition;
  readonly executor: ToolExecutor;
}

/**
 * MCP server 의 listTools() 결과를 FinClaw RegisteredToolDefinition 으로 변환 + executor 생성.
 *
 * - group='mcp' (사용자 결정 5: group 슬롯으로 일괄 권한 분리)
 * - isExternal=true (CircuitBreaker 적용)
 * - requiresApproval=true (사용자 결정 5: require-approval 기본)
 * - inputSchema 는 MCP 의 inputSchema (이미 JSON Schema 형식) 그대로 사용 — ToolDefinition.inputSchema 는 Record<string, unknown>.
 */
export async function bridgeMCPTools(handle: MCPClientHandle): Promise<MCPToolRegistration[]> {
  const tools = await handle.client.listTools();
  const registrations: MCPToolRegistration[] = [];

  for (const t of tools.tools) {
    const namespaced = `mcp:${handle.spec.id}:${t.name}`;
    const definition: RegisteredToolDefinition = {
      name: namespaced,
      description: t.description ?? `MCP tool ${t.name}`,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
      group: 'mcp', // D7 에서 ToolGroupId 에 추가
      requiresApproval: true,
      isTransactional: false,
      accessesSensitiveData: false,
      isExternal: true,
      timeoutMs: handle.spec.timeoutMs ?? 30_000,
    };

    const executor: ToolExecutor = async (input, ctx) => {
      try {
        const result = await handle.client.callTool({ name: t.name, arguments: input }, undefined, {
          timeout: handle.spec.timeoutMs ?? 30_000,
          signal: ctx.abortSignal,
        });
        // MCP CallToolResult.content[] → 단일 string 으로 join.
        const content = (result.content ?? [])
          .map((b: { type: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : ''))
          .join('\n');
        return {
          content,
          isError: result.isError === true,
          metadata: { source: 'mcp', server: handle.spec.id, originalName: t.name },
        };
      } catch (err) {
        return {
          content: `MCP tool error: ${(err as Error).message}`,
          isError: true,
          metadata: { source: 'mcp', server: handle.spec.id },
        };
      }
    };

    registrations.push({ definition, executor });
  }
  return registrations;
}

export function registerMCPTools(
  registry: ToolRegistry,
  registrations: readonly MCPToolRegistration[],
): void {
  for (const r of registrations) {
    registry.register(r.definition, r.executor, 'plugin');
  }
}
```

검증: `pnpm typecheck`.

### D6. EDIT `packages/agent/src/agents/tools/groups.ts` — `'mcp'` ToolGroupId 추가

```ts
// packages/agent/src/agents/tools/groups.ts
export type ToolGroupId =
  | 'finance'
  | 'system'
  | 'web'
  | 'data'
  | 'communication'
  | 'mcp' // Phase 29 D: MCP 외부 도구
  | 'custom';

export const BUILT_IN_GROUPS = [
  // ... 기존 ...
  {
    id: 'mcp',
    displayName: 'MCP 외부 도구',
    description: 'MCP (Model Context Protocol) 서버가 노출한 외부 도구',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
  // ... custom ...
] as const satisfies readonly ToolGroup[];
```

검증: `pnpm typecheck`.

### D7. EDIT `packages/agent/src/agents/tools/policy.ts` — group 'mcp' 슬롯 (require-approval)

기존 `evaluateGroupPolicy` 는 PolicyRule 기반이라 별도 코드는 필요 없음 — `BUILT_IN_GROUPS.mcp.defaultPolicy = 'require-approval'` 가 이미 트리거. 그러나 InMemoryToolRegistry 의 policyRules 가 비어있으면 기본 group policy 가 적용 안 될 수 있음 → main.ts 에서 mcp:\* require-approval rule 을 명시 등록 (D9).

본 단계는 단지 group 'mcp' 가 finance-safety 단계 (Stage 8) 로 fallthrough 되지 않도록 명시 rule 만 추가.

```ts
// packages/agent/src/agents/tools/policy.ts (필요 시 코멘트만 추가)
// Phase 29 D: group='mcp' 도구는 main.ts 에서 require-approval rule 을 등록한다.
// finance-safety 단계는 isTransactional/accessesSensitiveData 만 트리거하므로,
// MCP 도구 (둘 다 false) 는 group-policy 단계에서 require-approval 로 분류돼야 한다.
```

검증: `pnpm typecheck`.

### D8. EDIT `packages/server/src/plugins/loader.ts` — Register 단계 확장 + shutdown hook 누적

```ts
// packages/server/src/plugins/loader.ts
import type { ToolRegistry } from '@finclaw/agent';
import { createMCPClient, type MCPClientHandle } from './mcp-transport.js';
import { bridgeMCPTools, registerMCPTools } from './mcp-tool-bridge.js';

export interface LoadResult {
  loaded: string[];
  failed: Array<{ pluginName: string; phase: string; error: string }>;
  /** Phase 29 D: 활성화된 MCP client 핸들 (server 종료 시 shutdown). */
  mcpHandles: MCPClientHandle[];
}

export async function loadPlugins(
  searchPaths: string[],
  allowedRoots: string[],
  /** Phase 29 D: MCP 도구 등록 대상 ToolRegistry (미주입 시 mcpServers skip + warn). */
  toolRegistry?: ToolRegistry,
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], failed: [], mcpHandles: [] };

  // ... 기존 Discovery / Manifest / Security / Load / Register 5 stage ...
  for (const { dir, manifestPath } of discovered) {
    // ... 기존 5-stage 본문 ...
    try {
      // ... Stage 5: Register (기존) ...

      // Phase 29 D: MCP servers 등록 (toolRegistry 주입 시).
      if (manifest.mcpServers && manifest.mcpServers.length > 0 && toolRegistry) {
        for (const spec of manifest.mcpServers) {
          try {
            const handle = await createMCPClient(spec);
            const regs = await bridgeMCPTools(handle);
            registerMCPTools(toolRegistry, regs);
            result.mcpHandles.push(handle);
          } catch (mcpErr) {
            recordDiagnostic(
              pluginName,
              'error',
              'register',
              `MCP server "${spec.id}" failed: ${(mcpErr as Error).message}`,
              mcpErr as Error,
            );
          }
        }
      } else if (manifest.mcpServers?.length && !toolRegistry) {
        recordDiagnostic(
          pluginName,
          'warn',
          'register',
          'mcpServers declared but toolRegistry not provided — skipped',
        );
      }
      // ... 기존 ...
    } catch (err) {
      /* 기존 */
    }
  }
  return result;
}
```

검증: `pnpm typecheck`, `pnpm test --filter @finclaw/server -- plugins/loader`.

### D9. EDIT `packages/server/src/main.ts` — pluginLoader 호출 + ToolRegistry 정책 룰 + shutdown 등록

```ts
// packages/server/src/main.ts
import { loadPlugins } from './plugins/loader.js';

// ... 기존 toolRegistry 생성 + skill 등록 직후, gateway 생성 직전 ...

// Phase 29 D: MCP 도구 group=mcp 정책 — require-approval (사용자 결정 5).
toolRegistry.addPolicyRule({
  pattern: 'mcp:*',
  verdict: 'require-approval',
  reason: 'MCP external tools require explicit approval',
  priority: 100,
});

// Phase 29 D: plugin loader 호출. plugins 디렉터리 미존재 시 no-op (loader 가 silently 처리).
const pluginsDir = process.env.FINCLAW_PLUGINS_DIR ?? join(homedir(), '.finclaw', 'plugins');
const pluginResult = await loadPlugins([pluginsDir], [pluginsDir], toolRegistry);
logger.info('Plugins loaded', {
  event: 'plugins.loaded',
  loaded: pluginResult.loaded,
  failed: pluginResult.failed,
  mcpServers: pluginResult.mcpHandles.length,
});
lifecycle.register(async () => {
  for (const h of pluginResult.mcpHandles) {
    await h.shutdown();
  }
});
```

검증: `pnpm typecheck`, `pnpm dev` 부팅 시 `plugins.loaded` 로그.

### D10. EDIT `packages/server/src/auto-reply/execution-adapter.ts` — transcript-repair MCP timeout 검증 (no-op 단계)

기존 `sliceHistoryRespectingToolPairs` 가 orphan tool_use/tool_result 제거 — MCP timeout 시 tool_executor 가 isError=true result 를 반환하므로 orphan 발생 X. 본 단계는 검증만:

```sh
# 코드 변경 없을 가능성 큼 — 그래도 다음 grep 으로 확인:
rg "isOrphanedToolResult|sliceHistoryRespecting" packages/server/src/auto-reply/execution-adapter.ts
```

기존 함수가 orphan tool_result 케이스를 다루는지 확인. 부족하면 케이스 추가 — 보통 변경 불필요.

검증: `pnpm test --filter @finclaw/server -- execution-adapter` 통과.

### D11. CREATE `packages/server/src/plugins/__tests__/mcp.test.ts` — 가짜 stdio MCP 서버 e2e

```ts
// packages/server/src/plugins/__tests__/mcp.test.ts
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryToolRegistry } from '@finclaw/agent';
import { loadPlugins } from '../loader.js';

describe('MCP plugin e2e (Phase 29 D)', () => {
  it('manifest.mcpServers 가 있으면 도구가 ToolRegistry 에 mcp:* 로 등록된다', async () => {
    // mock MCP server: 1개 echo 도구를 노출하는 stdio 프로세스.
    // 단순화 — node -e 로 인라인 MCP 서버 시뮬레이션 (도구 list + call 응답).
    const tmpDir = mkdtempSync(join(tmpdir(), 'finclaw-mcp-test-'));
    const pluginDir = join(tmpDir, 'echo-plugin');
    mkdirSync(pluginDir, { recursive: true });

    // 플러그인 entry — register/activate 둘 다 비워둔 채 MCP 서버만 spawn.
    writeFileSync(join(pluginDir, 'index.js'), `export const register = () => {};\n`);
    writeFileSync(
      join(pluginDir, 'manifest.json'),
      JSON.stringify({
        name: 'echo-plugin',
        version: '0.1.0',
        main: 'index.js',
        type: 'tool',
        mcpServers: [
          {
            id: 'echo',
            command: process.execPath,
            args: [join(__dirname, 'fixtures', 'mock-mcp-server.mjs')],
          },
        ],
      }),
    );

    const registry = new InMemoryToolRegistry();
    const result = await loadPlugins([tmpDir], [tmpDir], registry);

    expect(result.loaded).toContain('echo-plugin');
    expect(result.mcpHandles.length).toBe(1);
    const echoTools = registry.list().filter((t) => t.definition.group === 'mcp');
    expect(echoTools.length).toBeGreaterThanOrEqual(1);

    // cleanup
    for (const h of result.mcpHandles) await h.shutdown();
  });
});
```

`fixtures/mock-mcp-server.mjs` 는 `@modelcontextprotocol/sdk/server/stdio.js` 의 최소 echo 서버 (도구 1개: echo).

```js
// packages/server/src/plugins/__tests__/fixtures/mock-mcp-server.mjs
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({ name: 'echo', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler({ method: 'tools/list' }, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'echoes input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
}));
server.setRequestHandler({ method: 'tools/call' }, async (req) => ({
  content: [{ type: 'text', text: String(req.params.arguments?.text ?? '') }],
  isError: false,
}));
await server.connect(new StdioServerTransport());
```

검증: `pnpm test --filter @finclaw/server -- plugins/mcp`. mocked 외부 서버이므로 OPENAI/ANTHROPIC 키 불필요 (CLAUDE.md feedback_tests_no_api_keys 준수).

### D12. CREATE `docs/plugins/mcp.md` — 운영자 문서 (~80줄)

```md
# FinClaw MCP Plugin

> stdio 기반 MCP (Model Context Protocol) 서버를 FinClaw plugin 으로 등록.
> 도구는 `ToolRegistry` 에 `group=mcp` 로 등록되며, 9-단계 정책의 require-approval 기본.

## manifest 예시

`~/.finclaw/plugins/my-mcp/manifest.json`:

\`\`\`json
{
"name": "my-mcp",
"version": "0.1.0",
"main": "index.js",
"type": "tool",
"mcpServers": [
{
"id": "fs",
"command": "npx",
"args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
"timeoutMs": 30000
}
]
}
\`\`\`

## 동작

1. 부팅 시 `loadPlugins` 가 manifest.mcpServers 를 발견 → stdio spawn.
2. `tools/list` 호출 → 각 도구를 `mcp:<spec.id>:<original_name>` 으로 namespace.
3. `ToolRegistry.register` 로 group='mcp', isExternal=true (CircuitBreaker 적용).
4. 9-단계 정책: `mcp:*` pattern 의 `require-approval` rule 이 main.ts 에서 등록되어 호출 시 사용자 승인 요구.

## 알려진 제약

- transport: stdio 만. SSE/WebSocket 은 Phase 30+.
- FinClaw 자체를 MCP 서버로 노출하기는 비대상 (Phase 30+).
- 도구별 fine-grained 정책은 Phase 30 — 본 Phase 는 group 일괄 정책.
```

검증: 파일 존재 확인.

### D13. 트랙 D 검증

```sh
pnpm typecheck
pnpm test --filter @finclaw/server -- plugins
pnpm format:fix
pnpm lint
git add -p && git commit -m "feat(server/plugins): MCP stdio client + ToolRegistry bridge + main.ts wiring (Phase 29 D)"
```

완료 조건:

- `pluginLoader.load()` 가 `main.ts` 부팅 시퀀스에서 호출됨 (`plugins.loaded` 로그)
- mock stdio MCP 서버 1개 → 도구 ≥1 개가 `ToolRegistry` 에 `group='mcp'` 로 등록됨
- 9-단계 정책 group=mcp 가 require-approval 로 분류 (1개 unit test)
- `agent.run` 으로 MCP 도구 호출 → 결과 → agent_runs 기록 (e2e 1 시나리오, 또는 unit 검증)

---

## 통합 검증 (트랙 E/A/B/C/D 모두 통과 후)

### V-1. 전체 테스트 + 타입체크 + 린트 + 포맷

```sh
pnpm format:fix
pnpm lint
pnpm typecheck
pnpm test
pnpm test:storage
```

모두 통과해야 한다.

### V-2. 트랙별 e2e 시나리오 일괄 실행

```sh
pnpm test --filter @finclaw/agent -- providers/openai           # C-1 (A)
pnpm test --filter @finclaw/server -- memory-citation           # C-2 (B)
pnpm test --filter @finclaw/storage -- embeddings reindex       # C-3 (C)
pnpm test --filter @finclaw/server -- plugins                   # C-4 (D)
pnpm test --filter @finclaw/server -- gateway/rate-limit gateway/access-log gateway/hot-reload main.test  # C-5 (E)
```

각 1+ e2e 시나리오 통과.

### V-3. 재감사 (스킬 사용)

```
"Phase 29 종료 — finclaw-openclaw-similarity 다시 실행"
```

(또는 `_workspace/audit/` 가 존재하던 별도 maturity-audit 하네스가 살아있다면 그쪽 — 본 레포는 openclaw-similarity 만 활성).

새 SUMMARY 결과를 `_workspace/audit/` 또는 동등 경로에 저장.

검증 항목:

- 종합 평균 ≥ **3.7** (plan.md 종료 기준 5번)
- Critical 5건 모두 해소 또는 'intentional' 라벨

### V-4. review.md 자동 작성 (finclaw-phase-finalize 연쇄)

`finclaw-phase-execute` 오케스트레이터가 자동 호출 — 본 todo 완료 후 트리거.

```
"Phase 29 review.md 작성"
```

내용:

- 트랙별 실제 결정 (정책 결정 5건 + 추가 결정)
- 계획에서 이탈한 부분 + 이유
- 잔여 작업 (Phase 30 이관)
- 시작/종료 SHA 비교 + LOC delta
- 재감사 결과 점수 비교 표

### V-5. CLAUDE.md 변경 이력 추가

`CLAUDE.md` 의 phase 풀 사이클 하네스 변경 이력 표에 Phase 29 행 추가.

---

## 롤백 절차

각 트랙이 독립 커밋이라면 `git revert <sha>` 로 단계적 롤백:

```sh
git log --oneline | grep "Phase 29"
# E (가장 먼저 머지) → D (가장 나중) 순으로 revert 검토
git revert <D 커밋>
git revert <C 커밋>
# ...
```

DB 마이그레이션 v6 → v7 (트랙 B) 은 컬럼 추가뿐 (used_memory_ids) 이라 이전 버전 호환 — revert 후에도 SCHEMA_VERSION 만 6 으로 되돌리면 무시됨. 단, 실제 v7 DB 에서 v6 코드를 실행하면 `addAgentRun` 의 INSERT 컬럼 수 mismatch 가능 — revert 시 dev DB 백업 (`db.sqlite.pre-phase29.bak`) 복원 권장.

---

## 종료 체크리스트

- [ ] P-1, P-2 완료 (사전 준비 + 결정 5건)
- [ ] 트랙 E (E1-E9) 완료
- [ ] 트랙 A (A1-A10) 완료
- [ ] 트랙 B (B1-B11) 완료 — v6 → v7 마이그레이션 검증
- [ ] 트랙 C (C1-C11) 완료
- [ ] 트랙 D (D1-D13) 완료
- [ ] V-1 ~ V-3 통합 검증 통과
- [ ] 재감사 종합 평균 ≥ 3.7
- [ ] V-4 review.md 작성
- [ ] V-5 CLAUDE.md 변경 이력 추가
