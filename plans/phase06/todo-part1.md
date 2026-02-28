# Phase 6 Part 1: L1 모델 계층 + 프로바이더 어댑터

> 소스 10 + 테스트 4 + 기존 수정 3 = **17 작업 항목**

---

## T1. 프로젝트 셋업 — package.json + tsconfig.json

### 목적

agent 패키지에 `@finclaw/infra`, `@finclaw/config` 의존성을 추가한다.

### 수정: `packages/agent/package.json`

```jsonc
{
  "name": "@finclaw/agent",
  "version": "0.1.0",
  "private": true,
  "files": ["dist"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
    },
  },
  "dependencies": {
    "@finclaw/types": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "@finclaw/config": "workspace:*",
  },
}
```

### 수정: `packages/agent/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../types" }, { "path": "../infra" }, { "path": "../config" }]
}
```

### 검증

```bash
pnpm install && pnpm typecheck
```

---

## T2. `packages/agent/src/errors.ts` — FailoverError + classifyFallbackError

### 목적

폴백 체인 에러 분류의 기반. 모든 downstream 모듈이 의존한다.

### 코드

```typescript
// packages/agent/src/errors.ts
import { FinClawError, isFinClawError } from '@finclaw/infra';

/** 폴백 사유 */
export type FallbackReason =
  | 'rate-limit'
  | 'server-error'
  | 'timeout'
  | 'context-overflow'
  | 'model-unavailable';

/** 폴백 에러 — SDK 에러를 래핑하여 분류된 사유를 포함 */
export class FailoverError extends FinClawError {
  readonly fallbackReason: FallbackReason;

  constructor(
    message: string,
    reason: FallbackReason,
    opts?: { statusCode?: number; cause?: Error },
  ) {
    super(message, `FAILOVER_${reason.toUpperCase().replaceAll('-', '_')}`, opts);
    this.name = 'FailoverError';
    this.fallbackReason = reason;
  }
}

/**
 * 에러를 FallbackReason으로 분류
 *
 * 우선순위:
 * 1. FailoverError → 직접 reason 반환
 * 2. FinClawError statusCode → HTTP 상태 기반 분류
 * 3. SDK .status 프로퍼티 → HTTP 상태 기반 분류
 * 4. 네트워크 에러 코드 → timeout
 * 5. AbortError → null (폴백 대상 아님)
 * 6. 401/403 → null (인증 에러는 폴백 대상 아님)
 */
export function classifyFallbackError(error: Error): FallbackReason | null {
  // AbortError: 사용자 취소 — 즉시 전파
  if (error.name === 'AbortError') return null;

  // FailoverError: 이미 분류됨
  if (error instanceof FailoverError) return error.fallbackReason;

  // HTTP 상태 코드 기반 분류
  const status = getStatusCode(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) return null; // 인증 에러 — 폴백 불가
    if (status === 429) return 'rate-limit';
    if (status === 529) return 'model-unavailable';
    if (status >= 500) return 'server-error';
  }

  // 네트워크 에러 코드
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return 'timeout';
  }

  // context overflow 감지 (SDK 메시지 기반 — 최후 수단)
  if (error.message.includes('context length') || error.message.includes('token limit')) {
    return 'context-overflow';
  }

  return null;
}

/** 에러 객체에서 HTTP 상태 코드 추출 */
function getStatusCode(error: Error): number | undefined {
  if (isFinClawError(error)) return error.statusCode;
  // SDK 에러는 .status 프로퍼티를 가짐
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** API 키 마스킹 유틸리티 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}
```

### 검증

- `FailoverError` 생성 시 `code`가 `FAILOVER_RATE_LIMIT` 형태
- `classifyFallbackError`: 429→'rate-limit', 5xx→'server-error', AbortError→null, 401→null
- `maskApiKey('sk-1234567890abcdef')` → `'sk-...cdef'`

---

## T3. `packages/agent/src/models/catalog.ts` — 타입 + InMemoryModelCatalog

### 목적

모델 카탈로그의 타입 정의와 인메모리 구현. 모든 모델 관련 모듈의 기반.

### 코드

```typescript
// packages/agent/src/models/catalog.ts

/** 모델 제공자 식별자 */
export type ProviderId = 'anthropic' | 'openai';

/** 모델이 지원하는 기능 */
export interface ModelCapabilities {
  readonly vision: boolean;
  readonly functionCalling: boolean;
  readonly streaming: boolean;
  readonly jsonMode: boolean;
  readonly extendedThinking: boolean;
  /** 금융 특화: 수치 추론 정확도 등급 */
  readonly numericalReasoningTier: 'low' | 'medium' | 'high';
}

/** 모델 가격 정보 (USD per 1M tokens) */
export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWritePerMillion?: number;
}

/** 모델 카탈로그 엔트리 */
export interface ModelEntry {
  readonly id: string;
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly capabilities: ModelCapabilities;
  readonly pricing: ModelPricing;
  readonly aliases: readonly string[];
  readonly deprecated: boolean;
  readonly releaseDate: string; // ISO 8601
}

/** 모델 카탈로그 인터페이스 */
export interface ModelCatalog {
  listModels(): readonly ModelEntry[];
  getModel(id: string): ModelEntry | undefined;
  getModelsByProvider(provider: ProviderId): readonly ModelEntry[];
  findModels(filter: Partial<ModelCapabilities>): readonly ModelEntry[];
  registerModel(entry: ModelEntry): void;
}

