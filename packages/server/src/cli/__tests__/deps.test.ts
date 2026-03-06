// packages/server/src/cli/__tests__/deps.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDefaultDeps } from '../deps.js';
import { createTestDeps } from './test-helpers.js';

describe('createDefaultDeps', () => {
  it('returns an object with all required keys', () => {
    const deps = createDefaultDeps();
    expect(deps).toHaveProperty('loadConfig');
    expect(deps).toHaveProperty('log');
    expect(deps).toHaveProperty('callGateway');
    expect(deps).toHaveProperty('getGatewayHealth');
    expect(deps).toHaveProperty('exit');
    expect(deps).toHaveProperty('output');
    expect(deps).toHaveProperty('error');
  });

  it('applies overrides', () => {
    const customExit = vi.fn();
    const deps = createDefaultDeps({ exit: customExit });
    expect(deps.exit).toBe(customExit);
  });
});

describe('createTestDeps', () => {
  it('returns mock deps', () => {
    const deps = createTestDeps();
    expect(vi.isMockFunction(deps.exit)).toBe(true);
    expect(vi.isMockFunction(deps.output)).toBe(true);
  });

  it('accepts overrides', () => {
    const customExit = vi.fn();
    const deps = createTestDeps({ exit: customExit });
    expect(deps.exit).toBe(customExit);
  });
});
