# Phase 6 Part 2: L2 인증 계층 + 폴백 통합

> 소스 5 신규 + 1 수정 + 테스트 4 + 기존 수정 3 = **13 작업 항목**
> **선행 조건**: Part 1 완료 (errors, catalog, selection, adapter 등 모두 구현)

---

## T1. FinClawEventMap 확장 — auth 이벤트 3종

### 수정: `packages/infra/src/events.ts`

`FinClawEventMap` 인터페이스에 아래 3개 이벤트를 추가한다 (Part 1에서 추가한 model 이벤트 아래):

```typescript
// 기존 FinClawEventMap에 추가:
  /** API 키 해석 완료 */
  'auth:resolve': (provider: string, source: string) => void;
  /** 프로필 쿨다운 진입 */
  'auth:cooldown': (profileId: string, reason: string, ms: number) => void;
  /** 프로필 건강 상태 변경 */
  'auth:health:change': (profileId: string, from: string, to: string) => void;
```

### 검증

`pnpm typecheck` 통과

---

## T2. Config 스키마 확장 — defaultModel, fallbacks

### 목적

`resolveModel()`의 기본 모델과 폴백 체인 설정을 config에서 읽을 수 있게 한다.

### 수정: `packages/types/src/config.ts`

`ModelsConfig` 인터페이스에 2개 필드 추가:

```typescript
export interface ModelsConfig {
  definitions?: Record<string, ModelDefinition>;
  aliases?: Record<string, string>;
  defaultModel?: string; // ★ 추가
  fallbacks?: string[]; // ★ 추가
}
```

### 수정: `packages/config/src/zod-schema.ts`

`models` 스키마에 2개 필드 추가:

```typescript
  models: z
    .strictObject({
      definitions: z.record(z.string(), ModelDefinitionSchema).optional(),
      aliases: z.record(z.string(), z.string()).optional(),
      defaultModel: z.string().optional(),         // ★ 추가
      fallbacks: z.array(z.string()).optional(),    // ★ 추가
    })
    .optional(),
```

### 검증

`pnpm typecheck && pnpm test -- packages/config` — 기존 config 테스트가 깨지지 않는지 확인

---

## T3. `packages/agent/src/auth/cooldown.ts` — CooldownTracker

### 목적

rate limit 발생 시 프로필을 일정 시간 사용 불가 상태로 전환한다.
시간 기반 로직이므로 테스트에서 `vi.useFakeTimers()` 사용 필수.

### 코드

```typescript
// packages/agent/src/auth/cooldown.ts
import { getEventBus } from '@finclaw/infra';

/** 쿨다운 엔트리 */
export interface CooldownEntry {
  readonly profileId: string;
  readonly reason: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly consecutiveFailures: number;
}

/** 쿨다운 트래커 */
export class CooldownTracker {
  /** 기본 쿨다운 시간 (ms) */
  static readonly DEFAULT_COOLDOWN_MS = 60_000;

  /** 사유별 기본 쿨다운 시간 (ms) */
  static readonly COOLDOWN_DEFAULTS: Record<string, number> = {
    'rate-limit': 60_000, // 1분
    billing: 86_400_000, // 24시간
    'server-error': 300_000, // 5분
    default: 60_000,
  };

  /** 지수 백오프 상한 (ms) */
  private static readonly MAX_BACKOFF_MS = 300_000; // 5분

  private readonly cooldowns = new Map<string, CooldownEntry>();

  /**
   * 프로필을 쿨다운 상태로 전환
   *
   * @param profileId 프로필 ID
   * @param reason 쿨다운 사유 (rate-limit, billing, server-error 등)
   * @param retryAfterMs Retry-After 헤더 값 (최우선)
   */
  setCooldown(profileId: string, reason = 'default', retryAfterMs?: number): void {
    const existing = this.cooldowns.get(profileId);
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;

    // 쿨다운 시간 결정: retryAfterMs > 사유별 기본값 > 지수 백오프
    let durationMs: number;
    if (retryAfterMs !== undefined) {
      durationMs = retryAfterMs;
    } else {
      const baseDuration =
        CooldownTracker.COOLDOWN_DEFAULTS[reason] ?? CooldownTracker.DEFAULT_COOLDOWN_MS;
      // 연속 실패 시 지수 백오프: base * 2^(failures - 1)
      const backoff = baseDuration * Math.pow(2, consecutiveFailures - 1);
      durationMs = Math.min(backoff, CooldownTracker.MAX_BACKOFF_MS);
    }

    const now = Date.now();
    this.cooldowns.set(profileId, {
      profileId,
      reason,
      startedAt: now,
      expiresAt: now + durationMs,
      consecutiveFailures,
    });

    getEventBus().emit('auth:cooldown', profileId, reason, durationMs);
  }

  /**
   * 프로필이 쿨다운 중인지 확인
   * 만료 시 엔트리 삭제 (consecutiveFailures도 리셋)
   */
  isInCooldown(profileId: string): boolean {
    const entry = this.cooldowns.get(profileId);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.cooldowns.delete(profileId);
      return false;
    }
    return true;
  }

  /** 잔여 쿨다운 시간 (ms) */
  getRemainingMs(profileId: string): number {
    const entry = this.cooldowns.get(profileId);
    if (!entry) return 0;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  /** 쿨다운 수동 해제 */
  clearCooldown(profileId: string): void {
    this.cooldowns.delete(profileId);
  }

  /** 만료된 쿨다운 일괄 정리 */
  pruneExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.cooldowns) {
      if (now >= entry.expiresAt) {
        this.cooldowns.delete(id);
      }
    }
  }
}
```

---

## T4. `packages/agent/src/auth/health.ts` — ProfileHealthMonitor

### 목적

