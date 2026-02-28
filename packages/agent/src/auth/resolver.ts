// packages/agent/src/auth/resolver.ts
import { createLogger, getEventBus } from '@finclaw/infra';
import type { ProviderId } from '../models/catalog.js';
import type { AuthProfileStore } from './profiles.js';
import { maskApiKey } from '../errors.js';

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
    log.debug(`Resolved API key for ${provider}: ${maskApiKey(profile.apiKey)} (source: profile)`);
    bus.emit('auth:resolve', provider, 'profile');
    return { apiKey: profile.apiKey, source: 'profile', profileId: profile.id };
  }

  // Step 2: 환경변수
  const envKey = ENV_KEY_MAP[provider];
  const envValue = options.env[envKey];
  if (envValue) {
    log.debug(`Resolved API key for ${provider}: ${maskApiKey(envValue)} (source: environment)`);
    bus.emit('auth:resolve', provider, 'environment');
    return { apiKey: envValue, source: 'environment' };
  }

  // Step 3: 설정 파일
  const configKey = options.config.providers?.[provider]?.apiKey;
  if (configKey) {
    log.debug(`Resolved API key for ${provider}: ${maskApiKey(configKey)} (source: config)`);
    bus.emit('auth:resolve', provider, 'config');
    return { apiKey: configKey, source: 'config' };
  }

  // Step 4: AWS Secrets Manager (향후 확장)
  // TODO: 구현하지 않음 — Phase 6 과잉 방지 체크리스트 참고

  // Step 5: 기본값 (개발용)
  if (options.config.allowDefaultKeys && options.config.defaultKeys?.[provider]) {
    const defaultKey = options.config.defaultKeys[provider];
    log.debug(`Resolved API key for ${provider}: ${maskApiKey(defaultKey)} (source: default)`);
    bus.emit('auth:resolve', provider, 'default');
    return { apiKey: defaultKey, source: 'default' };
  }

  // Step 6: 에러
  throw new Error(
    `No API key found for provider "${provider}". ` +
      `Set ${envKey} env var, add an auth profile, or configure in settings.`,
  );
}
