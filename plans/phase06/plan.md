# Phase 6: 에이전트 코어 -- 모델 선택 & 인증

> 복잡도: **L** | 소스 파일: ~15 | 테스트 파일: ~7 | 합계: **~22 파일**

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

| 참조 문서 경로                                              | 적용할 패턴                                        |
| ----------------------------------------------------------- | -------------------------------------------------- |
| `openclaw_review/deep-dive/06-agent-model-auth.md` §3.1-3.4 | 별칭 해석, alias index, 폴백 체인, 카탈로그 스키마 |
| `openclaw_review/deep-dive/06-agent-model-auth.md` §3.5-3.7 | 6단계 API 키 해석 체인, 환경변수 매핑              |
| `openclaw_review/deep-dive/06-agent-model-auth.md` §3.8     | 제공자 설정 정규화                                 |
| `openclaw_review/deep-dive/06-agent-model-auth.md` §3.13    | 라운드 로빈, 쿨다운, 프로필 건강 모니터링          |
| `openclaw_review/docs/06.에이전트-모델-인증-세션.md`        | 위 deep-dive 한국어 요약                           |
| `openclaw_review/docs/12.인프라-런타임-기반-레이어.md`      | retry, circuit breaker, 동시성 패턴                |

**OpenClaw 대비 FinClaw 간소화 사항:**

- 120+ 파일(L1-L2) -> ~22 파일로 핵심만 추출
- 20+ 제공자 -> Anthropic + OpenAI 2종으로 초기 제한
- AWS Bedrock/Vertex AI 인증은 향후 확장으로 미룸
- OAuth 플로우 제외 (API 키 기반만 지원)
- 금융 도메인 전용: 모델별 금융 분석 성능 메타데이터 추가

---

## 3. 생성할 파일

### 소스 파일 (15개)

```
packages/agent/src/
├── index.ts                      # 에이전트 모듈 public API
├── errors.ts                     # ★ FailoverError + classifyFallbackError
├── models/
│   ├── catalog.ts                # 모델 카탈로그 (JSON DB + 조회)
│   ├── catalog-data.ts           # 내장 모델 데이터 (+haiku-3.5, +gpt-4o-mini 저비용 폴백용)
│   ├── selection.ts              # 모델 선택 + 별칭 해석
│   ├── alias-index.ts            # buildModelAliasIndex()
│   ├── fallback.ts               # runWithModelFallback() 폴백 체인
│   └── provider-normalize.ts     # 제공자별 응답/사용량 정규화
├── auth/
│   ├── profiles.ts               # ManagedAuthProfile CRUD 저장소
│   ├── resolver.ts               # resolveApiKeyForProvider() 6단계 해석
│   ├── cooldown.ts               # 쿨다운 트래커 (rate limit 대응)
│   └── health.ts                 # 프로필 건강 모니터링
└── providers/
    ├── adapter.ts                # ★ ProviderAdapter 인터페이스 + 팩토리 + CircuitBreaker
    ├── anthropic.ts              # ★ Anthropic SDK 어댑터 (~60줄)
    └── openai.ts                 # ★ OpenAI SDK 어댑터 (~60줄)
```

### 테스트 파일 (7개)

```
packages/agent/test/
├── catalog.test.ts               # 모델 카탈로그 조회/필터 테스트
├── selection.test.ts             # 별칭 해석 + alias index 테스트
├── fallback.test.ts              # 폴백 체인 실행 테스트
├── errors.test.ts                # ★ FailoverError + classifyFallbackError 테스트
├── resolver.test.ts              # 6단계 API 키 해석 테스트
├── cooldown.test.ts              # 쿨다운 상태 전환 테스트
└── health.test.ts                # 프로필 건강 상태 모니터링 테스트
```

---

## 4. 핵심 인터페이스/타입

### 4.1 Model Catalog 타입

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
// packages/agent/src/models/selection.ts

/**
 * 해석 전 사용자 입력(별칭/ID 문자열).
 * @finclaw/types의 ModelRef(해석 완료된 모델 참조)와 구분하기 위해
 * UnresolvedModelRef로 명명한다.
 */
