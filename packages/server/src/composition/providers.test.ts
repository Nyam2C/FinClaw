import type { FinClawLogger } from '@finclaw/infra';
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
  it('creates toolRegistry (phase46: CLI 실행은 runtime 드라이버)', () => {
    const b = buildProviders({ logger });
    expect(b.toolRegistry).toBeDefined();
  });
});
