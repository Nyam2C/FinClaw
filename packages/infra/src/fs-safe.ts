import * as crypto from 'node:crypto';
import { constants } from 'node:fs';
// packages/infra/src/fs-safe.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 원자적 파일 쓰기
 *
 * 1. 임시 파일에 쓰기 (PID+UUID로 충돌 방지)
 * 2. rename()으로 원자적 교체
 * 3. Windows fallback: copyFile + chmod + unlink
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpName = `.tmp.${process.pid}.${crypto.randomUUID()}`;
  const tmpPath = path.join(dir, tmpName);

  try {
    await fs.writeFile(tmpPath, data, { mode });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (isWindowsRenameError(err)) {
      await fs.copyFile(tmpPath, filePath);
      await fs.chmod(filePath, mode);
      await fs.unlink(tmpPath).catch(() => {});
    } else {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}

/**
 * 안전한 파일 읽기 — 심링크 검사
 * O_NOFOLLOW로 심링크 공격 방지
 */
export async function readFileSafe(filePath: string): Promise<string> {
  const fd = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const content = await fd.readFile({ encoding: 'utf-8' });
    return content;
  } finally {
    await fd.close();
  }
}

/**
 * 디렉토리 존재 보장 (존재하지 않으면 생성)
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 안전한 파일 삭제 (없으면 무시)
 */
export async function unlinkSafe(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

function isWindowsRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EEXIST');
}
