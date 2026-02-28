import { getEventBus, ensureDir } from '@finclaw/infra';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ── 타입 ──

/** 세션 잠금 결과 */
export interface LockResult {
  readonly acquired: boolean;
  readonly lockPath: string;
  readonly release: () => Promise<void>;
}

/** 세션 잠금 옵션 */
export interface LockOptions {
  readonly sessionDir: string;
  readonly sessionId: string;
  /** 잠금 대기 타임아웃 (기본: 5000ms) */
  readonly timeoutMs?: number;
  /** 오래된 잠금 자동 해제 (기본: 300_000ms = 5분) */
  readonly staleAfterMs?: number;
  /** 폴링 간격 (기본: 100ms) */
  readonly pollIntervalMs?: number;
  /** 재진입 잠금 허용 (기본: false) */
  readonly allowReentrant?: boolean;
}

// ── PID 생존 확인 ──

/** 프로세스가 살아있는지 확인 (gateway-lock.ts 패턴 재사용) */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── 재진입 추적 ──

interface HeldLock {
  lockPath: string;
  pid: number;
  count: number;
}

const heldLocks = new Map<string, HeldLock>();

// ── 메인 함수 ──

/**
 * 파일 기반 배타적 잠금
 *
 * 알고리즘:
 * 1. fs.open(lockPath, 'wx') 로 exclusive 생성 시도
 * 2. 성공 → 잠금 획득, PID + timestamp 기록
 * 3. 실패(EEXIST) → PID 생존 확인 → 죽었으면 stale 처리
 *    → 살아있으면 시간 기반 stale 확인
 *    → stale 아니면 pollIntervalMs 대기 후 재시도
 * 4. 타임아웃 → acquired: false 반환
 * 5. release() → 잠금 파일 삭제 + 시그널 핸들러 해제
 */
export async function acquireWriteLock(options: LockOptions): Promise<LockResult> {
  const {
    sessionDir,
    sessionId,
    timeoutMs = 5_000,
    staleAfterMs = 300_000,
    pollIntervalMs = 100,
    allowReentrant = false,
  } = options;

  await ensureDir(sessionDir);
  const lockPath = path.join(sessionDir, `${sessionId}.lock`);
  const deadline = Date.now() + timeoutMs;
  const bus = getEventBus();

  while (Date.now() < deadline) {
    try {
      // 배타적 생성 시도 (O_CREAT | O_EXCL)
      const fd = await fs.open(lockPath, 'wx');
      const lockData = JSON.stringify({
        pid: process.pid,
        timestamp: new Date().toISOString(),
        sessionId,
      });
      await fd.writeFile(lockData);
      await fd.close();

      // 재진입 추적 등록
      heldLocks.set(lockPath, { lockPath, pid: process.pid, count: 1 });

      // 시그널 핸들러 등록
      const cleanup = async (): Promise<void> => {
        try {
          await fs.unlink(lockPath);
        } catch {
          /* 이미 해제된 경우 무시 */
        }
        heldLocks.delete(lockPath);
      };
      const onSignal = (): void => {
        // 동기적으로 삭제 시도 (best-effort)
        fs.unlink(lockPath).catch(() => {});
        heldLocks.delete(lockPath);
      };

      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);

      bus.emit('session:lock:acquire', sessionId, process.pid);

      return {
        acquired: true,
        lockPath,
        release: async (): Promise<void> => {
          const held = heldLocks.get(lockPath);
          if (held) {
            held.count--;
            if (held.count > 0) {
              return; // 재진입 참조 카운트 남아있음
            }
          }
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
          await cleanup();
          bus.emit('session:lock:release', sessionId);
        },
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }

      // 기존 잠금 확인
      try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const info = JSON.parse(raw) as { pid: number; timestamp: string; sessionId: string };

        // ① PID 생존 확인 — 죽은 프로세스면 즉시 stale 처리
        if (!isProcessAlive(info.pid)) {
          bus.emit('session:lock:stale', sessionId, info.pid);
          await fs.unlink(lockPath);
          continue;
        }

        // ② 재진입 확인
        if (info.pid === process.pid && allowReentrant) {
          const held = heldLocks.get(lockPath);
          if (held) {
            held.count++;
            return {
              acquired: true,
              lockPath,
              release: async (): Promise<void> => {
                held.count--;
                if (held.count <= 0) {
                  await fs.unlink(lockPath).catch(() => {});
                  heldLocks.delete(lockPath);
                  bus.emit('session:lock:release', sessionId);
                }
              },
            };
          }
        }

        // ③ 시간 기반 stale 확인
        const stat = await fs.stat(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > staleAfterMs) {
          bus.emit('session:lock:stale', sessionId, info.pid);
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        // readFile/stat 실패 시 재시도 (파일이 사라졌을 수 있음)
        continue;
      }

      // 대기 후 재시도
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  // 타임아웃
  return {
    acquired: false,
    lockPath,
    release: async (): Promise<void> => {},
  };
}

/** 테스트용: 재진입 추적 초기화 */
export function resetHeldLocks(): void {
  heldLocks.clear();
}