슬라이딩 윈도우 내 성공/실패 비율로 프로필 건강 상태를 판정한다.

### 코드

```typescript
// packages/agent/src/auth/health.ts
import { getEventBus } from '@finclaw/infra';
import type { ManagedAuthProfile } from './profiles.js';

/** 프로필 건강 상태 */
export type ProfileHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'disabled';

/** 건강 판정 기준 */
export interface HealthThresholds {
  readonly maxConsecutiveFailures: number; // 기본: 3
  readonly degradedFailureRate: number; // 기본: 0.3 (30%)
  readonly unhealthyFailureRate: number; // 기본: 0.7 (70%)
  readonly windowSizeMs: number; // 기본: 300_000 (5분)
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  maxConsecutiveFailures: 3,
  degradedFailureRate: 0.3,
  unhealthyFailureRate: 0.7,
  windowSizeMs: 300_000,
};

/** 내부 기록 엔트리 */
interface HealthRecord {
  readonly success: boolean;
  readonly timestamp: number;
}

/** 프로필별 상태 */
interface ProfileState {
  records: HealthRecord[];
  consecutiveFailures: number;
  lastHealth: ProfileHealthStatus;
}

/**
 * 프로필 건강 모니터
 *
 * 알고리즘:
 * 1. 슬라이딩 윈도우 내 요청 기록 유지
 * 2. consecutiveFailures >= max → 'disabled'
 * 3. failureRate >= unhealthyRate → 'unhealthy'
 * 4. failureRate >= degradedRate → 'degraded'
 * 5. 그 외 → 'healthy'
 */
export class ProfileHealthMonitor {
  private readonly thresholds: HealthThresholds;
  private readonly states = new Map<string, ProfileState>();

  constructor(thresholds?: Partial<HealthThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** 요청 결과 기록 */
  recordResult(profileId: string, success: boolean): void {
    const state = this.getOrCreateState(profileId);
    const now = Date.now();

    state.records.push({ success, timestamp: now });
    state.consecutiveFailures = success ? 0 : state.consecutiveFailures + 1;

    // 윈도우 밖 기록 정리
    const cutoff = now - this.thresholds.windowSizeMs;
    state.records = state.records.filter((r) => r.timestamp >= cutoff);

    // 건강 상태 변경 감지
    const newHealth = this.computeHealth(state);
    if (newHealth !== state.lastHealth) {
      getEventBus().emit('auth:health:change', profileId, state.lastHealth, newHealth);
      state.lastHealth = newHealth;
    }
  }

  /** 현재 건강 상태 조회 */
  getHealth(profileId: string): ProfileHealthStatus {
    const state = this.states.get(profileId);
    if (!state) return 'healthy';

    // 윈도우 밖 기록 정리
    const cutoff = Date.now() - this.thresholds.windowSizeMs;
    state.records = state.records.filter((r) => r.timestamp >= cutoff);

    return this.computeHealth(state);
  }

  /** 건강한 프로필만 필터링 (disabled 제외) */
  filterHealthy(profiles: readonly ManagedAuthProfile[]): readonly ManagedAuthProfile[] {
    return profiles.filter((p) => this.getHealth(p.id) !== 'disabled');
  }

  /** 건강 상태 요약 */
  getSummary(): Map<string, ProfileHealthStatus> {
    const summary = new Map<string, ProfileHealthStatus>();
    for (const [id] of this.states) {
      summary.set(id, this.getHealth(id));
    }
    return summary;
  }

  private computeHealth(state: ProfileState): ProfileHealthStatus {
    // 연속 실패 → disabled (최우선)
    if (state.consecutiveFailures >= this.thresholds.maxConsecutiveFailures) {
      return 'disabled';
    }

    // 기록이 없으면 healthy
    if (state.records.length === 0) return 'healthy';

    // 실패율 계산
    const failCount = state.records.filter((r) => !r.success).length;
    const failureRate = failCount / state.records.length;

    if (failureRate >= this.thresholds.unhealthyFailureRate) return 'unhealthy';
    if (failureRate >= this.thresholds.degradedFailureRate) return 'degraded';
    return 'healthy';
  }

  private getOrCreateState(profileId: string): ProfileState {
    let state = this.states.get(profileId);
    if (!state) {
      state = { records: [], consecutiveFailures: 0, lastHealth: 'healthy' };
      this.states.set(profileId, state);
    }
    return state;
  }
}
```

> **주의**: `ManagedAuthProfile`은 `profiles.ts`에서 정의하지만, `health.ts`가 `profiles.ts`를 import하면
> 순환 의존이 생긴다 (`profiles.ts` → `health.ts` → `profiles.ts`).
> **해결**: `filterHealthy()`의 파라미터 타입을 `readonly { id: string }[]`로 축소하거나,
> `ManagedAuthProfile` 타입을 `import type`으로만 사용한다 (type-only import는 순환 안전).

---

## T5. `packages/agent/src/auth/profiles.ts` — InMemoryAuthProfileStore

### 목적

ManagedAuthProfile CRUD 저장소. 쿨다운/건강 상태를 통합한 라운드 로빈 선택 구현.

### 코드

