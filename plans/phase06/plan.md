# Phase 6: 에이전트 코어 -- 모델 선택 & 인증

> 복잡도: **L** | 소스 파일: ~12 | 테스트 파일: ~6 | 합계: **~18 파일**

---

## 1. 목표

AI 에이전트의 **모델 선택(L1)** 과 **인증 관리(L2)** 계층을 구현한다. 금융 AI 어시스턴트로서 다중 LLM 제공자를 유연하게 전환하고, API 키의 안전한 관리와 장애 시 자동 폴백을 보장한다.

### L1 모델 계층

- **Model Catalog**: JSON 기반 모델 데이터베이스. 제공자, 기능(capabilities), 컨텍스트 윈도우, 가격 정보를 구조화하여 관리한다.
- **Model Selection**: 별칭(alias) 기반 모델 해석. `"opus"` -> `{provider: "anthropic", model: "claude-opus-4-6"}` 같은 간편 참조를 지원한다.
- **Model Alias Index**: `buildModelAliasIndex()`로 별칭 -> 모델 참조 색인을 구축한다.
- **Model Fallback**: `runWithModelFallback()`으로 3~5단계 폴백 체인을 실행한다. 주 모델 실패 시 대체 모델로 자동 전환한다.

### L2 인증 계층

- **Auth Profiles**: CRUD 저장소. 여러 API 키 프로필을 관리하고 라운드 로빈 선택을 지원한다.
- **API Key Resolution**: `resolveApiKeyForProvider()` -- 6단계 해석 체인(profile -> env -> config -> aws -> default -> error).
- **Cooldown Tracking**: rate limit 발생 시 1분간 해당 프로필을 쿨다운 상태로 전환한다.
- **Auth Health**: 프로필 건강 상태 모니터링. 반복 실패 시 자동 비활성화한다.

FinClaw 초기 지원 제공자: **Anthropic**, **OpenAI** (2종, 확장 가능 설계).

---

## 2. OpenClaw 참조

| 참조 문서 경로                                          | 적용할 패턴                                      |
| ------------------------------------------------------- | ------------------------------------------------ |
| `openclaw_review/docs/agents/model-selection.md`        | 별칭 해석 체계, alias index 빌드 패턴            |
| `openclaw_review/docs/agents/model-catalog.md`          | JSON 기반 모델 카탈로그 스키마, 모델 메타데이터  |
| `openclaw_review/docs/agents/model-fallback.md`         | 폴백 체인 알고리즘, 재시도 전략                  |
| `openclaw_review/docs/agents/model-auth.md`             | 6단계 API 키 해석 체인, 환경변수 우선순위        |
| `openclaw_review/deep-dive/auth-profiles.md`            | 라운드 로빈, 쿨다운 트래킹, 프로필 건강 모니터링 |
| `openclaw_review/docs/agents/provider-normalization.md` | 다중 제공자 응답 정규화 패턴                     |

**OpenClaw 대비 FinClaw 간소화 사항:**

- 120+ 파일(L1-L2) -> ~18 파일로 핵심만 추출
- 20+ 제공자 -> Anthropic + OpenAI 2종으로 초기 제한
- AWS Bedrock/Vertex AI 인증은 향후 확장으로 미룸
- OAuth 플로우 제외 (API 키 기반만 지원)
- 금융 도메인 전용: 모델별 금융 분석 성능 메타데이터 추가

---

## 3. 생성할 파일

### 소스 파일 (12개)

```
src/agents/
├── index.ts                      # 에이전트 모듈 public API
├── models/
│   ├── catalog.ts                # 모델 카탈로그 (JSON DB + 조회)
│   ├── catalog-data.ts           # 내장 모델 데이터 (Anthropic, OpenAI)
│   ├── selection.ts              # 모델 선택 + 별칭 해석
│   ├── alias-index.ts            # buildModelAliasIndex()
│   ├── fallback.ts               # runWithModelFallback() 폴백 체인
│   └── provider-normalize.ts     # 제공자별 응답/사용량 정규화
├── auth/
│   ├── profiles.ts               # AuthProfile CRUD 저장소
│   ├── resolver.ts               # resolveApiKeyForProvider() 6단계 해석
│   ├── cooldown.ts               # 쿨다운 트래커 (rate limit 대응)
│   └── health.ts                 # 프로필 건강 모니터링
└── providers/
    └── index.ts                  # 제공자 어댑터 팩토리 (Anthropic, OpenAI)
```

