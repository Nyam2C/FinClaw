import type { FinClawLogger } from '@finclaw/infra';
import type { FinClawConfig } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import { buildProviders } from './providers.js';

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as unknown as FinClawLogger;

describe('buildProviders — Phase 41 CLI-only', () => {
  it('creates CLI providerAdapter + toolRegistry', () => {
    const b = buildProviders({
      finclawConfig: { provider: 'claude-cli' } as unknown as FinClawConfig,
      logger,
      mcpEndpoint: { url: 'http://127.0.0.1:0/mcp', jwtSecret: 'test' },
    });
    expect(b.providerAdapter).toBeDefined();
    expect(b.toolRegistry).toBeDefined();
  });
});
