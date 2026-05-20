import { describe, it, expect } from 'vitest';
import { enqueueCliRun } from '../../../src/providers/claude-cli/queue.js';

describe('enqueueCliRun', () => {
  it('serializes same-key tasks', async () => {
    const log: string[] = [];
    const t1 = enqueueCliRun('k1', async () => {
      await new Promise((r) => setTimeout(r, 30));
      log.push('t1');
    });
    const t2 = enqueueCliRun('k1', async () => {
      log.push('t2');
    });
    await Promise.all([t1, t2]);
    expect(log).toEqual(['t1', 't2']);
  });

  it('does NOT serialize different-key tasks', async () => {
    const log: string[] = [];
    const t1 = enqueueCliRun('k1', async () => {
      await new Promise((r) => setTimeout(r, 30));
      log.push('t1');
    });
    const t2 = enqueueCliRun('k2', async () => {
      log.push('t2');
    });
    await Promise.all([t1, t2]);
    // t2 가 먼저 끝남 (병렬)
    expect(log).toEqual(['t2', 't1']);
  });
});