export interface UnresolvedModelRef {
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
  ref: UnresolvedModelRef,
  catalog: ModelCatalog,
  aliasIndex: AliasIndex,
  defaultModelId?: string,
): ResolvedModel;
```

### 4.3 Model Fallback

```typescript
// packages/agent/src/models/fallback.ts

/** 폴백 체인 설정 */
export interface FallbackConfig {
  /** 시도할 모델 목록 (우선순위 순) */
  readonly models: readonly UnresolvedModelRef[];
  /** 모델별 최대 재시도 횟수 */
  readonly maxRetriesPerModel: number;
  /** 재시도 기본 간격 (ms) — computeBackoff()의 minDelay로 사용 */
  readonly retryBaseDelayMs: number;
  /** 폴백 사유 필터: 이 에러만 폴백 트리거 */
  readonly fallbackOn: readonly FallbackTrigger[];
  /** 취소 시그널 (선택) */
  readonly abortSignal?: AbortSignal;
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
  resolveModel: (ref: UnresolvedModelRef) => ResolvedModel,
): Promise<FallbackResult<T>>;
```

### 4.4 Auth Profiles & Resolution

```typescript
// packages/agent/src/auth/profiles.ts

import type { AuthProfile as BaseAuthProfile } from '@finclaw/types';

/**
 * CRUD 수명주기 필드가 추가된 관리형 인증 프로필.
 * @finclaw/types의 AuthProfile(provider, apiKey 등 기본 필드)을 확장한다.
 */
export interface ManagedAuthProfile extends BaseAuthProfile {
  readonly id: string;
  readonly name: string;
  // provider, apiKey는 BaseAuthProfile에서 상속
  readonly isActive: boolean;
  readonly priority: number; // 라운드 로빈 가중치
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly failureCount: number;
  readonly cooldownUntil: Date | null;
}

/** 프로필 CRUD 저장소 인터페이스 */
export interface AuthProfileStore {
  list(provider?: ProviderId): Promise<readonly ManagedAuthProfile[]>;
  get(id: string): Promise<ManagedAuthProfile | undefined>;
  create(input: CreateProfileInput): Promise<ManagedAuthProfile>;
  update(id: string, patch: Partial<ManagedAuthProfile>): Promise<ManagedAuthProfile>;
  delete(id: string): Promise<boolean>;

  /** 라운드 로빈: 사용 가능한 다음 프로필 선택 */
  selectNext(provider: ProviderId): Promise<ManagedAuthProfile | undefined>;

  /** 프로필 사용 기록 업데이트 */
  recordUsage(id: string, success: boolean): Promise<void>;
}

export interface CreateProfileInput {
  readonly name: string;
  readonly provider: ProviderId;
  readonly apiKey: string; // BaseAuthProfile 필수 필드
  readonly priority?: number;
}

// packages/agent/src/auth/resolver.ts

/**
 * 6단계 API 키 해석 체인
 *
 * 해석 순서:
 * 1. ManagedAuthProfile 저장소 (라운드 로빈 선택)
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
// packages/agent/src/auth/cooldown.ts

/** 쿨다운 트래커 */
export class CooldownTracker {
  /** 기본 쿨다운 시간 (ms) */
  static readonly DEFAULT_COOLDOWN_MS = 60_000; // 1분

  /** 사유별 기본 쿨다운 시간 (ms) */
  static readonly COOLDOWN_DEFAULTS: Record<string, number> = {
    'rate-limit': 60_000, // 1분
    billing: 86_400_000, // 24시간 (402 에러는 결제 문제)
    'server-error': 300_000, // 5분
    default: 60_000,
  };

  private readonly cooldowns = new Map<string, CooldownEntry>();

  /**
   * Rate limit 발생 시 프로필을 쿨다운 상태로 전환
   * - reason 파라미터로 사유별 차등 쿨다운 적용
   * - Retry-After 헤더가 있으면 retryAfterMs 사용 (최우선)
   * - 없으면 COOLDOWN_DEFAULTS[reason] 사용
   * - 연속 실패 시 지수 백오프 적용 (최대 5분)
   */
  setCooldown(profileId: string, reason?: string, retryAfterMs?: number): void;

