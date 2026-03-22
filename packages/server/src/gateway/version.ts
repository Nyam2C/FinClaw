// packages/server/src/gateway/version.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let cached: string | null = null;

/**
 * build-info.json에서 버전을 로드한다.
 * 파일이 없으면(개발 환경) '0.0.0-dev' 반환.
 * 한 번 로드 후 캐시.
 */
export function loadVersion(): string {
  if (cached !== null) {
    return cached;
  }

  try {
    const infoPath = resolve(import.meta.dirname, '../../../build-info.json');
    const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as { version?: string };
    cached = info.version ?? '0.0.0-dev';
  } catch {
    cached = '0.0.0-dev';
  }

  return cached;
}

/** 테스트용: 캐시 초기화 */
export function resetVersionCache(): void {
  cached = null;
}