### 테스트 파일 (6개)

```
src/agents/__tests__/
├── catalog.test.ts               # 모델 카탈로그 조회/필터 테스트
├── selection.test.ts             # 별칭 해석 + alias index 테스트
├── fallback.test.ts              # 폴백 체인 실행 테스트
├── resolver.test.ts              # 6단계 API 키 해석 테스트
├── cooldown.test.ts              # 쿨다운 상태 전환 테스트
└── health.test.ts                # 프로필 건강 상태 모니터링 테스트
```

---

## 4. 핵심 인터페이스/타입

### 4.1 Model Catalog 타입

```typescript
// src/agents/models/catalog.ts

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
  readonly id: string; // e.g. 'claude-opus-4-6'
  readonly provider: ProviderId;
  readonly displayName: string; // e.g. 'Claude Opus 4.6'
  readonly contextWindow: number; // e.g. 200_000
  readonly maxOutputTokens: number; // e.g. 32_768
  readonly capabilities: ModelCapabilities;
  readonly pricing: ModelPricing;
  readonly aliases: readonly string[]; // e.g. ['opus', 'opus-4']
  readonly deprecated: boolean;
  readonly releaseDate: string; // ISO 8601
}

/** 모델 카탈로그 인터페이스 */
export interface ModelCatalog {
  /** 모든 등록된 모델 조회 */
  listModels(): readonly ModelEntry[];

  /** ID로 모델 조회 */
  getModel(id: string): ModelEntry | undefined;

  /** 제공자별 모델 필터링 */
  getModelsByProvider(provider: ProviderId): readonly ModelEntry[];

  /** 기능 요구사항으로 모델 필터링 */
  findModels(filter: Partial<ModelCapabilities>): readonly ModelEntry[];

  /** 커스텀 모델 등록 (플러그인 확장용) */
  registerModel(entry: ModelEntry): void;
}
```

### 4.2 Model Selection & Alias

```typescript
// src/agents/models/selection.ts

/** 모델 참조 (해석 전) */
export interface ModelRef {
  readonly raw: string; // 사용자가 입력한 원본 문자열
}

/** 해석된 모델 참조 */
export interface ResolvedModel {
  readonly entry: ModelEntry;
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly resolvedFrom: 'id' | 'alias' | 'default';
}

/** 별칭 색인 */
export type AliasIndex = ReadonlyMap<string, ModelEntry>;

/**
 * 별칭 색인 빌드
 * - 카탈로그의 모든 모델에서 aliases 필드를 수집
 * - 중복 별칭 발견 시 경고 로그 + 먼저 등록된 모델 우선
 */
export function buildModelAliasIndex(catalog: ModelCatalog): AliasIndex;

/**
 * 모델 참조 해석
 * 해석 순서: 1) 정확한 ID 매칭 -> 2) 별칭 매칭 -> 3) 기본 모델 -> 4) 에러
 */
export function resolveModel(
  ref: ModelRef,
  catalog: ModelCatalog,
  aliasIndex: AliasIndex,
  defaultModelId?: string,
): ResolvedModel;
```

### 4.3 Model Fallback

```typescript
// src/agents/models/fallback.ts

/** 폴백 체인 설정 */
export interface FallbackConfig {
  /** 시도할 모델 목록 (우선순위 순) */
  readonly models: readonly ModelRef[];
  /** 모델별 최대 재시도 횟수 */
  readonly maxRetriesPerModel: number;
  /** 재시도 간격 (ms) */
  readonly retryDelayMs: number;
  /** 폴백 사유 필터: 이 에러만 폴백 트리거 */
  readonly fallbackOn: readonly FallbackTrigger[];
}

export type FallbackTrigger =
  | 'rate-limit' // 429
  | 'server-error' // 5xx
  | 'timeout' // 요청 타임아웃
  | 'context-overflow' // 컨텍스트 윈도우 초과
  | 'model-unavailable'; // 모델 서비스 중단

/** 폴백 실행 결과 */
export interface FallbackResult<T> {
  readonly result: T;
  readonly modelUsed: ResolvedModel;
  readonly attempts: readonly FallbackAttempt[];
}

export interface FallbackAttempt {
  readonly model: ResolvedModel;
  readonly success: boolean;
  readonly error?: Error;
  readonly durationMs: number;
}

/**
 * 폴백 체인 실행
 *
 * 알고리즘:
 * 1. models 배열의 첫 번째 모델로 fn 실행 시도
 * 2. 실패 시 fallbackOn에 해당하는 에러인지 확인
 * 3. 해당하면 다음 모델로 전환, maxRetriesPerModel만큼 재시도
 * 4. 모든 모델 소진 시 마지막 에러를 throw
 * 5. 성공 시 결과 + 사용된 모델 + 시도 내역 반환
 */
export async function runWithModelFallback<T>(
  config: FallbackConfig,
  fn: (model: ResolvedModel) => Promise<T>,
  resolveModel: (ref: ModelRef) => ResolvedModel,
): Promise<FallbackResult<T>>;
```

