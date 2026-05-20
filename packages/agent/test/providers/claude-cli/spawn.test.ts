import { describe, it, expect } from 'vitest';
import { spawnWithWatchdog } from '../../../src/providers/claude-cli/spawn.js';

describe('spawnWithWatchdog', () => {
  it('captures stdout for short-lived process', async () => {
    const result = await spawnWithWatchdog({
      argv: ['node', '-e', 'process.stdout.write("hello")'],
      timeoutMs: 5_000,
      noOutputTimeoutMs: 3_000,
    });
    expect(result.reason).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
  });

  it('kills on overall timeout', async () => {
    const result = await spawnWithWatchdog({
      argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 500,
      noOutputTimeoutMs: 10_000,
    });
    expect(result.reason).toBe('overall-timeout');
  });

  it('kills on no-output timeout (idle process)', async () => {
    const result = await spawnWithWatchdog({
      argv: ['node', '-e', 'process.stdout.write("a"); setInterval(() => {}, 5000)'],
      timeoutMs: 10_000,
      noOutputTimeoutMs: 500,
    });
    expect(result.reason).toBe('no-output-timeout');
    expect(result.noOutputTimedOut).toBe(true);
  });
});
