// packages/infra/src/gateway-lock.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FinClawError } from './errors.js';

/** Co-located 에러 클래스 */
export class GatewayLockError extends FinClawError {
  constructor(message: string, opts?: { cause?: Error }) {
    super(message, 'GATEWAY_LOCK_ERROR', { statusCode: 503, cause: opts?.cause });
    this.name = 'GatewayLockError';
  }
}

export interface GatewayLockHandle {
  lockPath: string;
  pid: number;
  port?: number;
  acquiredAt: number;
  release(): Promise<void>;
}

export interface GatewayLockOptions {
  lockDir: string;
  timeoutMs?: number; // 기본: 5000
  pollIntervalMs?: number; // 기본: 100
  staleThresholdMs?: number; // 기본: 30000
  port?: number;
  signal?: AbortSignal;
}

/**
 * 파일 기반 뮤텍스로 게이트웨이 단일 인스턴스 보장
 *
 * 1. fs.open('wx') exclusive 생성
 * 2. EEXIST → 기존 파일의 PID 유효성 검증
 * 3. stale 감지 → 파일 삭제 후 재시도
 * 4. 타임아웃/signal → GatewayLockError throw (Error.cause 포함)
 */
export async function acquireGatewayLock(opts: GatewayLockOptions): Promise<GatewayLockHandle> {
  const {
    lockDir,
    timeoutMs = 5000,
    pollIntervalMs = 100,
    staleThresholdMs = 30000,
    port,
    signal,
  } = opts;

  await fs.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, 'gateway.lock');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new GatewayLockError('Lock acquisition aborted');
    }

    try {
      const fd = await fs.open(lockPath, 'wx');
      const acquiredAt = Date.now();
      const payload = JSON.stringify({
        pid: process.pid,
        port,
        acquiredAt,
      });
      await fd.writeFile(payload);
      await fd.close();

      return {
        lockPath,
        pid: process.pid,
        port,
        acquiredAt,
        release: async () => {
          try {
            await fs.unlink(lockPath);
          } catch {
            /* ignore */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new GatewayLockError('Failed to create lock file', {
          cause: err instanceof Error ? err : undefined,
        });
      }

      // 기존 잠금 검사
      await handleExistingLock(lockPath, staleThresholdMs);
      await sleep(pollIntervalMs);
    }
  }

  throw new GatewayLockError(
    `Timeout acquiring gateway lock after ${timeoutMs}ms. Another instance may be running.`,
  );
}

/**
 * 잠금 파일 정보 읽기 (디버깅/진단용)
 */
export async function readLockInfo(lockPath: string): Promise<
  | {
      pid: number;
      port?: number;
      acquiredAt: number;
    }
  | undefined
> {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

async function handleExistingLock(lockPath: string, staleThresholdMs: number): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > staleThresholdMs) {
      // stale 잠금 → PID 유효성 추가 확인
      const info = await readLockInfo(lockPath);
      if (info && !isProcessAlive(info.pid)) {
        await fs.unlink(lockPath);
      } else if (Date.now() - stat.mtimeMs > staleThresholdMs * 2) {
        // 프로세스가 살아있어도 2x 임계치 초과 시 강제 삭제
        await fs.unlink(lockPath);
      }
    }
  } catch {
    // 파일이 이미 삭제됨 → 다음 루프에서 재시도
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
