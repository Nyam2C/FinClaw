import { describe, it, expect } from 'vitest';
import { safeSpawn } from '../../src/process/spawn.js';

describe('safeSpawn', () => {
  it('정상 명령 실행 후 stdout 수집', async () => {
    const result = await safeSpawn({ command: 'echo', args: ['hello'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('존재하지 않는 명령 실행 시 에러', async () => {
    await expect(safeSpawn({ command: '__nonexistent_cmd_12345__' })).rejects.toThrow();
  });

  it('타임아웃 시 timedOut=true', async () => {
    const result = await safeSpawn({
      command: 'sleep',
      args: ['10'],
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
  });

  it('외부 AbortSignal로 취소 시 aborted=true', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await safeSpawn({
      command: 'sleep',
      args: ['10'],
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('stdin 입력 전달', async () => {
    const result = await safeSpawn({
      command: 'cat',
      stdin: 'hello from stdin',
    });
    expect(result.stdout.trim()).toBe('hello from stdin');
  });

  it('exitCode가 0이 아닌 경우', async () => {
    const result = await safeSpawn({ command: 'false' });
    expect(result.exitCode).not.toBe(0);
  });

  it('durationMs가 양수', async () => {
    const result = await safeSpawn({ command: 'echo', args: ['hi'] });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