```typescript
// packages/agent/src/auth/profiles.ts
import type { AuthProfile } from '@finclaw/types';
import type { ProviderId } from '../models/catalog.js';
import type { CooldownTracker } from './cooldown.js';
import type { ProfileHealthMonitor } from './health.js';

/**
 * CRUD 수명주기 필드가 추가된 관리형 인증 프로필.
 * @finclaw/types의 AuthProfile(provider, apiKey 등 기본 필드)을 확장.
 */
export interface ManagedAuthProfile extends AuthProfile {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly priority: number;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly failureCount: number;
  readonly cooldownUntil: Date | null;
}

/** 프로필 생성 입력 */
export interface CreateProfileInput {
  readonly name: string;
  readonly provider: ProviderId;
  readonly apiKey: string;
  readonly organizationId?: string;
  readonly baseUrl?: string;
  readonly priority?: number;
}

/** 프로필 CRUD 저장소 인터페이스 */
export interface AuthProfileStore {
  list(provider?: ProviderId): Promise<readonly ManagedAuthProfile[]>;
  get(id: string): Promise<ManagedAuthProfile | undefined>;
  create(input: CreateProfileInput): Promise<ManagedAuthProfile>;
  update(
    id: string,
    patch: Partial<Pick<ManagedAuthProfile, 'name' | 'isActive' | 'priority' | 'apiKey'>>,
  ): Promise<ManagedAuthProfile>;
  delete(id: string): Promise<boolean>;
  selectNext(provider: ProviderId): Promise<ManagedAuthProfile | undefined>;
  recordUsage(id: string, success: boolean): Promise<void>;
}

/** 인메모리 프로필 저장소 */
export class InMemoryAuthProfileStore implements AuthProfileStore {
  private readonly profiles = new Map<string, ManagedAuthProfile>();
  private nextId = 1;

  constructor(
    private readonly cooldownTracker: CooldownTracker,
    private readonly healthMonitor: ProfileHealthMonitor,
  ) {}

  async list(provider?: ProviderId): Promise<readonly ManagedAuthProfile[]> {
    const all = [...this.profiles.values()];
    if (!provider) return all;
    return all.filter((p) => p.provider === provider);
  }

  async get(id: string): Promise<ManagedAuthProfile | undefined> {
    return this.profiles.get(id);
  }

  async create(input: CreateProfileInput): Promise<ManagedAuthProfile> {
    const id = `profile-${this.nextId++}`;
    const profile: ManagedAuthProfile = {
      id,
      name: input.name,
      provider: input.provider,
      apiKey: input.apiKey,
      organizationId: input.organizationId,
      baseUrl: input.baseUrl,
      isActive: true,
      priority: input.priority ?? 0,
      createdAt: new Date(),
      lastUsedAt: null,
      failureCount: 0,
      cooldownUntil: null,
    };
    this.profiles.set(id, profile);
    return profile;
  }

  async update(
    id: string,
    patch: Partial<Pick<ManagedAuthProfile, 'name' | 'isActive' | 'priority' | 'apiKey'>>,
  ): Promise<ManagedAuthProfile> {
    const existing = this.profiles.get(id);
    if (!existing) throw new Error(`Profile not found: ${id}`);
    const updated = { ...existing, ...patch } as ManagedAuthProfile;
    this.profiles.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.profiles.delete(id);
  }

  /**
   * 라운드 로빈 프로필 선택
   *
   * 1. provider 필터
   * 2. isActive === true
   * 3. 쿨다운 중이 아닌 프로필
   * 4. 건강 상태가 'disabled'가 아닌 프로필
   * 5. priority 내림차순, lastUsedAt 오름차순 정렬
   * 6. 첫 번째 프로필 선택 + lastUsedAt 업데이트
   */
  async selectNext(provider: ProviderId): Promise<ManagedAuthProfile | undefined> {
    const profiles = await this.list(provider);

    const available = profiles.filter(
      (p) =>
        p.isActive &&
        !this.cooldownTracker.isInCooldown(p.id) &&
        this.healthMonitor.getHealth(p.id) !== 'disabled',
    );

    if (available.length === 0) return undefined;

    const sorted = [...available].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const aTime = a.lastUsedAt?.getTime() ?? 0;
      const bTime = b.lastUsedAt?.getTime() ?? 0;
      return aTime - bTime;
    });

    const selected = sorted[0];
    // lastUsedAt 업데이트
    this.profiles.set(selected.id, { ...selected, lastUsedAt: new Date() });
    return selected;
  }

  /** 사용 결과 기록 */
  async recordUsage(id: string, success: boolean): Promise<void> {
    const profile = this.profiles.get(id);
    if (!profile) return;

    this.healthMonitor.recordResult(id, success);

    if (success) {
      this.profiles.set(id, { ...profile, failureCount: 0, lastUsedAt: new Date() });
    } else {
      this.profiles.set(id, {
        ...profile,
        failureCount: profile.failureCount + 1,
        lastUsedAt: new Date(),
      });
    }
  }
}
```

---

## T6. `packages/agent/src/auth/resolver.ts` — resolveApiKeyForProvider()

### 목적

6단계 API 키 해석 체인. 프로필 → 환경변수 → 설정 → (AWS) → 기본값 → 에러.

### 코드

