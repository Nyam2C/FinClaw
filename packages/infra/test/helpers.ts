// packages/infra/test/helpers.ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/** 임시 디렉토리 생성 + 자동 정리 */
export async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finclaw-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 테스트용 무출력 로거 */
export function createTestLogger() {
  const noop = () => {};
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => createTestLogger(),
    flush: async () => {},
  };
}
