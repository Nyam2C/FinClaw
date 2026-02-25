// packages/infra/src/env.ts
const FINCLAW_PREFIX = 'FINCLAW_';

/** FINCLAW_ 접두사 환경 변수의 빈 문자열을 undefined로 정규화 */
export function normalizeEnv(): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(FINCLAW_PREFIX)) {
      continue;
    }

    // 빈 문자열 → undefined 정규화
    if (value === '') {
      delete process.env[key];
    }
  }
}

/**
 * 환경 변수 조회
 *
 * FINCLAW_ 접두사를 우선 검색하고, 없으면 접두사 없는 키를 검색.
 */
export function getEnv(key: string, fallback?: string): string | undefined {
  return process.env[`${FINCLAW_PREFIX}${key}`] ?? process.env[key] ?? fallback;
}

/** 필수 환경 변수 조회 — 없으면 throw */
export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) {
    throw new Error(`Required environment variable not set: ${FINCLAW_PREFIX}${key} or ${key}`);
  }
  return value;
}

/** truthy 환경 변수 판별 ('1', 'true', 'yes') */
export function isTruthyEnvValue(value: string | undefined): boolean {
  return value != null && ['1', 'true', 'yes'].includes(value.toLowerCase());
}

/** 허용된 환경 변수 값을 로그에 기록 (민감 정보 제외) */
export function logAcceptedEnvOption(
  key: string,
  value: string,
  logger: { info: (msg: string) => void },
): void {
  logger.info(`env: ${key} = ${value}`);
}