```typescript
// packages/agent/src/auth/resolver.ts
import { createLogger, getEventBus } from '@finclaw/infra';
import type { ProviderId } from '../models/catalog.js';
import { maskApiKey } from '../errors.js';
import type { AuthProfileStore } from './profiles.js';

const log = createLogger({ name: 'AuthResolver' });

/** 해석 결과 */
export interface ResolvedApiKey {
  readonly apiKey: string;
  readonly source: ApiKeySource;
  readonly profileId?: string;
}

/** API 키 출처 */
export type ApiKeySource = 'profile' | 'environment' | 'config' | 'aws-secrets' | 'default';

/** 해석 옵션 — config 부분은 필요한 필드만 */
export interface AgentResolverConfig {
  readonly providers?: Record<string, { apiKey?: string }>;
  readonly allowDefaultKeys?: boolean;
  readonly defaultKeys?: Record<string, string>;
}

export interface ResolverOptions {
  readonly profileStore: AuthProfileStore;
  readonly env: Record<string, string | undefined>;
  readonly config: AgentResolverConfig;
}

/** 제공자별 환경변수 이름 매핑 */
const ENV_KEY_MAP: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/**
 * 6단계 API 키 해석 체인
 *
 * 1. ManagedAuthProfile 저장소 (라운드 로빈)
 * 2. 환경변수 (ANTHROPIC_API_KEY, OPENAI_API_KEY)
 * 3. 설정 파일 (config.providers.{provider}.apiKey)
 * 4. AWS Secrets Manager (향후 확장 — TODO)
 * 5. 기본값 (개발용, allowDefaultKeys=true일 때만)
 * 6. 에러
 */
export async function resolveApiKeyForProvider(
  provider: ProviderId,
  options: ResolverOptions,
): Promise<ResolvedApiKey> {
  const bus = getEventBus();

  // Step 1: 프로필 저장소 (라운드 로빈)
  const profile = await options.profileStore.selectNext(provider);
  if (profile) {
    log.info(`Resolved API key for ${provider}: ${maskApiKey(profile.apiKey)} (source: profile)`);
    bus.emit('auth:resolve', provider, 'profile');
    return { apiKey: profile.apiKey, source: 'profile', profileId: profile.id };
  }

  // Step 2: 환경변수
  const envKey = ENV_KEY_MAP[provider];
  const envValue = options.env[envKey];
  if (envValue) {
    log.info(`Resolved API key for ${provider}: ${maskApiKey(envValue)} (source: environment)`);
    bus.emit('auth:resolve', provider, 'environment');
    return { apiKey: envValue, source: 'environment' };
  }

  // Step 3: 설정 파일
  const configKey = options.config.providers?.[provider]?.apiKey;
  if (configKey) {
    log.info(`Resolved API key for ${provider}: ${maskApiKey(configKey)} (source: config)`);
    bus.emit('auth:resolve', provider, 'config');
    return { apiKey: configKey, source: 'config' };
  }

  // Step 4: AWS Secrets Manager (향후 확장)
  // TODO: 구현하지 않음 — Phase 6 과잉 방지 체크리스트 참고

  // Step 5: 기본값 (개발용)
  if (options.config.allowDefaultKeys && options.config.defaultKeys?.[provider]) {
    const defaultKey = options.config.defaultKeys[provider];
    log.info(`Resolved API key for ${provider}: ${maskApiKey(defaultKey)} (source: default)`);
    bus.emit('auth:resolve', provider, 'default');
    return { apiKey: defaultKey, source: 'default' };
  }

  // Step 6: 에러
  throw new Error(
    `No API key found for provider "${provider}". ` +
      `Set ${envKey} env var, add an auth profile, or configure in settings.`,
  );
}
```

---

## T7. `packages/agent/src/models/fallback.ts` — runWithModelFallback()

### 목적

L1(모델 선택) + L2(인증)를 통합하는 폴백 체인 실행기.

### 코드

```typescript
// packages/agent/src/models/fallback.ts
import { sleepWithAbort, computeBackoff, getEventBus } from '@finclaw/infra';
import { classifyFallbackError } from '../errors.js';
import { getBreakerForProvider } from '../providers/adapter.js';
import type { ResolvedModel } from './selection.js';

/** 해석 전 모델 참조 */
export interface UnresolvedModelRef {
  readonly raw: string;
}

/** 폴백 트리거 사유 */
export type FallbackTrigger =
  | 'rate-limit'
  | 'server-error'
  | 'timeout'
  | 'context-overflow'
  | 'model-unavailable';

/** 폴백 체인 설정 */
export interface FallbackConfig {
  /** 시도할 모델 목록 (우선순위 순) */
  readonly models: readonly UnresolvedModelRef[];
  /** 모델별 최대 재시도 횟수 */
  readonly maxRetriesPerModel: number;
  /** 재시도 기본 간격 (ms) */
  readonly retryBaseDelayMs: number;
  /** 폴백 사유 필터 */
  readonly fallbackOn: readonly FallbackTrigger[];
  /** 취소 시그널 */
  readonly abortSignal?: AbortSignal;
}

/** 폴백 실행 결과 */
export interface FallbackResult<T> {
  readonly result: T;
  readonly modelUsed: ResolvedModel;
  readonly attempts: readonly FallbackAttempt[];
}

/** 개별 시도 기록 */
export interface FallbackAttempt {
  readonly model: ResolvedModel;
  readonly success: boolean;
  readonly error?: Error;
  readonly durationMs: number;
}

/**
 * 기본 fallbackOn (context-overflow 의도적 미포함):
 * 더 작은 컨텍스트 윈도우 모델로 폴백하면 동일 에러 반복.
 */
export const DEFAULT_FALLBACK_TRIGGERS: readonly FallbackTrigger[] = [
  'rate-limit',
  'server-error',
  'timeout',
  'model-unavailable',
];

/**
 * 폴백 체인 실행
 *
 * 1. models 순회, 각 모델마다 CircuitBreaker 확인
 * 2. maxRetriesPerModel만큼 재시도
 * 3. 실패 시 classifyFallbackError로 분류 → fallbackOn 해당 시 다음 모델
 * 4. AbortError는 즉시 rethrow
 * 5. 모든 모델 소진 시 AggregateError throw
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

        // AbortError: 사용자 취소 → 즉시 전파
        if (err.name === 'AbortError') throw err;

        attempts.push({
          model: resolved,
          success: false,
          error: err,
          durationMs: performance.now() - startTime,
        });

        // 폴백 트리거 해당 여부 확인
        const trigger = classifyFallbackError(err);
        if (!trigger || !config.fallbackOn.includes(trigger)) {
          throw err; // 폴백 대상이 아닌 에러 → 즉시 throw
        }

        bus.emit('model:fallback', resolved.modelId, modelRef.raw, trigger);

        // 동일 모델 재시도 전 대기
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

---

## T8. `packages/agent/src/index.ts` — 완전한 배럴 export

### 목적

Part 1 배럴에 auth + fallback export를 추가하여 완성한다.

### 코드

```typescript
// @finclaw/agent — complete barrel export

