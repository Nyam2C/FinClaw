// packages/server/src/cli/__tests__/route.test.ts
import { describe, it, expect, vi } from 'vitest';
import { tryFastPath } from '../route.js';
import { createTestDeps } from './test-helpers.js';

describe('tryFastPath', () => {
  it('returns null for unknown command', async () => {
    const deps = createTestDeps();
    expect(await tryFastPath(['unknown'], deps)).toBeNull();
  });

  it('returns null for empty argv', async () => {
    const deps = createTestDeps();
    expect(await tryFastPath([], deps)).toBeNull();
  });

  it('handles health command on success', async () => {
    const deps = createTestDeps();
    const code = await tryFastPath(['health'], deps);
    expect(code).toBe(0);
    expect(deps.output).toHaveBeenCalled();
  });

  it('handles health command on failure', async () => {
    const deps = createTestDeps({
      getGatewayHealth: vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: -1, message: 'Connection refused' } }),
    });
    const code = await tryFastPath(['health'], deps);
    expect(code).toBe(3); // EXIT.GATEWAY_ERROR
    expect(deps.error).toHaveBeenCalled();
  });

  it('handles status command', async () => {
    const deps = createTestDeps({
      callGateway: vi.fn().mockResolvedValue({ ok: true, data: { version: '0.1.0' } }),
    });
    const code = await tryFastPath(['status'], deps);
    expect(code).toBe(0);
  });

  it('ignores option flags in argv', async () => {
    const deps = createTestDeps();
    const code = await tryFastPath(['--verbose', 'health'], deps);
    expect(code).toBe(0);
  });
});