### 4.4 Auth Profiles & Resolution

```typescript
// src/agents/auth/profiles.ts

/** 인증 프로필 */
export interface AuthProfile {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderId;
  readonly apiKey: string; // 암호화 저장 권장
  readonly isActive: boolean;
  readonly priority: number; // 라운드 로빈 가중치
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly failureCount: number;
  readonly cooldownUntil: Date | null;
}

/** 프로필 CRUD 저장소 인터페이스 */
export interface AuthProfileStore {
  list(provider?: ProviderId): Promise<readonly AuthProfile[]>;
  get(id: string): Promise<AuthProfile | undefined>;
  create(input: CreateProfileInput): Promise<AuthProfile>;
  update(id: string, patch: Partial<AuthProfile>): Promise<AuthProfile>;
  delete(id: string): Promise<boolean>;

  /** 라운드 로빈: 사용 가능한 다음 프로필 선택 */
  selectNext(provider: ProviderId): Promise<AuthProfile | undefined>;

  /** 프로필 사용 기록 업데이트 */
  recordUsage(id: string, success: boolean): Promise<void>;
}

export interface CreateProfileInput {
  readonly name: string;
  readonly provider: ProviderId;
  readonly apiKey: string;
  readonly priority?: number;
}

// src/agents/auth/resolver.ts

/**
 * 6단계 API 키 해석 체인
 *
 * 해석 순서:
 * 1. AuthProfile 저장소 (라운드 로빈 선택)
 * 2. 환경변수 (ANTHROPIC_API_KEY, OPENAI_API_KEY)
 * 3. 설정 파일 (config.agents.providers.{provider}.apiKey)
 * 4. AWS Secrets Manager (향후 확장)
 * 5. 기본값 (개발용 더미 키)
 * 6. 에러 (키를 찾을 수 없음)
 */
export async function resolveApiKeyForProvider(
  provider: ProviderId,
  options: ResolverOptions,
): Promise<ResolvedApiKey>;

export interface ResolverOptions {
  readonly profileStore: AuthProfileStore;
  readonly env: Record<string, string | undefined>;
  readonly config: AgentConfig;
}

export interface ResolvedApiKey {
  readonly apiKey: string;
  readonly source: ApiKeySource;
  readonly profileId?: string;
}

export type ApiKeySource = 'profile' | 'environment' | 'config' | 'aws-secrets' | 'default';
```

### 4.5 Cooldown & Health

