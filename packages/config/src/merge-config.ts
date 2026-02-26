// packages/config/src/merge-config.ts

/**
 * 섹션 단위 shallow merge + deep merge
 *
 * - 배열: 연결 (concat)
 * - 객체: 재귀 병합
 * - 원시값: source 우선
 * - 프로토타입 오염 방지
 */
export function mergeConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }

    const tVal = result[key];
    const sVal = source[key];

    if (Array.isArray(tVal) && Array.isArray(sVal)) {
      result[key] = [...tVal, ...sVal];
    } else if (isPlainObject(tVal) && isPlainObject(sVal)) {
      result[key] = mergeConfig(tVal, sVal);
    } else {
      result[key] = sVal;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}