/** 인메모리 모델 카탈로그 구현 */
export class InMemoryModelCatalog implements ModelCatalog {
  private readonly models = new Map<string, ModelEntry>();

  constructor(initialModels?: readonly ModelEntry[]) {
    if (initialModels) {
      for (const model of initialModels) {
        this.models.set(model.id, model);
      }
    }
  }

  listModels(): readonly ModelEntry[] {
    return [...this.models.values()];
  }

  getModel(id: string): ModelEntry | undefined {
    return this.models.get(id);
  }

  getModelsByProvider(provider: ProviderId): readonly ModelEntry[] {
    return this.listModels().filter((m) => m.provider === provider);
  }

  findModels(filter: Partial<ModelCapabilities>): readonly ModelEntry[] {
    return this.listModels().filter((model) => {
      for (const [key, value] of Object.entries(filter)) {
        if (model.capabilities[key as keyof ModelCapabilities] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  registerModel(entry: ModelEntry): void {
    if (this.models.has(entry.id)) {
      throw new Error(`Model already registered: ${entry.id}`);
    }
    this.models.set(entry.id, entry);
  }
}
```

---

## T4. `packages/agent/src/models/catalog-data.ts` — BUILT_IN_MODELS

### 목적

하드코딩된 6종의 내장 모델 데이터. 순수 데이터 파일(Ce=0).

### 코드

```typescript
// packages/agent/src/models/catalog-data.ts
import type { ModelEntry } from './catalog.js';

/** 내장 모델 카탈로그 데이터 (6종) */
export const BUILT_IN_MODELS: readonly ModelEntry[] = [
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    displayName: 'Claude Opus 4.6',
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: true,
      numericalReasoningTier: 'high',
    },
    pricing: { inputPerMillion: 15, outputPerMillion: 75 },
    aliases: ['opus', 'opus-4', 'claude-opus'],
    deprecated: false,
    releaseDate: '2025-05-22',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: true,
      numericalReasoningTier: 'medium',
    },
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
    aliases: ['sonnet', 'sonnet-4', 'claude-sonnet'],
    deprecated: false,
    releaseDate: '2025-05-22',
  },
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
      numericalReasoningTier: 'medium',
    },
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    aliases: ['gpt4o', '4o'],
    deprecated: false,
    releaseDate: '2024-05-13',
  },
  {
    id: 'claude-haiku-3.5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 3.5',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: false,
      numericalReasoningTier: 'low',
    },
    pricing: { inputPerMillion: 0.8, outputPerMillion: 4 },
    aliases: ['haiku', 'haiku-3.5', 'claude-haiku'],
    deprecated: false,
    releaseDate: '2024-10-29',
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
      numericalReasoningTier: 'low',
    },
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    aliases: ['4o-mini', 'gpt4o-mini'],
    deprecated: false,
    releaseDate: '2024-07-18',
  },
  {
    id: 'o3',
    provider: 'openai',
    displayName: 'o3',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    capabilities: {
      vision: true,
      functionCalling: true,
      streaming: true,
      jsonMode: true,
      extendedThinking: true,
      numericalReasoningTier: 'high',
    },
    pricing: { inputPerMillion: 10, outputPerMillion: 40 },
    aliases: ['o3'],
    deprecated: false,
    releaseDate: '2025-04-16',
  },
];

/** 권장 폴백 체인 순서 */
export const DEFAULT_FALLBACK_CHAIN = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-3.5',
  'gpt-4o',
  'gpt-4o-mini',
] as const;
```

---

## T5. `packages/agent/src/models/alias-index.ts` — buildModelAliasIndex()

### 목적

카탈로그의 모든 모델 별칭을 소문자 정규화하여 색인 Map을 구축한다.

### 코드

```typescript
// packages/agent/src/models/alias-index.ts
import { createLogger } from '@finclaw/infra';
import type { ModelCatalog, ModelEntry } from './catalog.js';

const log = createLogger({ name: 'ModelAliasIndex' });

/** 별칭 색인 타입 */
export type AliasIndex = ReadonlyMap<string, ModelEntry>;

/**
 * 별칭 색인 빌드
 *
 * 1. 카탈로그의 모든 모델 순회
 * 2. 모델 ID + aliases 배열을 소문자 정규화 후 Map에 등록
 * 3. 중복 별칭: 먼저 등록된 모델 유지 + 경고 로그
 */
export function buildModelAliasIndex(catalog: ModelCatalog): AliasIndex {
  const index = new Map<string, ModelEntry>();

  for (const model of catalog.listModels()) {
    const keysToRegister = [model.id, ...model.aliases];

    for (const alias of keysToRegister) {
      const normalized = alias.toLowerCase().trim();
      if (index.has(normalized)) {
        const existing = index.get(normalized)!;
        log.warn(`Duplicate alias "${normalized}": keeping ${existing.id}, ignoring ${model.id}`);
        continue;
      }
      index.set(normalized, model);
    }
  }

  return index;
}
```

---

## T6. `packages/agent/src/models/selection.ts` — resolveModel()

### 목적

사용자가 입력한 문자열(별칭/ID)을 구체적인 ModelEntry로 해석한다.

### 코드

```typescript
// packages/agent/src/models/selection.ts
import { getEventBus } from '@finclaw/infra';
import type { ModelCatalog, ModelEntry, ProviderId } from './catalog.js';
import type { AliasIndex } from './alias-index.js';