  /**
   * 프로필이 쿨다운 중인지 확인
   * - 쿨다운 만료 시 consecutiveFailures도 함께 리셋 (에스컬레이션 루프 방지)
   */
  isInCooldown(profileId: string): boolean {
    const entry = this.cooldowns.get(profileId);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.cooldowns.delete(profileId); // consecutiveFailures도 함께 삭제
      return false;
    }
    return true;
  }

  /** 잔여 쿨다운 시간 (ms) */
  getRemainingMs(profileId: string): number;

  /** 쿨다운 해제 */
  clearCooldown(profileId: string): void;

  /** 만료된 쿨다운 정리 */
  pruneExpired(): void;
}

export interface CooldownEntry {
  readonly profileId: string;
  readonly reason: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly consecutiveFailures: number;
}

// packages/agent/src/auth/health.ts

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
  filterHealthy(profiles: readonly ManagedAuthProfile[]): readonly ManagedAuthProfile[];

  /** 건강 상태 요약 */
  getSummary(): Map<string, ProfileHealthStatus>;
}
```

### 4.6 Provider Normalization

```typescript
// packages/agent/src/models/provider-normalize.ts

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

**Cross-SDK 토큰 필드 매핑:**

| 정규화 필드        | Anthropic SDK                       | OpenAI SDK                |
| ------------------ | ----------------------------------- | ------------------------- |
| `inputTokens`      | `usage.input_tokens`                | `usage.prompt_tokens`     |
| `outputTokens`     | `usage.output_tokens`               | `usage.completion_tokens` |
| `cacheReadTokens`  | `usage.cache_read_input_tokens`     | N/A (0)                   |
| `cacheWriteTokens` | `usage.cache_creation_input_tokens` | N/A (0)                   |
| `totalTokens`      | `input + output` (계산)             | `usage.total_tokens`      |

**스트리밍 타입 선언 (구현은 Phase 9):**

```typescript
export interface StreamChunk {
  readonly type: 'text_delta' | 'tool_use_delta' | 'usage' | 'done';
  readonly text?: string;
  readonly usage?: Partial<NormalizedUsage>;
}
```

### 4.7 FailoverError 에러 클래스

`classifyError` 이름이 `@finclaw/infra`의 `unhandled-rejections.ts` export와 충돌하므로, Phase 6 전용 에러 분류는 `classifyFallbackError`로 명명한다. 또한 §5.4의 문자열 매칭(`error.message.includes('context')`)이 SDK 메시지 변경에 취약하므로, 구조화된 에러 클래스로 대체한다.

```typescript
// packages/agent/src/errors.ts
import { FinClawError } from '@finclaw/infra';

export type FallbackReason =
  | 'rate-limit'
  | 'server-error'
  | 'timeout'
  | 'context-overflow'
  | 'model-unavailable';

export class FailoverError extends FinClawError {
  readonly fallbackReason: FallbackReason;
  constructor(
    message: string,
    reason: FallbackReason,
    opts?: { statusCode?: number; cause?: Error },
  ) {
    super(message, `FAILOVER_${reason.toUpperCase().replace('-', '_')}`, opts);
    this.fallbackReason = reason;
  }
}

/**
 * 에러를 FallbackReason으로 분류 (classifyError 이름 충돌 방지)
 *
 * 우선순위: FailoverError → FinClawError statusCode → SDK status → 네트워크 에러 코드
 * AbortError → null (폴백 대상 아님, 즉시 rethrow)
 */
export function classifyFallbackError(error: Error): FallbackReason | null;
```

---

## 5. 구현 상세

### 5.1 Model Catalog: JSON 기반 모델 데이터베이스

```typescript
// packages/agent/src/models/catalog.ts

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
// packages/agent/src/models/catalog-data.ts

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

// 권장 폴백 체인: opus → sonnet → haiku → gpt-4o → 4o-mini
```

### 5.3 Alias Index 빌드 & 모델 해석