```typescript
// src/agents/auth/cooldown.ts

/** 쿨다운 트래커 */
export class CooldownTracker {
  /** 기본 쿨다운 시간 (ms) */
  static readonly DEFAULT_COOLDOWN_MS = 60_000; // 1분

  private readonly cooldowns = new Map<string, CooldownEntry>();

  /**
   * Rate limit 발생 시 프로필을 쿨다운 상태로 전환
   * - Retry-After 헤더가 있으면 해당 시간 사용
   * - 없으면 DEFAULT_COOLDOWN_MS 사용
   * - 연속 실패 시 지수 백오프 적용 (최대 5분)
   */
  setCooldown(profileId: string, retryAfterMs?: number): void;

  /** 프로필이 쿨다운 중인지 확인 */
  isInCooldown(profileId: string): boolean;

  /** 잔여 쿨다운 시간 (ms) */
  getRemainingMs(profileId: string): number;

  /** 쿨다운 해제 */
  clearCooldown(profileId: string): void;

  /** 만료된 쿨다운 정리 */
  pruneExpired(): void;
}

export interface CooldownEntry {
  readonly profileId: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly consecutiveFailures: number;
}

// src/agents/auth/health.ts

/** 프로필 건강 상태 */
export type ProfileHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'disabled';

/** 건강 판정 기준 */
export interface HealthThresholds {
  readonly maxConsecutiveFailures: number; // 기본: 3
  readonly degradedFailureRate: number; // 기본: 0.3 (30%)
  readonly unhealthyFailureRate: number; // 기본: 0.7 (70%)
  readonly windowSizeMs: number; // 측정 윈도우 (기본: 5분)
}

/**
 * 프로필 건강 모니터
 *
 * 알고리즘:
 * 1. 슬라이딩 윈도우(windowSizeMs) 내의 요청 성공/실패 비율 계산
 * 2. consecutiveFailures >= maxConsecutiveFailures -> 'disabled'
 * 3. failureRate >= unhealthyFailureRate -> 'unhealthy'
 * 4. failureRate >= degradedFailureRate -> 'degraded'
 * 5. 그 외 -> 'healthy'
 */
export class ProfileHealthMonitor {
  constructor(thresholds?: Partial<HealthThresholds>);

  /** 요청 결과 기록 */
  recordResult(profileId: string, success: boolean): void;

  /** 현재 건강 상태 조회 */
  getHealth(profileId: string): ProfileHealthStatus;

  /** 건강한 프로필만 필터링 */
  filterHealthy(profiles: readonly AuthProfile[]): readonly AuthProfile[];

  /** 건강 상태 요약 */
  getSummary(): Map<string, ProfileHealthStatus>;
}
```

### 4.6 Provider Normalization

```typescript
// src/agents/models/provider-normalize.ts

/** 정규화된 AI 응답 */
export interface NormalizedResponse {
  readonly content: string;
  readonly stopReason: StopReason;
  readonly usage: NormalizedUsage;
  readonly modelId: string;
  readonly provider: ProviderId;
  readonly raw: unknown;
}

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

/** 제공자별 응답 정규화 함수 */
export type ResponseNormalizer = (raw: unknown) => NormalizedResponse;

/** 정규화 함수 레지스트리 */
export const normalizers: ReadonlyMap<ProviderId, ResponseNormalizer> = new Map([
  ['anthropic', normalizeAnthropicResponse],
  ['openai', normalizeOpenAIResponse],
]);

function normalizeAnthropicResponse(raw: unknown): NormalizedResponse;
function normalizeOpenAIResponse(raw: unknown): NormalizedResponse;
```

---

## 5. 구현 상세

### 5.1 Model Catalog: JSON 기반 모델 데이터베이스

```typescript
// src/agents/models/catalog.ts

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

### 5.2 내장 모델 데이터

```typescript
// src/agents/models/catalog-data.ts

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
```

### 5.3 Alias Index 빌드 & 모델 해석

```typescript
// src/agents/models/alias-index.ts

/**
 * 별칭 색인 빌드
 *
 * 알고리즘:
 * 1. 카탈로그의 모든 모델 순회
 * 2. 각 모델의 aliases 배열에서 소문자 정규화 후 Map에 추가
 * 3. 중복 별칭 발견 시 먼저 등록된 모델 유지 + 경고 로그
 * 4. 모델 ID 자체도 별칭으로 등록 (정확한 ID 매칭 지원)
 */
export function buildModelAliasIndex(catalog: ModelCatalog): AliasIndex {
  const index = new Map<string, ModelEntry>();

  for (const model of catalog.listModels()) {
    // 모델 ID를 별칭으로도 등록
    const keysToRegister = [model.id, ...model.aliases];

    for (const alias of keysToRegister) {
      const normalized = alias.toLowerCase().trim();
      if (index.has(normalized)) {
        const existing = index.get(normalized)!;
        console.warn(
          `[ModelAliasIndex] Duplicate alias "${normalized}": ` +
            `keeping ${existing.id}, ignoring ${model.id}`,
        );
        continue;
      }
      index.set(normalized, model);
    }
  }

  return index;
}
```

### 5.4 Model Fallback 체인

```typescript
// src/agents/models/fallback.ts

