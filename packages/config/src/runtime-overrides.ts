// packages/config/src/runtime-overrides.ts
import type { FinClawConfig } from '@finclaw/types';

/**
 * 인메모리 런타임 오버라이드
 *
 * - set(path, value): 오버라이드 등록
 * - unset(path): 오버라이드 제거
 * - apply(config): 오버라이드를 config에 적용 (shallow merge)
 * - reset(): 모든 오버라이드 초기화
 */

const overrides = new Map<string, unknown>();

export function setOverride(path: string, value: unknown): void {
  overrides.set(path, value);
}

export function unsetOverride(path: string): void {
  overrides.delete(path);
}

export function applyOverrides(config: FinClawConfig): FinClawConfig {
  if (overrides.size === 0) {
    return config;
  }

  let result: Record<string, unknown> = { ...config };
  for (const [dotPath, value] of overrides) {
    result = setNestedValue(result, dotPath.split('.'), value);
  }
  return result as FinClawConfig;
}

export function resetOverrides(): void {
  overrides.clear();
}

export function getOverrideCount(): number {
  return overrides.size;
}

function setNestedValue(
  obj: Record<string, unknown>,
  keys: string[],
  value: unknown,
): Record<string, unknown> {
  if (keys.length === 0) {
    return obj;
  }
  if (keys.length === 1) {
    return { ...obj, [keys[0]]: value };
  }

  const [head, ...rest] = keys;
  const child = (obj[head] ?? {}) as Record<string, unknown>;
  return {
    ...obj,
    [head]: setNestedValue({ ...child }, rest, value),
  };
}