// ─── errors ───
export { FailoverError, classifyFallbackError, maskApiKey } from './errors.js';
export type { FallbackReason } from './errors.js';

// ─── models: catalog ───
export { InMemoryModelCatalog } from './models/catalog.js';
export type {
  ProviderId,
  ModelCapabilities,
  ModelPricing,
  ModelEntry,
  ModelCatalog,
} from './models/catalog.js';

// ─── models: catalog data ───
export { BUILT_IN_MODELS, DEFAULT_FALLBACK_CHAIN } from './models/catalog-data.js';

// ─── models: alias index ───
export { buildModelAliasIndex } from './models/alias-index.js';
export type { AliasIndex } from './models/alias-index.js';

// ─── models: selection ───
export { resolveModel } from './models/selection.js';
export type { UnresolvedModelRef, ResolvedModel } from './models/selection.js';

// ─── models: provider normalize ───
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

// ─── models: fallback ───
export { runWithModelFallback, DEFAULT_FALLBACK_TRIGGERS } from './models/fallback.js';
export type {
  FallbackConfig,
  FallbackTrigger,
  FallbackResult,
  FallbackAttempt,
} from './models/fallback.js';

// ─── providers ───
export {
  createProviderAdapter,
  getBreakerForProvider,
  resetBreakers,
} from './providers/adapter.js';
export type { ProviderAdapter, ProviderRequestParams } from './providers/adapter.js';
export { AnthropicAdapter } from './providers/anthropic.js';
export { OpenAIAdapter } from './providers/openai.js';

// ─── auth: cooldown ───
export { CooldownTracker } from './auth/cooldown.js';
export type { CooldownEntry } from './auth/cooldown.js';

// ─── auth: health ───
export { ProfileHealthMonitor } from './auth/health.js';
export type { ProfileHealthStatus, HealthThresholds } from './auth/health.js';

// ─── auth: profiles ───
export { InMemoryAuthProfileStore } from './auth/profiles.js';
export type { ManagedAuthProfile, AuthProfileStore, CreateProfileInput } from './auth/profiles.js';

// ─── auth: resolver ───
export { resolveApiKeyForProvider } from './auth/resolver.js';
export type {
  ResolverOptions,
  ResolvedApiKey,
  ApiKeySource,
  AgentResolverConfig,
} from './auth/resolver.js';
```

---

## T9. `packages/agent/test/cooldown.test.ts`

### 테스트 케이스

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CooldownTracker } from '../src/auth/cooldown.js';
import { resetEventBus } from '@finclaw/infra';

describe('CooldownTracker', () => {
  let tracker: CooldownTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new CooldownTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
  });

  it('setCooldown 후 isInCooldown = true', () => {
    tracker.setCooldown('p1');
    expect(tracker.isInCooldown('p1')).toBe(true);
  });

  it('DEFAULT_COOLDOWN_MS 경과 후 쿨다운 만료', () => {
    tracker.setCooldown('p1');
    expect(tracker.isInCooldown('p1')).toBe(true);

    vi.advanceTimersByTime(CooldownTracker.DEFAULT_COOLDOWN_MS);
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('billing 사유 → 24시간 쿨다운', () => {
    tracker.setCooldown('p1', 'billing');
    vi.advanceTimersByTime(86_400_000 - 1);
    expect(tracker.isInCooldown('p1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('server-error 사유 → 5분 쿨다운', () => {
    tracker.setCooldown('p1', 'server-error');
    vi.advanceTimersByTime(300_000 - 1);
    expect(tracker.isInCooldown('p1')).toBe(true);

    vi.advanceTimersByTime(1);
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('retryAfterMs 우선 적용', () => {
    tracker.setCooldown('p1', 'rate-limit', 5_000);
    vi.advanceTimersByTime(5_000);
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('연속 실패 시 지수 백오프', () => {
    // 첫 실패: 60s
    tracker.setCooldown('p1', 'rate-limit');
    const remaining1 = tracker.getRemainingMs('p1');
    expect(remaining1).toBeLessThanOrEqual(60_000);

    vi.advanceTimersByTime(60_000);

    // 두 번째 실패: 120s (60 * 2^1)
    tracker.setCooldown('p1', 'rate-limit');
    const remaining2 = tracker.getRemainingMs('p1');
    expect(remaining2).toBeGreaterThan(60_000);
    expect(remaining2).toBeLessThanOrEqual(120_000);
  });

  it('쿨다운 만료 시 consecutiveFailures 리셋', () => {
    tracker.setCooldown('p1', 'rate-limit');
    vi.advanceTimersByTime(CooldownTracker.DEFAULT_COOLDOWN_MS);
    expect(tracker.isInCooldown('p1')).toBe(false);

    // 리셋 후 다시 쿨다운 → 초기 시간(지수 백오프 없이)
    tracker.setCooldown('p1', 'rate-limit');
    const remaining = tracker.getRemainingMs('p1');
    expect(remaining).toBeLessThanOrEqual(60_000);
  });

  it('clearCooldown 수동 해제', () => {
    tracker.setCooldown('p1');
    tracker.clearCooldown('p1');
    expect(tracker.isInCooldown('p1')).toBe(false);
  });

  it('pruneExpired 만료된 엔트리 정리', () => {
    tracker.setCooldown('p1');
    tracker.setCooldown('p2');
    vi.advanceTimersByTime(CooldownTracker.DEFAULT_COOLDOWN_MS);
    tracker.pruneExpired();
    expect(tracker.isInCooldown('p1')).toBe(false);
    expect(tracker.isInCooldown('p2')).toBe(false);
  });

  it('getRemainingMs 정확도', () => {
    tracker.setCooldown('p1');
    vi.advanceTimersByTime(30_000);
    const remaining = tracker.getRemainingMs('p1');
    expect(remaining).toBeCloseTo(30_000, -2); // ±100ms
  });

  it('쿨다운 중이 아닌 프로필 → getRemainingMs = 0', () => {
    expect(tracker.getRemainingMs('nonexistent')).toBe(0);
  });
});
```

