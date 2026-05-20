// packages/agent/src/providers/claude-cli/spawn.ts

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface SpawnRequest {
  argv: [string, ...string[]]; // [command, ...args]
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string; // stdin
  timeoutMs: number; // overall
  noOutputTimeoutMs: number; // watchdog
  signal?: AbortSignal;
}

export type SpawnReason = 'exit' | 'overall-timeout' | 'no-output-timeout' | 'aborted';

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason: SpawnReason;
  pid?: number;
  noOutputTimedOut: boolean;
  durationMs: number;
}

export async function spawnWithWatchdog(req: SpawnRequest): Promise<SpawnResult> {
  const [command, ...args] = req.argv;
  const startedAt = Date.now();

  return new Promise<SpawnResult>((resolve) => {
    let child: ChildProcess | undefined;
    let stdout = '';
    let stderr = '';
    let lastOutputAt = Date.now();
    let resolved = false;
    let noOutputTimedOut = false;

    const finalize = (final: SpawnReason, exitCode: number | null = null) => {
      if (resolved) {
        return;
      }
      resolved = true;
      try {
        child?.kill('SIGTERM');
      } catch {}
      // 2초 후에도 살아있으면 SIGKILL
      setTimeout(() => {
        try {
          child?.kill('SIGKILL');
        } catch {}
      }, 2_000);
      resolve({
        exitCode,
        stdout,
        stderr,
        reason: final,
        pid: child?.pid,
        noOutputTimedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    let proc: ChildProcess;
    try {
      proc = nodeSpawn(command, args, {
        cwd: req.cwd,
        env: req.env,
        stdio: req.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        reason: 'exit',
        noOutputTimedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    child = proc;

    if (req.input && proc.stdin) {
      proc.stdin.write(req.input);
      proc.stdin.end();
    }

    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
      lastOutputAt = Date.now();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
      lastOutputAt = Date.now();
    });

    proc.on('exit', (code) => finalize('exit', code));
    proc.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finalize('exit', null);
    });

    // watchdog: noOutput timeout (slide window)
    const watchdog = setInterval(
      () => {
        const idle = Date.now() - lastOutputAt;
        if (idle >= req.noOutputTimeoutMs) {
          noOutputTimedOut = true;
          clearInterval(watchdog);
          finalize('no-output-timeout');
        }
      },
      Math.min(req.noOutputTimeoutMs / 4, 2_000),
    );

    // overall timeout
    const overallTimer = setTimeout(() => {
      clearInterval(watchdog);
      finalize('overall-timeout');
    }, req.timeoutMs);

    // abort signal
    req.signal?.addEventListener(
      'abort',
      () => {
        clearInterval(watchdog);
        clearTimeout(overallTimer);
        finalize('aborted');
      },
      { once: true },
    );

    // 정리: exit 시 timer 들 클리어
    proc.once('exit', () => {
      clearInterval(watchdog);
      clearTimeout(overallTimer);
    });
  });
}
