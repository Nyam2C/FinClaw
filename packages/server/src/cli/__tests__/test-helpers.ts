// packages/server/src/cli/__tests__/test-helpers.ts
import { vi } from 'vitest';
import type { CliDeps } from '../deps.js';

export function createTestDeps(overrides?: Partial<CliDeps>): CliDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      providers: {},
      storage: { database: { path: ':memory:' } },
    }),
    log: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
      flush: vi.fn().mockResolvedValue(undefined),
    },
    callGateway: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    getGatewayHealth: vi.fn().mockResolvedValue({ ok: true, data: { status: 'ok' } }),
    exit: vi.fn() as unknown as CliDeps['exit'],
    output: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}
