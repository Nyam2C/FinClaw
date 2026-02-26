// packages/config/src/normalize-paths.ts
import * as os from 'node:os';

/**
 * ~/ 경로 확장
 *
 * 문자열 값에서 ~/ 접두사를 homedir()로 치환.
 * 재귀적으로 객체/배열을 탐색.
 */
export function normalizePaths(value: unknown, homedir: () => string = os.homedir): unknown {
  if (typeof value === 'string') {
    return expandTilde(value, homedir);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizePaths(item, homedir));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = normalizePaths(v, homedir);
    }
    return result;
  }
  return value;
}

function expandTilde(str: string, homedir: () => string): string {
  if (str === '~') {
    return homedir();
  }
  if (str.startsWith('~/')) {
    return homedir() + str.slice(1);
  }
  return str;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
