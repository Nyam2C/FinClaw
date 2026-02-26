// packages/config/src/includes.ts
import { CircularIncludeError } from './errors.js';

const MAX_INCLUDE_DEPTH = 10;

/**
 * $include 재귀 해석
 *
 * - $include 키가 있으면 해당 파일을 읽어 deepMerge
 * - 순환 참조 감지 (chain 배열로 추적)
 * - MAX_INCLUDE_DEPTH(10) 제한
 */
export function resolveIncludes(
  raw: Record<string, unknown>,
  readFile: (filePath: string) => Record<string, unknown>,
  basePath: string,
  chain: string[] = [],
): Record<string, unknown> {
  if (chain.length > MAX_INCLUDE_DEPTH) {
    throw new CircularIncludeError(chain);
  }

  const includePath = raw.$include;
  if (typeof includePath !== 'string') {
    return raw;
  }

  const resolvedPath = resolvePath(includePath, basePath);

  if (chain.includes(resolvedPath)) {
    throw new CircularIncludeError([...chain, resolvedPath]);
  }

  const included = readFile(resolvedPath);
  const resolvedIncluded = resolveIncludes(included, readFile, resolvedPath, [
    ...chain,
    resolvedPath,
  ]);

  const { $include: _, ...rest } = raw;
  return deepMerge(resolvedIncluded, rest) as Record<string, unknown>;
}

/** Deep merge: 배열=연결, 객체=재귀, 원시값=source 우선 */
export function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result: Record<string, unknown> = { ...target };
    for (const key of Object.keys(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      result[key] = key in result ? deepMerge(result[key], source[key]) : source[key];
    }
    return result;
  }
  return source;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function resolvePath(includePath: string, basePath: string): string {
  if (includePath.startsWith('/')) {
    return includePath;
  }
  const dir = basePath.replace(/[/\\][^/\\]*$/, '');
  return `${dir}/${includePath}`;
}
