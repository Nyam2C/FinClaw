// packages/config/src/defaults.ts
import type { FinClawConfig } from '@finclaw/types';
import { mergeConfig } from './merge-config.js';

/**
 * 7단계 불변 기본값
 *
 * 모든 optional 필드에 합리적인 기본값을 제공한다.
 * Zod .default()를 쓰지 않는 이유: 파이프라인에서 명시적 단계로 분리.
 */
const DEFAULTS = Object.freeze({
  gateway: {
    port: 3000,
    host: '127.0.0.1',
    tls: false,
    corsOrigins: [] as string[],
  },
  agents: {
    defaults: {
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      maxConcurrent: 2,
      maxTokens: 4096,
      temperature: 0.7,
    },
    entries: {},
  },
  channels: {
    cli: { enabled: true },
    web: { enabled: false, port: 3001 },
  },
  session: {
    mainKey: 'default',
    resetPolicy: 'idle' as const,
    idleTimeoutMs: 1_800_000, // 30분
  },
  logging: {
    level: 'info' as const,
    file: false,
    redactSensitive: true,
  },
  models: {
    definitions: {},
    aliases: {},
  },
  plugins: {
    enabled: [] as string[],
    disabled: [] as string[],
  },
}) satisfies FinClawConfig;

/** 기본값을 유저 설정에 병합 (유저 값 우선) */
export function applyDefaults(userConfig: FinClawConfig): FinClawConfig {
  return mergeConfig(
    DEFAULTS as unknown as Record<string, unknown>,
    userConfig as unknown as Record<string, unknown>,
  ) as unknown as FinClawConfig;
}

/** 기본값 조회 (읽기 전용) */
export function getDefaults(): Readonly<FinClawConfig> {
  return DEFAULTS;
}