```typescript
// packages/agent/src/models/alias-index.ts

import { createLogger } from '@finclaw/infra';

const log = createLogger({ name: 'ModelAliasIndex' });

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
        log.warn(`Duplicate alias "${normalized}": keeping ${existing.id}, ignoring ${model.id}`);
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
// packages/agent/src/models/fallback.ts

import { sleepWithAbort, computeBackoff, getEventBus } from '@finclaw/infra';
import { classifyFallbackError, FailoverError } from '../errors.js';
import { getBreakerForProvider } from '../providers/adapter.js';

/**
 * FallbackConfig.fallbackOn 기본값:
 * ['rate-limit', 'server-error', 'timeout', 'model-unavailable']
 * 'context-overflow'는 의도적 미포함 — 더 작은 컨텍스트 윈도우 모델로
 * 폴백하면 동일 에러 반복. 명시적 opt-in만 허용.
 */

export async function runWithModelFallback<T>(
  config: FallbackConfig,
  fn: (model: ResolvedModel) => Promise<T>,
  resolve: (ref: UnresolvedModelRef) => ResolvedModel,
): Promise<FallbackResult<T>> {
  const attempts: FallbackAttempt[] = [];
  const bus = getEventBus();

  for (const modelRef of config.models) {
    const resolved = resolve(modelRef);

    // CircuitBreaker: open 상태면 이 제공자 건너뛰기
    const circuit = getBreakerForProvider(resolved.provider);
    if (circuit.getState() === 'open') {
      continue;
    }

    for (let retry = 0; retry <= config.maxRetriesPerModel; retry++) {
      const startTime = performance.now();
      try {
        const result = await circuit.execute(() => fn(resolved));
        attempts.push({
          model: resolved,
          success: true,
          durationMs: performance.now() - startTime,
        });
        return { result, modelUsed: resolved, attempts };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // AbortError: 사용자 취소(Ctrl+C)는 즉시 전파 (폴백 대상 아님)
        if (err.name === 'AbortError') throw err;

        attempts.push({
          model: resolved,
          success: false,
          error: err,
          durationMs: performance.now() - startTime,
        });

        // 폴백 트리거 해당 여부 확인 (classifyFallbackError 사용)
        const trigger = classifyFallbackError(err);
        if (!trigger || !config.fallbackOn.includes(trigger)) {
          throw err; // 폴백 대상이 아닌 에러는 즉시 throw
        }

        bus.emit('model:fallback', resolved.modelId, modelRef.raw, trigger);

        // 동일 모델 재시도 전 대기 (@finclaw/infra 재사용)
        if (retry < config.maxRetriesPerModel) {
          const delayMs = computeBackoff(retry, { minDelay: config.retryBaseDelayMs });
          await sleepWithAbort(delayMs, config.abortSignal);
        }
      }
    }
  }

  // 모든 모델 소진
  const lastError = attempts.at(-1)?.error ?? new Error('All models exhausted');
  const modelIds = config.models.map((m) => m.raw);
  bus.emit('model:exhausted', modelIds, lastError.message);
  throw new AggregateError(
    attempts.filter((a) => a.error).map((a) => a.error!),
    `All ${config.models.length} models failed: ${lastError.message}`,
  );
}
```

> **에러 분류 위치:** `classifyFallbackError()`는 `errors.ts`에, 각 SDK 어댑터(`anthropic.ts`, `openai.ts`)는 SDK 에러를 `FailoverError`로 래핑하여 에러 분류가 어댑터에서 한 번만 발생한다.

**2계층 장애 격리:**

- **CircuitBreaker** (제공자 단위): "Anthropic API 다운" → 해당 제공자 전체 건너뜀
- **Cooldown** (프로필 단위): "특정 키 rate limit" → 해당 키만 건너뜀

### 5.5 API Key 6단계 해석