---

## T10. `packages/agent/test/health.test.ts`

### 테스트 케이스

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProfileHealthMonitor } from '../src/auth/health.js';
import { resetEventBus } from '@finclaw/infra';

describe('ProfileHealthMonitor', () => {
  let monitor: ProfileHealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new ProfileHealthMonitor();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
  });

  it('기록이 없으면 healthy', () => {
    expect(monitor.getHealth('p1')).toBe('healthy');
  });

  it('연속 성공 → healthy 유지', () => {
    for (let i = 0; i < 5; i++) {
      monitor.recordResult('p1', true);
    }
    expect(monitor.getHealth('p1')).toBe('healthy');
  });

  it('실패율 30%+ → degraded', () => {
    // 10번 중 4번 실패 = 40%
    for (let i = 0; i < 6; i++) monitor.recordResult('p1', true);
    for (let i = 0; i < 4; i++) monitor.recordResult('p1', false);
    expect(monitor.getHealth('p1')).toBe('degraded');
  });

  it('실패율 70%+ → unhealthy', () => {
    // 10번 중 8번 실패 = 80%
    for (let i = 0; i < 2; i++) monitor.recordResult('p1', true);
    for (let i = 0; i < 8; i++) monitor.recordResult('p1', false);
    expect(monitor.getHealth('p1')).toBe('unhealthy');
  });

  it('연속 실패 3회 → disabled', () => {
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    expect(monitor.getHealth('p1')).toBe('disabled');
  });

  it('성공으로 연속 실패 카운터 리셋', () => {
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', true); // 리셋
    monitor.recordResult('p1', false);
    // consecutiveFailures = 1 (3 미만) → disabled 아님
    expect(monitor.getHealth('p1')).not.toBe('disabled');
  });

  it('윈도우 밖 기록은 무시', () => {
    // 과거에 실패 다수
    for (let i = 0; i < 10; i++) monitor.recordResult('p1', false);

    // 5분 경과 → 윈도우 밖
    vi.advanceTimersByTime(300_001);

    // 새로운 성공 기록
    monitor.recordResult('p1', true);
    // 윈도우 내 기록: 성공 1개 → healthy
    // (단, consecutiveFailures가 리셋되지 않았을 수 있으므로 recordResult(true)에서 리셋됨)
    expect(monitor.getHealth('p1')).toBe('healthy');
  });

  it('filterHealthy: disabled 프로필 제외', () => {
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false);
    monitor.recordResult('p1', false); // disabled

    const profiles = [{ id: 'p1' } as any, { id: 'p2' } as any];
    const healthy = monitor.filterHealthy(profiles);
    expect(healthy).toHaveLength(1);
    expect(healthy[0].id).toBe('p2');
  });

  it('getSummary: 모든 추적 프로필의 상태 반환', () => {
    monitor.recordResult('p1', true);
    monitor.recordResult('p2', false);
    monitor.recordResult('p2', false);
    monitor.recordResult('p2', false);

    const summary = monitor.getSummary();
    expect(summary.get('p1')).toBe('healthy');
    expect(summary.get('p2')).toBe('disabled');
  });

  it('커스텀 thresholds 적용', () => {
    const custom = new ProfileHealthMonitor({ maxConsecutiveFailures: 5 });
    for (let i = 0; i < 4; i++) custom.recordResult('p1', false);
    expect(custom.getHealth('p1')).not.toBe('disabled');

    custom.recordResult('p1', false); // 5번째
    expect(custom.getHealth('p1')).toBe('disabled');
  });
});
```

---

## T11. `packages/agent/test/resolver.test.ts`

### 테스트 케이스

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveApiKeyForProvider } from '../src/auth/resolver.js';
import { InMemoryAuthProfileStore } from '../src/auth/profiles.js';
import { CooldownTracker } from '../src/auth/cooldown.js';
import { ProfileHealthMonitor } from '../src/auth/health.js';
import { resetEventBus } from '@finclaw/infra';
import type { ResolverOptions } from '../src/auth/resolver.js';

describe('resolveApiKeyForProvider', () => {
  let store: InMemoryAuthProfileStore;
  let cooldown: CooldownTracker;
  let health: ProfileHealthMonitor;

  beforeEach(() => {
    cooldown = new CooldownTracker();
    health = new ProfileHealthMonitor();
    store = new InMemoryAuthProfileStore(cooldown, health);
  });

  afterEach(() => {
    resetEventBus();
  });

  function makeOptions(overrides?: Partial<ResolverOptions>): ResolverOptions {
    return {
      profileStore: store,
      env: {},
      config: {},
      ...overrides,
    };
  }

  it('Step 1: 프로필 저장소에서 해석', async () => {
    await store.create({ name: 'test', provider: 'anthropic', apiKey: 'sk-profile-key' });
    const result = await resolveApiKeyForProvider('anthropic', makeOptions());
    expect(result.source).toBe('profile');
    expect(result.apiKey).toBe('sk-profile-key');
    expect(result.profileId).toBeDefined();
  });

  it('Step 2: 환경변수에서 해석', async () => {
    const result = await resolveApiKeyForProvider(
      'anthropic',
      makeOptions({
        env: { ANTHROPIC_API_KEY: 'sk-env-key' },
      }),
    );
    expect(result.source).toBe('environment');
    expect(result.apiKey).toBe('sk-env-key');
  });

  it('Step 2: OpenAI 환경변수 매핑', async () => {
    const result = await resolveApiKeyForProvider(
      'openai',
      makeOptions({
        env: { OPENAI_API_KEY: 'sk-openai-env' },
      }),
    );
    expect(result.source).toBe('environment');
    expect(result.apiKey).toBe('sk-openai-env');
  });

  it('Step 3: 설정 파일에서 해석', async () => {
    const result = await resolveApiKeyForProvider(
      'anthropic',
      makeOptions({
        config: { providers: { anthropic: { apiKey: 'sk-config-key' } } },
      }),
    );
    expect(result.source).toBe('config');
    expect(result.apiKey).toBe('sk-config-key');
  });

  it('Step 5: 기본값 (allowDefaultKeys=true)', async () => {
    const result = await resolveApiKeyForProvider(
      'anthropic',
      makeOptions({
        config: {
          allowDefaultKeys: true,
          defaultKeys: { anthropic: 'sk-default' },
        },
      }),
    );
    expect(result.source).toBe('default');
    expect(result.apiKey).toBe('sk-default');
  });

  it('Step 5: allowDefaultKeys=false면 기본값 스킵', async () => {
    await expect(
      resolveApiKeyForProvider(
        'anthropic',
        makeOptions({
          config: {
            allowDefaultKeys: false,
            defaultKeys: { anthropic: 'sk-default' },
          },
        }),
      ),
    ).rejects.toThrow('No API key found');
  });

  it('Step 6: 아무것도 없으면 에러', async () => {
    await expect(resolveApiKeyForProvider('anthropic', makeOptions())).rejects.toThrow(
      'No API key found for provider "anthropic"',
    );
  });

  it('우선순위: profile > env > config', async () => {
    await store.create({ name: 'test', provider: 'anthropic', apiKey: 'sk-profile' });
    const result = await resolveApiKeyForProvider(
      'anthropic',
      makeOptions({
        env: { ANTHROPIC_API_KEY: 'sk-env' },
        config: { providers: { anthropic: { apiKey: 'sk-config' } } },
      }),
    );
    expect(result.source).toBe('profile');
    expect(result.apiKey).toBe('sk-profile');
  });

  it('프로필 없으면 env로 폴백', async () => {
    const result = await resolveApiKeyForProvider(
      'anthropic',
      makeOptions({
        env: { ANTHROPIC_API_KEY: 'sk-env' },
        config: { providers: { anthropic: { apiKey: 'sk-config' } } },
      }),
    );
    expect(result.source).toBe('environment');
  });

  it('라운드 로빈: 연속 호출 시 다른 프로필 반환', async () => {
    await store.create({ name: 'a', provider: 'anthropic', apiKey: 'key-a' });
    await store.create({ name: 'b', provider: 'anthropic', apiKey: 'key-b' });

    const r1 = await resolveApiKeyForProvider('anthropic', makeOptions());
    const r2 = await resolveApiKeyForProvider('anthropic', makeOptions());

    // selectNext가 lastUsedAt 기반 라운드 로빈이므로 다른 프로필 선택
    expect(r1.profileId).not.toBe(r2.profileId);
  });
});
```