export async function runWithModelFallback<T>(
  config: FallbackConfig,
  fn: (model: ResolvedModel) => Promise<T>,
  resolve: (ref: ModelRef) => ResolvedModel,
): Promise<FallbackResult<T>> {
  const attempts: FallbackAttempt[] = [];

  for (const modelRef of config.models) {
    const resolved = resolve(modelRef);

    for (let retry = 0; retry <= config.maxRetriesPerModel; retry++) {
      const startTime = performance.now();
      try {
        const result = await fn(resolved);
        attempts.push({
          model: resolved,
          success: true,
          durationMs: performance.now() - startTime,
        });
        return { result, modelUsed: resolved, attempts };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        attempts.push({
          model: resolved,
          success: false,
          error: err,
          durationMs: performance.now() - startTime,
        });

        // 폴백 트리거 해당 여부 확인
        const trigger = classifyError(err);
        if (!trigger || !config.fallbackOn.includes(trigger)) {
          throw err; // 폴백 대상이 아닌 에러는 즉시 throw
        }

        // 동일 모델 재시도 전 대기
        if (retry < config.maxRetriesPerModel) {
          await sleep(config.retryDelayMs * Math.pow(2, retry));
        }
      }
    }
  }

  // 모든 모델 소진
  const lastError = attempts.at(-1)?.error ?? new Error('All models exhausted');
  throw new AggregateError(
    attempts.filter((a) => a.error).map((a) => a.error!),
    `All ${config.models.length} models failed: ${lastError.message}`,
  );
}

