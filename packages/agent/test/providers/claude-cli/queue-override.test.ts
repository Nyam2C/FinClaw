import { describe, it, expect, vi } from 'vitest';
import * as queueMod from '../../../src/providers/claude-cli/queue.js';
import { runCliAgent } from '../../../src/providers/claude-cli/runner.js';
import * as spawnMod from '../../../src/providers/claude-cli/spawn.js';

describe('runCliAgent queueKey override (Phase 41)', () => {
  it('uses provided queueKey instead of backendId-derived key', async () => {
    const enqueueSpy = vi.spyOn(queueMod, 'enqueueCliRun');
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      exitCode: 0,
      reason: 'exit',
      stdout: '{"result":"ok"}',
      stderr: '',
      noOutputTimedOut: false,
    } as never);

    await runCliAgent({ prompt: 'hi', queueKey: 'claude-analysis', modelId: 'opus' });

    expect(enqueueSpy).toHaveBeenCalledWith('claude-analysis', expect.any(Function));
  });

  it('falls back to backendId key when queueKey omitted', async () => {
    const enqueueSpy = vi.spyOn(queueMod, 'enqueueCliRun');
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      exitCode: 0,
      reason: 'exit',
      stdout: '{"result":"ok"}',
      stderr: '',
      noOutputTimedOut: false,
    } as never);

    await runCliAgent({ prompt: 'hi' });

    expect(enqueueSpy).toHaveBeenCalledWith('claude', expect.any(Function));
  });
});
