// packages/server/src/process/spawn.ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface SpawnOptions {
  /** 실행할 명령어 */
  command: string;
  /** 명령어 인자 */
  args?: string[];
  /** 작업 디렉토리 */
  cwd?: string;
  /** 환경 변수 */
  env?: NodeJS.ProcessEnv;
  /** 타임아웃 (ms, 기본: 30000) */
  timeoutMs?: number;
  /** 외부 중단 시그널 (AbortSignal.any()로 타임아웃과 합성) */
  signal?: AbortSignal;
  /** stdin 입력 */
  stdin?: string;
  /** 최대 출력 버퍼 (bytes, 기본: 10MB) */
  maxBuffer?: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;
  timedOut: boolean;
  /** 외부 AbortSignal에 의한 취소 여부 */
  aborted: boolean;
  durationMs: number;
}

/**
 * 안전한 자식 프로세스 실행
 *
 * - AbortSignal.timeout() + AbortSignal.any()로 타임아웃/외부 취소 합성
 * - 타임아웃 시 SIGTERM -> 2초 유예 -> SIGKILL
 * - stdout/stderr 스트림 수집 (maxBuffer 제한)
 */
export async function safeSpawn(opts: SpawnOptions): Promise<SpawnResult> {
  const {
    command,
    args = [],
    cwd,
    env,
    timeoutMs = 30_000,
    signal: externalSignal,
    stdin,
    maxBuffer = 10 * 1024 * 1024,
  } = opts;

  // AbortSignal 합성: 타임아웃 + 외부 시그널
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    // NOTE: maxBuffer 초과 시 조용히 truncate. truncated 플래그 없이 출력이 잘려도 알 수 없음.
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length <= maxBuffer) {
        stdout += chunk.toString();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length <= maxBuffer) {
        stderr += chunk.toString();
      }
    });

    if (stdin) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }

    // NOTE: child가 이미 종료된 후 signal abort 시 불필요한 SIGTERM이 발생할 수 있으나 실해 없음.
    combinedSignal.addEventListener('abort', () => gracefulKill(child), { once: true });

    child.on('close', (exitCode, sig) => {
      const timedOut = timeoutSignal.aborted;
      const aborted = externalSignal?.aborted ?? false;
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        signal: sig ?? undefined,
        timedOut,
        aborted,
        durationMs: Date.now() - startTime,
      });
    });

    child.on('error', (err) => {
      gracefulKill(child);
      reject(err);
    });
  });
}

/** SIGTERM -> 2초 유예 -> SIGKILL */
function gracefulKill(child: ChildProcess): void {
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }, 2000);
}
