// packages/config/src/env-substitution.ts
import { MissingEnvVarError } from './errors.js';

/**
 * 환경변수 치환 엔진
 *
 * - 대문자만: [A-Z_][A-Z0-9_]*
 * - 1회 치환 (재귀 없음 — injection 방지)
 * - $${VAR} escape: 리터럴 ${VAR} 출력
 * - 미설정/빈 문자열: MissingEnvVarError throw
 */

const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const ESCAPED_PATTERN = /\$\$\{([A-Z_][A-Z0-9_]*)\}/g;
const NUL = '\x00';
const RESTORE_PATTERN = new RegExp(`${NUL}ESC_ENV${NUL}([A-Z_][A-Z0-9_]*)${NUL}`, 'g');

export function resolveEnvVars(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return substituteString(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvVars(item, env));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveEnvVars(v, env);
    }
    return result;
  }
  return value;
}

function substituteString(str: string, env: NodeJS.ProcessEnv): string {
  if (!str.includes('$')) {
    return str;
  }

  let result = str.replace(ESCAPED_PATTERN, '\x00ESC_ENV\x00$1\x00');

  result = result.replace(ENV_VAR_PATTERN, (_, varName: string) => {
    const value = env[varName];
    if (value === undefined || value === '') {
      throw new MissingEnvVarError(varName);
    }
    return value;
  });

  result = result.replace(RESTORE_PATTERN, '${$1}');

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
