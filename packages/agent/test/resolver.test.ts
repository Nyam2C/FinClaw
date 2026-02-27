import { resetEventBus } from '@finclaw/infra';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ResolverOptions } from '../src/auth/resolver.js';
import { CooldownTracker } from '../src/auth/cooldown.js';
import { ProfileHealthMonitor } from '../src/auth/health.js';
import { InMemoryAuthProfileStore } from '../src/auth/profiles.js';
import { resolveApiKeyForProvider } from '../src/auth/resolver.js';

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