---

## T12. `packages/agent/test/fallback.test.ts`

### 테스트 케이스

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithModelFallback, DEFAULT_FALLBACK_TRIGGERS } from '../src/models/fallback.js';
import type { FallbackConfig } from '../src/models/fallback.js';
import type { ResolvedModel } from '../src/models/selection.js';
import { FailoverError } from '../src/errors.js';
import { resetEventBus, resetBreakers } from '../src/index.js';

// 모킹 helpers
function makeResolved(id: string, provider: 'anthropic' | 'openai' = 'anthropic'): ResolvedModel {
  return {
    entry: { id, provider } as any,
    provider,
    modelId: id,
    resolvedFrom: 'id',
  };
}

function makeConfig(overrides?: Partial<FallbackConfig>): FallbackConfig {
  return {
    models: [{ raw: 'model-a' }, { raw: 'model-b' }],
    maxRetriesPerModel: 1,
    retryBaseDelayMs: 10,
    fallbackOn: [...DEFAULT_FALLBACK_TRIGGERS],
    ...overrides,
  };
}

describe('runWithModelFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetEventBus();
    // resetBreakers(); // Part 1에서 export됨
  });

  const resolveMap: Record<string, ResolvedModel> = {
    'model-a': makeResolved('model-a'),
    'model-b': makeResolved('model-b', 'openai'),
  };
  const resolve = (ref: { raw: string }) => resolveMap[ref.raw];

  it('첫 모델 성공 → 폴백 없이 반환', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await runWithModelFallback(makeConfig(), fn, resolve);
    expect(result.result).toBe('success');
    expect(result.modelUsed.modelId).toBe('model-a');
    expect(result.attempts).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('첫 모델 rate-limit → 두 번째 모델로 폴백', async () => {
    const rateLimitErr = new FailoverError('rate limited', 'rate-limit', { statusCode: 429 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitErr)
      .mockRejectedValueOnce(rateLimitErr) // retry
      .mockResolvedValueOnce('fallback-success');

    const promise = runWithModelFallback(makeConfig(), fn, resolve);
    // sleepWithAbort 대기 처리
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.result).toBe('fallback-success');
    expect(result.modelUsed.modelId).toBe('model-b');
    expect(result.attempts.length).toBeGreaterThan(1);
  });

  it('모든 모델 소진 → AggregateError', async () => {
    const err = new FailoverError('server error', 'server-error', { statusCode: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    const promise = runWithModelFallback(makeConfig(), fn, resolve);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).rejects.toThrow(AggregateError);
  });

  it('비폴백 에러 (401) → 즉시 throw', async () => {
    const authErr = Object.assign(new Error('unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(authErr);

    await expect(runWithModelFallback(makeConfig(), fn, resolve)).rejects.toThrow('unauthorized');
    expect(fn).toHaveBeenCalledTimes(1); // 재시도 없음
  });

  it('AbortError → 즉시 throw', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fn = vi.fn().mockRejectedValue(abortErr);

    await expect(runWithModelFallback(makeConfig(), fn, resolve)).rejects.toThrow('aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('context-overflow는 기본 fallbackOn에 없음 → 즉시 throw', async () => {
    const ctxErr = new FailoverError('context', 'context-overflow');
    const fn = vi.fn().mockRejectedValue(ctxErr);

    await expect(runWithModelFallback(makeConfig(), fn, resolve)).rejects.toThrow('context');
  });

  it('context-overflow를 fallbackOn에 명시 → 폴백 트리거', async () => {
    const ctxErr = new FailoverError('context', 'context-overflow');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(ctxErr)
      .mockRejectedValueOnce(ctxErr)
      .mockResolvedValueOnce('ok');

    const config = makeConfig({
      fallbackOn: [...DEFAULT_FALLBACK_TRIGGERS, 'context-overflow'],
    });

    const promise = runWithModelFallback(config, fn, resolve);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.result).toBe('ok');
  });

  it('maxRetriesPerModel=0이면 재시도 없이 바로 다음 모델', async () => {
    const err = new FailoverError('rate limit', 'rate-limit');
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('second');

    const result = await runWithModelFallback(makeConfig({ maxRetriesPerModel: 0 }), fn, resolve);
    expect(result.modelUsed.modelId).toBe('model-b');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

---

## T13. Part 2 최종 검증

```bash
# 1. 타입 체크
pnpm typecheck

# 2. 빌드
pnpm build

# 3. agent 패키지 전체 테스트 (Part 1 + Part 2)
pnpm test -- packages/agent

# 4. config 패키지 테스트 (스키마 변경 확인)
pnpm test -- packages/config

# 5. 린트
pnpm lint

# 6. 포맷
pnpm format:fix
```

### 성공 기준

- [ ] `pnpm typecheck` 에러 없음
- [ ] `pnpm build` 성공
- [ ] agent 테스트 8종 모두 통과 (Part 1: 4 + Part 2: 4)
- [ ] config 테스트 기존 통과 (스키마 변경이 breaking 아님 확인)
- [ ] `pnpm lint` 에러 없음
- [ ] `packages/agent/src/` 에 15개 소스 파일 존재
- [ ] `packages/agent/test/` 에 7+1(normalize) = 8개 테스트 파일 존재
- [ ] `@finclaw/agent`에서 모든 public API import 가능
- [ ] 순환 의존성 없음

---

## 파일 체크리스트

| #   | 파일                                    | 상태                      |
| --- | --------------------------------------- | ------------------------- |
| 1   | `packages/infra/src/events.ts`          | 수정 (auth 이벤트 3종)    |
| 2   | `packages/types/src/config.ts`          | 수정 (ModelsConfig 확장)  |
| 3   | `packages/config/src/zod-schema.ts`     | 수정 (models 스키마 확장) |
| 4   | `packages/agent/src/auth/cooldown.ts`   | 신규                      |
| 5   | `packages/agent/src/auth/health.ts`     | 신규                      |
| 6   | `packages/agent/src/auth/profiles.ts`   | 신규                      |
| 7   | `packages/agent/src/auth/resolver.ts`   | 신규                      |
| 8   | `packages/agent/src/models/fallback.ts` | 신규                      |
| 9   | `packages/agent/src/index.ts`           | 수정 (배럴 완성)          |
| 10  | `packages/agent/test/cooldown.test.ts`  | 신규                      |
| 11  | `packages/agent/test/health.test.ts`    | 신규                      |
| 12  | `packages/agent/test/resolver.test.ts`  | 신규                      |
| 13  | `packages/agent/test/fallback.test.ts`  | 신규                      |

---

## Phase 6 전체 완료 후 최종 체크

```
packages/agent/src/
├── index.ts                          ✓ 완전한 배럴
├── errors.ts                         ✓ FailoverError + classifyFallbackError
├── models/
│   ├── catalog.ts                    ✓ 타입 + InMemoryModelCatalog
│   ├── catalog-data.ts               ✓ BUILT_IN_MODELS 6종
│   ├── selection.ts                  ✓ resolveModel()
│   ├── alias-index.ts                ✓ buildModelAliasIndex()
│   ├── fallback.ts                   ✓ runWithModelFallback()
│   └── provider-normalize.ts         ✓ 정규화 함수 2종
├── auth/
│   ├── profiles.ts                   ✓ InMemoryAuthProfileStore
│   ├── resolver.ts                   ✓ resolveApiKeyForProvider()
│   ├── cooldown.ts                   ✓ CooldownTracker
│   └── health.ts                     ✓ ProfileHealthMonitor
└── providers/
    ├── adapter.ts                    ✓ ProviderAdapter + CircuitBreaker
    ├── anthropic.ts                  ✓ Anthropic SDK 어댑터
    └── openai.ts                     ✓ OpenAI SDK 어댑터

packages/agent/test/
├── errors.test.ts                    ✓
├── catalog.test.ts                   ✓
├── selection.test.ts                 ✓
├── normalize.test.ts                 ✓
├── cooldown.test.ts                  ✓
├── health.test.ts                    ✓
├── resolver.test.ts                  ✓
└── fallback.test.ts                  ✓
```

소스 15 + 테스트 8 = **23 파일** (plan의 22 + normalize.test.ts 1 추가)