/** 해석 전 사용자 입력 (별칭 또는 모델 ID 문자열) */
export interface UnresolvedModelRef {
  readonly raw: string;
}

/** 해석 완료된 모델 참조 */
export interface ResolvedModel {
  readonly entry: ModelEntry;
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly resolvedFrom: 'id' | 'alias' | 'default';
}

/**
 * 모델 참조 해석
 *
 * 해석 순서:
 * 1. 정확한 ID 매칭 (catalog.getModel)
 * 2. 별칭 매칭 (aliasIndex.get, 소문자 정규화)
 * 3. 기본 모델 (defaultModelId가 제공된 경우)
 * 4. 에러 throw
 */
export function resolveModel(
  ref: UnresolvedModelRef,
  catalog: ModelCatalog,
  aliasIndex: AliasIndex,
  defaultModelId?: string,
): ResolvedModel {
  const bus = getEventBus();
  const raw = ref.raw.trim();

  // 1. 정확한 ID 매칭
  const byId = catalog.getModel(raw);
  if (byId) {
    bus.emit('model:resolve', raw, byId.id);
    return { entry: byId, provider: byId.provider, modelId: byId.id, resolvedFrom: 'id' };
  }

  // 2. 별칭 매칭
  const byAlias = aliasIndex.get(raw.toLowerCase());
  if (byAlias) {
    bus.emit('model:resolve', raw, byAlias.id);
    return {
      entry: byAlias,
      provider: byAlias.provider,
      modelId: byAlias.id,
      resolvedFrom: 'alias',
    };
  }

  // 3. 기본 모델
  if (defaultModelId) {
    const defaultEntry =
      catalog.getModel(defaultModelId) ?? aliasIndex.get(defaultModelId.toLowerCase());
    if (defaultEntry) {
      bus.emit('model:resolve', raw, defaultEntry.id);
      return {
        entry: defaultEntry,
        provider: defaultEntry.provider,
        modelId: defaultEntry.id,
        resolvedFrom: 'default',
      };
    }
  }

  // 4. 에러
  throw new Error(
    `Model not found: "${raw}". Available models: ${catalog
      .listModels()
      .map((m) => m.id)
      .join(', ')}`,
  );
}
```

---

## T7. `packages/agent/src/models/provider-normalize.ts` — 응답 정규화

### 목적

Anthropic/OpenAI SDK 응답을 통일된 NormalizedResponse 형태로 변환한다.

### 코드

```typescript
// packages/agent/src/models/provider-normalize.ts
import type { ProviderId, ModelPricing } from './catalog.js';

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

/** 정규화된 토큰 사용량 */
export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  /** 금융 특화: 예상 비용 (USD) */
  readonly estimatedCostUsd: number;
}

/** 정규화된 AI 응답 */
export interface NormalizedResponse {
  readonly content: string;
  readonly stopReason: StopReason;
  readonly usage: NormalizedUsage;
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly raw: unknown;
}

/** 스트리밍 청크 (타입만 선언, 구현은 Phase 9) */
export interface StreamChunk {
  readonly type: 'text_delta' | 'tool_use_delta' | 'usage' | 'done';
  readonly text?: string;
  readonly usage?: Partial<NormalizedUsage>;
}

/** 비용 계산 헬퍼 */
export function calculateEstimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/** 제공자별 응답 정규화 함수 타입 */
export type ResponseNormalizer = (raw: unknown, pricing: ModelPricing) => NormalizedResponse;

/**
 * Anthropic SDK 응답 정규화
 *
 * 필드 매핑:
 * - usage.input_tokens → inputTokens
 * - usage.output_tokens → outputTokens
 * - usage.cache_read_input_tokens → cacheReadTokens
 * - usage.cache_creation_input_tokens → cacheWriteTokens
 * - stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
 */
export function normalizeAnthropicResponse(
  raw: unknown,
  pricing: ModelPricing,
): NormalizedResponse {
  const r = raw as {
    id?: string;
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  const inputTokens = r.usage?.input_tokens ?? 0;
  const outputTokens = r.usage?.output_tokens ?? 0;
  const cacheReadTokens = r.usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = r.usage?.cache_creation_input_tokens ?? 0;

  const content =
    r.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('') ?? '';

  return {
    content,
    stopReason: (r.stop_reason as StopReason) ?? 'end_turn',
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: calculateEstimatedCost(inputTokens, outputTokens, pricing),
    },
    modelId: r.model ?? '',
    provider: 'anthropic',
    raw,
  };
}

/**
 * OpenAI SDK 응답 정규화
 *
 * 필드 매핑:
 * - usage.prompt_tokens → inputTokens
 * - usage.completion_tokens → outputTokens
 * - cacheReadTokens, cacheWriteTokens → 0 (OpenAI N/A)
 * - usage.total_tokens → totalTokens
 * - finish_reason: 'stop' → 'end_turn', 'length' → 'max_tokens', 'tool_calls' → 'tool_use'
 */
