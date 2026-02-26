// packages/infra/src/json-file.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic, readFileSafe, ensureDir } from './fs-safe.js';

/**
 * JSON 파일 비동기 읽기
 *
 * 파일이 없으면 undefined 반환.
 * JSON 파싱 실패 시 에러 throw.
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    const content = await readFileSafe(filePath);
    return JSON.parse(content) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/**
 * JSON 파일 비동기 쓰기 (원자적)
 *
 * 디렉토리가 없으면 자동 생성.
 * 퍼미션: 0o600 (소유자만 읽기/쓰기).
 */
export async function writeJsonFile(filePath: string, data: unknown, indent = 2): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const content = JSON.stringify(data, null, indent) + '\n';
  await writeFileAtomic(filePath, content, 0o600);
}

/**
 * JSON 파일 동기 읽기 (프로세스 시작 시 사용)
 *
 * 파일이 없으면 undefined 반환.
 */
export function readJsonFileSync<T = unknown>(filePath: string): T | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}