```typescript
// packages/agent/src/auth/resolver.ts

/** 제공자별 환경변수 이름 매핑 */
const ENV_KEY_MAP: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export async function resolveApiKeyForProvider(
  provider: ProviderId,
  options: ResolverOptions,
): Promise<ResolvedApiKey> {
  // Step 1: ManagedAuthProfile 저장소 (라운드 로빈)
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
  // TODO: 구현하지 않음 — §13 과잉 방지 체크리스트 참고
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
// packages/agent/src/auth/profiles.ts (selectNext 핵심 로직)

/**
 * 라운드 로빈 선택 알고리즘:
 * 1. 해당 provider의 활성 프로필 목록 조회
 * 2. 쿨다운 중인 프로필 제외
 * 3. 건강 상태가 'disabled'인 프로필 제외
 * 4. priority 기준 정렬
 * 5. lastUsedAt이 가장 오래된 프로필 선택 (null이면 최우선)
 * 6. 선택된 프로필의 lastUsedAt 업데이트
 */
async selectNext(provider: ProviderId): Promise<ManagedAuthProfile | undefined> {
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

### 5.6-A 프로필 순환 + 폴백 통합

동일 제공자 멀티키 순환이 교차 제공자 폴백보다 선행한다:

```
anthropic (key-A) → fail(429) → 쿨다운
→ anthropic (key-B) → fail(429) → 쿨다운
→ openai (key-C) → success (제공자 전환)
```

**구현:** `runWithModelFallback()` 내부에서 매 retry마다 `resolveApiKeyForProvider()` 재호출. `selectNext()`의 라운드 로빈이 자동으로 다음 프로필 선택.

### 5.7 Provider Adapter

```typescript
// packages/agent/src/providers/adapter.ts

import { createCircuitBreaker, type CircuitBreaker } from '@finclaw/infra';

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  chatCompletion(params: ProviderRequestParams): Promise<ProviderRawResponse>;
}

export interface ProviderRequestParams {
  readonly model: string;
  readonly messages: ConversationMessage[];
  readonly tools?: ToolDefinition[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly abortSignal?: AbortSignal; // SDK 호출에 시그널 전파
}

export function createProviderAdapter(
  provider: ProviderId,
  apiKey: string,
  options?: { baseUrl?: string },
): ProviderAdapter;

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
```

각 어댑터 (`anthropic.ts`, `openai.ts`, ~60줄)는 SDK 에러를 `FailoverError`로 래핑하여 에러 분류가 어댑터에서 한 번만 발생한다.

---

## 6. infra 패키지 재사용 가이드

`@finclaw/infra` 패키지(Phase 2 산출물)의 유틸리티를 재사용하여 자체 구현을 최소화한다.

| infra 함수                      | Phase 6 활용처                                 | 비고                                                                    |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `retry(fn, opts)`               | 제공자 API 호출 재시도                         | `RetryOptions`로 횟수/조건 제어                                         |
| `computeBackoff(attempt, opts)` | 폴백 체인 재시도 간격 계산                     | `minDelay`, `maxDelay`, `jitter` 지원. 자체 `Math.pow(2, retry)` 불필요 |
| `sleepWithAbort(ms, signal?)`   | 재시도 대기, 쿨다운 대기                       | `AbortSignal`로 취소 가능. 자체 `sleep()` 구현 불필요                   |
| `createCircuitBreaker(opts)`    | 제공자별 장애 감지 (`getBreakerForProvider()`) | 반복 실패 시 자동 open → half-open → closed 전환                        |
| `FinClawError`                  | `FailoverError` 기반 클래스                    | `code`, `statusCode` 필드로 `classifyFallbackError()` 분류 간소화       |
| `isFinClawError(err)`           | 에러 타입 가드                                 | `classifyFallbackError()`에서 statusCode 안전 접근                      |
| `createLogger(config)`          | 모델 선택/인증 과정 구조화 로깅                | tslog 기반, `name` 필드로 컨텍스트 구분                                 |
| `ConcurrencyLane`               | 제공자별 RPM 제한                              | `acquire()/release()`로 동시 API 호출 수 제한                           |
| `Dedupe`                        | 동일 alias 해석 중복 방지                      | 동시 `resolveModel()` 호출 중복 제거                                    |
| `getEventBus()`                 | 모델/인증 이벤트 발행                          | `model:fallback`, `auth:cooldown` 등                                    |
| `wrapError()`                   | SDK 에러 cause 체이닝                          | `FailoverError` 생성 시 원인 에러 보존                                  |
| `extractErrorInfo()`            | 에러 로깅                                      | 폴백 시도 실패 로그에 구조화된 정보 포함                                |

```typescript
// packages/agent/src/models/fallback.ts — infra 재사용 예시
import { sleepWithAbort, computeBackoff } from '@finclaw/infra';

// 재시도 대기 (취소 가능, 지수 백오프 + 지터)
const delayMs = computeBackoff(retry, { minDelay: config.retryBaseDelayMs });
await sleepWithAbort(delayMs, config.abortSignal);
```

> **원칙:** `@finclaw/infra`에 이미 존재하는 기능은 재구현하지 않는다. `sleep()`, `retry()`, 에러 클래스 등을 자체 정의하지 말 것.

### 6-A. FinClawEventMap 확장

`@finclaw/infra/src/events.ts`의 `FinClawEventMap`에 Phase 6 이벤트를 추가한다:

| 이벤트 키            | 시그니처                                                  | 발행 시점           |
| -------------------- | --------------------------------------------------------- | ------------------- |
| `model:resolve`      | `(alias: string, modelId: string) => void`                | 모델 별칭 해석 완료 |
| `model:fallback`     | `(from: string, to: string, reason: string) => void`      | 폴백 전환           |
| `model:exhausted`    | `(models: string[], lastError: string) => void`           | 모든 모델 소진      |
| `auth:resolve`       | `(provider: string, source: string) => void`              | API 키 해석 완료    |
| `auth:cooldown`      | `(profileId: string, reason: string, ms: number) => void` | 쿨다운 진입         |
| `auth:health:change` | `(profileId: string, from: string, to: string) => void`   | 건강 상태 변경      |

---

## 7. API 키 보안 고려사항

| 항목                 | 지침                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **로그 마스킹**      | API 키를 로그에 전체 노출하지 않는다. `sk-...xxxx` 형태로 마스킹                          |
| **환경변수 검증**    | `@finclaw/config`의 Zod v4 스키마로 `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` 형식 검증       |
| **평문 저장 최소화** | ManagedAuthProfile 저장 시 인메모리에만 유지. 디스크 저장은 Phase 후반에서 암호화 적용 후 |
| **에러 메시지**      | 키 해석 실패 에러에 실제 키 값을 포함하지 않는다                                          |
| **전송**             | API 키는 HTTPS 전용. 로컬 설정 파일에 평문 저장 시 `.gitignore` 필수                      |

```typescript
/** API 키 마스킹 유틸리티 */
function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

// 사용 예: 로그에서
log.info(
  `Resolved API key for ${provider}: ${maskApiKey(resolvedKey.apiKey)} (source: ${resolvedKey.source})`,
);
```

---

## 8. 비용 추적 인터페이스

`NormalizedUsage.estimatedCostUsd`를 누적 추적하여 LLM API 비용 초과 리스크를 완화한다.

```typescript
// packages/agent/src/models/provider-normalize.ts 내 또는 별도 파일

interface UsageSnapshot {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
  readonly requestCount: number;
}

/** 제공자/모델별 사용량 누적 집계기 */
class UsageAggregator {
  private byProvider = new Map<ProviderId, UsageSnapshot>();
  private byModel = new Map<string, UsageSnapshot>();