export function normalizeOpenAIResponse(raw: unknown, pricing: ModelPricing): NormalizedResponse {
  const r = raw as {
    id?: string;
    model?: string;
    choices?: Array<{
      message?: { content?: string | null };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const inputTokens = r.usage?.prompt_tokens ?? 0;
  const outputTokens = r.usage?.completion_tokens ?? 0;
  const content = r.choices?.[0]?.message?.content ?? '';

  const openAiReason = r.choices?.[0]?.finish_reason;
  const stopReason = mapOpenAIFinishReason(openAiReason);

  return {
    content,
    stopReason,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: r.usage?.total_tokens ?? inputTokens + outputTokens,
      estimatedCostUsd: calculateEstimatedCost(inputTokens, outputTokens, pricing),
    },
    modelId: r.model ?? '',
    provider: 'openai',
    raw,
  };
}

function mapOpenAIFinishReason(reason?: string): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

/** 정규화 함수 레지스트리 */
export const normalizers: ReadonlyMap<ProviderId, ResponseNormalizer> = new Map([
  ['anthropic', normalizeAnthropicResponse],
  ['openai', normalizeOpenAIResponse],
]);
```

---

## T8. `packages/agent/src/providers/adapter.ts` — ProviderAdapter + CircuitBreaker 레지스트리

### 목적

제공자별 API 호출을 추상화하는 어댑터 인터페이스 + 팩토리 + CircuitBreaker 관리.

### 코드

```typescript
// packages/agent/src/providers/adapter.ts
import { createCircuitBreaker, type CircuitBreaker } from '@finclaw/infra';
import type { ConversationMessage, ToolDefinition } from '@finclaw/types';
import type { ProviderId } from '../models/catalog.js';

/** 제공자 API 호출 파라미터 */
export interface ProviderRequestParams {
  readonly model: string;
  readonly messages: ConversationMessage[];
  readonly tools?: ToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly abortSignal?: AbortSignal;
}

/** 제공자 어댑터 인터페이스 */
export interface ProviderAdapter {
  readonly providerId: ProviderId;
  chatCompletion(params: ProviderRequestParams): Promise<unknown>;
}

/** 제공자 어댑터 생성 팩토리 */
export function createProviderAdapter(
  provider: ProviderId,
  apiKey: string,
  options?: { baseUrl?: string },
): ProviderAdapter {
  switch (provider) {
    case 'anthropic': {
      const { AnthropicAdapter } = require('./anthropic.js') as typeof import('./anthropic.js');
      return new AnthropicAdapter(apiKey, options?.baseUrl);
    }
    case 'openai': {
      const { OpenAIAdapter } = require('./openai.js') as typeof import('./openai.js');
      return new OpenAIAdapter(apiKey, options?.baseUrl);
    }
    default:
      throw new Error(`Unsupported provider: ${provider as string}`);
  }
}

/** 제공자별 CircuitBreaker 레지스트리 */
const breakers = new Map<ProviderId, CircuitBreaker>();

export function getBreakerForProvider(provider: ProviderId): CircuitBreaker {
  let cb = breakers.get(provider);
  if (!cb) {
    cb = createCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });
    breakers.set(provider, cb);
  }
  return cb;
}

/** 테스트용 초기화 */
export function resetBreakers(): void {
  for (const cb of breakers.values()) {
    cb.reset();
  }
  breakers.clear();
}
```

> **주의**: `createProviderAdapter`에서 dynamic require 대신 lazy import를 쓸 수도 있다.
> ESM에서는 `await import('./anthropic.js')` 형태가 더 적절하나, 동기 팩토리 시그니처를 유지하기 위해
> 각 어댑터 클래스를 직접 export하고 사용처에서 선택적으로 import하는 방식도 고려.
> **구현 시 결정**: 어댑터가 가벼우므로 static import로 단순화해도 무방.

### 대안: static import 버전

```typescript
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';

export function createProviderAdapter(
  provider: ProviderId,
  apiKey: string,
  options?: { baseUrl?: string },
): ProviderAdapter {
  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter(apiKey, options?.baseUrl);
    case 'openai':
      return new OpenAIAdapter(apiKey, options?.baseUrl);
    default:
      throw new Error(`Unsupported provider: ${provider as string}`);
  }
}
```

→ **static import 방식 권장** (ESM 호환, 타입 추론 자연스러움).

---

## T9. `packages/agent/src/providers/anthropic.ts` — Anthropic SDK 어댑터

### 목적

Anthropic Messages API 호출을 래핑하고, SDK 에러를 FailoverError로 변환한다.

### 선행: SDK 설치

```bash
cd packages/agent && pnpm add @anthropic-ai/sdk
```

### 코드

```typescript
// packages/agent/src/providers/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import { FailoverError } from '../errors.js';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerId = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new Anthropic({ apiKey, baseURL: baseUrl });
  }

  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    // system 메시지 분리 (Anthropic API는 system을 별도 파라미터로 받음)
    const systemMessages = params.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = params.messages.filter((m) => m.role !== 'system');

    const system = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    try {
      return await this.client.messages.create(
        {
          model: params.model,
          max_tokens: params.maxTokens ?? 4096,
          ...(system ? { system } : {}),
          messages: nonSystemMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        },
        { signal: params.abortSignal },
      );
    } catch (error) {
      throw wrapAnthropicError(error);
    }
  }
}

