// packages/infra/src/env.ts
const FINCLAW_PREFIX = 'FINCLAW_';

/**
 * 환경 변수 조회
 *
 * FINCLAW_ 접두사를 우선 검색하고, 없으면 접두사 없는 키를 검색.
 */
export function getEnv(key: string, fallback?: string): string | undefined {
  return process.env[`${FINCLAW_PREFIX}${key}`] ?? process.env[key] ?? fallback;
}
