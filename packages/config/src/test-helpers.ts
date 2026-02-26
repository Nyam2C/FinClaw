// packages/config/src/test-helpers.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 임시 홈 디렉토리에서 콜백 실행
 *
 * 테스트 격리: 임시 디렉토리를 생성하고, 콜백에 경로를 전달.
 * 콜백 종료 후 디렉토리 정리.
 */
export async function withTempHome<T>(fn: (tmpHome: string) => T | Promise<T>): Promise<T> {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-test-'));
  try {
    return await fn(tmpHome);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

/**
 * 환경변수를 임시로 설정하고 콜백 실행
 *
 * 콜백 종료 후 원래 값으로 복원.
 */
export async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const originals: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