/** Anthropic SDK 에러 → FailoverError 변환 */
function wrapAnthropicError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (error.name === 'AbortError') return error;

  const status = (error as { status?: number }).status;
  if (status === 429) {
    return new FailoverError(`Anthropic rate limit: ${error.message}`, 'rate-limit', {
      statusCode: 429,
      cause: error,
    });
  }
  if (status === 529) {
    return new FailoverError(`Anthropic overloaded: ${error.message}`, 'model-unavailable', {
      statusCode: 529,
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new FailoverError(`Anthropic server error: ${error.message}`, 'server-error', {
      statusCode: status,
      cause: error,
    });
  }
  return error;
}
```

---

## T10. `packages/agent/src/providers/openai.ts` — OpenAI SDK 어댑터

### 목적

OpenAI Chat Completions API 호출을 래핑하고, SDK 에러를 FailoverError로 변환한다.

### 선행: SDK 설치

```bash
cd packages/agent && pnpm add openai
```

### 코드

```typescript
// packages/agent/src/providers/openai.ts
import OpenAI from 'openai';
import { FailoverError } from '../errors.js';
import type { ProviderAdapter, ProviderRequestParams } from './adapter.js';

export class OpenAIAdapter implements ProviderAdapter {
  readonly providerId = 'openai' as const;
  private readonly client: OpenAI;

  constructor(apiKey: string, baseUrl?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  async chatCompletion(params: ProviderRequestParams): Promise<unknown> {
    try {
      return await this.client.chat.completions.create(
        {
          model: params.model,
          messages: params.messages.map((m) => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        },
        { signal: params.abortSignal },
      );
    } catch (error) {
      throw wrapOpenAIError(error);
    }
  }
}

/** OpenAI SDK 에러 → FailoverError 변환 */
function wrapOpenAIError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (error.name === 'AbortError') return error;

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

---

## T11. FinClawEventMap 확장 — model 이벤트 3종

### 수정: `packages/infra/src/events.ts`

`FinClawEventMap` 인터페이스에 아래 3개 이벤트를 추가한다:

```typescript
// 기존 FinClawEventMap에 추가:
  /** 모델 별칭 해석 완료 */
  'model:resolve': (alias: string, modelId: string) => void;
  /** 폴백 모델 전환 */
  'model:fallback': (from: string, to: string, reason: string) => void;
  /** 모든 모델 소진 */
  'model:exhausted': (models: string[], lastError: string) => void;
```

위치: `'system:unhandledRejection'` 아래, `}` 닫기 전에 삽입.

---

## T12. `packages/agent/src/index.ts` — Part 1 배럴 export

### 목적

기존 stub을 교체하고 Part 1 모듈을 모두 export한다.

### 코드

```typescript
// @finclaw/agent — Part 1 barrel export (L1 Model Layer + Providers)

// errors
export { FailoverError, classifyFallbackError, maskApiKey } from './errors.js';
export type { FallbackReason } from './errors.js';

// models — catalog
export { InMemoryModelCatalog } from './models/catalog.js';
export type {
  ProviderId,
  ModelCapabilities,
  ModelPricing,
  ModelEntry,
  ModelCatalog,
} from './models/catalog.js';

// models — catalog data
export { BUILT_IN_MODELS, DEFAULT_FALLBACK_CHAIN } from './models/catalog-data.js';

// models — alias index
export { buildModelAliasIndex } from './models/alias-index.js';
export type { AliasIndex } from './models/alias-index.js';

// models — selection
export { resolveModel } from './models/selection.js';
export type { UnresolvedModelRef, ResolvedModel } from './models/selection.js';

// models — provider normalize
export {
  normalizers,
  normalizeAnthropicResponse,
  normalizeOpenAIResponse,
  calculateEstimatedCost,
} from './models/provider-normalize.js';
export type {
  NormalizedResponse,
  NormalizedUsage,
  StopReason,
  StreamChunk,
  ResponseNormalizer,
} from './models/provider-normalize.js';

// providers
export {
  createProviderAdapter,
  getBreakerForProvider,
  resetBreakers,
} from './providers/adapter.js';
export type { ProviderAdapter, ProviderRequestParams } from './providers/adapter.js';
export { AnthropicAdapter } from './providers/anthropic.js';
export { OpenAIAdapter } from './providers/openai.js';
```

---

## T13. `packages/agent/test/errors.test.ts`

### 테스트 케이스

```typescript
import { describe, it, expect } from 'vitest';
import { FailoverError, classifyFallbackError, maskApiKey } from '../src/errors.js';
import { FinClawError } from '@finclaw/infra';

describe('FailoverError', () => {
  it('FinClawError를 상속한다', () => {
    const err = new FailoverError('rate limited', 'rate-limit', { statusCode: 429 });
    expect(err).toBeInstanceOf(FinClawError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FailoverError');
    expect(err.fallbackReason).toBe('rate-limit');
    expect(err.code).toBe('FAILOVER_RATE_LIMIT');
    expect(err.statusCode).toBe(429);
  });

  it('cause를 체이닝한다', () => {
    const cause = new Error('original');
    const err = new FailoverError('wrapped', 'server-error', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('classifyFallbackError', () => {
  it('FailoverError → 직접 reason 반환', () => {
    const err = new FailoverError('test', 'timeout');
    expect(classifyFallbackError(err)).toBe('timeout');
  });

  it('FinClawError statusCode 429 → rate-limit', () => {
    const err = new FinClawError('limit', 'RATE', { statusCode: 429 });
    expect(classifyFallbackError(err)).toBe('rate-limit');
  });

  it('SDK .status 500 → server-error', () => {
    const err = Object.assign(new Error('internal'), { status: 500 });
    expect(classifyFallbackError(err)).toBe('server-error');
  });

  it('SDK .status 529 → model-unavailable', () => {
    const err = Object.assign(new Error('overloaded'), { status: 529 });
    expect(classifyFallbackError(err)).toBe('model-unavailable');
  });

  it('AbortError → null', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyFallbackError(err)).toBeNull();
  });

  it('401 → null (인증 에러는 폴백 불가)', () => {
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    expect(classifyFallbackError(err)).toBeNull();
  });

  it('403 → null', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    expect(classifyFallbackError(err)).toBeNull();
  });

  it('ECONNRESET → timeout', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(classifyFallbackError(err)).toBe('timeout');
  });

  it('ETIMEDOUT → timeout', () => {
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    expect(classifyFallbackError(err)).toBe('timeout');
  });

  it('context length 메시지 → context-overflow', () => {
    const err = new Error('maximum context length exceeded');
    expect(classifyFallbackError(err)).toBe('context-overflow');
  });

  it('분류 불가 에러 → null', () => {
    const err = new Error('unknown error');
    expect(classifyFallbackError(err)).toBeNull();
  });
});

describe('maskApiKey', () => {
  it('긴 키를 마스킹한다', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-...cdef');
  });

  it('짧은 키는 ***로 대체한다', () => {
    expect(maskApiKey('short')).toBe('***');
    expect(maskApiKey('12345678')).toBe('***');
  });

  it('9자 이상이면 마스킹 적용', () => {
    expect(maskApiKey('123456789')).toBe('123...6789');
  });
});
```

---

## T14. `packages/agent/test/catalog.test.ts`

### 테스트 케이스

```typescript
import { describe, it, expect } from 'vitest';
import { InMemoryModelCatalog } from '../src/models/catalog.js';
import { BUILT_IN_MODELS } from '../src/models/catalog-data.js';

describe('InMemoryModelCatalog', () => {
  const catalog = new InMemoryModelCatalog(BUILT_IN_MODELS);

  it('내장 모델 6종을 모두 조회한다', () => {
    expect(catalog.listModels()).toHaveLength(6);
  });

  it('ID로 모델을 조회한다', () => {
    const opus = catalog.getModel('claude-opus-4-6');
    expect(opus).toBeDefined();
    expect(opus!.displayName).toBe('Claude Opus 4.6');
    expect(opus!.provider).toBe('anthropic');
  });

  it('존재하지 않는 ID → undefined', () => {
    expect(catalog.getModel('nonexistent')).toBeUndefined();
  });

  it('제공자별 필터링', () => {
    const anthropicModels = catalog.getModelsByProvider('anthropic');
    expect(anthropicModels.length).toBeGreaterThanOrEqual(3);
    expect(anthropicModels.every((m) => m.provider === 'anthropic')).toBe(true);

    const openaiModels = catalog.getModelsByProvider('openai');
    expect(openaiModels.length).toBeGreaterThanOrEqual(2);
    expect(openaiModels.every((m) => m.provider === 'openai')).toBe(true);
  });

  it('기능 요구사항으로 필터링', () => {
    const thinkingModels = catalog.findModels({ extendedThinking: true });
    expect(thinkingModels.length).toBeGreaterThanOrEqual(2);
    expect(thinkingModels.every((m) => m.capabilities.extendedThinking)).toBe(true);
  });

  it('numericalReasoningTier로 필터링', () => {
    const highTier = catalog.findModels({ numericalReasoningTier: 'high' });
    expect(highTier.length).toBeGreaterThanOrEqual(2); // opus + o3
  });

  it('registerModel()로 커스텀 모델 등록', () => {
    const custom = new InMemoryModelCatalog();
    const entry = {
      id: 'custom-model',
      provider: 'anthropic' as const,
      displayName: 'Custom',
      contextWindow: 100_000,
      maxOutputTokens: 4096,
      capabilities: {
        vision: false,
        functionCalling: false,
        streaming: false,
        jsonMode: false,
        extendedThinking: false,
        numericalReasoningTier: 'low' as const,
      },
      pricing: { inputPerMillion: 1, outputPerMillion: 5 },
      aliases: ['custom'],
      deprecated: false,
      releaseDate: '2025-01-01',
    };
    custom.registerModel(entry);
    expect(custom.getModel('custom-model')).toBe(entry);
  });

  it('중복 모델 등록 시 에러', () => {
    const dup = new InMemoryModelCatalog(BUILT_IN_MODELS);
    expect(() => dup.registerModel(BUILT_IN_MODELS[0])).toThrow('already registered');
  });

  it('빈 카탈로그 → listModels() = []', () => {
    const empty = new InMemoryModelCatalog();
    expect(empty.listModels()).toEqual([]);
  });
});
```

---

## T15. `packages/agent/test/selection.test.ts`

### 테스트 케이스

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryModelCatalog } from '../src/models/catalog.js';
import { BUILT_IN_MODELS } from '../src/models/catalog-data.js';
import { buildModelAliasIndex } from '../src/models/alias-index.js';
import { resolveModel } from '../src/models/selection.js';
import { resetEventBus } from '@finclaw/infra';

describe('buildModelAliasIndex', () => {
  const catalog = new InMemoryModelCatalog(BUILT_IN_MODELS);

  it('모든 모델 ID와 별칭을 색인한다', () => {
    const index = buildModelAliasIndex(catalog);
    // 6 모델 ID + 각 모델의 aliases 합계
    expect(index.size).toBeGreaterThan(6);
  });

  it('대소문자 무시하여 조회', () => {
    const index = buildModelAliasIndex(catalog);
    expect(index.get('opus')).toBeDefined();
    expect(index.get('OPUS')).toBeUndefined(); // key는 소문자로 저장됨
    // resolveModel에서 .toLowerCase() 처리하므로 alias-index 자체는 소문자 키만 저장
  });

  it('중복 별칭 시 먼저 등록된 모델 유지', () => {
    const models = [
      { ...BUILT_IN_MODELS[0], id: 'model-a', aliases: ['shared'] },
      { ...BUILT_IN_MODELS[1], id: 'model-b', aliases: ['shared'] },
    ];
    const cat = new InMemoryModelCatalog(models);
    const index = buildModelAliasIndex(cat);
    expect(index.get('shared')!.id).toBe('model-a');
  });
});

describe('resolveModel', () => {
  const catalog = new InMemoryModelCatalog(BUILT_IN_MODELS);
  const aliasIndex = buildModelAliasIndex(catalog);

  afterEach(() => {
    resetEventBus();
  });

  it('정확한 ID로 해석', () => {
    const result = resolveModel({ raw: 'claude-opus-4-6' }, catalog, aliasIndex);
    expect(result.modelId).toBe('claude-opus-4-6');
    expect(result.resolvedFrom).toBe('id');
    expect(result.provider).toBe('anthropic');
  });

  it('별칭으로 해석', () => {
    const result = resolveModel({ raw: 'opus' }, catalog, aliasIndex);
    expect(result.modelId).toBe('claude-opus-4-6');
    expect(result.resolvedFrom).toBe('alias');
  });

  it('대소문자 무관하게 별칭 해석', () => {
    const result = resolveModel({ raw: 'SONNET' }, catalog, aliasIndex);
    expect(result.modelId).toBe('claude-sonnet-4-6');
    expect(result.resolvedFrom).toBe('alias');
  });

  it('기본 모델로 폴백', () => {
    const result = resolveModel({ raw: 'nonexistent' }, catalog, aliasIndex, 'claude-sonnet-4-6');
    expect(result.modelId).toBe('claude-sonnet-4-6');
    expect(result.resolvedFrom).toBe('default');
  });

  it('기본 모델도 없으면 에러', () => {
    expect(() => resolveModel({ raw: 'nonexistent' }, catalog, aliasIndex)).toThrow(
      'Model not found',
    );
  });

  it('빈 카탈로그에서 에러', () => {
    const empty = new InMemoryModelCatalog();
    const emptyIndex = buildModelAliasIndex(empty);
    expect(() => resolveModel({ raw: 'anything' }, empty, emptyIndex)).toThrow('Model not found');
  });

  it('공백 포함 입력 처리', () => {
    const result = resolveModel({ raw: '  opus  ' }, catalog, aliasIndex);
    expect(result.modelId).toBe('claude-opus-4-6');
  });
});
```

---

## T16. `packages/agent/test/normalize.test.ts`

### 테스트 케이스

```typescript
import { describe, it, expect } from 'vitest';
import {
  normalizeAnthropicResponse,
  normalizeOpenAIResponse,
  calculateEstimatedCost,
} from '../src/models/provider-normalize.js';
import type { ModelPricing } from '../src/models/catalog.js';

const pricing: ModelPricing = { inputPerMillion: 15, outputPerMillion: 75 };

describe('normalizeAnthropicResponse', () => {
  const mockResponse = {
    id: 'msg_123',
    model: 'claude-opus-4-6',
    content: [{ type: 'text', text: 'Hello world' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  };

  it('필드를 정확히 매핑한다', () => {
    const result = normalizeAnthropicResponse(mockResponse, pricing);
    expect(result.content).toBe('Hello world');
    expect(result.stopReason).toBe('end_turn');
    expect(result.modelId).toBe('claude-opus-4-6');
    expect(result.provider).toBe('anthropic');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cacheReadTokens).toBe(10);
    expect(result.usage.cacheWriteTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(150);
  });

  it('비용을 계산한다', () => {
    const result = normalizeAnthropicResponse(mockResponse, pricing);
    // (100/1M)*15 + (50/1M)*75 = 0.0015 + 0.00375 = 0.00525
    expect(result.usage.estimatedCostUsd).toBeCloseTo(0.00525, 5);
  });

  it('content가 여러 블록이면 text만 연결한다', () => {
    const multi = {
      ...mockResponse,
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tool_1' },
        { type: 'text', text: ' World' },
      ],
    };
    const result = normalizeAnthropicResponse(multi, pricing);
    expect(result.content).toBe('Hello World');
  });

  it('usage가 없으면 0으로 기본값', () => {
    const noUsage = { ...mockResponse, usage: undefined };
    const result = normalizeAnthropicResponse(noUsage, pricing);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });

  it('raw를 보존한다', () => {
    const result = normalizeAnthropicResponse(mockResponse, pricing);
    expect(result.raw).toBe(mockResponse);
  });
});

describe('normalizeOpenAIResponse', () => {
  const mockResponse = {
    id: 'chatcmpl-123',
    model: 'gpt-4o',
    choices: [
      {
        message: { content: 'Hi there' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 80,
      completion_tokens: 30,
      total_tokens: 110,
    },
  };

  it('필드를 정확히 매핑한다', () => {
    const result = normalizeOpenAIResponse(mockResponse, pricing);
    expect(result.content).toBe('Hi there');
    expect(result.stopReason).toBe('end_turn'); // 'stop' → 'end_turn'
    expect(result.modelId).toBe('gpt-4o');
    expect(result.provider).toBe('openai');
    expect(result.usage.inputTokens).toBe(80);
    expect(result.usage.outputTokens).toBe(30);
    expect(result.usage.totalTokens).toBe(110);
  });

  it('캐시 토큰은 0이다 (OpenAI N/A)', () => {
    const result = normalizeOpenAIResponse(mockResponse, pricing);
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheWriteTokens).toBe(0);
  });

  it('finish_reason 매핑: length → max_tokens', () => {
    const r = { ...mockResponse, choices: [{ message: { content: '' }, finish_reason: 'length' }] };
    expect(normalizeOpenAIResponse(r, pricing).stopReason).toBe('max_tokens');
  });

  it('finish_reason 매핑: tool_calls → tool_use', () => {
    const r = {
      ...mockResponse,
      choices: [{ message: { content: '' }, finish_reason: 'tool_calls' }],
    };
    expect(normalizeOpenAIResponse(r, pricing).stopReason).toBe('tool_use');
  });

  it('content가 null이면 빈 문자열', () => {
    const r = { ...mockResponse, choices: [{ message: { content: null }, finish_reason: 'stop' }] };
    expect(normalizeOpenAIResponse(r, pricing).content).toBe('');
  });
});

describe('calculateEstimatedCost', () => {
  it('정확한 비용을 계산한다', () => {
    // 1000 input * $15/1M + 500 output * $75/1M
    // = 0.015 + 0.0375 = 0.0525
    expect(calculateEstimatedCost(1000, 500, pricing)).toBeCloseTo(0.0525, 4);
  });

  it('0 토큰이면 비용 0', () => {
    expect(calculateEstimatedCost(0, 0, pricing)).toBe(0);
  });
});
```

---

## T17. Part 1 최종 검증

```bash
# 1. 의존성 설치 (SDK 추가됨)
pnpm install

# 2. 타입 체크
pnpm typecheck

# 3. 빌드
pnpm build

# 4. agent 패키지 테스트
pnpm test -- packages/agent

# 5. 린트
pnpm lint

# 6. 포맷
pnpm format:fix
```

### 성공 기준

- [ ] `pnpm typecheck` 에러 없음
- [ ] `pnpm build` 성공
- [ ] 테스트 4종 모두 통과 (errors, catalog, selection, normalize)
- [ ] `pnpm lint` 에러 없음
- [ ] `packages/agent/src/` 에 10개 소스 파일 생성
- [ ] `packages/agent/test/` 에 4개 테스트 파일 생성
- [ ] `@finclaw/agent` import 가능하고 타입 추론 정상

---

## 파일 체크리스트

| #   | 파일                                              | 상태                    |
| --- | ------------------------------------------------- | ----------------------- |
| 1   | `packages/agent/package.json`                     | 수정                    |
| 2   | `packages/agent/tsconfig.json`                    | 수정                    |
| 3   | `packages/infra/src/events.ts`                    | 수정 (model 이벤트 3종) |
| 4   | `packages/agent/src/errors.ts`                    | 신규                    |
| 5   | `packages/agent/src/models/catalog.ts`            | 신규                    |
| 6   | `packages/agent/src/models/catalog-data.ts`       | 신규                    |
| 7   | `packages/agent/src/models/alias-index.ts`        | 신규                    |
| 8   | `packages/agent/src/models/selection.ts`          | 신규                    |
| 9   | `packages/agent/src/models/provider-normalize.ts` | 신규                    |
| 10  | `packages/agent/src/providers/adapter.ts`         | 신규                    |
| 11  | `packages/agent/src/providers/anthropic.ts`       | 신규                    |
| 12  | `packages/agent/src/providers/openai.ts`          | 신규                    |
| 13  | `packages/agent/src/index.ts`                     | 교체 (stub → barrel)    |
| 14  | `packages/agent/test/errors.test.ts`              | 신규                    |
| 15  | `packages/agent/test/catalog.test.ts`             | 신규                    |
| 16  | `packages/agent/test/selection.test.ts`           | 신규                    |
| 17  | `packages/agent/test/normalize.test.ts`           | 신규                    |