  /** 사용량 기록 (각 API 호출 후) */
  record(provider: ProviderId, modelId: string, usage: NormalizedUsage): void;

  /** 제공자별 통계 조회 */
  getByProvider(provider: ProviderId): UsageSnapshot | undefined;

  /** 모델별 통계 조회 */
  getByModel(modelId: string): UsageSnapshot | undefined;

  /** 전체 통계 */
  getTotal(): UsageSnapshot;

  /** 초기화 */
  reset(): void;
}
```

> **범위 제한:** 인메모리 집계 전용. 영속 저장(`@finclaw/storage` 연동)은 Phase 후반에서 추가. 비용 임계값 알림은 향후 확장.

---

## 9. 선행 조건

| Phase                 | 패키지            | 구체적 산출물                                                                                                                         | 필요 이유                                         |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Phase 1 (타입 시스템) | `@finclaw/types`  | `ModelRef`, `AuthProfile`, `TokenUsage`, `AgentRunResult` 인터페이스 (`packages/types/src/agent.ts`)                                  | 모델/인증 인터페이스의 타입 기반                  |
| Phase 2 (인프라)      | `@finclaw/infra`  | `retry()`, `computeBackoff()`, `sleepWithAbort()`, `createCircuitBreaker()`, `FinClawError`, `createLogger()` (`packages/infra/src/`) | 폴백 체인 재시도, 에러 분류, 해석 과정 로깅       |
| Phase 3 (설정)        | `@finclaw/config` | `FinClawConfigSchema` (Zod v4), `validateConfig()` (`packages/config/src/`)                                                           | 모델 선택 기본값, API 키 설정 경로, 환경변수 검증 |

**의존성 추가 필요:**

`packages/agent/package.json`:

```json
{
  "dependencies": {
    "@finclaw/types": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "@finclaw/config": "workspace:*"
  }
}
```

`packages/agent/tsconfig.json`의 `references`:

```json
{ "path": "../types" }, { "path": "../infra" }, { "path": "../config" }
```

`@finclaw/config/src/zod-schema.ts`의 `models` 섹션 확장:

```typescript
models: z.strictObject({
  definitions: z.record(z.string(), ModelDefinitionSchema).optional(),
  aliases: z.record(z.string(), z.string()).optional(),
  defaultModel: z.string().optional(),     // ★ 추가
  fallbacks: z.array(z.string()).optional(), // ★ 추가
}).optional(),
```

---

## 10. 산출물 및 검증

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
# 단위 테스트 (agent 패키지)
pnpm test packages/agent

# 타입 체크
pnpm typecheck

# 커버리지 (목표: branches 85%+)
pnpm test:coverage -- packages/agent
```

---

## 11. 테스트 전략 상세

### 11.1 시간 기반 로직: `vi.useFakeTimers()`

쿨다운 트래커와 건강 모니터링은 시간 의존 로직이므로 Vitest fake timers를 활용한다.

```typescript
// packages/agent/test/cooldown.test.ts

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it('should expire cooldown after DEFAULT_COOLDOWN_MS', () => {
  tracker.setCooldown('profile-1');
  expect(tracker.isInCooldown('profile-1')).toBe(true);

  vi.advanceTimersByTime(CooldownTracker.DEFAULT_COOLDOWN_MS);
  expect(tracker.isInCooldown('profile-1')).toBe(false);
});

it('should apply exponential backoff on consecutive failures', () => {
  tracker.setCooldown('profile-1'); // 1분
  vi.advanceTimersByTime(60_000);
  tracker.setCooldown('profile-1'); // 2분
  expect(tracker.getRemainingMs('profile-1')).toBeGreaterThan(60_000);
});
```

### 11.2 제공자 API 응답 모킹

외부 LLM API를 호출하지 않고 정규화 로직을 테스트한다.

```typescript
// packages/agent/test/fallback.test.ts

const mockAnthropicSuccess = {
  id: 'msg_123',
  content: [{ type: 'text', text: 'response' }],
  usage: { input_tokens: 10, output_tokens: 20 },
};
const mockRateLimitError = Object.assign(new Error('rate limited'), { status: 429 });
const mockServerError = Object.assign(new Error('internal error'), { status: 500 });

it('should fallback to second model on rate limit', async () => {
  const fn = vi
    .fn()
    .mockRejectedValueOnce(mockRateLimitError)
    .mockResolvedValueOnce(mockAnthropicSuccess);
  // ...
});
```

### 11.3 엣지 케이스 목록

| 시나리오                        | 테스트 파일         | 기대 동작                                      |
| ------------------------------- | ------------------- | ---------------------------------------------- |
| 동시 `selectNext()` 호출        | `resolver.test.ts`  | 서로 다른 프로필 반환 (라운드 로빈 무결성)     |
| 모든 모델 소진                  | `fallback.test.ts`  | `AggregateError` throw, 모든 시도 내역 포함    |
| 빈 카탈로그                     | `catalog.test.ts`   | `listModels()` → `[]`, `resolveModel()` → 에러 |
| 모든 프로필 쿨다운              | `cooldown.test.ts`  | `selectNext()` → `undefined`                   |
| 중복 별칭 등록                  | `selection.test.ts` | 경고 로그 + 먼저 등록된 모델 유지              |
| 비폴백 에러 (예: 인증 실패 401) | `fallback.test.ts`  | 폴백 없이 즉시 throw                           |
| AbortSignal 취소                | `fallback.test.ts`  | 대기 중 즉시 중단, AbortError throw            |
| billing(402) 에러               | `cooldown.test.ts`  | 24시간 쿨다운 적용                             |
| circuit breaker open → 호출     | `fallback.test.ts`  | 즉시 건너뜀, 다음 모델로 폴백                  |
| 동일 제공자 멀티키 순환 후 폴백 | `fallback.test.ts`  | key-A(429)→key-B(429)→다른 제공자              |
| 쿨다운 만료 시 카운터 리셋      | `cooldown.test.ts`  | consecutiveFailures 0으로 초기화               |

---

## 12. 복잡도 및 예상 파일 수

| 항목            | 값                                                                         |
| --------------- | -------------------------------------------------------------------------- |
| **복잡도**      | **L** (변동 없음)                                                          |
| **소스 파일**   | 15개 (`models/` 6 + `auth/` 4 + `providers/` 3 + `errors.ts` + `index.ts`) |
| **테스트 파일** | 7개                                                                        |
| **총 파일 수**  | **~22개**                                                                  |
| **예상 LOC**    | 소스 ~1,400 / 테스트 ~1,100 / 합계 ~2,500                                  |
| **새 의존성**   | `@anthropic-ai/sdk` (필수), `openai` (선택)                                |
| **새 devDep**   | `msw: ^2.x` (통합 테스트용, 선택)                                          |

### 복잡도 근거 (L)

- OpenClaw L1-L2 계층 120+ 파일을 22개로 압축, 2개 제공자만 초기 지원
- **`@finclaw/infra` 재사용으로 실제 구현량 감소**: `retry()`, `computeBackoff()`, `sleepWithAbort()`, `FinClawError`, `createLogger()`, `createCircuitBreaker()`, `ConcurrencyLane`, `Dedupe`, `getEventBus()` 등을 자체 구현하지 않음
- 폴백 체인은 에러 분류 로직이 핵심이며 테스트 경우의 수가 많음 (5종 트리거 x 3-5단 폴백)
- 6단계 API 키 해석 체인은 각 단계별 모킹 필요
- 쿨다운 + 건강 모니터링은 시간 기반 로직이므로 `vi.useFakeTimers()` 활용 필수
- 라운드 로빈 선택은 동시성(concurrent selectNext) 고려 필요
- 제공자 응답 정규화는 각 SDK의 응답 형식에 대한 정확한 매핑 필요

---

## 13. 과잉 방지 체크리스트

Phase 6 구현 시 범위를 제한하기 위한 명시적 가이드라인.

| 항목                          | 초기 구현                  | 하지 않을 것                           |
| ----------------------------- | -------------------------- | -------------------------------------- |
| **제공자**                    | Anthropic + OpenAI (2종)   | Google, Mistral, Cohere 등 추가 제공자 |
| **ManagedAuthProfile 저장소** | 인메모리 (`Map` 기반)      | `@finclaw/storage` 연동, 디스크 영속화 |
| **AWS Secrets Manager**       | `// TODO` 주석 자리표시만  | 실제 AWS SDK 통합                      |
| **비용 추적**                 | 인메모리 `UsageAggregator` | 영속 저장, 임계값 알림, 대시보드       |
| **OAuth 플로우**              | 미구현                     | OAuth 토큰 갱신, 리프레시 로직         |
| **모델 카탈로그**             | 하드코딩 `BUILT_IN_MODELS` | 외부 JSON 파일 로드, 동적 업데이트     |
| **API 키 암호화**             | 평문 인메모리 저장         | AES 암호화, 키링 연동                  |

> **원칙:** 각 항목은 실제 필요가 확인될 때 확장한다. "나중에 필요할 수 있다"는 이유로 미리 구현하지 않는다.

---

## 14. 구현 순서

| 단계      | 파일                                                               | 검증                      |
| --------- | ------------------------------------------------------------------ | ------------------------- |
| 1. 기반   | `errors.ts`, `catalog.ts`, `catalog-data.ts`                       | 타입체크 + catalog 테스트 |
| 2. 해석   | `alias-index.ts`, `selection.ts`                                   | alias/selection 테스트    |
| 3. 인증   | `profiles.ts`, `cooldown.ts`, `health.ts`, `resolver.ts`           | resolver 6단계 테스트     |
| 4. 제공자 | `adapter.ts`, `anthropic.ts`, `openai.ts`, `provider-normalize.ts` | 정규화 테스트             |
| 5. 통합   | `fallback.ts`, `index.ts`                                          | 폴백 체인 통합 테스트     |