/** 에러를 FallbackTrigger로 분류 */
function classifyError(error: Error): FallbackTrigger | null {
  if ('status' in error) {
    const status = (error as any).status;
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server-error';
  }
  if (error.name === 'AbortError' || error.message.includes('timeout')) {
    return 'timeout';
  }
  if (error.message.includes('context') && error.message.includes('exceed')) {
    return 'context-overflow';
  }
  if (error.message.includes('model') && error.message.includes('unavailable')) {
    return 'model-unavailable';
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### 5.5 API Key 6단계 해석

```typescript
// src/agents/auth/resolver.ts

/** 제공자별 환경변수 이름 매핑 */
const ENV_KEY_MAP: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export async function resolveApiKeyForProvider(
  provider: ProviderId,
  options: ResolverOptions,
): Promise<ResolvedApiKey> {
  // Step 1: AuthProfile 저장소 (라운드 로빈)
  const profile = await options.profileStore.selectNext(provider);
  if (profile) {
    return { apiKey: profile.apiKey, source: 'profile', profileId: profile.id };
  }

  // Step 2: 환경변수
  const envKey = ENV_KEY_MAP[provider];
  const envValue = options.env[envKey];
  if (envValue) {
    return { apiKey: envValue, source: 'environment' };
  }

  // Step 3: 설정 파일
  const configKey = options.config.providers?.[provider]?.apiKey;
  if (configKey) {
    return { apiKey: configKey, source: 'config' };
  }

  // Step 4: AWS Secrets Manager (향후 확장)
  // const awsKey = await resolveFromAWS(provider);
  // if (awsKey) return { apiKey: awsKey, source: 'aws-secrets' };

  // Step 5: 기본값 (개발용)
  if (options.config.allowDefaultKeys && options.config.defaultKeys?.[provider]) {
    return { apiKey: options.config.defaultKeys[provider], source: 'default' };
  }

  // Step 6: 에러
  throw new Error(
    `No API key found for provider "${provider}". ` +
      `Set ${envKey} env var, add an auth profile, or configure in settings.`,
  );
}
```

### 5.6 라운드 로빈 프로필 선택

```typescript
// src/agents/auth/profiles.ts (selectNext 핵심 로직)

/**
 * 라운드 로빈 선택 알고리즘:
 * 1. 해당 provider의 활성 프로필 목록 조회
 * 2. 쿨다운 중인 프로필 제외
 * 3. 건강 상태가 'disabled'인 프로필 제외
 * 4. priority 기준 정렬
 * 5. lastUsedAt이 가장 오래된 프로필 선택 (null이면 최우선)
 * 6. 선택된 프로필의 lastUsedAt 업데이트
 */
async selectNext(provider: ProviderId): Promise<AuthProfile | undefined> {
  const profiles = await this.list(provider);

  const available = profiles.filter(p =>
    p.isActive &&
    !this.cooldownTracker.isInCooldown(p.id) &&
    this.healthMonitor.getHealth(p.id) !== 'disabled'
  );

  if (available.length === 0) return undefined;

  // priority 내림차순, lastUsedAt 오름차순 정렬
  const sorted = [...available].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const aTime = a.lastUsedAt?.getTime() ?? 0;
    const bTime = b.lastUsedAt?.getTime() ?? 0;
    return aTime - bTime;
  });

  const selected = sorted[0];
  await this.recordUsage(selected.id, true);
  return selected;
}
```

---

## 6. 선행 조건

| Phase                 | 구체적 산출물                                                           | 필요 이유                                   |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| Phase 1 (타입 시스템) | `ModelRef`, `AuthProfile`, `ProviderId`, `NormalizedResponse` 타입 정의 | 모델/인증 인터페이스의 타입 기반            |
| Phase 2 (인프라)      | `retry()` 유틸리티, `FinClawError` 커스텀 에러, `Logger`                | 폴백 체인 재시도, 에러 분류, 해석 과정 로깅 |
| Phase 3 (설정)        | `AgentConfig` zod 스키마 (providers, defaultModel, fallbackChain 등)    | 모델 선택 기본값, API 키 설정 경로          |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| #   | 산출물                          | 검증 방법                                                                         |
| --- | ------------------------------- | --------------------------------------------------------------------------------- |
| 1   | `InMemoryModelCatalog`          | 단위 테스트: listModels, getModel, getModelsByProvider, findModels                |
| 2   | `buildModelAliasIndex()`        | 단위 테스트: 별칭 해석, 중복 별칭 경고, 대소문자 무시                             |
| 3   | `resolveModel()`                | 단위 테스트: ID 매칭 -> 별칭 매칭 -> 기본 모델 -> 에러 순서                       |
| 4   | `runWithModelFallback()`        | 단위 테스트: 성공(첫 모델), 폴백(두 번째 모델), 전체 실패, 비폴백 에러 즉시 throw |
| 5   | `resolveApiKeyForProvider()`    | 단위 테스트: 6단계 순서 검증 (프로필 -> env -> config -> default -> error)        |
| 6   | `CooldownTracker`               | 단위 테스트: 쿨다운 설정/확인/해제, 지수 백오프, 만료 정리                        |
| 7   | `ProfileHealthMonitor`          | 단위 테스트: healthy/degraded/unhealthy/disabled 상태 전환                        |
| 8   | `AuthProfileStore.selectNext()` | 단위 테스트: 라운드 로빈, 쿨다운 제외, 우선순위 정렬                              |
| 9   | `normalizeAnthropicResponse()`  | 단위 테스트: Anthropic SDK 응답 -> NormalizedResponse 변환                        |
| 10  | `normalizeOpenAIResponse()`     | 단위 테스트: OpenAI SDK 응답 -> NormalizedResponse 변환                           |

### 검증 명령어

```bash
# 단위 테스트
pnpm test -- --filter='src/agents/__tests__/**'

# 타입 체크
pnpm typecheck

# 커버리지 (목표: branches 85%+)
pnpm test:coverage -- --filter='src/agents/**'
```

---

## 8. 복잡도 및 예상 파일 수

| 항목            | 값                                                             |
| --------------- | -------------------------------------------------------------- |
| **복잡도**      | **L**                                                          |
| **소스 파일**   | 12개 (`models/` 6 + `auth/` 4 + `providers/` 1 + `index.ts` 1) |
| **테스트 파일** | 6개                                                            |
| **총 파일 수**  | **~18개**                                                      |
| **예상 LOC**    | 소스 ~1,500 / 테스트 ~1,000 / 합계 ~2,500                      |
| **새 의존성**   | `@anthropic-ai/sdk` (필수), `openai` (선택)                    |
| **예상 소요**   | 2-3일                                                          |

### 복잡도 근거 (L)

- OpenClaw L1-L2 계층 120+ 파일을 18개로 압축, 2개 제공자만 초기 지원
- 폴백 체인은 에러 분류 로직이 핵심이며 테스트 경우의 수가 많음 (5종 트리거 x 3-5단 폴백)
- 6단계 API 키 해석 체인은 각 단계별 모킹 필요
- 쿨다운 + 건강 모니터링은 시간 기반 로직이므로 `vi.useFakeTimers()` 활용 필수
- 라운드 로빈 선택은 동시성(concurrent selectNext) 고려 필요
- 제공자 응답 정규화는 각 SDK의 응답 형식에 대한 정확한 매핑 필요
